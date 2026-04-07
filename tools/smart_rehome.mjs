#!/usr/bin/env node
/**
 * Smart Re-Home: uses tools/librarian_log.txt source paths to classify misfiled assets
 * and moves them to assets/ui/*, assets/vfx/, or assets/units/vehicles/.
 *
 * Run: node tools/smart_rehome.mjs
 *      node tools/smart_rehome.mjs --archive-scraps  (after catalog rebuild; moves true scraps)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LOG_PATH = path.join(ROOT, "tools", "librarian_log.txt");
const REHOME_LOG = path.join(ROOT, "tools", "rehome_log.txt");
const TRUE_SCRAPS_LIST = path.join(ROOT, "tools", "true_scraps.txt");
const TIER_REPORT = path.join(ROOT, "tools", "tier_confirmation.txt");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const STRIP_RATIO = 3;
const ARGS = new Set(process.argv.slice(2));
const ARCHIVE_SCRAPS = ARGS.has("--archive-scraps");

function posixRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function uniqueDest(destBase) {
  if (!fs.existsSync(destBase)) return destBase;
  const dir = path.dirname(destBase);
  const ext = path.extname(destBase);
  const base = path.basename(destBase, ext);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_rehome_${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

/**
 * Librarian log source path (under New_Arrivals/) -> desired home bucket.
 */
function desiredHomeFromSource(sourceRel) {
  const s = sourceRel.replace(/\\/g, "/").toLowerCase();

  if (s.includes("png modern gui plus more")) {
    let uiSub = "panels";
    if (s.includes("/hud/")) uiSub = "hud";
    else if (s.includes("levels menu")) uiSub = "menu";
    else if (s.includes("minimap")) uiSub = "minimap";
    return { kind: "ui", uiSub };
  }

  if (s.includes("_tmp_vehicle_cells") || s.includes("tmp_vehicle_cell")) {
    return { kind: "vehicle" };
  }

  if (s.includes("png battle tanks plus more")) {
    if (s.includes("/effects/")) return { kind: "vfx" };
    if (
      s.includes("hulls_color") ||
      s.includes("/tracks/") ||
      s.includes("weapon_color") ||
      s.includes("/turret")
    ) {
      return { kind: "vehicle" };
    }
  }

  return null;
}

function targetPathForDesired(desired, fileName) {
  if (desired.kind === "ui") {
    return path.join(ROOT, "assets", "ui", desired.uiSub, fileName);
  }
  if (desired.kind === "vfx") {
    return path.join(ROOT, "assets", "vfx", fileName);
  }
  if (desired.kind === "vehicle") {
    return path.join(ROOT, "assets", "units", "vehicles", fileName);
  }
  return null;
}

function isAlreadyHome(desired, posixDest) {
  const p = posixDest.replace(/\\/g, "/").toLowerCase();
  if (desired.kind === "ui") return p.startsWith(`assets/ui/${desired.uiSub}/`);
  if (desired.kind === "vfx") return p.startsWith("assets/vfx/");
  if (desired.kind === "vehicle") return p.startsWith("assets/units/vehicles/");
  return false;
}

function parseLibrarianMoves() {
  if (!fs.existsSync(LOG_PATH)) return new Map();
  const text = fs.readFileSync(LOG_PATH, "utf8");
  /** @type {Map<string, string>} dest posix -> source rel (last wins) */
  const destToSource = new Map();
  const re = /MOVE New_Arrivals\/(.+?)\s*(?:?|->)\s*(assets\/[^\s|]+)/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const src = m[1].replace(/\s+$/, "").trim();
    destToSource.set(m[2], src);
  }
  return destToSource;
}

