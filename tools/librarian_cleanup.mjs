#!/usr/bin/env node
/**
 * Resolution-based isolation + supersession scan for the Asset Librarian.
 * Moves candidates to assets/archive_for_deletion/ (does not permanently delete).
 *
 * @typedef {{ from: string, to: string, reason: string }} MoveEntry
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const TILE_MIN = 256;
const BUILDING_MIN = 512;
/** Wide/tall strips & atlases: do not treat as a single 256 tile for isolation */
const STRIP_RATIO = 2.5;

const SKIP_DIR_NAMES = new Set([
  "New_Arrivals",
  "archive_for_deletion",
  "archive_for_review",
]);

function posixRel(rootAbs, fullAbs) {
  return path.relative(rootAbs, fullAbs).split(path.sep).join("/");
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
    candidate = path.join(dir, `${base}__dup${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

function* walkImages(dir, baseRel = "") {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(baseRel.replace(/\\/g, "/"), e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      yield* walkImages(full, rel);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) yield { full, rel, name: e.name };
    }
  }
}

/**
 * Strip trailing 8-hex hash (librarian-style) and collapse punctuation for matching.
 */
export function normalizeAssetStem(fileName) {
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const noHash = base.replace(/_[0-9a-f]{8}$/i, "");
  return noHash
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Add relaxed stems so e.g. unit_urban_sprite_hd matches unit_urban_sprite */
function addRelaxedStems(set, fileName) {
  let s = normalizeAssetStem(fileName);
  set.add(s);
  const stripped = s.replace(/_(hd|high|new|v2|alt|b|2)$/i, "");
  if (stripped !== s) set.add(stripped);
}

async function measureRaster(absPath) {
  const m = await sharp(absPath).metadata();
  const w = Math.floor(m.width || 0);
  const h = Math.floor(m.height || 0);
  return { w, h, ratio: w > 0 && h > 0 ? w / h : 0 };
}

function pathHasTmpSegment(relFromAssets) {
  const parts = relFromAssets.split("/");
  return parts.some((p) => p === "_tmp" || p.endsWith("_tmp"));
}

function isDirectlyUnderAssets(relFromAssets) {
  return !relFromAssets.includes("/");
}

function classifyPrimaryFolder(relFromAssets) {
  const parts = relFromAssets.split("/");
  if (parts[0] === "tiles") return "tile";
  if (parts[0] === "buildings") return "building";
  if (parts[0] === "obstacles") return "obstacle";
  if (parts[0] === "units") return "unit";
  if (parts[0] === "guns") return "gun";
  return null;
}

function failsThreshold(kind, w, h, ratio, baseName = "") {
  const n = baseName.toLowerCase();
  if (
    /strip|sprite_?sheet|sheet|atlas|animation|walls_floor|objects_|water_coasts|trap_|fire_animation|coasts/i.test(
      n,
    )
  ) {
    return false;
  }
  if (ratio >= STRIP_RATIO || ratio <= 1 / STRIP_RATIO) return false;
  if (kind === "building") return w < BUILDING_MIN || h < BUILDING_MIN;
  return w < TILE_MIN || h < TILE_MIN;
}

/**
 * @param {object} opts
 * @param {string} opts.root - repo root
 * @param {boolean} [opts.includePrimary] - scan assets/obstacles + assets/buildings for sub-HD rasters
 * @param {boolean} [opts.includeTiles] - also scan assets/tiles (aggressive: legacy 64x64 grids will flag)
 * @param {boolean} [opts.dryRun] - report only, no moves
 */
export async function runCleanupIsolate(opts) {
  const {
    root,
    includePrimary = false,
    includeTiles = false,
    dryRun = false,
  } = opts;
  const assetsRoot = path.join(root, "assets");
  const archiveRoot = path.join(assetsRoot, "archive_for_deletion");
  const newArrivals = path.join(assetsRoot, "New_Arrivals");
  /** @type {MoveEntry[]} */
  const moved = [];
  /** @type {string[]} */
  const errors = [];

  ensureDir(archiveRoot);

  /** @type {Set<string>} */
  const newArrivalStems = new Set();
  if (fs.existsSync(newArrivals)) {
    for (const { full, name } of walkImages(newArrivals, "")) {
      try {
        await measureRaster(full);
      } catch {
        /* still index stem for supersession */
      }
      addRelaxedStems(newArrivalStems, name);
    }
  }

  /** @type {{ rel: string, full: string, reason: string }[]} */
  const toMove = [];

  for (const { full } of walkImages(assetsRoot, "")) {
    const relAssets = posixRel(assetsRoot, full);
    if (relAssets.startsWith("archive_for_deletion/")) continue;

    const inRootFile = isDirectlyUnderAssets(relAssets);
    const inTmp = pathHasTmpSegment(relAssets);
    const primaryKind = classifyPrimaryFolder(relAssets);

    let checkResolution = inRootFile || inTmp;
    let resKind = "tile";
    if (inRootFile || inTmp) {
      if (/buildings?\//i.test(relAssets) || /building/i.test(path.basename(full)))
        resKind = "building";
    }
    if (includePrimary && primaryKind && primaryKind !== "unit" && primaryKind !== "gun") {
      if (primaryKind === "tile" && !includeTiles) {
        /* skip ù tactical tree often uses <256 legacy cells unless --include-tiles */
      } else {
        checkResolution = true;
        if (primaryKind === "building") resKind = "building";
        else resKind = "tile";
      }
    }

    if (checkResolution) {
      try {
        const { w, h, ratio } = await measureRaster(full);
        if (failsThreshold(resKind, w, h, ratio, path.basename(full))) {
          const need =
            resKind === "building"
              ? `${BUILDING_MIN}x${BUILDING_MIN}`
              : `${TILE_MIN}x${TILE_MIN}`;
          toMove.push({
            rel: relAssets,
            full,
            reason: `Low resolution (${w}x${h}; need >=${need} for ${resKind})`,
          });
        }
      } catch (e) {
        errors.push(`${relAssets}: measure failed - ${e?.message || e}`);
      }
    }

    if (primaryKind === "unit" || relAssets.startsWith("units/")) {
      const stem = normalizeAssetStem(path.basename(full));
      if (stem && newArrivalStems.has(stem)) {
        toMove.push({
          rel: relAssets,
          full,
          reason: `Superseded (stem "${stem}" matches New_Arrivals after hash/_hd normalization)`,
        });
      }
    }
  }

  const dedupe = new Map();
  for (const item of toMove) {
    dedupe.set(path.resolve(item.full), item);
  }

  for (const item of dedupe.values()) {
    const destRel = item.rel.replace(/^assets\//, "");
    const destAbs = uniqueDest(path.join(archiveRoot, destRel));
    ensureDir(path.dirname(destAbs));
    try {
      if (!dryRun) {
        fs.renameSync(item.full, destAbs);
      }
      const toPath = dryRun
        ? `(dry-run) assets/archive_for_deletion/${posixRel(archiveRoot, destAbs)}`
        : path.posix.join("assets", posixRel(assetsRoot, destAbs));
      moved.push({
        from: path.posix.join("assets", item.rel),
        to: toPath,
        reason: item.reason,
      });
    } catch (e) {
      errors.push(`${item.rel}: move failed - ${e?.message || e}`);
    }
  }

  return { moved, errors, archiveRoot, dryRun };
}

export function formatCleanupReport({
  moved,
  errors,
  dryRun,
  generatedAt,
  keptIngestedNote,
  ingested = [],
}) {
  const lines = [];
  lines.push(`CTU Librarian cleanup report`);
  lines.push(`Generated: ${generatedAt}`);
  lines.push(
    dryRun
      ? `Mode: DRY RUN (no files were moved)`
      : `Mode: LIVE (files moved under assets/archive_for_deletion/)`,
  );
  lines.push("");
  lines.push("=== [MOVED TO DELETION] (isolation folder; not permanently deleted) ===");
  if (!moved.length) lines.push("(none)");
  for (const m of moved) {
    lines.push(`[MOVED TO DELETION]: ${m.from} (Reason: ${m.reason})`);
    lines.push(`    -> ${m.to}`);
  }
  lines.push("");
  lines.push("=== [KEPT / INGESTED] ===");
  if (keptIngestedNote) lines.push(keptIngestedNote);
  for (const row of ingested) {
    const dest = row.to || row.path || "";
    const src = row.from || "";
    lines.push(
      `[KEPT/INGESTED]: ${dest} (Reason: New asset / ingest from ${src})`,
    );
  }
  if (!keptIngestedNote && !ingested.length) {
    lines.push(`[KEPT/INGESTED]: (no rows ù run with --cleanup to merge report with ingest)`);
  }
  if (errors.length) {
    lines.push("");
    lines.push("=== ERRORS ===");
    for (const e of errors) lines.push(e);
  }
  lines.push("");
  return lines.join("\n");
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const root = path.join(__dirname, "..");
  const dryRun = process.argv.includes("--dry-run");
  const includePrimary = process.argv.includes("--include-primary");
  const includeTiles = process.argv.includes("--include-tiles");
  const reportPath = path.join(root, "tools", "cleanup_report.txt");
  runCleanupIsolate({ root, dryRun, includePrimary, includeTiles }).then((r) => {
    const txt = formatCleanupReport({
      moved: r.moved,
      errors: r.errors,
      dryRun: r.dryRun,
      generatedAt: new Date().toISOString(),
      keptIngestedNote:
        "Standalone cleanup scan only (no ingest). Run `node tools/catalog_assets.mjs --cleanup` for full librarian + manifest.",
      ingested: [],
    });
    ensureDir(path.dirname(reportPath));
    fs.writeFileSync(reportPath, txt, "utf8");
    console.log(txt);
    process.exit(r.errors.length ? 1 : 0);
  });
}
