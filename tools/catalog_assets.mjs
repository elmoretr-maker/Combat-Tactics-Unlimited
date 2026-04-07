#!/usr/bin/env node
/**
 * Asset Librarian — scans assets/New_Arrivals/, sorts files into permanent dirs,
 * regenerates js/config/assetManifest.json.
 *
 * New_Arrivals raster ingest is CTU-only: each image must have a sibling `.ctu.asset.json` with a
 * non-unknown `classification.type`. Destination comes from `pipeline.folderLayoutHint` (when valid
 * under assets/) or `suggestedDestRelFromMetadata` + placement-derived theme hints — never from
 * filename or folder path. Rasters without valid CTU are moved to `New_Arrivals/review/`.
 *
 * Run: node tools/catalog_assets.mjs
 *      npm run catalog-assets
 *
 * Flags: --visual-report (write tools/visual_assessment_report.json)
 *        --cleanup | --cleanup-dry-run  (isolate low-res / superseded → assets/archive_for_deletion/)
 *        --cleanup-include-primary  (scan obstacles + buildings; not tiles)
 *        --cleanup-include-tiles    (also scan tiles — aggressive vs legacy 64² cells)
 *        --skip-new-arrivals        (manifest rebuild only; no ingest/promote)
 *        --enforce-ctu-sidecars     (move obstacles/units rasters missing `.ctu.asset.json` → New_Arrivals/review)
 *        --enforce-ctu-sidecars-dry-run  (log only; no moves)
 *
 * Each manifest rebuild writes tools/classification_audit.txt (path, assigned category, reason).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import {
  analyzeImageVisual,
  isGenericFileName,
  planLibrarianRename,
} from "./visual_analysis.mjs";
import {
  runCleanupIsolate,
  formatCleanupReport,
} from "./librarian_cleanup.mjs";
import {
  METADATA_SUFFIX,
  compactPlacementTagsFromSurfaces,
  suggestedDestRelFromMetadata,
} from "./asset_metadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const NEW_ARRIVALS = path.join(ROOT, "assets", "New_Arrivals");
const MANIFEST_PATH = path.join(ROOT, "js", "config", "assetManifest.json");
const VISUAL_REPORT_PATH = path.join(ROOT, "tools", "visual_assessment_report.json");
const LIBRARIAN_LOG_PATH = path.join(ROOT, "tools", "librarian_log.txt");
const CLEANUP_REPORT_PATH = path.join(ROOT, "tools", "cleanup_report.txt");
const CLASSIFICATION_AUDIT_PATH = path.join(ROOT, "tools", "classification_audit.txt");
const FUNCTIONAL_RESCUE_REPORT_PATH = path.join(ROOT, "tools", "functional_rescue_report.txt");

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

const NEW_ARRIVALS_SOURCE_EXT = new Set([
  ".psd",
  ".ai",
  ".eps",
  ".scml",
]);

const ARGS = new Set(process.argv.slice(2));
const FLAG_VISUAL_REPORT = ARGS.has("--visual-report");
/** Move low-res / superseded rasters to assets/archive_for_deletion/ */
const FLAG_CLEANUP = ARGS.has("--cleanup");
const FLAG_CLEANUP_DRY_RUN = ARGS.has("--cleanup-dry-run");
/** Scan assets/obstacles + assets/buildings for sub-HD rasters (not tiles unless below) */
const FLAG_CLEANUP_INCLUDE_PRIMARY = ARGS.has("--cleanup-include-primary");
/** Also scan assets/tiles (flags legacy 64x64 etc.; use only when migrating to 256 grid) */
const FLAG_CLEANUP_INCLUDE_TILES = ARGS.has("--cleanup-include-tiles");
/** Regenerate manifest only (no New_Arrivals ingest / promote) */
const FLAG_SKIP_NEW_ARRIVALS = ARGS.has("--skip-new-arrivals");
/** Move rasters under assets/obstacles + assets/units missing `.ctu.asset.json` to New_Arrivals/review */
const FLAG_ENFORCE_CTU_SIDECARS = ARGS.has("--enforce-ctu-sidecars");
const FLAG_ENFORCE_CTU_SIDECARS_DRY = ARGS.has("--enforce-ctu-sidecars-dry-run");

function obstacleThemeForPalette(theme) {
  if (theme === "desert" || theme === "grass") return theme;
  return "urban";
}

function appendLibrarianLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LIBRARIAN_LOG_PATH, line, "utf8");
}

function manifestBucketLabel(record) {
  const t = record.type;
  if (t === "gun") return `Manifest bucket: gun (${record.gunClass || "?"})`;
  if (t === "building") return `Manifest bucket: building (${record.footprint || "?"})`;
  if (t === "tile") return `Manifest bucket: tile (${record.theme || "?"})`;
  if (t === "obstacle") return `Manifest bucket: obstacle (${record.theme || "?"}, ${record.obstacleKind || "?"})`;
  if (t === "vfx") return `Manifest bucket: vfx (assets/vfx)`;
  if (t === "ui") return `Manifest bucket: ui (${record.uiKind || "?"})`;
  if (t === "unit") {
    const k = record.unitKind === "vehicle" ? "vehicle" : "soldier";
    return `Manifest bucket: unit (${k}, theme ${record.theme || "?"})`;
  }
  return `Manifest bucket: ${t || "unknown"}`;
}

/**
 * Assigned category for audit (manifest record.type; units → "units" label).
 */
function assignedCategoryForAudit(record) {
  if (record.type === "unit") return "units";
  return record.type;
}

function classificationAuditReason(record) {
  const parts = [manifestBucketLabel(record)];
  if (record.metadata === "scrap") parts.push('metadata: "scrap"');
  if (record.tier === "high") parts.push('tier: "high"');
  return parts.join(" | ");
}

function writeClassificationAudit(assets, generatedAt) {
  const lines = [
    "# CTU Librarian — classification audit",
    `# generatedAt: ${generatedAt}`,
    "# Path | Assigned category | Reason",
    "",
  ];
  const sorted = [...assets].sort((a, b) => (a.path || "").localeCompare(b.path || ""));
  for (const a of sorted) {
    const p = a.path || "";
    const cat = assignedCategoryForAudit(a);
    const reason = classificationAuditReason(a);
    lines.push(`${p}\t${cat}\t${reason}`);
  }
  const sourceRows = collectNewArrivalsSourceInventoryLines();
  if (sourceRows.length) {
    lines.push(
      "",
      "## New_Arrivals — source formats (not moved by ingest; export PNG/WebP/TIFF to ingest)",
      "",
    );
    lines.push(...sourceRows);
  }
  fs.mkdirSync(path.dirname(CLASSIFICATION_AUDIT_PATH), { recursive: true });
  fs.writeFileSync(CLASSIFICATION_AUDIT_PATH, `${lines.join("\n")}\n`, "utf8");
}