function migrateLegacyUiVfx() {
  const legacy = path.join(ROOT, "assets", "ui", "vfx");
  const targetRoot = path.join(ROOT, "assets", "vfx");
  if (!fs.existsSync(legacy)) return [];
  const moves = [];
  const names = fs.readdirSync(legacy);
  ensureDir(targetRoot);
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const from = path.join(legacy, name);
    if (!fs.statSync(from).isFile()) continue;
    let to = path.join(targetRoot, name);
    to = uniqueDest(to);
    fs.renameSync(from, to);
    moves.push({ from: posixRel(from), to: posixRel(to) });
  }
  try {
    if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
  } catch {
    /* ignore */
  }
  return moves;
}

function runRehomeFromLog() {
  const destToSource = parseLibrarianMoves();
  const lines = [];
  const moved = [];

  for (const [destPosix, sourceRel] of destToSource) {
    const desired = desiredHomeFromSource(sourceRel);
    if (!desired) continue;

    const absFrom = path.join(ROOT, ...destPosix.split("/"));
    if (!fs.existsSync(absFrom) || !fs.statSync(absFrom).isFile()) continue;

    if (isAlreadyHome(desired, destPosix)) continue;

    const fileName = path.basename(destPosix);
    let absTo = targetPathForDesired(desired, fileName);
    if (!absTo) continue;
    ensureDir(path.dirname(absTo));
    absTo = uniqueDest(absTo);

    fs.renameSync(absFrom, absTo);
    const toPosix = posixRel(absTo);
    moved.push({
      from: destPosix,
      to: toPosix,
      sourceHint: sourceRel,
      kind: desired.kind,
    });
    lines.push(`${destPosix} -> ${toPosix} | ${desired.kind} | ${sourceRel}`);
  }

  const legacyMoves = migrateLegacyUiVfx();
  for (const l of legacyMoves) {
    lines.push(`legacy ${l.from} -> ${l.to}`);
  }

  ensureDir(path.dirname(REHOME_LOG));
  fs.writeFileSync(
    REHOME_LOG,
    `# smart_rehome ${new Date().toISOString()}\n${lines.join("\n")}\n`,
    "utf8",
  );

  console.log("Smart re-home complete.");
  console.log("  Moves:", moved.length);
  console.log("  Legacy ui/vfx -> vfx:", legacyMoves.length);
  console.log("  Log:", REHOME_LOG);
  return moved;
}

function collectReferencedAssetPathsFromJs() {
  const jsRoot = path.join(ROOT, "js");
  const files = [];
  walkJsFiles(jsRoot, files);
  const refs = new Set();
  const re =
    /assets\/(?:tiles|obstacles|buildings|guns|units|vfx)\/[a-zA-Z0-9_./-]+\.(?:png|webp|jpg|jpeg|gif)/g;
  for (const file of files) {
    const s = fs.readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(s)) !== null) refs.add(m[0].replace(/\\/g, "/").toLowerCase());
  }
  return refs;
}

function walkJsFiles(dir, acc) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkJsFiles(full, acc);
    else if (/\.(js|json)$/.test(name.name)) acc.push(full);
  }
}

