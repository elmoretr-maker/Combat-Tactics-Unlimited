#!/usr/bin/env node
/**
 * CTU asset pipeline � analysis, duplicate detection, CLIP hooks, optional VFX promotion.
 *
 * Usage:
 *   node tools/asset_pipeline_ingest.mjs analyze [--out=tools/asset_pipeline_analysis.json]
 *   node tools/asset_pipeline_ingest.mjs duplicates [--min-size=1]
 *   node tools/asset_pipeline_ingest.mjs organize [--dry-run]   (CTU sidecar vs suggestedDest)
 *   node tools/asset_pipeline_ingest.mjs promote-light-tank-vfx [--dry-run]
 *
 * CLIP batch classification (moves files): use `npm run smart-catalog` (tools/smart_catalog.mjs).
 */

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import {
  suggestedDestRelFromMetadata,
  METADATA_SUFFIX,
  compactPlacementTagsFromSurfaces,
} from "./asset_metadata.mjs";
import { assetBucketForRel, mapClipCategoryToCoarseFamily } from "./asset_layout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

function posixRel(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function* walkFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".")) continue;
    const full = path.join(dir, name.name);
    if (name.isDirectory()) yield* walkFilesRecursive(full);
    else yield full;
  }
}

function analyzeTree(rootRel) {
  const abs = path.join(ROOT, ...rootRel.split("/"));
  const byExt = {};
  let files = 0;
  const basenames = [];
  const ambiguousNames = [];
  for (const full of walkFilesRecursive(abs)) {
    const ext = path.extname(full).toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
    files++;
    if (IMAGE_EXT.has(ext)) {
      const base = path.basename(full);
      basenames.push({ base, rel: posixRel(full) });
      const lower = base.toLowerCase();
      if (
        /^(frame|sheet|strip|sprite|atlas|sequence)/i.test(lower) ||
        /\d{2,4}x\d{2,4}/.test(lower)
      ) {
        ambiguousNames.push(posixRel(full));
      }
    }
  }
  return { rootRel, files, byExt, basenames, ambiguousNames };
}

function basenameCollisions(entries) {
  const map = new Map();
  for (const { base, rel } of entries) {
    const k = base.toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(rel);
  }
  const dups = [];
  for (const [k, rels] of map) {
    if (rels.length > 1) dups.push({ basename: k, paths: rels.sort() });
  }
  dups.sort((a, b) => b.paths.length - a.paths.length);
  return dups;
}

function sha256File(abs) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(abs));
  return h.digest("hex");
}

function themeFromCtuPlacement(ctu) {
  let p = ctu?.placement;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const legacy = p.allowedSurfaces;
    if (Array.isArray(legacy)) p = compactPlacementTagsFromSurfaces(legacy);
    else p = null;
  }
  if (!Array.isArray(p)) return "urban";
  if (p.includes("desert")) return "desert";
  if (p.includes("grass")) return "grass";
  return "urban";
}