/* ── Gun classification (filename + relative path, case-insensitive) ─────────
 * Order matters: evaluate machine gun before rifle (e.g. "machine" contains no "rifle"
 * but SMG/LMG patterns are specific).
 *
 * 1) machine_gun — machine gun, SMG, LMG, HMG, minigun, SAW, common MG model tokens
 * 2) handgun     — pistol, revolver, handgun, sidearm, well-known pistol families
 * 3) rifle       — rifle, sniper, carbine, DMR, AR/AK patterns
 * 4) Subfolder hints: .../rifle/..., .../handgun/..., .../machine_gun/...
 * 5) Default     — rifle (long-gun assumption for ambiguous weapon art)
 */
function classifyGunClass(fileName, relDirFromNewArrivals) {
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  if (
    /\b(machine[\s_-]*gun|machinegun|minigun|gatling|submachine|sub[\s_-]*machine|\bsmg\b|\blmg\b|\bhmg\b|m249|m240|m60|pkm|saw\b|sten|uzi|mp5|mp7|p90|vector|thompson)\b/i.test(
      base,
    )
  ) {
    return "machine_gun";
  }
  if (
    /\b(handgun|pistol|revolver|sidearm|glock|beretta|m1911|1911|desert[\s_-]*eagle|\bdeagle\b|walther|makarov)\b/i.test(
      base,
    )
  ) {
    return "handgun";
  }
  if (
    /\b(rifle|sniper|carbine|dmr|\bar[\s_-]*15\b|\bak[\s_-]*47\b|bolt[\s_-]*action|lever[\s_-]*action|shotgun)\b/i.test(
      base,
    )
  ) {
    return "rifle";
  }
  if (/^gun[_\s-]/i.test(base) || /[_\s-]gun[_\s-]/i.test(base) || /^gun\d/i.test(base)) {
    return "rifle";
  }

  const s = `${relDirFromNewArrivals}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)rifles?(\/|$)/i.test(s) || /\/rifle\//i.test(s)) return "rifle";
  if (/(^|\/)handguns?(\/|$)|\/pistol\//i.test(s)) return "handgun";
  if (/(^|\/)machine[\s_-]*guns?(\/|$)|\/smg\/|\/lmg\//i.test(s)) return "machine_gun";

  return "rifle";
}

function classifyBuildingFootprint(fileName, relDir) {
  const s = `${relDir}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (/\b(bunker|fort\b|fortress|citadel|bastion|redoubt|keep\b|castle|curtain[\s_-]*wall|defensive)\b/.test(s)) {
    return "fortified";
  }
  if (/\b(warehouse|mansion|tower|complex|hangar|factory|arena|skyscraper|apartment)\b/.test(s)) {
    return "large";
  }
  if (/\b(small|shack|hut|shed|booth|kiosk|tiny)\b/.test(s)) {
    return "small";
  }
  if (/\b(medium|house|cabin|office|shop|store|garage|building)\b/.test(s)) {
    return "medium";
  }
  if (/\/small\//i.test(s)) return "small";
  if (/\/large\//i.test(s)) return "large";
  if (/\/fortified\//i.test(s)) return "fortified";
  return "medium";
}

function classifyTileTheme(fileName, relDir) {
  const s = `${relDir}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (/\b(desert|sand|dune|arid|sahara|badlands|mesa|dust)\b/.test(s)) return "desert";
  if (/\b(urban|city|street|concrete|brick|asphalt|pavement|downtown|metro)\b/.test(s)) {
    return "urban";
  }
  if (/\/desert\//i.test(s)) return "desert";
  if (/\/urban\//i.test(s)) return "urban";
  return "urban";
}

function classifyObstacleKind(fileName) {
  const s = fileName.toLowerCase();
  if (/_strip_|obstacle_[^_]+_strip_/i.test(fileName)) return "strip";
  if (/\btree|bush|palm|pine\b/.test(s)) return "tree";
  if (/\bcrate|box\b/.test(s)) return "crate";
  if (/\bbarrel\b/.test(s)) return "barrel";
  if (/\bruin|ruins|rubble|wreck\b/.test(s)) return "ruins";
  if (/\brock|boulder|stone\b/.test(s)) return "ruins";
  return "crate";
}

/** Interior / scatter policy for obstacle props (manifest + generator). */
function classifyPlacementRuleFromFileName(fileName) {
  const s = fileName.toLowerCase();
  if (/\b(debris|wreck|scrap|junk)\b/.test(s)) return "debris";
  if (/\b(bed|bookcase|bookshelf|desk|shelf|wardrobe|dresser|cabinet)\b/.test(s)) {
    return "wall_anchored";
  }
  if (/\b(table|rug|carpet|chair|sofa|couch|ottoman|stool)\b/.test(s)) {
    return "central";
  }
  return null;
}

function applyTileFlowConnectorHints(record) {
  const n = record.fileName || "";
  if (!/waterstrip|water_strip|riverstrip|river_strip|roadstrip|road_strip|flowconnector/i.test(n)) {
    return;
  }
  record.flowConnector = true;
  record.flowKind = /roadstrip|road_strip|cp_road/i.test(n) ? "road" : "water";
  const tags = new Set(record.tags || []);
  tags.add("flowConnector");
  record.tags = [...tags];
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
    candidate = path.join(dir, `${base}_${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

const REVIEW_DIR_FOR_CTU_ENFORCE = path.join(NEW_ARRIVALS, "review");

/**
 * Strict CTU: rasters without a sibling `.ctu.asset.json` cannot stay in scatter paths.
 */
function enforceCtuSidecarsToReview() {
  const dry = FLAG_ENFORCE_CTU_SIDECARS_DRY;
  const roots = [path.join(ROOT, "assets", "obstacles"), path.join(ROOT, "assets", "units")];
  let moved = 0;
  ensureDir(REVIEW_DIR_FOR_CTU_ENFORCE);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const { full, name } of walkFiles(root, "")) {
      const ext = path.extname(name);
      const base = full.slice(0, -ext.length);
      const sidecar = `${base}${METADATA_SUFFIX}`;
      if (fs.existsSync(sidecar)) continue;
      const relFrom = posixRel(full);
      if (dry) {
        console.log("[catalog][enforce-ctu dry-run] missing sidecar → would move:", relFrom);
        continue;
      }
      const dest = uniqueDest(path.join(REVIEW_DIR_FOR_CTU_ENFORCE, name));
      fs.renameSync(full, dest);
      appendLibrarianLog(`ENFORCE_CTU missing sidecar → review: ${relFrom} → ${posixRel(dest)}`);
      moved += 1;
    }
  }
  if (dry || moved) {
    console.log(
      `[catalog] enforce CTU sidecars: ${dry ? "dry-run (no moves)" : `moved ${moved} file(s)`}`,
    );
  }
}

function* walkFiles(dir, baseRel = "") {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn("[catalog] skip unreadable dir:", dir, err?.code || err?.message || err);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "README.md") continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(baseRel.replace(/\\/g, "/"), e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full, rel);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) yield { full, rel, name: e.name };
    }
  }
}

/** All files under New_Arrivals (for source-format audit; skips dotfiles + README). */
function* walkNewArrivalsAllFiles(dir, baseRel = "") {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn("[catalog] skip unreadable dir:", dir, err?.code || err?.message || err);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "README.md") continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(baseRel.replace(/\\/g, "/"), e.name);
    if (e.isDirectory()) {
      yield* walkNewArrivalsAllFiles(full, rel);
    } else if (e.isFile()) {
      yield { full, rel, name: e.name };
    }
  }
}