async function runArchiveTrueScrapsAndTierReport() {
  const MANIFEST = path.join(ROOT, "js", "config", "assetManifest.json");
  let manifest = null;
  if (fs.existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    } catch {
      /* ignore */
    }
  }

  const referencedPaths = collectReferencedAssetPathsFromJs();

  const exemptPrefix = (p) => {
    const x = p.replace(/\\/g, "/").toLowerCase();
    return (
      x.startsWith("assets/units/") ||
      x.startsWith("assets/guns/") ||
      x.startsWith("assets/ui/")
    );
  };

  const roots = [
    path.join(ROOT, "assets", "tiles"),
    path.join(ROOT, "assets", "obstacles"),
    path.join(ROOT, "assets", "buildings"),
    path.join(ROOT, "assets", "vfx"),
  ];

  const scrapLines = [];
  const archiveDir = path.join(ROOT, "assets", "archive_for_deletion");
  ensureDir(archiveDir);

  async function considerFile(abs, relPosix) {
    if (referencedPaths.has(relPosix.replace(/\\/g, "/").toLowerCase())) return;
    if (exemptPrefix(relPosix)) return;
    const ext = path.extname(abs).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return;
    let w = 0;
    let h = 0;
    try {
      const m = await sharp(abs).metadata();
      w = Math.floor(m.width || 0);
      h = Math.floor(m.height || 0);
    } catch {
      return;
    }
    if (!w || !h) return;
    const ratio = w / h;
    const isStrip = ratio >= STRIP_RATIO || ratio <= 1 / STRIP_RATIO;
    if (isStrip) return;
    if (w >= 128 || h >= 128) return;

    scrapLines.push(relPosix);
    if (ARCHIVE_SCRAPS) {
      const dest = path.join(archiveDir, path.basename(abs));
      const finalDest = uniqueDest(dest);
      fs.renameSync(abs, finalDest);
      scrapLines[scrapLines.length - 1] += ` -> ${posixRel(finalDest)}`;
    }
  }

  async function walk(dir, baseRel) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith(".")) continue;
      const full = path.join(dir, name.name);
      const rel = baseRel ? `${baseRel}/${name.name}` : name.name;
      if (name.isDirectory()) {
        await walk(full, rel);
      } else {
        const posix = `assets/${rel.split(path.sep).join("/")}`;
        await considerFile(full, posix);
      }
    }
  }

  for (const r of roots) {
    await walk(r, path.relative(path.join(ROOT, "assets"), r).split(path.sep).join("/"));
  }

  fs.writeFileSync(
    TRUE_SCRAPS_LIST,
    `# True scraps (<128x128, not units/guns/ui) ${new Date().toISOString()}\n${ARCHIVE_SCRAPS ? "# Archived to assets/archive_for_deletion/\n" : "# Dry list only (re-run with --archive-scraps to move)\n"}${scrapLines.join("\n")}\n`,
    "utf8",
  );

  /** Tier confirmation from manifest */
  let tierBody = `# Tier confirmation ${new Date().toISOString()}\n`;
  if (manifest?.assets) {
    const tilesHigh = manifest.assets.filter(
      (a) => a.type === "tile" && a.tier === "high",
    ).length;
    const buildingsHigh = manifest.assets.filter(
      (a) => a.type === "building" && a.tier === "high",
    ).length;
    const tiles = manifest.assets.filter((a) => a.type === "tile");
    const buildings = manifest.assets.filter((a) => a.type === "building");
    tierBody += `Tiles total: ${tiles.length}, tier "high": ${tilesHigh}\n`;
    tierBody += `Buildings total: ${buildings.length}, tier "high": ${buildingsHigh}\n`;
    const tilesNotInFolder = manifest.assets.filter(
      (a) => a.type === "tile" && a.path && !a.path.includes("/tiles/"),
    );
    if (tilesNotInFolder.length) {
      tierBody += `\n# type=tile but path not under assets/tiles/:\n`;
      for (const a of tilesNotInFolder) tierBody += `${a.path}\n`;
    }
    const buildingsNotInFolder = manifest.assets.filter(
      (a) =>
        a.type === "building" && a.path && !a.path.includes("/buildings/"),
    );
    if (buildingsNotInFolder.length) {
      tierBody += `\n# type=building but path not under assets/buildings/:\n`;
      for (const a of buildingsNotInFolder) tierBody += `${a.path}\n`;
    }
  } else {
    tierBody += "(no manifest)\n";
  }
  fs.writeFileSync(TIER_REPORT, tierBody, "utf8");

  console.log("True scraps listed:", TRUE_SCRAPS_LIST, "count:", scrapLines.length);
  if (ARCHIVE_SCRAPS) console.log("  Archived to assets/archive_for_deletion/");
  console.log("Tier report:", TIER_REPORT);
}

async function main() {
  if (!ARCHIVE_SCRAPS) {
    runRehomeFromLog();
    console.log("\nNext: node tools/catalog_assets.mjs --skip-new-arrivals");
    console.log("Then: node tools/smart_rehome.mjs --archive-scraps");
    return;
  }
  await runArchiveTrueScrapsAndTierReport();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