function cmdAnalyze() {
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const outPath = outArg
    ? path.join(ROOT, outArg.slice("--out=".length).replace(/^\//, ""))
    : path.join(ROOT, "tools", "asset_pipeline_analysis.json");

  const assets = analyzeTree("assets");
  const attached = analyzeTree("attached_assets");
  const collisions = basenameCollisions(assets.basenames);

  const payload = {
    generatedAt: new Date().toISOString(),
    layoutVersion: 1,
    summary: {
      assetsFiles: assets.files,
      attachedAssetsFiles: attached.files,
      duplicateBasenamesUnderAssets: collisions.length,
      possibleSpriteSheetsOrSequences: assets.ambiguousNames.length,
    },
    coarseFamilyMap: Object.fromEntries(
      [
        "tactical_vehicles",
        "soldiers_infantry",
        "weapons_firearms",
        "terrain_tiles",
        "buildings_structures",
        "urban_ruins",
        "urban_props",
        "foliage",
        "desert_scatter",
        "vfx_combat",
        "ui_hud",
        "loot_icons",
      ].map((id) => [id, mapClipCategoryToCoarseFamily(id)]),
    ),
    targets: {
      units: ["assets/units/vehicles", "assets/units/infantry"],
      tiles: ["assets/tiles/terrain/{urban,desert,grass}", "assets/tiles/{urban,desert,grass} (legacy)"],
      structures: ["assets/tiles/structures/{small,medium,large,fortified}", "assets/buildings/* (legacy)"],
      effects: ["assets/effects/explosions", "assets/effects/muzzle", "assets/effects/smoke", "assets/vfx (legacy)"],
      ui: ["assets/ui/*"],
    },
    inconsistencies: [
      "Many Gun_* variants under assets/New_Arrivals/review � likely duplicate weapon art until deduped.",
      "Legacy paths: assets/buildings, assets/tiles/urban, assets/units/urban, assets/vfx coexist with the new layout.",
      "attached_assets/ holds CraftPix packs + light_tank sequences; only a small subset is tracked in assetManifest.",
      "Two CTU sidecar shapes exist (schemaVersion vs version + placement object vs array).",
    ],
    duplicateBasenamesSample: collisions.slice(0, 80),
    attachedAssetsTopLevel: fs.existsSync(path.join(ROOT, "attached_assets"))
      ? fs.readdirSync(path.join(ROOT, "attached_assets")).filter((n) => !n.startsWith("."))
      : [],
    assetsByExtension: assets.byExt,
    attachedByExtension: attached.byExt,
    ambiguousAssetPathsSample: assets.ambiguousNames.slice(0, 50),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${posixRel(outPath)}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

function cmdDuplicates() {
  const minSize = 2;
  const byHash = new Map();
  const base = path.join(ROOT, "assets");
  for (const full of walkFilesRecursive(base)) {
    const ext = path.extname(full).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    try {
      const st = fs.statSync(full);
      if (st.size < minSize) continue;
      const hash = sha256File(full);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(posixRel(full));
    } catch {
      /* skip */
    }
  }
  const groups = [...byHash.entries()]
    .filter(([, rels]) => rels.length > 1)
    .map(([hash, rels]) => ({ hash, paths: rels.sort() }));
  groups.sort((a, b) => b.paths.length - a.paths.length);
  const outPath = path.join(ROOT, "tools", "asset_pipeline_duplicates.json");
  fs.writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), groups }, null, 2)}\n`);
  console.log(`Duplicate content groups: ${groups.length} ? ${posixRel(outPath)}`);
}

function cmdOrganize() {
  const dry = process.argv.includes("--dry-run");
  const moves = [];
  const review = [];
  for (const full of walkFilesRecursive(path.join(ROOT, "assets"))) {
    const ext = path.extname(full).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const rel = posixRel(full);
    if (rel.includes("/New_Arrivals/") || rel.includes("/archive_for_deletion/")) continue;
    const sidecar = `${full.slice(0, -ext.length)}${METADATA_SUFFIX}`;
    if (!fs.existsSync(sidecar)) continue;
    let ctu;
    try {
      ctu = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    } catch {
      review.push({ rel, reason: "invalid_sidecar_json" });
      continue;
    }
    const type = ctu?.classification?.type;
    if (!type || type === "unknown") {
      review.push({ rel, reason: "unknown_type" });
      continue;
    }
    const theme = themeFromCtuPlacement(ctu);
    const suggested = suggestedDestRelFromMetadata(
      { classification: ctu.classification },
      theme,
      path.basename(full),
    );
    const hint = ctu?.pipeline?.folderLayoutHint;
    const targetRel = typeof hint === "string" && hint.startsWith("assets/") ? hint : suggested;
    const curDir = path.posix.dirname(rel);
    if (curDir === targetRel || rel.startsWith(targetRel + "/")) continue;
    const destPath = path.join(ROOT, ...targetRel.split("/"), path.basename(full));
    moves.push({ from: rel, to: posixRel(destPath), targetRel, theme });
    if (!dry) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.renameSync(full, destPath);
      const newSide = `${destPath.slice(0, -ext.length)}${METADATA_SUFFIX}`;
      if (fs.existsSync(sidecar) && path.resolve(sidecar) !== path.resolve(newSide)) {
        fs.renameSync(sidecar, newSide);
      }
    }
  }
  const report = path.join(ROOT, "tools", "asset_pipeline_organize_report.json");
  fs.writeFileSync(
    report,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), dryRun: dry, moves, review }, null, 2)}\n`,
  );
  console.log(`${dry ? "[dry-run] " : ""}moves: ${moves.length}, review: ${review.length} ? ${posixRel(report)}`);
}

const LIGHT_TANK_VFX = [
  ["attached_assets/sprites/light_tank/run", "assets/effects/muzzle/light_tank/run"],
  ["attached_assets/sprites/light_tank/shot", "assets/effects/muzzle/light_tank/shot"],
  ["attached_assets/sprites/light_tank/dead", "assets/effects/explosions/light_tank/dead"],
  ["attached_assets/sprites/light_tank/fx", "assets/effects/muzzle/light_tank/fx"],
];

function cmdPromoteLightTank() {
  const dry = process.argv.includes("--dry-run");
  let n = 0;
  for (const [srcRel, destRel] of LIGHT_TANK_VFX) {
    const src = path.join(ROOT, ...srcRel.split("/"));
    const dest = path.join(ROOT, ...destRel.split("/"));
    if (!fs.existsSync(src)) {
      console.warn("Skip missing:", srcRel);
      continue;
    }
    if (!dry) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        const sf = path.join(src, name);
        if (!fs.statSync(sf).isFile()) continue;
        const df = path.join(dest, name);
        fs.copyFileSync(sf, df);
        n++;
      }
    } else {
      n += fs.readdirSync(src).filter((x) => fs.statSync(path.join(src, x)).isFile()).length;
    }
  }
  console.log(`${dry ? "[dry-run] " : ""}promoted ${n} files under assets/effects/**/light_tank`);
}

const cmd = process.argv[2] || "help";
if (cmd === "analyze") cmdAnalyze();
else if (cmd === "duplicates") cmdDuplicates();
else if (cmd === "organize") cmdOrganize();
else if (cmd === "promote-light-tank-vfx") cmdPromoteLightTank();
else {
  console.log(`Commands: analyze | duplicates | organize [--dry-run] | promote-light-tank-vfx [--dry-run]
CLIP moves: npm run smart-catalog
Catalog manifest: npm run catalog-assets`);
}