function collectNewArrivalsSourceInventoryLines() {
  const rows = [];
  for (const { rel, name } of walkNewArrivalsAllFiles(NEW_ARRIVALS, "")) {
    const ext = path.extname(name).toLowerCase();
    if (NEW_ARRIVALS_SOURCE_EXT.has(ext)) {
      rows.push(`New_Arrivals/${rel}\t${ext}\tsource asset (not raster-ingested)`);
    }
  }
  return rows.sort();
}

function posixRel(fromRootAbs) {
  return path.relative(ROOT, fromRootAbs).split(path.sep).join("/");
}

/**
 * When present, `record.ctu` is authoritative for placement/behavior vs folder-derived manifest fields.
 */
function mergeCtuSidecarIntoRecord(record, imageAbsPath) {
  const ext = path.extname(imageAbsPath);
  const base = ext ? imageAbsPath.slice(0, -ext.length) : imageAbsPath;
  const sidecarPath = `${base}${METADATA_SUFFIX}`;
  try {
    if (!fs.existsSync(sidecarPath)) return;
    const side = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    if (!side || typeof side !== "object") return;
    let placement = side.placement;
    if (placement && typeof placement === "object" && !Array.isArray(placement)) {
      const legacy = placement.allowedSurfaces;
      if (Array.isArray(legacy)) placement = compactPlacementTagsFromSurfaces(legacy);
    }
    if (Array.isArray(placement) && placement.length === 0) {
      placement = compactPlacementTagsFromSurfaces([]);
    }
    record.ctu = {
      schemaVersion: side.schemaVersion,
      classification: side.classification,
      placement,
      behavior: side.behavior,
      rulesApplied: side.rulesApplied,
      clipSuggestions: side.clipSuggestions,
      pipeline: side.pipeline,
    };
  } catch {
    /* ignore missing or invalid sidecar */
  }
}

/** relRoot as passed to collectAssetsUnder, e.g. "assets/obstacles" (no trailing slash). */
function assetBucket(relRoot) {
  const n = relRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (n === "assets/guns" || n.startsWith("assets/guns/")) return "guns";
  if (n === "assets/buildings" || n.startsWith("assets/buildings/")) return "buildings";
  if (n === "assets/tiles" || n.startsWith("assets/tiles/")) return "tiles";
  if (n === "assets/obstacles" || n.startsWith("assets/obstacles/")) return "obstacles";
  if (n === "assets/vfx" || n.startsWith("assets/vfx/")) return "vfx";
  if (n === "assets/ui" || n.startsWith("assets/ui/")) return "ui";
  if (n === "assets/units" || n.startsWith("assets/units/")) return "units";
  return null;
}

/**
 * One-time fix: earlier runs misclassified tile sheets / UI as obstacles.
 * Moves matching files from assets/obstacles/{theme}/ → tiles or ui/buttons.
 */
function promoteMisfiledFromObstacles() {
  const promoted = [];
  const uiName = (name) => /picsart|preview\.png$/i.test(name) || /\bbutton\b/i.test(name);

  const isTileSheetName = (name) =>
    /walls_floor|decorative_cracks|doors_lever|trap_|fire_animation|water_|Water_coasts|water_detil|water_details|Objects\.png|Bridges\.png|^Objects_/i.test(
      name,
    );

  for (const theme of ["urban", "desert", "grass"]) {
    const dir = path.join(ROOT, "assets", "obstacles", theme);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;

      if (uiName(name)) {
        const destDir = path.join(ROOT, "assets", "ui", "buttons");
        ensureDir(destDir);
        const dest = uniqueDest(path.join(destDir, name));
        fs.renameSync(full, dest);
        promoted.push({ from: `assets/obstacles/${theme}/${name}`, to: posixRel(dest) });
        continue;
      }
      if (isTileSheetName(name)) {
        const destDir = path.join(ROOT, "assets", "tiles", theme);
        ensureDir(destDir);
        const dest = uniqueDest(path.join(destDir, name));
        fs.renameSync(full, dest);
        promoted.push({ from: `assets/obstacles/${theme}/${name}`, to: posixRel(dest) });
      }
    }
  }
  return promoted;
}

/**
 * Re-home obstacle rasters that are clearly vehicles (mis-ingested tmp packs, etc.).
 * Only filenames/paths containing vehicle/tank/plane tokens are moved — UUID-only
 * Obstacle_* names cannot be recovered without re-dropping into New_Arrivals.
 */
function promoteVehiclesFromObstacles() {
  const promoted = [];
  const delim = (name, fullRel) => {
    const base = path.basename(name, path.extname(name)).toLowerCase();
    const s = `${fullRel}/${name}`.replace(/\\/g, "/").toLowerCase();
    const tok = (re) => re.test(base) || re.test(s);
    return (
      tok(/(^|[_\-.])(vehicle|tank|plane)([_\-.]|$)/i) ||
      /\b(vehicle|tank|plane)\b/.test(s) ||
      /tmp_vehicle|vehicle_cell/i.test(s)
    );
  };

  const destDir = path.join(ROOT, "assets", "units", "vehicles");
  ensureDir(destDir);

  for (const theme of ["urban", "desert", "grass"]) {
    const dir = path.join(ROOT, "assets", "obstacles", theme);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      if (!delim(name, `assets/obstacles/${theme}`)) continue;

      const dest = uniqueDest(path.join(destDir, name));
      fs.renameSync(full, dest);
      promoted.push({
        from: `assets/obstacles/${theme}/${name}`,
        to: posixRel(dest),
      });
      appendLibrarianLog(
        `PROMOTE vehicle keyword: assets/obstacles/${theme}/${name} → ${posixRel(dest)}`,
      );
    }
  }
  return promoted;
}

/** Theme subfolder hint from CTU `placement` tags only (no path inference). */
function themeHintFromCtuPlacement(ctu) {
  let p = ctu?.placement;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const legacy = p.allowedSurfaces;
    if (Array.isArray(legacy)) p = compactPlacementTagsFromSurfaces(legacy);
    else p = null;
  }
  if (!Array.isArray(p)) return null;
  if (p.includes("desert")) return "desert";
  if (p.includes("grass")) return "grass";
  if (p.includes("urban")) return "urban";
  if (p.includes("interior")) return "urban";
  if (p.includes("land") || p.includes("any")) return "urban";
  return null;
}

/** Optional `pipeline.folderLayoutHint` to absolute dir under `assets/`. */
function safeFolderLayoutHintDir(ctu) {
  const hint = ctu?.pipeline?.folderLayoutHint;
  if (typeof hint !== "string") return null;
  const h = hint.replace(/\\/g, "/").trim().replace(/\/+$/, "");
  if (!h.startsWith("assets/") || h.includes("..")) return null;
  const abs = path.normalize(path.join(ROOT, ...h.split("/")));
  const assetsRoot = path.normalize(path.join(ROOT, "assets"));
  if (abs !== assetsRoot && !abs.startsWith(assetsRoot + path.sep)) return null;
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return path.dirname(abs);
  } catch {
    return null;
  }
  return abs;
}

function ingestDestDirFromCtu(ctu) {
  const fromHint = safeFolderLayoutHintDir(ctu);
  if (fromHint) return fromHint;
  const theme = themeHintFromCtuPlacement(ctu) || "urban";
  const rel = suggestedDestRelFromMetadata({ classification: ctu.classification }, theme);
  return path.normalize(path.join(ROOT, ...rel.split("/")));
}

/** New_Arrivals raster ingest: sibling `.ctu.asset.json` required; no path/filename classification. */
async function ingestNewArrivals() {
  ensureDir(NEW_ARRIVALS);
  ensureDir(path.dirname(LIBRARIAN_LOG_PATH));
  ensureDir(REVIEW_DIR_FOR_CTU_ENFORCE);
  const moves = [];
  for (const { full, rel, name } of walkFiles(NEW_ARRIVALS, "")) {
    const relPosix = rel.replace(/\\/g, "/");
    if (relPosix === "review" || relPosix.startsWith("review/")) continue;

    const ext = path.extname(name).toLowerCase();
    const sidecarPath = `${full.slice(0, -ext.length)}${METADATA_SUFFIX}`;
    const hadSidecarFile = fs.existsSync(sidecarPath);

    let ctu = null;
    let ctuOk = false;
    if (hadSidecarFile) {
      try {
        ctu = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
        ctuOk = Boolean(ctu && typeof ctu === "object");
      } catch {
        ctu = null;
        ctuOk = false;
      }
    }

    const type = ctuOk ? ctu.classification?.type : null;
    const typeOk = Boolean(type && type !== "unknown");

    if (!ctuOk || !typeOk) {
      const dest = uniqueDest(path.join(REVIEW_DIR_FOR_CTU_ENFORCE, name));
      fs.renameSync(full, dest);
      if (hadSidecarFile && fs.existsSync(sidecarPath)) {
        const sideDest = uniqueDest(path.join(REVIEW_DIR_FOR_CTU_ENFORCE, path.basename(sidecarPath)));
        fs.renameSync(sidecarPath, sideDest);
      }
      const why = !hadSidecarFile ? "missing_ctu_sidecar" : !ctuOk ? "invalid_ctu_json" : "ctu_classification_unknown";
      appendLibrarianLog(`INGEST review (${why}): New_Arrivals/${rel} -> ${posixRel(dest)}`);
      moves.push({ from: `New_Arrivals/${rel}`, to: posixRel(dest), meta: { reason: why } });
      continue;
    }

    let destDir;
    try {
      destDir = ingestDestDirFromCtu(ctu);
    } catch (err) {
      const dest = uniqueDest(path.join(REVIEW_DIR_FOR_CTU_ENFORCE, name));
      fs.renameSync(full, dest);
      if (fs.existsSync(sidecarPath)) {
        const sideDest = uniqueDest(path.join(REVIEW_DIR_FOR_CTU_ENFORCE, path.basename(sidecarPath)));
        fs.renameSync(sidecarPath, sideDest);
      }
      appendLibrarianLog(
        `INGEST review (dest_resolution_error): New_Arrivals/${rel} -> ${posixRel(dest)} | ${err?.message || err}`,
      );
      moves.push({
        from: `New_Arrivals/${rel}`,
        to: posixRel(dest),
        meta: { reason: "dest_resolution_error" },
      });
      continue;
    }

    ensureDir(destDir);
    let destPath = path.join(destDir, name);
    destPath = uniqueDest(destPath);
    fs.renameSync(full, destPath);

    const newSidecarPath = `${destPath.slice(0, -ext.length)}${METADATA_SUFFIX}`;
    if (fs.existsSync(sidecarPath) && path.resolve(sidecarPath) !== path.resolve(newSidecarPath)) {
      fs.renameSync(sidecarPath, newSidecarPath);
    }

    const hintUsed = Boolean(safeFolderLayoutHintDir(ctu));
    const reasoning = [
      `CTU ingest type=${type} subtype=${ctu.classification?.subtype ?? "?"}`,
      hintUsed ? "folderLayoutHint" : "suggestedDest",
      posixRel(destDir),
    ];
    appendLibrarianLog(`MOVE New_Arrivals/${rel} -> ${posixRel(destPath)} || ${reasoning.join(" || ")}`);
    moves.push({
      from: `New_Arrivals/${rel}`,
      to: posixRel(destPath),
      meta: { ctuIngest: true, classification: ctu.classification },
    });
  }
  return moves;
}

function collectAssetsUnder(relRoot) {
  const abs = path.join(ROOT, relRoot);
  const out = [];
  if (!fs.existsSync(abs)) return out;
  for (const { full, name } of walkFiles(abs, "")) {
    const rel = posixRel(full);
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    let record = {
      id: rel.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
      path: rel,
      fileName: name,
      ext: ext.slice(1),
    };

    const bucket = assetBucket(relRoot);
    if (bucket === "guns") {
      const gunClass = rel.split("/")[2];
      record.type = "gun";
      record.gunClass = gunClass;
      record.theme = null;
      record.footprint = null;
      record.tags = ["gun", gunClass];
    } else if (bucket === "buildings") {
      const pathSeg = rel.split("/")[2];
      const footprint =
        pathSeg === "urban"
          ? classifyBuildingFootprint(name, rel)
          : pathSeg;
      record.type = "building";
      record.footprint = footprint;
      record.theme = inferBuildingTheme(name);
      record.tags = ["building", footprint, record.theme].filter(Boolean);
    } else if (bucket === "tiles") {
      const theme = rel.split("/")[2];
      record.type = "tile";
      record.theme = theme;
      record.footprint = null;
      record.tags = ["tile", theme];
      applyTileFlowConnectorHints(record);
    } else if (bucket === "obstacles") {
      const theme = rel.split("/")[2];
      record.type = "obstacle";
      record.theme = theme;
      record.obstacleKind = classifyObstacleKind(name);
      record.footprint = null;
      record.tags = ["obstacle", theme, record.obstacleKind];
      const pr = classifyPlacementRuleFromFileName(name);
      if (pr) {
        record.placementRule = pr;
        record.tags = [...record.tags, `placement:${pr}`];
      }
    } else if (bucket === "vfx") {
      record.type = "vfx";
      record.theme = null;
      record.footprint = null;
      record.tags = ["vfx", "mapgenExcluded"];
    } else if (bucket === "ui") {
      const uiKind = rel.split("/")[2] || "misc";
      record.type = "ui";
      record.uiKind = uiKind;
      record.tags = ["ui", uiKind];
      record.theme = null;
      record.footprint = null;
    } else if (bucket === "units") {
      const ut = rel.split("/")[2] || "urban";
      if (ut === "vehicles") {
        record.type = "unit";
        record.unitKind = "vehicle";
        record.theme = obstacleThemeForPalette(classifyTileTheme(name, ""));
        record.footprint = null;
        record.gunClass = null;
        record.tags = ["unit", "vehicle", record.theme, "mapSprite"];
      } else {
        record.type = "unit";
        record.unitKind = "soldier";
        record.theme = ut;
        record.footprint = null;
        record.gunClass = null;
        record.tags = ["unit", ut, "mapSprite"];
      }
    } else {
      continue;
    }
    mergeCtuSidecarIntoRecord(record, full);
    out.push(record);
  }
  return out;
}

function inferBuildingTheme(fileName) {
  const s = fileName.toLowerCase();
  if (/\b(desert|sand|adobe)\b/.test(s)) return "desert";
  if (/\b(urban|city|street|brick)\b/.test(s)) return "urban";
  return "urban";
}

const DEFAULT_FOUNDATION_HINTS = {
  urban: {
    baseTerrain: "cp_grass",
    roadTerrain: "cp_road",
    dividerTerrain: "water",
  },
  desert: {
    baseTerrain: "desert",
    roadTerrain: "road",
    dividerTerrain: "water",
  },
  grass: {
    baseTerrain: "plains",
    roadTerrain: "road",
    dividerTerrain: "water",
  },
};

const LEGACY_CRAFTPIX_OBSTACLES = [
  {
    kind: "tree",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Trees Bushes/TDS04_0022_Tree1.png",
    tags: ["urban", "obstacle", "tree"],
  },
  {
    kind: "ruins",
    sprite:
      "attached_assets/craftpix_pack/city/PNG City 2/broken_small_houses/Elements/small_house1_carcass1.png",
    tags: ["urban", "obstacle", "ruins"],
  },
  {
    kind: "crate",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Crates Barrels/TDS04_0018_Box1.png",
    tags: ["urban", "obstacle", "crate"],
  },
  {
    kind: "barrel",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Crates Barrels/TDS04_0016_Barrel.png",
    tags: ["urban", "obstacle", "barrel"],
  },
];

/** Procedural mapgen pools: high-tier terrain/buildings/obstacles only; flow connectors stay eligible when not legacy. */
function includeInProceduralTileIndex(a) {
  return a.tier === "high" || a.flowConnector === true;
}

function includeInProceduralBuildingObstacleIndex(a) {
  return a.tier === "high";
}

function buildIndex(assets) {
  const index = {
    guns: { handgun: [], rifle: [], machine_gun: [] },
    buildings: { small: [], medium: [], large: [], fortified: [] },
    tiles: { desert: [], urban: [], grass: [] },
    unitsByTheme: { urban: [], desert: [], grass: [] },
    vehicles: [],
    obstaclesByTheme: { urban: [], desert: [], grass: [] },
    interiorFurnitureByTheme: { urban: [], desert: [], grass: [] },
    buildingsByThemeFootprint: {
      urban: { small: [], medium: [], large: [], fortified: [] },
      desert: { small: [], medium: [], large: [], fortified: [] },
      grass: { small: [], medium: [], large: [], fortified: [] },
    },
  };

  for (const a of assets) {
    if (a.type === "gun" && index.guns[a.gunClass]) {
      index.guns[a.gunClass].push(a.path);
    }
    if (
      a.type === "building" &&
      index.buildings[a.footprint] &&
      includeInProceduralBuildingObstacleIndex(a)
    ) {
      index.buildings[a.footprint].push(a.path);
      const th = a.theme || "urban";
      if (index.buildingsByThemeFootprint[th]?.[a.footprint]) {
        index.buildingsByThemeFootprint[th][a.footprint].push(a.path);
      }
    }
    if (a.type === "tile") {
      const th = a.theme && index.tiles[a.theme] ? a.theme : "urban";
      if (includeInProceduralTileIndex(a) && a.tier !== "legacy") {
        index.tiles[th].push(a.path);
      }
    }
    if (a.type === "unit") {
      if (a.unitKind === "vehicle") {
        index.vehicles.push(a.path);
      } else {
        const ut = a.theme && index.unitsByTheme[a.theme] ? a.theme : "urban";
        index.unitsByTheme[ut].push(a.path);
      }
    }
    if (
      a.type === "obstacle" &&
      index.obstaclesByTheme[a.theme] &&
      includeInProceduralBuildingObstacleIndex(a)
    ) {
      const entry = {
        kind: a.obstacleKind,
        sprite: a.path,
        tags: a.tags,
        placementRule: a.placementRule,
      };
      const pr = a.placementRule;
      if (pr === "wall_anchored" || pr === "central") {
        const th = a.theme && index.interiorFurnitureByTheme[a.theme] ? a.theme : "urban";
        index.interiorFurnitureByTheme[th].push(entry);
      } else {
        index.obstaclesByTheme[a.theme].push(entry);
      }
    }
  }

  for (const th of ["urban", "desert", "grass"]) {
    if (!index.obstaclesByTheme[th].length) {
      index.obstaclesByTheme[th] = LEGACY_CRAFTPIX_OBSTACLES.map((o) => ({ ...o }));
    }
  }

  return index;
}

function scanUnmappedRoots() {
  const attached = path.join(ROOT, "attached_assets");
  const notes = [];
  if (!fs.existsSync(attached)) return notes;
  for (const name of fs.readdirSync(attached, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (name.name.startsWith(".")) continue;
    const rel = `attached_assets/${name.name}`;
    notes.push({
      path: rel,
      note: "Pack not managed by assets/ librarian; reference manually or symlink into assets/New_Arrivals for ingestion.",
    });
  }
  return notes;
}

/* ── Functional Asset Brain: shield, physical re-home, archive rescue ───── */

/** Stem (lowercase, no ext): frame/anim/icon/btn/button, or `fx` / `ui` / `vfx` as tokens (avoids e.g. "affix", "quit"). */
function stemMatchesFunctionalKeyword(stemLower) {
  if (!stemLower) return false;
  if (/frame|anim|icon|btn|button/.test(stemLower)) return true;
  if (/(^|[^a-z0-9])fx([^a-z0-9]|$)/i.test(stemLower)) return true;
  if (/(^|[^a-z0-9])ui([^a-z0-9]|$)/i.test(stemLower)) return true;
  if (/(^|[^a-z0-9])vfx([^a-z0-9]|$)/i.test(stemLower)) return true;
  return false;
}

/** Path or basename (lowercase) is shielded from scrap; small assets may be re-homed from tiles/obstacles. */
function isFunctionalShield(posixPath, stemLower) {
  const p = posixPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("assets/ui/") || p.includes("assets/vfx/")) return true;
  const segs = p.split("/").filter(Boolean);
  if (segs.some((s) => s === "icons" || s === "buttons")) return true;
  return stemMatchesFunctionalKeyword(stemLower);
}

function functionalUiSubfolder(baseLower) {
  if (baseLower.includes("btn") || baseLower.includes("button")) return "buttons";
  if (baseLower.includes("icon")) return "panels";
  return "panels";
}

function isVfxName(baseLower) {
  return /explosion|flame|flash|smoke/.test(baseLower);
}

/** Final `_` + digits before extension only; 2–4 digits (avoids UUID hashes like `_28744415`). */
function isAnimationFrameName(baseLower) {
  const stem = baseLower.replace(/\.(png|webp|gif|jpe?g|bmp)$/i, "");
  const m = stem.match(/_(\d+)$/);
  if (!m) return false;
  const len = m[1].length;
  return len >= 2 && len <= 4;
}

function shouldMoveFunctionalFromBattleFolder(posix, baseLower) {
  const p = posix.replace(/\\/g, "/").toLowerCase();
  if (!/^assets\/(tiles|obstacles)\//.test(p)) return false;
  const segs = p.split("/").filter(Boolean);
  if (segs.includes("icons") || segs.includes("buttons")) return true;
  if (!isFunctionalShield(posix, baseLower)) return false;
  return stemMatchesFunctionalKeyword(baseLower);
}

/** Map-scale sprite strips / terrain animations: never physically re-home (still shielded from scrap). */
function isLikelyTerrainOrMapAnimationFile(name) {
  return /walls_floor|decorative_cracks|doors_lever|trap_|fire_animation|water_details|^water_|^Water_animation|Water_coasts|water_detil|Objects\.png|Bridges\.png|^Objects_/i.test(
    name,
  );
}

function destRootForFunctionalMisplaced(baseLower) {
  if (isVfxName(baseLower) || isAnimationFrameName(baseLower)) {
    return path.join(ROOT, "assets", "vfx");
  }
  return path.join(ROOT, "assets", "ui", functionalUiSubfolder(baseLower));
}

function archiveRescueDestination(baseName) {
  const bl = baseName.toLowerCase();
  const stem = path.basename(baseName, path.extname(baseName)).toLowerCase();
  if (isVfxName(bl) || isAnimationFrameName(bl)) return path.join(ROOT, "assets", "vfx");
  if (stemMatchesFunctionalKeyword(stem)) {
    return path.join(ROOT, "assets", "ui", functionalUiSubfolder(bl));
  }
  return null;
}

const STRIP_RATIO_TIER = 3;
const TILE_HD = 256;
const BUILDING_HD = 512;

/**
 * @returns {Promise<{ moves: { from: string; to: string; w: number; h: number; reason: string }[] }>}
 */
async function runFunctionalPhysicalPipeline() {
  const moves = [];

  async function moveOne(absFrom, reason) {
    const ext = path.extname(absFrom).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return;
    if (!fs.existsSync(absFrom) || !fs.statSync(absFrom).isFile()) return;
    let w = 0;
    let h = 0;
    try {
      const m = await sharp(absFrom).metadata();
      w = Math.floor(m.width || 0);
      h = Math.floor(m.height || 0);
    } catch {
      return;
    }
    const base = path.basename(absFrom);
    const destDir = destRootForFunctionalMisplaced(base.toLowerCase());
    ensureDir(destDir);
    let destPath = path.join(destDir, base);
    destPath = uniqueDest(destPath);
    fs.renameSync(absFrom, destPath);
    const fromPosix = posixRel(absFrom);
    const toPosix = posixRel(destPath);
    moves.push({ from: fromPosix, to: toPosix, w, h, reason });
    appendLibrarianLog(`FUNCTIONAL re-home ${fromPosix} -> ${toPosix} | ${reason}`);
  }

  for (const bucket of ["tiles", "obstacles"]) {
    for (const th of ["urban", "desert", "grass"]) {
      const dir = path.join(ROOT, "assets", bucket, th);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const ext = path.extname(name).toLowerCase();
        if (!IMAGE_EXT.has(ext)) continue;
        const full = path.join(dir, name);
        if (!fs.statSync(full).isFile()) continue;
        const posix = posixRel(full);
        const baseL = path.basename(name, ext).toLowerCase();
        if (!shouldMoveFunctionalFromBattleFolder(posix, baseL)) continue;
        if (isLikelyTerrainOrMapAnimationFile(name)) continue;

        let w = 0;
        let h = 0;
        try {
          const m = await sharp(full).metadata();
          w = Math.floor(m.width || 0);
          h = Math.floor(m.height || 0);
        } catch {
          continue;
        }
        if (!w || !h) continue;
        const ratio = w / h;
        const isStrip =
          ratio >= STRIP_RATIO_TIER || ratio <= 1 / STRIP_RATIO_TIER;
        if (isStrip) continue;

        const pLower = posix.replace(/\\/g, "/").toLowerCase();
        const segs = pLower.split("/").filter(Boolean);
        const inIconsPath =
          segs.includes("icons") || segs.includes("buttons");
        const maxDim = Math.max(w, h);
        /* Small misfiled HUD/icons only; large rasters stay as terrain/obstacles. */
        if (!inIconsPath && maxDim > 256) continue;

        await moveOne(full, `functional misfiled (${bucket}/${th})`);
      }
    }
  }

  const archiveDir = path.join(ROOT, "assets", "archive_for_deletion");
  if (fs.existsSync(archiveDir)) {
    for (const name of fs.readdirSync(archiveDir)) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      const full = path.join(archiveDir, name);
      if (!fs.statSync(full).isFile()) continue;
      const bl = name.toLowerCase();
      const stem = path.basename(name, ext).toLowerCase();
      const rescue =
        isVfxName(bl) ||
        isAnimationFrameName(bl) ||
        /^(explosion|flame|flash|smoke)/i.test(stem) ||
        stemMatchesFunctionalKeyword(stem);
      if (!rescue) continue;
      const destRoot = archiveRescueDestination(name);
      if (!destRoot) continue;
      ensureDir(destRoot);
      let destPath = path.join(destRoot, name);
      destPath = uniqueDest(destPath);
      let w = 0;
      let h = 0;
      try {
        const m = await sharp(full).metadata();
        w = Math.floor(m.width || 0);
        h = Math.floor(m.height || 0);
      } catch {
        /* ok */
      }
      fs.renameSync(full, destPath);
      const toPosix = posixRel(destPath);
      moves.push({
        from: `assets/archive_for_deletion/${name}`,
        to: toPosix,
        w,
        h,
        reason: "archive rescue (animation / UI / VFX)",
      });
      appendLibrarianLog(`ARCHIVE RESCUE ${name} -> ${toPosix}`);
    }
  }

  return { moves };
}

function writeFunctionalRescueReport(moves, generatedAt) {
  const lines = [
    "# CTU Functional Asset Brain — rescue & re-home report",
    `# generatedAt: ${generatedAt}`,
    "",
    "## 64x64 assets re-homed (UI / animation / functional)",
    "",
  ];
  const sixFour = moves.filter((m) => m.w === 64 && m.h === 64);
  if (!sixFour.length) {
    lines.push("(none this run)");
  } else {
    for (const m of sixFour) {
      lines.push(`${m.from}\t->\t${m.to}\t|\t${m.reason}`);
    }
  }
  lines.push("", "## All functional moves this run (any size)", "");
  for (const m of moves) {
    lines.push(`${m.w}x${m.h}\t${m.from}\t->\t${m.to}\t|\t${m.reason}`);
  }
  fs.mkdirSync(path.dirname(FUNCTIONAL_RESCUE_REPORT_PATH), { recursive: true });
  fs.writeFileSync(FUNCTIONAL_RESCUE_REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
}

function isSquarePo2HighTier(w, h) {
  return w === h && [128, 256, 512].includes(w);
}

async function enrichSpriteSheetMetadata(assets) {
  for (const a of assets) {
    const extl = (a.ext || "").toLowerCase();
    if (!["png", "webp", "gif", "tif", "tiff"].includes(extl)) continue;
    const fp = path.join(ROOT, a.path.split("/").join(path.sep));
    if (!fs.existsSync(fp)) continue;
    try {
      const m = await sharp(fp).metadata();
      const w = m.width;
      const h = m.height;
      if (!w || !h || h < 12) continue;
      const ratio = w / h;
      /* Horizontal strips: e.g. 688×192 ≈ 3.6× — treat ratio ≥ 3 as multi-frame row */
      if (ratio >= 3) {
        const columns = Math.max(2, Math.min(64, Math.round(ratio)));
        const frameW = Math.floor(w / columns);
        if (frameW < 4) continue;
        a.spriteSheet = {
          layout: "horizontal",
          columns,
          frameW,
          frameH: Math.floor(h),
          padding: 0,
        };
        const t = new Set(a.tags || []);
        t.add("spriteSheet");
        a.tags = [...t];
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * tier: "high" vs "standard", tight tileFit (floored px, padding 0) for grid rasters.
 */
async function enrichTierAndTileFit(assets) {
  for (const a of assets) {
    const extl = (a.ext || "").toLowerCase();
    if (!["png", "webp", "gif", "bmp", "jpg", "jpeg", "tif", "tiff"].includes(extl))
      continue;
    const fp = path.join(ROOT, a.path.split("/").join(path.sep));
    if (!fs.existsSync(fp)) continue;
    const posixPath = (a.path || "").replace(/\\/g, "/");
    const stemLower = path.parse(a.path).name.toLowerCase();
    try {
      const m = await sharp(fp).metadata();
      const w = Math.floor(m.width || 0);
      const h = Math.floor(m.height || 0);
      if (!w || !h) continue;
      const ratio = w / h;
      const isStrip =
        ratio >= STRIP_RATIO_TIER || ratio <= 1 / STRIP_RATIO_TIER;

      const shielded = isFunctionalShield(posixPath, stemLower);

      if (a.type === "tile") {
        if (a.spriteSheet?.layout === "horizontal") {
          a.spriteSheet.padding = 0;
          const fw = Math.floor(a.spriteSheet.frameW || 0);
          const fh = Math.floor(a.spriteSheet.frameH || h);
          if (fw === 64 && fh === 64) {
            a.tier = "legacy";
          } else {
            a.tier =
              fw >= TILE_HD && fh >= TILE_HD ? "high" : "standard";
          }
        } else if (!isStrip) {
          a.tileFit = { w, h, padding: 0 };
          if (w === 64 && h === 64) {
            a.tier = "legacy";
          } else if (isSquarePo2HighTier(w, h)) {
            a.tier = "high";
          } else if (
            posixPath.includes("/tiles/urban/") &&
            Math.min(w, h) >= 128
          ) {
            /* 128px-detail urban layers (e.g. 128×240) — procedural index parity with HD squares */
            a.tier = "high";
          } else {
            a.tier = w >= TILE_HD && h >= TILE_HD ? "high" : "standard";
          }
        }
      } else if (a.type === "building") {
        if (!isStrip) {
          a.tileFit = { w, h, padding: 0 };
          a.tier =
            isSquarePo2HighTier(w, h) || (w >= BUILDING_HD && h >= BUILDING_HD)
              ? "high"
              : "standard";
        }
      } else if (a.type === "obstacle") {
        if (!isStrip) {
          if (w === 64 && h === 64) {
            a.tier = "legacy";
          } else if (isSquarePo2HighTier(w, h)) {
            a.tier = "high";
          } else {
            a.tier = w >= TILE_HD && h >= TILE_HD ? "high" : "standard";
          }
        }
      } else if (a.type === "unit") {
        if (!isStrip) {
          a.tier =
            isSquarePo2HighTier(w, h) || (w >= TILE_HD && h >= TILE_HD)
              ? "high"
              : "standard";
        }
      } else if (a.type === "gun") {
        a.tier =
          isSquarePo2HighTier(w, h) || (w >= TILE_HD && h >= TILE_HD)
            ? "high"
            : "standard";
      } else if (a.type === "vfx" || a.type === "ui") {
        a.tier =
          isSquarePo2HighTier(w, h) || (w >= TILE_HD && h >= TILE_HD)
            ? "high"
            : "standard";
      }

      const posix = posixPath.toLowerCase();
      const inUnits = posix.startsWith("assets/units/");
      const inGuns = posix.startsWith("assets/guns/");
      if (shielded) {
        delete a.metadata;
        continue;
      }
      if (
        !inUnits &&
        !inGuns &&
        w === 64 &&
        h === 64 &&
        !isStrip &&
        (a.type === "tile" || a.type === "obstacle")
      ) {
        delete a.metadata;
        continue;
      }
      if (!inUnits && !inGuns && w < 128 && h < 128 && !isStrip) {
        a.metadata = "scrap";
      }
    } catch {
      /* ignore */
    }
  }
}

async function rebuildManifest(priorFoundationHints) {
  const functional = await runFunctionalPhysicalPipeline();
  const buckets = [
    collectAssetsUnder("assets/guns"),
    collectAssetsUnder("assets/buildings"),
    collectAssetsUnder("assets/tiles"),
    collectAssetsUnder("assets/obstacles"),
    collectAssetsUnder("assets/vfx"),
    collectAssetsUnder("assets/ui"),
    collectAssetsUnder("assets/units"),
  ];
  const assets = buckets.flat();
  await enrichSpriteSheetMetadata(assets);
  await enrichTierAndTileFit(assets);
  const generatedAt = new Date().toISOString();
  writeFunctionalRescueReport(functional.moves, generatedAt);
  writeClassificationAudit(assets, generatedAt);
  const index = buildIndex(assets);
  const foundationHints = {
    ...DEFAULT_FOUNDATION_HINTS,
    ...(priorFoundationHints && typeof priorFoundationHints === "object"
      ? priorFoundationHints
      : {}),
  };

  const manifest = {
    version: 1,
    generatedAt,
    description:
      "Master catalog for procedural mapgen and tooling. Paths are repo-relative (forward slashes).",
    foundationHints,
    assets,
    index,
    externalRootsScan: scanUnmappedRoots(),
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function runVisualAssessmentReport() {
  const candidates = [];
  const seen = new Set();

  function addCandidate(full, relNote) {
    const base = path.basename(full);
    const ext = path.extname(base).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return;
    if (!isGenericFileName(base)) return;
    const key = path.resolve(full);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ full, relNote });
  }

  if (fs.existsSync(NEW_ARRIVALS)) {
    for (const { full, rel } of walkFiles(NEW_ARRIVALS, "")) {
      addCandidate(full, `New_Arrivals/${rel}`);
    }
  }

  for (const sub of ["tiles", "obstacles"]) {
    const root = path.join(ROOT, "assets", sub);
    if (!fs.existsSync(root)) continue;
    for (const { full } of walkFiles(root, "")) {
      addCandidate(full, posixRel(full));
    }
  }

  const items = [];
  for (const { full, relNote } of candidates) {
    const ext = path.extname(full).toLowerCase();
    try {
      const analysis = await analyzeImageVisual(full);
      const plan = planLibrarianRename(analysis, path.basename(full), ext);
      items.push({
        path: relNote,
        fileName: path.basename(full),
        dimensions: { width: analysis.width, height: analysis.height },
        aspect: analysis.aspect,
        dominantHex: analysis.dominantHex,
        avgRgb: analysis.avgRgb,
        inferredTheme: analysis.theme,
        inferredAssetType: analysis.assetType,
        categoryByVisual: plan.category,
        proposedRename: plan.newFileName,
        librarianSubtype: plan.librarianSubtype,
      });
    } catch (e) {
      items.push({
        path: relNote,
        fileName: path.basename(full),
        error: String(e?.message || e),
      });
    }
  }

  items.sort((a, b) => (a.path || "").localeCompare(b.path || ""));

  /** When nothing in New_Arrivals is generically named, still emit a short demo slice so the pipeline is verifiable. */
  let demoSamples = [];
  if (!items.length) {
    const urban = path.join(ROOT, "assets", "tiles", "urban");
    if (fs.existsSync(urban)) {
      const names = fs
        .readdirSync(urban)
        .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
        .sort()
        .slice(0, 8);
      for (const name of names) {
        const full = path.join(urban, name);
        if (!fs.statSync(full).isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        try {
          const analysis = await analyzeImageVisual(full);
          const plan = planLibrarianRename(analysis, name, ext);
          demoSamples.push({
            path: posixRel(full),
            fileName: name,
            filenameWasGeneric: false,
            dimensions: { width: analysis.width, height: analysis.height },
            aspect: analysis.aspect,
            dominantHex: analysis.dominantHex,
            avgRgb: analysis.avgRgb,
            inferredTheme: analysis.theme,
            inferredAssetType: analysis.assetType,
            categoryByVisual: plan.category,
            proposedRenameIfGeneric: plan.newFileName,
            librarianSubtype: plan.librarianSubtype,
          });
        } catch (e) {
          demoSamples.push({
            path: posixRel(full),
            fileName: name,
            filenameWasGeneric: false,
            error: String(e?.message || e),
          });
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    note: "Primary list: generic basenames only. If that list is empty, `demoSamples` shows the same heuristics on a few `assets/tiles/urban` files (filenames not renamed by the librarian).",
    scannedForGenericUnder: ["assets/New_Arrivals", "assets/tiles", "assets/obstacles"],
    genericNameCount: items.length,
    items,
    demoSamples,
  };

  ensureDir(path.dirname(VISUAL_REPORT_PATH));
  fs.writeFileSync(VISUAL_REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log("CTU Visual assessment report →", VISUAL_REPORT_PATH);
  console.log("  Generic-name rasters analyzed:", items.length);
  if (demoSamples.length) {
    console.log("  Demo samples (urban tiles, non-generic names):", demoSamples.length);
  }
}

/* ── main ─────────────────────────────────────────────────── */
let priorHints = null;
if (fs.existsSync(MANIFEST_PATH)) {
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    priorHints = prev.foundationHints;
  } catch {
    /* ignore */
  }
}

async function main() {
  if (FLAG_VISUAL_REPORT) {
    await runVisualAssessmentReport();
    return;
  }

  appendLibrarianLog(`======== catalog_assets run ========`);

  if (FLAG_ENFORCE_CTU_SIDECARS || FLAG_ENFORCE_CTU_SIDECARS_DRY) {
    enforceCtuSidecarsToReview();
  }

  let cleanupResult = null;
  if (FLAG_CLEANUP || FLAG_CLEANUP_DRY_RUN) {
    cleanupResult = await runCleanupIsolate({
      root: ROOT,
      includePrimary: FLAG_CLEANUP_INCLUDE_PRIMARY,
      includeTiles: FLAG_CLEANUP_INCLUDE_TILES,
      dryRun: FLAG_CLEANUP_DRY_RUN,
    });
    console.log(
      FLAG_CLEANUP_DRY_RUN
        ? "CTU cleanup (dry-run — no files moved)"
        : "CTU cleanup (isolation moves)",
    );
    console.log(
      "  Flagged / moved:",
      cleanupResult.moved.length ? cleanupResult.moved.length : "(none)",
    );
    for (const m of cleanupResult.moved) {
      console.log("   ", m.from, "->", m.to);
      console.log("       ", m.reason);
    }
    if (cleanupResult.errors.length) {
      for (const err of cleanupResult.errors) console.warn("  ", err);
    }
  }

  const moves = FLAG_SKIP_NEW_ARRIVALS ? [] : await ingestNewArrivals();
  const promoted = FLAG_SKIP_NEW_ARRIVALS ? [] : promoteMisfiledFromObstacles();
  const promotedVehicles = FLAG_SKIP_NEW_ARRIVALS
    ? []
    : promoteVehiclesFromObstacles();
  const manifest = await rebuildManifest(priorHints);

  const highTier = manifest.assets.filter((a) => a.tier === "high").length;
  const keptNote = `[KEPT/INGESTED]: ${manifest.assets.length} assets in manifest; ${highTier} tagged tier "high"; tiles/buildings include tileFit (padding 0, floored dimensions) where applicable.`;

  if (FLAG_CLEANUP || FLAG_CLEANUP_DRY_RUN) {
    const reportBody = formatCleanupReport({
      moved: cleanupResult.moved,
      errors: cleanupResult.errors,
      dryRun: cleanupResult.dryRun,
      generatedAt: new Date().toISOString(),
      keptIngestedNote: keptNote,
      ingested: moves,
    });
    fs.mkdirSync(path.dirname(CLEANUP_REPORT_PATH), { recursive: true });
    fs.writeFileSync(CLEANUP_REPORT_PATH, reportBody, "utf8");
    console.log("  Cleanup report:", CLEANUP_REPORT_PATH);
  }

  console.log("CTU Asset Librarian");
  console.log("  New_Arrivals moves:", moves.length ? moves.length : "(none)");
  for (const m of moves) {
    console.log("   ", m.from, "→", m.to, JSON.stringify(m.meta));
  }
  console.log(
    "  Promoted (obstacles → tiles/ui):",
    promoted.length ? promoted.length : "(none)",
  );
  for (const p of promoted) {
    console.log("   ", p.from, "→", p.to);
  }
  console.log(
    "  Promoted (obstacles → units/vehicles):",
    promotedVehicles.length ? promotedVehicles.length : "(none)",
  );
  for (const p of promotedVehicles) {
    console.log("   ", p.from, "→", p.to);
  }
  console.log("  Manifest:", MANIFEST_PATH);
  console.log("  Functional rescue report:", FUNCTIONAL_RESCUE_REPORT_PATH);
  console.log("  Classification audit:", CLASSIFICATION_AUDIT_PATH);
  console.log("  Total catalogued assets:", manifest.assets.length);
  console.log('  tier "high" count:', highTier);
  console.log("  External roots (informational):", manifest.externalRootsScan.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
