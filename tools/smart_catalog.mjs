#!/usr/bin/env node
/**
 * CLIP vision sort — staged pipeline: classify (batched) | decide (pure) | file ops | log.
 *
 * Usage:
 *   node tools/smart_catalog.mjs [--watch] [--dry-run] [--max-files=N]
 *   node tools/smart_catalog.mjs --inbox-subdir=urban_buildings_assets   (only that folder under New_Arrivals)
 *   node tools/smart_catalog.mjs --unified-ingest   (reference_images/ ONLY authority; CLIP = similarity vs refs; auto-move if confident)
 *   node tools/smart_catalog.mjs --unified-ingest --dry-run   (preview tools/unified_preview.json; review → review*.preview.*; no dest mkdir)
 *   node tools/smart_catalog.mjs --unified-ingest --dry-run-strict   (dry-run + no log/jsonl/cache writes)
 *   node tools/smart_catalog.mjs --unified-ingest --reprocess-review (scan assets/New_Arrivals/review/ only; auto → move + log; surfacing reasons → review.md + place cards)
 *   node tools/smart_catalog.mjs --verbose-decisions   (per-file decision lines; combine with unified/dry as needed)
 *   (Default: CLIP classifies then moves auto → assets/… and review → New_Arrivals/review/.)
 *   (--reference-labels: classifies vs reference_images/ labels; NO inbox moves unless --primary-promote.)
 *   node tools/smart_catalog.mjs --batch-size=12
 *   node tools/smart_catalog.mjs --batch-adaptive   (shrink batch after fallback; grow after clean batch)
 *   node tools/smart_catalog.mjs --reference-labels   (CLIP text labels + image↔image similarity vs reference_images/)
 *   node tools/smart_catalog.mjs --reference-labels --primary-promote   (move usage:ready → assets/PRIMARY/…)
 *   node tools/smart_catalog.mjs --reference-labels --export-review-labels   (write review_labels.json + review.md for usage:review)
 *   node tools/import_review_labels_to_reference.mjs   (copy labeled items from review_labels.json → reference_images/<label>/)
 *   node tools/sync_review_md_to_json.mjs   (fill review_labels.json correct_label from **Correct label:** lines in review.md)
 *   node tools/smart_catalog.mjs --reference-labels --export-group-review   (review_groups.json + review_groups.md — approve then tools/execute_group_moves.mjs)
 *   With --reference-labels: atomic multi-image folders are classified once (1–3 samples); default no moves.
 *
 * Stages: Scan -> Cache filter -> Classification -> Decision -> File operations -> Log + metrics
 */

import fs from "fs-extra";
import path from "path";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import { pipeline, env } from "@xenova/transformers";

import {
  buildAssetMetadata,
  suggestedDestRelFromMetadata,
  themeHintFromRelPosix,
  writeAssetMetadataSidecar,
} from "./asset_metadata.mjs";
import { REVIEW_QUICK_SELECT_LABELS } from "./review_quick_select_labels.mjs";
import { primaryDestRelForContent } from "./lib/primary_dest.mjs";
import { buildGroupReviewPayload, renderGroupReviewMarkdown } from "./lib/folder_asset_pipeline.mjs";
import {
  UNIFIED_HIGH_CONFIDENCE,
  UNIFIED_MIN_PROB_MARGIN,
  unifiedDestRelForContentKey,
  resolveUnifiedDestination,
  buildUnifiedMetadata,
} from "./unified_ingest.mjs";
import { analyzeUnifiedHeuristicHints } from "./unified_heuristic_hints.mjs";

// --- paths & env ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

env.cacheDir = path.join(ROOT, "node_modules", ".cache", "transformers");

const SOURCE_DIR = path.join(ROOT, "assets", "New_Arrivals");
const REVIEW_DIR = path.join(SOURCE_DIR, "review");
const ERROR_DIR = path.join(SOURCE_DIR, "error");
const LOG_TEXT_PATH = path.join(ROOT, "tools", "smart_catalog_log.txt");
const LOG_JSONL_PATH = path.join(ROOT, "tools", "smart_catalog.jsonl");
const CACHE_PATH = path.join(ROOT, "tools", "smart_catalog_cache.json");
/** Human-in-the-loop export (repo root; data only, no moves). */
const REVIEW_LABELS_JSON = path.join(ROOT, "review_labels.json");
const REVIEW_MD = path.join(ROOT, "review.md");
/** Written during --dry-run / --dry-run-strict instead of overwriting review_labels.json / review.md */
const REVIEW_LABELS_PREVIEW_JSON = path.join(ROOT, "review_labels.preview.json");
const REVIEW_MD_PREVIEW = path.join(ROOT, "review.preview.md");
/** Unified ingest dry-run analysis output */
const UNIFIED_PREVIEW_JSON = path.join(ROOT, "tools", "unified_preview.json");
/** Unified ingest: pending review place cards (two-phase commit; files stay in place until approved). */
const UNIFIED_PLACE_CARDS_JSON = path.join(ROOT, "tools", "unified_place_cards.json");
/** Append-only log of unified auto-moves (repo-relative paths). */
const UNIFIED_MOVE_LOG_JSON = path.join(ROOT, "tools", "unified_move_log.json");

/** Unified: only these review reasons appear in review.md / place cards (minimal human queue). */
const UNIFIED_SURFACING_REASONS = new Set([
  "unified_low_confidence_or_ambiguous",
  "high_conflict_low_margin",
  "source_atlas_filename_hint",
]);

function shouldSurfaceUnifiedReview(d) {
  return (
    Boolean(d.classifyMeta?.unifiedIngest) &&
    d.decision === "review" &&
    UNIFIED_SURFACING_REASONS.has(String(d.reason || ""))
  );
}

function passesReviewExportFilter(d) {
  if (d.classifyMeta?.unifiedIngest) {
    return shouldSurfaceUnifiedReview(d);
  }
  const ext = d.referenceAssetExtension;
  return Boolean(ext && ext.usage === "review");
}
const REVIEW_GROUPS_JSON = path.join(ROOT, "review_groups.json");
const REVIEW_GROUPS_MD = path.join(ROOT, "review_groups.md");

/** Project-relative visual reference roots (joined with ROOT for I/O). */
const REFERENCE_REL = "reference_images";

/**
 * Human-readable folder/token names → reference_images subfolder ids (synonyms).
 * Only resolves to labels that exist under reference_images/; unmatched aliases are reported but ignored for READY/MISMATCH.
 */
const LABEL_ALIASES = {
  character: "unit",
  characters: "unit",
  hud: "ui",
  menu: "ui",
  inventory: "unit_items",
  weapon: "gun",
  weapons: "gun",
  icons: "sprite_sheet",
  ui: "ui",
  panel: "ui",
  screen: "ui",
  loading: "ui",
  level: "map",
  levels: "map",
};

/** Basename substring hints for source atlases / sheets (not in-game ready art). */
const SOURCE_NAME_FRAGMENTS = ["sheet", "atlas", "sprite", "strip"];

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

/** Basename hints for animation / sprite grouping (atomic folder detection). */
const ATOMIC_ANIM_PATTERN =
  /(walk|attack|idle|die|death|hit|hurt|run|shoot|reload|jump|cast|spell|frame|anim|seq|burst|slash|defend|turn|move|stand|firing)/i;
const ATOMIC_SHEET_PATTERN = /(sheet|atlas|sprite|strip|frames?|sequence|tileset)/i;

/** Bump when on-disk cache schema changes */
const CACHE_VERSION = 6;
const MODEL_ID = "Xenova/clip-vit-base-patch32";

const HYPOTHESIS = { hypothesis_template: "This is a photo of {}." };

/** Stage 2 (reference mode only): image↔ref refinement — softmax over cosine maxima (reporting / optional checks). */
const VISUAL_SOFTMAX_TEMPERATURE = 12;

/** Cosine top-1 vs top-2 pairs held for review when margin is below minimum (see runUnifiedIngestDecisions). */
const UNIFIED_HIGH_CONFLICT_COSINE_PAIRS = new Set([
  ["debris", "prop"].sort().join("|"),
  ["obstacle", "prop"].sort().join("|"),
  ["debris", "terrain"].sort().join("|"),
  ["road", "terrain"].sort().join("|"),
]);

function isUnifiedHighConflictCosineTop2(top1, top2) {
  if (top1 == null || top2 == null) return false;
  const k = [String(top1).toLowerCase(), String(top2).toLowerCase()].sort().join("|");
  return UNIFIED_HIGH_CONFLICT_COSINE_PAIRS.has(k);
}
/** Require strong best-vs-rest separation on raw cosine (max per label vs reference_images). */
const REF_IMAGE_REFINE_MIN_BEST_COSINE = 0.22;
const REF_IMAGE_REFINE_MIN_COSINE_MARGIN = 0.045;

const MIN_TOP_SCORE = 0.22;
const MIN_MARGIN_VS_SECOND = 0.035;

const BATCH_MIN = 1;
const BATCH_MAX = 32;
const BATCH_DEFAULT = 12;

// --- CLI ---
const ARGS = new Set(process.argv.slice(2));
const FLAG_WATCH = ARGS.has("--watch");
const FLAG_DRY = ARGS.has("--dry-run");
/** No moves, no mkdirs, no cache; also no smart_catalog_log.txt / smart_catalog.jsonl writes */
const FLAG_DRY_STRICT = ARGS.has("--dry-run-strict");
/** Per-file decision line to console */
const FLAG_VERBOSE_DECISIONS = ARGS.has("--verbose-decisions");
/** Suppresses file moves, cache write, mkdir in file ops, and (with strict) all log file I/O */
const FLAG_EFFECTIVE_DRY = FLAG_DRY || FLAG_DRY_STRICT;
const FLAG_BATCH_ADAPTIVE = ARGS.has("--batch-adaptive");
/** Load CLIP label set from reference_images/<label>/ (one label per subfolder). */
const FLAG_REFERENCE_LABELS = ARGS.has("--reference-labels");
/** With --reference-labels: move only usage:ready assets to assets/PRIMARY/<route>/ (requires classification extension). */
const FLAG_PRIMARY_PROMOTE = ARGS.has("--primary-promote");
/** With --reference-labels: write review_labels.json and review.md for assets with usage:review (export only). */
const FLAG_EXPORT_REVIEW_LABELS = ARGS.has("--export-review-labels");
/** With --reference-labels: write review_groups.json + review_groups.md (folder grouping; does not run CLIP). */
const FLAG_EXPORT_GROUP_REVIEW = ARGS.has("--export-group-review");
/**
 * Reference-only ingest: softmax vs reference_images/ embeddings; auto-move only if prob≥HIGH and margin≥MIN.
 * Does not use generic CLIP text categories as final class.
 */
const FLAG_UNIFIED_INGEST = ARGS.has("--unified-ingest");
/** Re-run unified classification on assets/New_Arrivals/review/ only; no file moves; overwrites review.md + tools/unified_place_cards.json. Requires --unified-ingest. */
const FLAG_REPROCESS_REVIEW = ARGS.has("--reprocess-review");

function parseArgInt(prefix, defaultVal, min, max) {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  if (!raw) return defaultVal;
  const n = parseInt(raw.slice(prefix.length), 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(max, Math.max(min, n));
}

function parseMaxFiles() {
  const raw = process.argv.find((a) => a.startsWith("--max-files="));
  if (!raw) return Infinity;
  const n = parseInt(raw.slice("--max-files=".length), 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

const MAX_FILES = parseMaxFiles();
const BATCH_SIZE_CONFIG = parseArgInt("--batch-size=", BATCH_DEFAULT, BATCH_MIN, BATCH_MAX);

/** Only walk `assets/New_Arrivals/<rel>` (forward slashes, no `..`). */
function parseInboxSubdirRel() {
  const raw = process.argv.find((a) => a.startsWith("--inbox-subdir="));
  if (!raw) return null;
  const rel = raw
    .slice("--inbox-subdir=".length)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!rel) return null;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.join("/");
}

const INBOX_SUBDIR_REL = parseInboxSubdirRel();
const SCAN_ROOT = FLAG_REPROCESS_REVIEW
  ? REVIEW_DIR
  : INBOX_SUBDIR_REL
    ? path.join(SOURCE_DIR, ...INBOX_SUBDIR_REL.split("/"))
    : SOURCE_DIR;

// --- categories: multiple prompts per CTU bucket (aggregated after CLIP softmax) ---
const CTU_CATEGORIES_DEFAULT = [
  {
    id: "tactical_vehicles",
    dest: "assets/units/vehicles",
    prompts: [
      "military tank, armored personnel carrier, or tactical combat vehicle seen from above for a strategy game",
      "armored fighting vehicle or APC sprite for a top-down wargame",
    ],
  },
  {
    id: "soldiers_infantry",
    dest: "assets/units/infantry",
    prompts: [
      "soldier, infantry squad member, or special forces operator sprite for a tactical wargame",
      "infantry unit or tactical operator character portrait or sprite",
    ],
  },
  {
    id: "weapons_firearms",
    dest: "assets/guns/rifle",
    prompts: [
      "firearm, rifle, pistol, machine gun, or infantry weapon sprite isolated on transparent or plain background",
      "gun weapon icon or side-view firearm asset for a game",
    ],
  },
  {
    id: "urban_ruins",
    dest: "assets/obstacles/urban",
    prompts: [
      "destroyed urban building, concrete rubble pile, bombed ruin, or war-damaged city debris prop",
      "collapsed structure, broken walls, urban destruction debris",
    ],
  },
  {
    id: "urban_props",
    dest: "assets/obstacles/urban",
    prompts: [
      "urban street clutter: barrels, crates, jersey barriers, roadblocks, traffic cones, city props",
      "street furniture, road barrier, or industrial crate prop",
    ],
  },
  {
    id: "foliage",
    dest: "assets/obstacles/grass",
    prompts: [
      "tree, bush, hedge, palm, cactus, or vegetation foliage for a top-down tactics map",
      "green plant, shrub, or canopy seen from above",
    ],
  },
  {
    id: "desert_scatter",
    dest: "assets/obstacles/desert",
    prompts: [
      "desert rock, sand dune clump, arid scrub, or dry wasteland scatter terrain object",
      "dry stones, sand, or arid ground scatter prop",
    ],
  },
  {
    id: "terrain_tiles",
    dest: "assets/tiles/terrain/urban",
    prompts: [
      "ground tile, terrain patch, repeating floor texture, grass sand or pavement map cell",
      "isometric or top-down ground texture tile for a tile map",
    ],
  },
  {
    id: "buildings_structures",
    dest: "assets/tiles/structures/medium",
    prompts: [
      "house, warehouse, bunker, hangar, or large building roof seen from top-down orthographic view",
      "rooftop, structure, or architectural mass seen from above",
    ],
  },
  {
    id: "vfx_combat",
    dest: "assets/effects/explosions",
    prompts: [
      "explosion, muzzle flash, impact burst, smoke cloud, fire, or combat visual effect sprite",
      "particle burst, flash, or animated combat effect strip",
    ],
  },
  {
    id: "ui_hud",
    dest: "assets/ui/panels",
    prompts: [
      "game user interface, HUD element, menu button, health bar, minimap chrome, or flat UI icon",
      "flat 2D interface widget or menu panel art",
    ],
  },
  {
    id: "loot_icons",
    dest: "assets/ui/panels",
    prompts: [
      "small inventory icon, loot pickup, consumable item, medal, or equipment badge for UI",
      "tiny item icon or reward glyph for an RPG inventory",
    ],
  },
];

let CTU_CATEGORIES;
/** Flat CLIP labels + owner category id per index */
let FLAT_LABELS;
let LABEL_CATEGORY_ID;
let CATEGORY_BY_ID;
/** Set when --reference-labels: sorted folder names under reference_images/ */
let REFERENCE_LABEL_NAMES = null;

/** Sync recursive collect of raster paths under a reference_images/<label>/ tree */
function collectReferenceRasterPathsSync(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectReferenceRasterPathsSync(full));
    } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Validate reference_images/ and return sorted label names (one per subfolder).
 * Prints image counts per category and path checks (process.cwd + resolved ROOT path).
 */
function validateReferenceFolders() {
  const absRef = path.join(ROOT, REFERENCE_REL);
  console.log("[reference] process.cwd():", process.cwd());
  console.log(`[reference] ${REFERENCE_REL}/ resolved from project root:`, absRef);
  const exists = fs.existsSync(absRef);
  console.log("[reference] accessible:", exists);
  if (!exists) {
    throw new Error(
      `Missing ${REFERENCE_REL}/ (expected at ${absRef}). cwd=${process.cwd()}`,
    );
  }

  const LABELS = fs.readdirSync(absRef, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();

  console.log(`[reference] ${LABELS.length} label(s):`, LABELS.join(", "));

  for (const name of LABELS) {
    const dir = path.join(absRef, name);
    const n = collectReferenceRasterPathsSync(dir).length;
    console.log(`[reference]   ${REFERENCE_REL}/${name}/: ${n} image(s)`);
    if (n < 1) {
      throw new Error(`${REFERENCE_REL}/${name}/ must contain at least one image`);
    }
  }

  if (LABELS.length === 0) {
    throw new Error(`No subfolders under ${REFERENCE_REL}/`);
  }

  return LABELS;
}

function initTaxonomy() {
  if (FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST) {
    REFERENCE_LABEL_NAMES = validateReferenceFolders();
    CTU_CATEGORIES = REFERENCE_LABEL_NAMES.map((id) => ({
      id,
      dest: null,
      prompts: [id],
    }));
  } else {
    REFERENCE_LABEL_NAMES = null;
    CTU_CATEGORIES = CTU_CATEGORIES_DEFAULT;
  }

  FLAT_LABELS = [];
  LABEL_CATEGORY_ID = [];
  for (const cat of CTU_CATEGORIES) {
    for (const p of cat.prompts) {
      FLAT_LABELS.push(p);
      LABEL_CATEGORY_ID.push(cat.id);
    }
  }
  CATEGORY_BY_ID = Object.fromEntries(CTU_CATEGORIES.map((c) => [c.id, c]));
}

initTaxonomy();

/**
 * Hash reference_images raster inventory so cache invalidates when refs change.
 * @returns {string}
 */
function computeRefVisualManifestHash() {
  if (!FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) return "";
  const absRef = path.join(ROOT, REFERENCE_REL);
  if (!fs.existsSync(absRef)) return "missing";
  const lines = [];
  const walk = (dir, baseRel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const rel = baseRel ? `${baseRel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!IMAGE_EXT.has(ext)) continue;
        try {
          const st = fs.statSync(full);
          lines.push(`${rel}|${st.mtimeMs}|${st.size}`);
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(absRef, "");
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24);
}

function computeConfigSignature() {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    model: MODEL_ID,
    hypothesis: HYPOTHESIS.hypothesis_template,
    minTop: MIN_TOP_SCORE,
    minMargin: MIN_MARGIN_VS_SECOND,
    categories: CTU_CATEGORIES.map((c) => ({ id: c.id, dest: c.dest, prompts: c.prompts })),
    refVisualManifest: computeRefVisualManifestHash(),
    refImageRefineCosine: FLAG_REFERENCE_LABELS ? REF_IMAGE_REFINE_MIN_BEST_COSINE : null,
    refImageRefineMargin: FLAG_REFERENCE_LABELS ? REF_IMAGE_REFINE_MIN_COSINE_MARGIN : null,
    refSoftmaxTemp:
      FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST ? VISUAL_SOFTMAX_TEMPERATURE : null,
    unifiedIngest: FLAG_UNIFIED_INGEST,
    unifiedHigh: FLAG_UNIFIED_INGEST ? UNIFIED_HIGH_CONFIDENCE : null,
    unifiedMargin: FLAG_UNIFIED_INGEST ? UNIFIED_MIN_PROB_MARGIN : null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

const CONFIG_SIGNATURE = computeConfigSignature();

// --- model ---
let classifierPromise = null;
let imageFeatureExtractorPromise = null;

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = pipeline("zero-shot-image-classification", MODEL_ID);
  }
  return classifierPromise;
}

/** CLIP vision tower — same checkpoint as zero-shot (image_embeds, 512-d). */
async function getImageFeatureExtractor() {
  if (!imageFeatureExtractorPromise) {
    imageFeatureExtractorPromise = pipeline("image-feature-extraction", MODEL_ID);
  }
  return imageFeatureExtractorPromise;
}

// --- utils ---
function shouldSkipDir(name) {
  return (
    name.startsWith(".") ||
    name === "_unclassified_clip" ||
    name === "review" ||
    name === "error" ||
    name === "README.md" ||
    name === "cyberpunk GUI plus more"
  );
}

async function uniqueDestPath(destBase) {
  if (!(await fs.pathExists(destBase))) return destBase;
  const dir = path.dirname(destBase);
  const ext = path.extname(destBase);
  const base = path.basename(destBase, ext);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_clip${i}${ext}`);
    i += 1;
  } while (await fs.pathExists(candidate));
  return candidate;
}

async function uniqueDestDirPath(destDir) {
  if (!(await fs.pathExists(destDir))) return destDir;
  const parent = path.dirname(destDir);
  const base = path.basename(destDir);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(parent, `${base}_primary${i}`);
    i += 1;
  } while (await fs.pathExists(candidate));
  return candidate;
}

async function uniqueDestPathPrimaryFile(destFilePath) {
  if (!(await fs.pathExists(destFilePath))) return destFilePath;
  const dir = path.dirname(destFilePath);
  const ext = path.extname(destFilePath);
  const base = path.basename(destFilePath, ext);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_primary${i}${ext}`);
    i += 1;
  } while (await fs.pathExists(candidate));
  return candidate;
}

function isPathUnderRoot(absPath, rootAbs) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(rootAbs);
  const rel = path.relative(root, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function cacheKey(relPosix, mtimeMs, size) {
  return `${relPosix}|${mtimeMs}|${size}`;
}

/**
 * Aggregate softmax scores over all flat prompts into per-category totals (sums to 1).
 */
function flatSortedToCategoryRanking(sortedFlat) {
  const totals = new Map();
  for (const c of CTU_CATEGORIES) totals.set(c.id, 0);

  for (const row of sortedFlat) {
    const idx = flatLabelIndex(row.label);
    if (idx < 0) continue;
    const cid = LABEL_CATEGORY_ID[idx];
    totals.set(cid, (totals.get(cid) || 0) + row.score);
  }

  const ranked = [...totals.entries()]
    .map(([id, confidence]) => ({
      id,
      confidence,
      dest: CATEGORY_BY_ID[id]?.dest ?? null,
    }))
    .sort((a, b) => b.confidence - a.confidence);

  return ranked;
}

function categoryRankingToTop3(ranked) {
  return ranked.slice(0, 3).map((r) => ({
    id: r.id,
    confidence: r.confidence,
    dest: r.dest,
  }));
}

/** Map CLIP output string back to a flat label index (handles template-expanded strings). */
function flatLabelIndex(clipLabel) {
  if (clipLabel == null) return -1;
  let idx = FLAT_LABELS.indexOf(clipLabel);
  if (idx >= 0) return idx;
  const s = String(clipLabel).toLowerCase();
  for (let i = 0; i < FLAT_LABELS.length; i++) {
    const p = FLAT_LABELS[i].toLowerCase();
    if (s.includes(p) || p.includes(s)) return i;
  }
  return -1;
}

function normalizeBatchClipOutput(raw, n) {
  if (n <= 0) return null;
  if (!Array.isArray(raw)) return null;

  if (n === 1) {
    const first = raw[0];
    if (first && typeof first === "object" && "score" in first && "label" in first) {
      return [raw];
    }
    if (Array.isArray(first) && first[0] && "score" in first[0] && "label" in first[0]) {
      return [first];
    }
    return null;
  }

  if (raw.length !== n) return null;
  for (const row of raw) {
    if (!Array.isArray(row) || !row[0] || !("score" in row[0])) return null;
  }
  return raw;
}

// --- cache ---
async function loadCache() {
  try {
    const data = await fs.readJson(CACHE_PATH);
    if (
      data?.version !== CACHE_VERSION ||
      data?.signature !== CONFIG_SIGNATURE ||
      typeof data.entries !== "object"
    ) {
      return { version: CACHE_VERSION, signature: CONFIG_SIGNATURE, entries: {} };
    }
    return data;
  } catch {
    return { version: CACHE_VERSION, signature: CONFIG_SIGNATURE, entries: {} };
  }
}

async function saveCache(cache) {
  cache.version = CACHE_VERSION;
  cache.signature = CONFIG_SIGNATURE;
  await fs.ensureDir(path.dirname(CACHE_PATH));
  await fs.writeJson(CACHE_PATH, cache, { spaces: 0 });
}

// --- sharp fallback ---
async function rasterToClipTempPng(absPath) {
  const sharp = (await import("sharp")).default;
  const tmpDir = path.join(SOURCE_DIR, ".clip_temp");
  await fs.ensureDir(tmpDir);
  const base = path.basename(absPath, path.extname(absPath)).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const out = path.join(tmpDir, `${base}_${randomBytes(4).toString("hex")}_224.png`);
  await sharp(absPath).resize(224, 224, { fit: "cover" }).png().toFile(out);
  return out;
}

/** Sharp resize fallback for paths outside New_Arrivals (e.g. reference_images/). */
async function rasterToClipTempPngGeneric(absPath) {
  const sharp = (await import("sharp")).default;
  const tmpDir = path.join(ROOT, "tools", ".clip_temp");
  await fs.ensureDir(tmpDir);
  const base = path.basename(absPath, path.extname(absPath)).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const out = path.join(tmpDir, `${base}_${randomBytes(4).toString("hex")}_224.png`);
  await sharp(absPath).resize(224, 224, { fit: "cover" }).png().toFile(out);
  return out;
}

function l2NormalizeFloat32(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/** @param {{ data: Float32Array | number[] }} tensor */
function tensorToNormalizedImageEmbedding(tensor) {
  const data = tensor?.data;
  if (!data || !data.length) return null;
  const copy = new Float32Array(data.length);
  copy.set(data);
  return l2NormalizeFloat32(copy);
}

/**
 * Encode one image to a unit L2-normalized CLIP image vector; Sharp fallback on decode errors.
 * @returns {Promise<Float32Array|null>}
 */
async function embedImageFeatureVector(extractor, absPath) {
  let tmp = null;
  try {
    const t = await extractor(absPath);
    const emb = tensorToNormalizedImageEmbedding(t);
    if (emb) return emb;
  } catch {
    /* try sharp */
  }
  try {
    tmp = await rasterToClipTempPngGeneric(absPath);
    const t = await extractor(tmp);
    return tensorToNormalizedImageEmbedding(t);
  } catch {
    return null;
  } finally {
    if (tmp) await fs.remove(tmp).catch(() => {});
  }
}

/**
 * Load all reference_images/* embeddings (sequential — reliable across formats).
 * @returns {Promise<{ ok: boolean, byLabel: Map<string, Float32Array[]>, loaded: number, failed: number, errors: string[] }>}
 */
async function loadReferenceEmbeddingTable(extractor) {
  const absRef = path.join(ROOT, REFERENCE_REL);
  const byLabel = new Map();
  const errors = [];
  let loaded = 0;
  let failed = 0;

  const labels = fs.existsSync(absRef)
    ? fs
        .readdirSync(absRef, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
        .map((e) => e.name)
        .sort()
    : [];

  for (const label of labels) {
    const dir = path.join(absRef, label);
    const filePaths = collectReferenceRasterPathsSync(dir);
    for (const absPath of filePaths) {
      const name = path.basename(absPath);
      const emb = await embedImageFeatureVector(extractor, absPath);
      if (!emb) {
        failed += 1;
        errors.push(`${label}/${name}: embedding_failed`);
        continue;
      }
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(emb);
      loaded += 1;
    }
  }

  const ok = loaded > 0 && labels.length > 0;
  return { ok, byLabel, loaded, failed, errors };
}

/** Per label: max cosine similarity (dot product on L2-normalized vectors). */
function maxCosineByLabel(inputNorm, byLabel) {
  const scores = new Map();
  for (const [label, vecs] of byLabel) {
    let maxS = -Infinity;
    for (const v of vecs) {
      let dot = 0;
      for (let i = 0; i < inputNorm.length; i++) dot += inputNorm[i] * v[i];
      if (dot > maxS) maxS = dot;
    }
    scores.set(label, maxS);
  }
  return scores;
}

function cosineMapToSoftmaxProbs(cosineMap, temperature) {
  const labels = [...cosineMap.keys()].sort();
  if (!labels.length) return new Map();
  const logits = labels.map((l) => (cosineMap.get(l) ?? 0) * temperature);
  const maxL = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - maxL));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const probs = new Map();
  labels.forEach((l, i) => probs.set(l, exps[i] / sum));
  return probs;
}

function visualProbsMapToRankedArray(visualProbs) {
  return [...visualProbs.entries()]
    .map(([id, confidence]) => ({
      id,
      confidence,
      dest: CATEGORY_BY_ID[id]?.dest ?? null,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

function eligibleForImageRefinement(d) {
  if (FLAG_UNIFIED_INGEST) return false;
  if (!FLAG_REFERENCE_LABELS) return false;
  const ext = d.referenceAssetExtension;
  if (!ext) return false;
  if (ext.usage !== "review") return false;
  if (ext.structure === "sprite_sheet") return false;
  if (d.decision === "error" && !d.top3?.length) return false;
  return true;
}

function refinementFailureReasonFromGates(bestC, marginCos, sortedLen) {
  if (sortedLen < 2) {
    return "ambiguous classification";
  }
  const lowC = bestC < REF_IMAGE_REFINE_MIN_BEST_COSINE;
  const lowM = marginCos < REF_IMAGE_REFINE_MIN_COSINE_MARGIN;
  if (lowC && lowM) return "low cosine and margin";
  if (lowC) return "low cosine";
  if (lowM) return "low margin";
  return null;
}

/**
 * Stage 2 — only items with usage:review (non-atlas) after text CLIP + reference extension.
 * @returns {Promise<{ upgrades: Array<{ relPosix: string, clipId: string, bestCosine: number }>, stats: object }>}
 */
async function runReferenceImageRefinementPass(decisions, records, featureExtractor, referenceVisualTable) {
  const inputEmbNormCache = new Map();
  const upgrades = [];
  const stats = {
    eligibleSeen: 0,
    upgraded: 0,
    failedInputEmbedding: 0,
    failedGates: 0,
    failedReasons: {
      "low cosine": 0,
      "low margin": 0,
      "low cosine and margin": 0,
      "ambiguous classification": 0,
    },
  };

  async function getInputEmbeddingNormForRecord(rec) {
    if (!featureExtractor) return null;
    if (rec.isAtomicGroupMember && rec.atomicFolderAbs) {
      const key = `atomic:${rec.atomicFolderAbs}`;
      if (inputEmbNormCache.has(key)) return inputEmbNormCache.get(key);
      const groupPaths = records
        .filter((r) => r.atomicFolderAbs === rec.atomicFolderAbs)
        .map((r) => r.absPath);
      const samples = pickSamplePaths(groupPaths, 3);
      const embs = [];
      for (const p of samples) {
        const e = await embedImageFeatureVector(featureExtractor, p);
        if (e) embs.push(e);
      }
      let mean = null;
      if (embs.length) {
        const dim = embs[0].length;
        const acc = new Float32Array(dim);
        for (const e of embs) {
          for (let i = 0; i < dim; i++) acc[i] += e[i];
        }
        for (let i = 0; i < dim; i++) acc[i] /= embs.length;
        mean = l2NormalizeFloat32(acc);
      }
      inputEmbNormCache.set(key, mean);
      return mean;
    }
    const key = `file:${rec.absPath}`;
    if (inputEmbNormCache.has(key)) return inputEmbNormCache.get(key);
    const emb = await embedImageFeatureVector(featureExtractor, rec.absPath);
    inputEmbNormCache.set(key, emb);
    return emb;
  }

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!eligibleForImageRefinement(d)) continue;
    stats.eligibleSeen += 1;

    const textTop3Before = (d.top3 || []).map((x) => ({
      id: x.id,
      confidence: x.confidence,
      dest: x.dest,
    }));
    const rec = records[i];
    const inputNorm = await getInputEmbeddingNormForRecord(rec);
    if (!inputNorm) {
      stats.failedInputEmbedding += 1;
      d.classifyMeta = {
        ...d.classifyMeta,
        referenceVisual: {
          ...(d.classifyMeta?.referenceVisual || {}),
          textTop3Before,
          refinementSkipped: "input_embedding_failed",
          refinementOutcome: {
            passed: false,
            reason: "input embedding failed",
            bestCosine: null,
            secondCosine: null,
            margin: null,
          },
        },
      };
      continue;
    }

    const cosByLabel = maxCosineByLabel(inputNorm, referenceVisualTable.byLabel);
    const sortedCos = [...cosByLabel.entries()].sort((a, b) => b[1] - a[1]);
    const bestC = sortedCos.length ? sortedCos[0][1] : null;
    const secondC = sortedCos.length > 1 ? sortedCos[1][1] : null;
    const marginCos =
      sortedCos.length >= 2 && bestC != null && secondC != null ? bestC - secondC : null;

    const gateFailReason = refinementFailureReasonFromGates(
      bestC ?? 0,
      marginCos ?? 0,
      sortedCos.length,
    );
    const gatesPass =
      sortedCos.length >= 2 &&
      bestC >= REF_IMAGE_REFINE_MIN_BEST_COSINE &&
      marginCos >= REF_IMAGE_REFINE_MIN_COSINE_MARGIN;

    if (!gatesPass) {
      stats.failedGates += 1;
      const reason = gateFailReason || "low cosine";
      if (stats.failedReasons[reason] != null) stats.failedReasons[reason] += 1;

      d.classifyMeta = {
        ...d.classifyMeta,
        referenceVisual: {
          ...(d.classifyMeta?.referenceVisual || {}),
          textTop3Before,
          visualCosineTop3: sortedCos.slice(0, 3).map(([id, cosine]) => ({ id, cosine })),
          bestCosine: bestC,
          secondCosine: secondC,
          cosineMarginRaw: marginCos,
          refinementOutcome: {
            passed: false,
            reason,
            bestCosine: bestC,
            secondCosine: secondC,
            margin: marginCos,
          },
        },
      };
      console.warn(
        `[reference] image refinement did not upgrade ${d.file.relPosix}: ${reason} (bestCosine=${bestC?.toFixed(4) ?? "n/a"}, margin=${marginCos?.toFixed(4) ?? "n/a"})`,
      );
      continue;
    }

    const visualProbs = cosineMapToSoftmaxProbs(cosByLabel, VISUAL_SOFTMAX_TEMPERATURE);
    const ranked = visualProbsMapToRankedArray(visualProbs);
    const top3 = categoryRankingToTop3(ranked);

    const chosen = top3[0] ?? null;
    const secondT = top3[1];
    const conf = chosen?.confidence ?? 0;
    const margin = secondT ? conf - secondT.confidence : conf;

    d.top3 = top3;
    d.chosen = chosen;
    d.confidence = conf;
    d.margin = margin;
    d.decision = "auto";
    d.reason = "image_refinement";
    d.clipId = chosen?.id;

    d.classifyMeta = {
      ...d.classifyMeta,
      referenceVisual: {
        refined: true,
        refinementStage: "image_vs_reference",
        textTop3Before,
        visualCosineTop3: sortedCos.slice(0, 3).map(([id, cosine]) => ({ id, cosine })),
        softmaxTop3: top3,
        bestCosine: bestC,
        secondCosine: secondC,
        cosineMarginRaw: marginCos,
        refinementOutcome: {
          passed: true,
          reason: null,
          bestCosine: bestC,
          secondCosine: secondC,
          margin: marginCos,
        },
      },
    };

    stats.upgraded += 1;
    upgrades.push({
      relPosix: d.file.relPosix,
      clipId: d.clipId,
      bestCosine: bestC,
    });
  }

  return { upgrades, stats };
}

function printReferenceImageRefinementReport(upgrades, stats, refTable) {
  console.log("\n=== REFERENCE IMAGE REFINEMENT (review → ready) ===\n");
  if (refTable) {
    console.log(
      `   referenceEmbeddingsLoaded: ${refTable.loaded} (${refTable.byLabel?.size ?? 0} labels, ok=${refTable.ok})`,
    );
  }
  if (stats) {
    console.log(
      `   eligible (stage 2): ${stats.eligibleSeen} | upgraded: ${stats.upgraded} | embedding failed: ${stats.failedInputEmbedding} | failed cosine gates: ${stats.failedGates}`,
    );
    if (stats.failedGates > 0 && stats.failedReasons) {
      console.log(`   gate failure breakdown: ${JSON.stringify(stats.failedReasons)}`);
    }
    console.log("");
  }
  if (!upgrades.length) {
    console.log(
      "   (no upgrades — no eligible item passed both cosine ≥ " +
        REF_IMAGE_REFINE_MIN_BEST_COSINE +
        " and margin ≥ " +
        REF_IMAGE_REFINE_MIN_COSINE_MARGIN +
        ")\n",
    );
    return;
  }
  console.log(`   upgraded ${upgrades.length} asset(s):\n`);
  for (const u of upgrades) {
    console.log(
      `   ${u.relPosix}  →  ${u.clipId}  (best cosine ${u.bestCosine.toFixed(4)})`,
    );
  }
  console.log("");
}

async function getInputEmbeddingNormReviewExport(rec, records, featureExtractor, cache) {
  if (!featureExtractor) return null;
  if (rec.isAtomicGroupMember && rec.atomicFolderAbs) {
    const key = `atomic:${rec.atomicFolderAbs}`;
    if (cache.has(key)) return cache.get(key);
    const groupPaths = records
      .filter((r) => r.atomicFolderAbs === rec.atomicFolderAbs)
      .map((r) => r.absPath);
    const samples = pickSamplePaths(groupPaths, 3);
    const embs = [];
    for (const p of samples) {
      const e = await embedImageFeatureVector(featureExtractor, p);
      if (e) embs.push(e);
    }
    let mean = null;
    if (embs.length) {
      const dim = embs[0].length;
      const acc = new Float32Array(dim);
      for (const e of embs) {
        for (let i = 0; i < dim; i++) acc[i] += e[i];
      }
      for (let i = 0; i < dim; i++) acc[i] /= embs.length;
      mean = l2NormalizeFloat32(acc);
    }
    cache.set(key, mean);
    return mean;
  }
  const key = `file:${rec.absPath}`;
  if (cache.has(key)) return cache.get(key);
  const emb = await embedImageFeatureVector(featureExtractor, rec.absPath);
  cache.set(key, emb);
  return emb;
}

/**
 * Human-in-the-loop export: usage:review rows only. Optional image↔ref columns when embeddings load.
 * Does not change classification or move files.
 */
async function writeReviewLabelExports(decisions, records, featureExtractorIn, referenceVisualTableIn) {
  let featureExtractor = featureExtractorIn;
  let referenceVisualTable = referenceVisualTableIn;

  async function ensureReferenceTableForExport() {
    if (referenceVisualTable?.ok) return referenceVisualTable;
    try {
      featureExtractor = featureExtractor ?? (await getImageFeatureExtractor());
      referenceVisualTable = await loadReferenceEmbeddingTable(featureExtractor);
      return referenceVisualTable;
    } catch {
      return null;
    }
  }

  const rows = [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!passesReviewExportFilter(d)) continue;
    const ext = d.referenceAssetExtension;
    if (!ext) continue;
    rows.push({ d, i });
  }

  const inputEmbCache = new Map();
  const items = [];

  for (const { d, i } of rows) {
    const rec = records[i];
    const ext = d.referenceAssetExtension;
    const rv = d.classifyMeta?.referenceVisual;
    const ro = rv?.refinementOutcome;
    const textTop3 = (rv?.textTop3Before?.length
      ? rv.textTop3Before
      : d.top3 || []
    ).map((x) => ({ id: x.id, confidence: Number(x.confidence) }));

    let bestCosine =
      ro?.bestCosine != null ? Number(ro.bestCosine) : rv?.bestCosine != null ? Number(rv.bestCosine) : null;
    let secondCosine =
      ro?.secondCosine != null ? Number(ro.secondCosine) : rv?.secondCosine != null ? Number(rv.secondCosine) : null;
    let visualCosineMargin =
      ro?.margin != null ? Number(ro.margin) : rv?.cosineMarginRaw != null ? Number(rv.cosineMarginRaw) : null;
    let top3Visual = null;
    if (rv?.softmaxTop3?.length) {
      top3Visual = rv.softmaxTop3.map((x) => ({ id: x.id, confidence: Number(x.confidence) }));
    }

    let refinement_failure_reason = null;
    if (ro?.passed === false && ro.reason) refinement_failure_reason = ro.reason;
    if (rv?.refinementSkipped === "input_embedding_failed") {
      refinement_failure_reason = "input embedding failed";
    }

    const table = await ensureReferenceTableForExport();
    if (table?.ok && featureExtractor && !top3Visual) {
      const inputNorm = await getInputEmbeddingNormReviewExport(rec, records, featureExtractor, inputEmbCache);
      if (inputNorm) {
        const cosByLabel = maxCosineByLabel(inputNorm, table.byLabel);
        const sorted = [...cosByLabel.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length) {
          bestCosine = sorted[0][1];
          secondCosine = sorted.length > 1 ? sorted[1][1] : null;
          visualCosineMargin =
            sorted.length > 1 ? sorted[0][1] - sorted[1][1] : sorted[0][1];
        }
        const visProbs = cosineMapToSoftmaxProbs(cosByLabel, VISUAL_SOFTMAX_TEMPERATURE);
        const ranked = visualProbsMapToRankedArray(visProbs);
        top3Visual = categoryRankingToTop3(ranked).map((x) => ({
          id: x.id,
          confidence: Number(x.confidence),
        }));
      }
    }

    const repoRelOriginal = path.relative(ROOT, d.file.absPath).split(path.sep).join("/");
    const baseItem = {
      path: repoRelOriginal,
      predicted_label: d.clipId ?? d.chosen?.id ?? null,
      structure: ext.structure,
      usage: ext.usage,
      confidence: d.confidence != null ? Number(d.confidence) : null,
      margin: d.margin != null ? Number(d.margin) : null,
      bestCosine: bestCosine != null ? Number(bestCosine.toFixed(6)) : null,
      secondCosine: secondCosine != null ? Number(secondCosine.toFixed(6)) : null,
      visual_cosine_margin:
        visualCosineMargin != null ? Number(visualCosineMargin.toFixed(6)) : null,
      top3_text_predictions: textTop3,
      top3_visual_predictions: top3Visual,
      refinement_failure_reason,
      correct_label: "",
    };
    if (d.classifyMeta?.unifiedIngest) {
      const dests = await buildUnifiedPlaceCardDestinations(d);
      baseItem.reason = d.reason ?? null;
      baseItem.proposed_destination = dests.proposed_destination;
      baseItem.alternative_destinations = dests.alternative_destinations;
    }
    items.push(baseItem);
  }

  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    modelId: MODEL_ID,
    referenceRoot: `${REFERENCE_REL}/`,
    items,
  };

  const labelsOut = FLAG_EFFECTIVE_DRY ? REVIEW_LABELS_PREVIEW_JSON : REVIEW_LABELS_JSON;
  const mdOut = FLAG_EFFECTIVE_DRY ? REVIEW_MD_PREVIEW : REVIEW_MD;

  await fs.writeJson(labelsOut, payload, { spaces: 2 });

  /** Repo-root-relative path, forward slashes (actual on-disk location; works with any inbox subfolder). */
  function repoPathForReviewItem(repoRelPosix) {
    return String(repoRelPosix)
      .split(/[/\\]+/)
      .filter(Boolean)
      .join("/");
  }

  function reviewMarkdownLinkTarget(repoPath) {
    return repoPath.includes(" ") ? `<${repoPath}>` : repoPath;
  }

  function safeMarkdownLinkText(s) {
    return String(s).replace(/\\/g, "/").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  }

  const mdLines = [
    "# Review assets (manual labeling)",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Items: **${items.length}** (unified surfacing reasons or usage: review)`,
    "",
    "Click the **filename** in each heading to open the file. Paths are repo-root-relative. **Correct label:** `=` accepts the predicted label; `1`–`9` map to Quick select rows; or type a full label name.",
    "",
    "---",
    "",
  ];
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const repoPath = repoPathForReviewItem(it.path);
    const posixRel = String(it.path).replace(/\\/g, "/");
    const fileName = path.posix.basename(posixRel);
    const linkT = reviewMarkdownLinkTarget(repoPath);
    const safeTitle = safeMarkdownLinkText(fileName);
    const predStr = String(it.predicted_label ?? "(none)").replace(/`/g, "′");

    mdLines.push(`## [${safeTitle}](${linkT})`, "");
    mdLines.push(`![preview](${linkT})`);
    mdLines.push("");
    mdLines.push(`Predicted: \`${predStr}\``);
    mdLines.push("");
    if (items[n].reason != null) {
      mdLines.push(`Reason: \`${String(items[n].reason).replace(/`/g, "′")}\``);
      mdLines.push("");
    }
    if (items[n].proposed_destination != null || (items[n].alternative_destinations?.length ?? 0) > 0) {
      if (items[n].proposed_destination != null) {
        mdLines.push(`**Proposed destination:** \`${items[n].proposed_destination}\``);
        mdLines.push("");
      }
      const alts = items[n].alternative_destinations;
      if (alts?.length) {
        mdLines.push("**Alternative destinations:**");
        for (const a of alts) {
          mdLines.push(
            `- \`${String(a.label).replace(/`/g, "′")}\` → \`${a.destination}\` (score ${a.score})`,
          );
        }
        mdLines.push("");
      }
    }
    mdLines.push(
      `**Scores:** confidence \`${items[n].confidence ?? "n/a"}\` · margin \`${items[n].margin ?? "n/a"}\``,
    );
    mdLines.push("");
    mdLines.push("**Quick select:**");
    mdLines.push(
      REVIEW_QUICK_SELECT_LABELS.map((l, i) => `[${i + 1}] ${l}`).join("   "),
    );
    mdLines.push("");
    mdLines.push("**Correct label:** `____________`");
    mdLines.push("");
    if (n < items.length - 1) {
      mdLines.push("---", "");
    }
  }

  await fs.writeFile(mdOut, mdLines.join("\n"), "utf8");

  console.log(
    `smart_catalog: review export → ${path.relative(ROOT, labelsOut)} (${items.length} item(s)) + ${path.relative(ROOT, mdOut)}${FLAG_EFFECTIVE_DRY ? " (dry-run: preview paths)" : ""}`,
  );
}

async function runClip(classifier, input) {
  return classifier(input, FLAT_LABELS, HYPOTHESIS);
}

async function classifyOnePath(classifier, absPath) {
  let tmp = null;
  try {
    let raw = await runClip(classifier, absPath);
    let sorted = Array.isArray(raw) ? raw : [];
    if (!sorted.length) {
      tmp = await rasterToClipTempPng(absPath);
      raw = await runClip(classifier, tmp);
      sorted = Array.isArray(raw) ? raw : [];
    }
    if (!sorted.length) throw new Error("empty_clip_output");
    return sorted;
  } finally {
    if (tmp) await fs.remove(tmp).catch(() => {});
  }
}

// --- Stage: scan ---
async function* walkRasterFiles(dir) {
  if (!(await fs.pathExists(dir))) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (shouldSkipDir(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkRasterFiles(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) yield full;
    }
  }
}

async function scanStage(rootDir) {
  const out = [];
  for await (const absPath of walkRasterFiles(rootDir)) {
    if (absPath.includes(`${path.sep}.clip_temp${path.sep}`)) continue;
    let st;
    try {
      st = await fs.stat(absPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const relPosix = path.relative(rootDir, absPath).split(path.sep).join("/");
    out.push({
      absPath,
      relPosix,
      mtimeMs: Math.floor(st.mtimeMs),
      size: st.size,
    });
  }
  return out;
}

// --- Atomic folder grouping (reference-label mode): preserve unit/VFX/animation sets ---

function isAtomicFolderFiles(entries) {
  const n = entries.length;
  if (n < 2) return false;
  if (n >= 3) return true;
  return entries.some(
    (e) => ATOMIC_ANIM_PATTERN.test(e.basename) || ATOMIC_SHEET_PATTERN.test(e.basename),
  );
}

/**
 * Mark scanned rows with atomicFolderAbs when sibling images form an atomic set.
 * @param {Array<{ absPath: string, relPosix: string, mtimeMs: number, size: number }>} scanned
 * @param {string} rootDir
 */
function augmentScannedWithAtomic(scanned, rootDir) {
  const byDir = new Map();
  for (const s of scanned) {
    const dir = path.dirname(s.absPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(s);
  }
  return scanned.map((s) => {
    const dir = path.dirname(s.absPath);
    const siblings = byDir.get(dir) || [];
    const entries = siblings.map((x) => ({
      absPath: x.absPath,
      basename: path.basename(x.absPath),
    }));
    const atomic = isAtomicFolderFiles(entries);
    if (!atomic) {
      return { ...s, isAtomicGroupMember: false };
    }
    return {
      ...s,
      isAtomicGroupMember: true,
      atomicFolderAbs: dir,
      atomicFolderKey: path.relative(rootDir, dir).split(path.sep).join("/"),
    };
  });
}

function pickSamplePaths(absPaths, max = 3) {
  const uniq = [...new Set(absPaths)].sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b)),
  );
  if (uniq.length <= max) return uniq;
  if (max <= 1) return [uniq[0]];
  if (max === 2) return [uniq[0], uniq[uniq.length - 1]];
  const mid = Math.floor(uniq.length / 2);
  return [uniq[0], uniq[mid], uniq[uniq.length - 1]];
}

/** Average softmax rows across CLIP runs; same label strings merged. */
function mergeClipSortedFlats(sortedFlats) {
  const valid = sortedFlats.filter((x) => Array.isArray(x) && x.length);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const acc = new Map();
  for (const sf of valid) {
    for (const row of sf) {
      const k = row.label;
      acc.set(k, (acc.get(k) || 0) + row.score);
    }
  }
  const merged = [...acc.entries()].map(([label, score]) => ({
    label,
    score: score / valid.length,
  }));
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

// --- Stage: cache filter ---
function cacheFilterStage(scanned, cache) {
  const records = scanned.map((s) => {
    const key = cacheKey(s.relPosix, s.mtimeMs, s.size);
    const hit = cache.entries[key];
    const skipCache =
      (FLAG_REFERENCE_LABELS && s.isAtomicGroupMember && s.atomicFolderAbs) ||
      FLAG_UNIFIED_INGEST;
    if (
      !skipCache &&
      hit &&
      hit.signature === CONFIG_SIGNATURE &&
      Array.isArray(hit.top3) &&
      hit.top3.length &&
      hit.top3[0]?.id
    ) {
      return {
        ...s,
        cacheKey: key,
        fromCache: true,
        cachedTop3: hit.top3,
      };
    }
    return { ...s, cacheKey: key, fromCache: false };
  });
  return { records };
}

// --- Stage: classification (batched only; no file moves) ---
async function tryBatchClip(classifier, absPaths) {
  const n = absPaths.length;
  const t0 = performance.now();
  const raw = await runClip(classifier, absPaths);
  const normalized = normalizeBatchClipOutput(raw, n);
  if (!normalized) {
    throw new Error("batch_output_shape_mismatch");
  }
  const wallMs = performance.now() - t0;
  return {
    perPath: absPaths.map((absPath, i) => ({
      absPath,
      sortedFlat: normalized[i],
      mode: "batch",
      classifyMs: wallMs / n,
      batchWallMs: wallMs,
    })),
    usedBatch: true,
    batchWallMs: wallMs,
  };
}

async function fallbackPerImageClip(classifier, absPaths, batchError) {
  const perPath = [];
  let totalWall = 0;
  for (const absPath of absPaths) {
    const t1 = performance.now();
    try {
      const sortedFlat = await classifyOnePath(classifier, absPath);
      const w = performance.now() - t1;
      totalWall += w;
      perPath.push({
        absPath,
        sortedFlat,
        mode: "single_fallback",
        classifyMs: w,
        batchWallMs: w,
        fallbackReason: String(batchError?.message || batchError),
      });
    } catch (e) {
      const w = performance.now() - t1;
      totalWall += w;
      perPath.push({
        absPath,
        sortedFlat: null,
        mode: "single_error",
        classifyMs: w,
        batchWallMs: w,
        error: String(e?.message || e),
      });
    }
  }
  return { perPath, usedBatch: false, batchWallMs: totalWall };
}

/**
 * Batch-first; on failure, per-image retry. No I/O on files here.
 */
async function classifyBatchWithRetry(classifier, absPaths) {
  if (absPaths.length === 0) {
    return { perPath: [], usedBatch: true, batchWallMs: 0 };
  }
  try {
    return await tryBatchClip(classifier, absPaths);
  } catch (batchErr) {
    return await fallbackPerImageClip(classifier, absPaths, batchErr);
  }
}

/**
 * Run classification for all paths: adaptive chunk size, never moves files.
 */
async function classificationStage(toClassify, metrics) {
  const classifier = await getClassifier();
  const byPath = new Map();
  let dynamicBatch = Math.min(BATCH_MAX, Math.max(BATCH_MIN, BATCH_SIZE_CONFIG));

  for (let i = 0; i < toClassify.length; ) {
    const slice = toClassify.slice(i, i + dynamicBatch);
    const paths = slice.map((r) => r.absPath);
    const tChunk = performance.now();
    const result = await classifyBatchWithRetry(classifier, paths);
    metrics.classifyWallMsTotal += result.batchWallMs;
    metrics.batchRuns += 1;
    metrics.batchTimesMs.push(result.batchWallMs);

    let hadSingleFallback = false;
    for (const p of result.perPath) {
      byPath.set(p.absPath, p);
      if (p.mode === "single_fallback" || p.mode === "single_error") hadSingleFallback = true;
    }

    if (FLAG_BATCH_ADAPTIVE) {
      if (result.usedBatch && !hadSingleFallback) {
        dynamicBatch = Math.min(BATCH_MAX, dynamicBatch + 1);
      } else {
        dynamicBatch = Math.max(BATCH_MIN, Math.floor(dynamicBatch * 0.75));
      }
    }

    i += slice.length;
  }

  return byPath;
}

/**
 * Reference mode: classify atomic folders once (merged CLIP on 1–3 samples), then remaining files.
 * Non-reference: identical to classificationStage.
 */
async function classificationStageReferenceAware(toClassify, metrics) {
  if (!FLAG_REFERENCE_LABELS) {
    return classificationStage(toClassify, metrics);
  }

  const classifier = await getClassifier();
  const byPath = new Map();

  const atomicGroups = new Map();
  const individuals = [];

  for (const rec of toClassify) {
    if (rec.isAtomicGroupMember && rec.atomicFolderAbs) {
      if (!atomicGroups.has(rec.atomicFolderAbs)) {
        atomicGroups.set(rec.atomicFolderAbs, []);
      }
      atomicGroups.get(rec.atomicFolderAbs).push(rec);
    } else {
      individuals.push(rec);
    }
  }

  for (const [, groupRecs] of atomicGroups) {
    const paths = groupRecs.map((r) => r.absPath);
    const samples = pickSamplePaths(paths, 3);
    const result = await classifyBatchWithRetry(classifier, samples);
    metrics.classifyWallMsTotal += result.batchWallMs;
    metrics.batchRuns += 1;
    metrics.batchTimesMs.push(result.batchWallMs);

    const sampleSfs = result.perPath.map((p) => p.sortedFlat).filter(Boolean);
    let mergedSf = mergeClipSortedFlats(sampleSfs);
    if (!mergedSf?.length && sampleSfs[0]) {
      mergedSf = sampleSfs[0];
    }

    for (const r of groupRecs) {
      byPath.set(r.absPath, {
        absPath: r.absPath,
        sortedFlat: mergedSf,
        mode: "atomic_folder",
        classifyMs: result.batchWallMs / Math.max(1, samples.length),
        batchWallMs: result.batchWallMs,
        atomicSamplePaths: samples,
      });
    }
  }

  const indMap = individuals.length ? await classificationStage(individuals, metrics) : new Map();
  for (const [k, v] of indMap) {
    byPath.set(k, v);
  }
  return byPath;
}

// --- Stage: decision (pure) ---
/**
 * @returns {{
 *   file: { absPath: string, relPosix: string, cacheKey?: string },
 *   top3: Array<{ id: string, confidence: number, dest: string|null }>,
 *   chosen: { id: string, confidence: number, dest: string|null } | null,
 *   confidence: number,
 *   margin: number,
 *   decision: 'auto'|'review'|'error',
 *   reason?: string,
 *   clipId?: string,
 *   destRel?: string,
 *   assetMetadata?: object,
 *   classifyMeta?: object
 * }}
 */
function decisionStage(fileRef, sortedFlat, classifyMeta) {
  const file = {
    absPath: fileRef.absPath,
    relPosix: fileRef.relPosix,
    cacheKey: fileRef.cacheKey,
  };

  if (!sortedFlat || !sortedFlat.length) {
    return {
      file,
      top3: [],
      chosen: null,
      confidence: 0,
      margin: 0,
      decision: "error",
      reason: classifyMeta?.error || "classification_failed",
      classifyMeta,
    };
  }

  const ranked = flatSortedToCategoryRanking(sortedFlat);
  const top3 = categoryRankingToTop3(ranked);
  const chosen = top3[0] ?? null;
  const second = top3[1];
  const confidence = chosen?.confidence ?? 0;
  const margin = second ? confidence - second.confidence : confidence;

  if (!chosen || !CATEGORY_BY_ID[chosen.id]) {
    return {
      file,
      top3,
      chosen,
      confidence,
      margin,
      decision: "error",
      reason: "no_valid_category",
      classifyMeta,
    };
  }

  if (confidence < MIN_TOP_SCORE || margin < MIN_MARGIN_VS_SECOND) {
    return {
      file,
      top3,
      chosen,
      confidence,
      margin,
      decision: "review",
      reason: "low_confidence_or_margin",
      classifyMeta,
    };
  }

  return {
    file,
    top3,
    chosen,
    confidence,
    margin,
    decision: "auto",
    clipId: chosen.id,
    classifyMeta,
  };
}

function buildDecisionFromCache(fileRef, cachedTop3, classifyMeta) {
  const chosen = cachedTop3[0] ?? null;
  const second = cachedTop3[1];
  const confidence = chosen?.confidence ?? 0;
  const margin = second ? confidence - second.confidence : confidence;

  const file = {
    absPath: fileRef.absPath,
    relPosix: fileRef.relPosix,
    cacheKey: fileRef.cacheKey,
  };

  if (!chosen || !CATEGORY_BY_ID[chosen.id]) {
    return {
      file,
      top3: cachedTop3,
      chosen,
      confidence,
      margin,
      decision: "error",
      reason: "cache_corrupt_category",
      classifyMeta,
    };
  }

  if (confidence < MIN_TOP_SCORE || margin < MIN_MARGIN_VS_SECOND) {
    return {
      file,
      top3: cachedTop3,
      chosen,
      confidence,
      margin,
      decision: "review",
      reason: "low_confidence_or_margin",
      classifyMeta: { ...classifyMeta, fromCache: true },
    };
  }

  return {
    file,
    top3: cachedTop3,
    chosen,
    confidence,
    margin,
    decision: "auto",
    clipId: chosen.id,
    classifyMeta: { ...classifyMeta, fromCache: true },
  };
}

/**
 * Rule-finalize metadata; CLIP top-N is suggestions only. Optional dest folder from metadata, not category.dest.
 */
function attachMetadataToDecisions(decisions) {
  for (const d of decisions) {
    const fn = path.basename(d.file.absPath);

    if (d.classifyMeta?.unifiedIngest) {
      const topRanked = (d.top3 || []).map(({ id, confidence }) => ({ id, confidence }));
      const originalLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
      const destRes = d.unifiedDestResolution;
      const routingLabel = destRes?.normalizedReferenceLabel ?? originalLabel;
      const layoutHint = destRes?.dest ?? (originalLabel ? unifiedDestRelForContentKey(originalLabel) : null);
      d.assetMetadata = buildUnifiedMetadata(fn, routingLabel || originalLabel, topRanked, {
        originalReferenceLabel: destRes?.originalReferenceLabel ?? originalLabel,
        destLabelAlias:
          destRes?.aliasApplied && destRes.originalReferenceLabel !== destRes.normalizedReferenceLabel
            ? `${destRes.originalReferenceLabel}→${destRes.aliasApplied}`
            : null,
        reviewPending: d.decision === "review",
        ingestError: d.decision === "error",
      });
      d.assetMetadata.pipeline.folderLayoutHint = layoutHint;
      if (d.decision === "auto" && layoutHint) {
        d.destRel = layoutHint;
      }
      continue;
    }

    const theme = themeHintFromRelPosix(d.file.relPosix);
    const clipTop3 = (d.top3 || []).map(({ id, confidence }) => ({ id, confidence }));
    const primaryClipId = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
    d.assetMetadata = buildAssetMetadata(fn, clipTop3, primaryClipId, {
      reviewPending: d.decision === "review",
      ingestError: d.decision === "error",
    });
    const layoutHint = suggestedDestRelFromMetadata(d.assetMetadata, theme, fn);
    d.assetMetadata.pipeline.folderLayoutHint = layoutHint;
    if (d.atomicFolderContext?.protectedAtomic) {
      d.assetMetadata.pipeline.atomicProtectedNote = "PROTECTED - DO NOT SPLIT";
    }
    if (d.decision === "auto") {
      d.destRel = layoutHint;
    }
  }
}

// --- Stage: file operations (movement only) ---
async function fileOperationsStage(decisions) {
  const results = [];
  if (FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    for (const d of decisions) {
      results.push({
        d,
        ok: true,
        kind: "skipped_reference_no_move",
        destPath: null,
        moveMs: 0,
        dry: true,
      });
    }
    return results;
  }
  for (const d of decisions) {
    const absPath = d.file.absPath;
    const t0 = performance.now();

    try {
      if (d.decision === "auto" && d.destRel) {
        const destDir = path.join(ROOT, d.destRel);
        if (!FLAG_EFFECTIVE_DRY) {
          await fs.ensureDir(destDir);
        }
        const baseName = path.basename(absPath);
        let destPath = path.join(destDir, baseName);
        destPath = await uniqueDestPath(destPath);
        if (FLAG_EFFECTIVE_DRY) {
          await writeAssetMetadataSidecar(destPath, d.assetMetadata, true);
          results.push({
            d,
            ok: true,
            kind: "auto",
            destPath,
            moveMs: performance.now() - t0,
            dry: true,
          });
          continue;
        }
        await fs.move(absPath, destPath, { overwrite: false });
        await writeAssetMetadataSidecar(destPath, d.assetMetadata, false);
        if (FLAG_UNIFIED_INGEST && d.classifyMeta?.unifiedIngest && !FLAG_EFFECTIVE_DRY) {
          await appendUnifiedMoveLogEntry({
            file: path.relative(ROOT, absPath).split(path.sep).join("/"),
            destination: path.relative(ROOT, destPath).split(path.sep).join("/"),
            confidence: d.confidence,
            date: new Date().toISOString(),
          });
        }
        results.push({
          d,
          ok: true,
          kind: "auto",
          destPath,
          moveMs: performance.now() - t0,
          dry: false,
        });
        continue;
      }

      if (d.decision === "review") {
        if (FLAG_UNIFIED_INGEST && d.classifyMeta?.unifiedIngest) {
          results.push({
            d,
            ok: true,
            kind: "unified_review_pending",
            destPath: null,
            moveMs: performance.now() - t0,
            dry: false,
          });
          continue;
        }
        if (!FLAG_EFFECTIVE_DRY) {
          await fs.ensureDir(REVIEW_DIR);
        }
        const baseName = path.basename(absPath);
        let destPath = path.join(REVIEW_DIR, baseName);
        destPath = await uniqueDestPath(destPath);
        const sidecar = `${destPath}.smart_catalog.json`;
        const meta = {
          top3: d.top3,
          chosen: d.chosen,
          confidence: d.confidence,
          margin: d.margin,
          reason: d.reason,
          classifyMeta: d.classifyMeta,
        };
        if (!FLAG_EFFECTIVE_DRY) {
          await fs.writeJson(sidecar, meta, { spaces: 2 });
          await fs.move(absPath, destPath, { overwrite: false });
          await writeAssetMetadataSidecar(destPath, d.assetMetadata, false);
        } else {
          await writeAssetMetadataSidecar(destPath, d.assetMetadata, true);
        }
        results.push({
          d,
          ok: true,
          kind: "review",
          destPath,
          sidecar,
          moveMs: performance.now() - t0,
          dry: FLAG_EFFECTIVE_DRY,
        });
        continue;
      }

      if (!FLAG_EFFECTIVE_DRY) {
        await fs.ensureDir(ERROR_DIR);
      }
      const baseName = path.basename(absPath);
      let destPath = path.join(ERROR_DIR, baseName);
      destPath = await uniqueDestPath(destPath);
      const sidecar = `${destPath}.error.json`;
      const payload = {
        reason: d.reason || "error",
        top3: d.top3,
        classifyMeta: d.classifyMeta,
        at: new Date().toISOString(),
      };
      if (!FLAG_EFFECTIVE_DRY) {
        await fs.writeJson(sidecar, payload, { spaces: 2 });
        await fs.move(absPath, destPath, { overwrite: false });
        await writeAssetMetadataSidecar(destPath, d.assetMetadata, false);
      } else {
        await writeAssetMetadataSidecar(destPath, d.assetMetadata, true);
      }
      results.push({
        d,
        ok: true,
        kind: "error",
        destPath,
        sidecar,
        moveMs: performance.now() - t0,
        dry: FLAG_EFFECTIVE_DRY,
      });
    } catch (e) {
      results.push({
        d,
        ok: false,
        kind: "failed",
        error: String(e?.message || e),
        moveMs: performance.now() - t0,
      });
    }
  }
  return results;
}

// --- logging ---
function appendTextLog(line) {
  if (FLAG_DRY_STRICT) return;
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_TEXT_PATH, `[${ts}] ${line}\n`, "utf8");
}

async function logJsonlLine(obj) {
  if (FLAG_DRY_STRICT) return;
  await fs.ensureDir(path.dirname(LOG_JSONL_PATH));
  fs.appendFileSync(LOG_JSONL_PATH, `${JSON.stringify(obj)}\n`, "utf8");
}

function mapUnifiedPreviewReason(d) {
  if (d.referenceAssetExtension?.usage === "redundant_source") return "redundant_source";
  const r = d.reason || "";
  if (r === "unified_reference_confident") return "high_confidence";
  if (r === "unified_low_confidence_or_ambiguous") return "ambiguous";
  if (r === "high_conflict_low_margin") return "high_conflict_low_margin";
  if (r === "source_atlas_filename_hint") return "sheet_detected";
  if (r === "redundant_source_sheet") return "redundant_source";
  if (r === "input_embedding_failed" || r === "no_labels" || r === "unknown_label_destination") return "low_confidence";
  return r || "unknown";
}

function buildUnifiedPreviewSummary(decisions) {
  const autoDecs = decisions.filter((d) => d.decision === "auto");
  const review = decisions.filter((d) => d.decision === "review").length;
  const high_confidence_avg = autoDecs.length
    ? autoDecs.reduce((s, d) => s + (Number(d.confidence) || 0), 0) / autoDecs.length
    : null;
  return {
    total_files: decisions.length,
    auto_move: autoDecs.length,
    review,
    high_confidence_avg: high_confidence_avg != null ? Number(high_confidence_avg.toFixed(6)) : null,
    low_confidence_count: decisions.filter((d) => d.decision !== "auto").length,
  };
}

/**
 * Same folder resolution as attachMetadataToDecisions (unified): resolveUnifiedDestination(label, cosine)
 * then unifiedDestRelForContentKey fallback when dest is null.
 */
function layoutHintForUnifiedCandidateLabel(label, cosineScore) {
  const destRes = resolveUnifiedDestination(label, cosineScore);
  const layoutHint = destRes?.dest ?? (label ? unifiedDestRelForContentKey(label) : null);
  return { destRes, layoutHint };
}

async function uniqueResolvedDestRel(layoutHint, absPath) {
  if (!layoutHint) return null;
  const baseName = path.basename(absPath);
  const destAbs = await uniqueDestPath(path.join(ROOT, layoutHint, baseName));
  return path.relative(ROOT, destAbs).split(path.sep).join("/");
}

async function appendUnifiedMoveLogEntry(entry) {
  if (FLAG_EFFECTIVE_DRY) return;
  const rec = {
    file: entry.file,
    destination: entry.destination,
    confidence: entry.confidence != null ? Number(Number(entry.confidence).toFixed(6)) : null,
    date: entry.date || new Date().toISOString(),
  };
  let payload = { schemaVersion: 1, entries: [] };
  if (await fs.pathExists(UNIFIED_MOVE_LOG_JSON)) {
    try {
      const prev = await fs.readJson(UNIFIED_MOVE_LOG_JSON);
      if (Array.isArray(prev)) {
        payload.entries = prev;
      } else if (Array.isArray(prev?.entries)) {
        payload.entries = prev.entries;
      }
    } catch {
      payload.entries = [];
    }
  }
  payload.entries = [...payload.entries, rec];
  payload.updatedAt = new Date().toISOString();
  await fs.ensureDir(path.dirname(UNIFIED_MOVE_LOG_JSON));
  await fs.writeJson(UNIFIED_MOVE_LOG_JSON, payload, { spaces: 2 });
}

/**
 * Destinations only from resolveUnifiedDestination + unifiedDestRelForContentKey (same as attachMetadata).
 * Cosine top-3 ∪ softmax top-3 (deduped by label); first resolvable path → proposed_destination, rest → alternatives.
 * No synthetic folders — if nothing resolves, proposed_destination is null and alternative_destinations may be empty.
 */
async function buildUnifiedPlaceCardDestinations(d) {
  const rv = d.classifyMeta?.referenceVisual;
  const byLabel = new Map();

  if (rv?.visualCosineTop3?.length) {
    for (const { id, cosine } of rv.visualCosineTop3) {
      if (!id) continue;
      const c = Number(cosine);
      if (!byLabel.has(id)) byLabel.set(id, c);
    }
  }
  if (d.top3?.length) {
    for (const e of d.top3) {
      if (!e?.id) continue;
      const c = e.confidence != null ? Number(e.confidence) : 0;
      if (!byLabel.has(e.id)) byLabel.set(e.id, c);
    }
  }

  const rows = [...byLabel.entries()].map(([label, cosine]) => ({ label, cosine }));

  const resolved = [];
  for (const { label, cosine } of rows) {
    if (!label) continue;
    const { layoutHint } = layoutHintForUnifiedCandidateLabel(label, cosine);
    const destRel = await uniqueResolvedDestRel(layoutHint, d.file.absPath);
    resolved.push({
      label,
      destination: destRel,
      score: Number(Number(cosine).toFixed(6)),
    });
  }

  const withDest = resolved.filter((r) => r.destination);
  let primary = withDest[0]?.destination ?? null;
  const seenPaths = new Set();
  if (primary) seenPaths.add(primary);

  const alternative_destinations = [];
  for (let i = 1; i < withDest.length; i++) {
    const { label, destination, score } = withDest[i];
    if (seenPaths.has(destination)) continue;
    seenPaths.add(destination);
    alternative_destinations.push({ label, destination, score });
  }

  return { proposed_destination: primary, alternative_destinations };
}

function unifiedPredictedAndRoutingLabels(d) {
  const originalLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
  const destRes = d.unifiedDestResolution;
  const predicted_label =
    destRes?.originalReferenceLabel != null && String(destRes.originalReferenceLabel).trim() !== ""
      ? destRes.originalReferenceLabel
      : originalLabel ?? d.clipId ?? null;
  const routing_label =
    destRes?.normalizedReferenceLabel != null && String(destRes.normalizedReferenceLabel).trim() !== ""
      ? destRes.normalizedReferenceLabel
      : originalLabel ?? d.clipId ?? null;
  return { predicted_label, routing_label };
}

async function writeUnifiedPlaceCards(decisions) {
  if (!FLAG_UNIFIED_INGEST) return;
  const items = [];
  for (const d of decisions) {
    if (!shouldSurfaceUnifiedReview(d)) continue;
    const file = path.relative(ROOT, d.file.absPath).split(path.sep).join("/");
    const { predicted_label, routing_label } = unifiedPredictedAndRoutingLabels(d);
    const { proposed_destination, alternative_destinations } = await buildUnifiedPlaceCardDestinations(d);
    let heuristic_hints;
    const needsHeuristicAssist =
      proposed_destination == null && (!alternative_destinations || alternative_destinations.length === 0);
    if (needsHeuristicAssist) {
      try {
        heuristic_hints = await analyzeUnifiedHeuristicHints(d.file.absPath);
      } catch {
        heuristic_hints = [];
      }
    }
    items.push({
      file,
      predicted_label,
      routing_label,
      proposed_destination,
      alternative_destinations,
      confidence: d.confidence != null ? Number(Number(d.confidence).toFixed(6)) : null,
      margin: d.margin != null ? Number(Number(d.margin).toFixed(6)) : null,
      reason: d.reason ?? null,
      ...(needsHeuristicAssist ? { heuristic_hints: heuristic_hints ?? [] } : {}),
      status: "pending_review",
    });
  }
  const payload = {
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    items,
  };
  if (!FLAG_DRY_STRICT) {
    await fs.ensureDir(path.dirname(UNIFIED_PLACE_CARDS_JSON));
  }
  await fs.writeJson(UNIFIED_PLACE_CARDS_JSON, payload, { spaces: 2 });
  if (items.length) {
    console.log(
      "smart_catalog: unified place cards →",
      path.relative(ROOT, UNIFIED_PLACE_CARDS_JSON),
      `(${items.length} pending)`,
    );
  }
}

async function writeUnifiedPreviewFile(decisions) {
  const items = decisions.map((d) => ({
    file: path.relative(ROOT, d.file.absPath).split(path.sep).join("/"),
    predicted_label: d.clipId ?? d.chosen?.id ?? null,
    confidence: d.confidence != null ? Number(Number(d.confidence).toFixed(6)) : null,
    second_label: d.top3?.[1]?.id ?? null,
    second_confidence:
      d.top3?.[1]?.confidence != null ? Number(Number(d.top3[1].confidence).toFixed(6)) : null,
    margin: d.margin != null ? Number(Number(d.margin).toFixed(6)) : null,
    action: d.decision === "auto" ? "auto-move" : d.decision === "review" ? "review" : "error",
    reason: mapUnifiedPreviewReason(d),
  }));
  const summary = buildUnifiedPreviewSummary(decisions);
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "unified-ingest",
    dryRun: FLAG_EFFECTIVE_DRY,
    dryRunStrict: FLAG_DRY_STRICT,
    summary,
    items,
  };
  if (!FLAG_DRY_STRICT) {
    await fs.ensureDir(path.dirname(UNIFIED_PREVIEW_JSON));
  }
  await fs.writeJson(UNIFIED_PREVIEW_JSON, payload, { spaces: 2 });
  console.log(
    "smart_catalog: unified preview →",
    path.relative(ROOT, UNIFIED_PREVIEW_JSON),
    "| summary:",
    JSON.stringify(summary),
  );
}

function logStructuredDecision(jsonlPayload) {
  return logJsonlLine(jsonlPayload);
}

// --- reference_images vs filename (visual validation) ---
function extractFilenameTokens(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  return base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

/**
 * Resolve a reference label from path tokens: direct label match first, then LABEL_ALIASES
 * (only accepted if alias target exists in validLabels).
 * @returns {{ label: string|null, matchedBy: 'direct'|'alias'|null, tokenHits: Array<{original: string, mapped: string, kind: string, accepted: boolean}> }}
 */
function resolveLabelFromTokens(tokens, validLabels) {
  const tokenHits = [];
  if (!validLabels?.length) {
    return { label: null, matchedBy: null, tokenHits };
  }
  const lowerToCanonical = new Map(validLabels.map((l) => [l.toLowerCase(), l]));

  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (lowerToCanonical.has(t)) {
      const label = lowerToCanonical.get(t);
      tokenHits.push({
        original: raw,
        mapped: label,
        kind: "direct",
        accepted: true,
      });
    } else if (Object.prototype.hasOwnProperty.call(LABEL_ALIASES, t)) {
      const aliased = LABEL_ALIASES[t];
      const canonical = lowerToCanonical.get(String(aliased).toLowerCase());
      tokenHits.push({
        original: raw,
        mapped: String(aliased),
        kind: "alias",
        accepted: Boolean(canonical),
      });
    }
  }

  for (const h of tokenHits) {
    if (h.kind === "direct") {
      return { label: h.mapped, matchedBy: "direct", tokenHits };
    }
  }
  for (const h of tokenHits) {
    if (h.kind === "alias" && h.accepted) {
      const label = lowerToCanonical.get(String(h.mapped).toLowerCase());
      if (label) {
        return { label, matchedBy: "alias", tokenHits };
      }
    }
  }

  return { label: null, matchedBy: null, tokenHits };
}

function basenameSuggestsSourceBasename(fileName) {
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  return SOURCE_NAME_FRAGMENTS.some((frag) => base.includes(frag));
}

/** Stronger hints for a packed master image (excludes generic "sprite" so sprite_0001.png can count as a cell). */
const MASTER_SHEET_NAME_RE = /sheet|atlas|tileset|strip|spritesheet/i;

function basenameLooksLikeExtractedCell(fileName) {
  const b = path.basename(fileName, path.extname(fileName));
  const lower = b.toLowerCase();
  if (MASTER_SHEET_NAME_RE.test(lower)) return false;
  if (/^sprite_\d+$/i.test(lower)) return true;
  if (/^frame[_-]?\d+$/i.test(lower)) return true;
  if (/^tile_\d+$/i.test(lower)) return true;
  if (/(^|_)(cell|cut|extract)(_|$)/i.test(lower)) return true;
  if (/^clip\d+/i.test(lower)) return true;
  if (/\d{3,4}$/.test(lower)) return true;
  return false;
}

/**
 * True when this path looks like a source sheet AND the same folder already has multiple likely cut sprites.
 * Avoids marking master sheets as needs_extraction when slices are already present.
 */
function folderShowsExtractedSpriteSiblings(masterAbsPath) {
  if (!basenameSuggestsSourceBasename(path.basename(masterAbsPath))) {
    return false;
  }
  const dir = path.dirname(masterAbsPath);
  const baseMaster = path.basename(masterAbsPath);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let cellLike = 0;
  let nonMasterNonHint = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    if (ent.name === baseMaster) continue;
    const stem = path.basename(ent.name, path.extname(ent.name));
    const lower = stem.toLowerCase();
    if (basenameLooksLikeExtractedCell(ent.name)) cellLike += 1;
    if (!MASTER_SHEET_NAME_RE.test(lower)) nonMasterNonHint += 1;
  }
  if (cellLike >= 2) return true;
  if (nonMasterNonHint >= 3) return true;
  if (nonMasterNonHint >= 2 && cellLike >= 1) return true;
  return false;
}

function isLowConfidenceForUsage(decision, confidence, margin) {
  return (
    decision === "error" ||
    decision === "review" ||
    confidence < MIN_TOP_SCORE ||
    margin < MIN_MARGIN_VS_SECOND
  );
}

/**
 * Extended reference reporting model (does not alter CLIP scores or moves).
 * STRUCTURE: sprite_sheet | animation | single_asset
 * CONTENT: semantic label from folder/name/alias, plus CLIP for context
 * USAGE: needs_extraction | redundant_source | ready | review
 */
function deriveReferenceClassificationModel(d) {
  const fn = path.basename(d.file.absPath);

  if (d.classifyMeta?.unifiedIngest) {
    const visualLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
    const content = visualLabel || "unspecified";
    const decision = d.decision;
    const isSpriteSheetStructure = basenameSuggestsSourceBasename(fn);
    const extractionAlreadyInFolder =
      isSpriteSheetStructure && folderShowsExtractedSpriteSiblings(d.file.absPath);

    let structure = isSpriteSheetStructure ? "sprite_sheet" : "single_asset";
    if (d.atomicFolderContext?.protectedAtomic) structure = "animation";

    let usage;
    if (structure === "sprite_sheet") {
      usage = extractionAlreadyInFolder ? "redundant_source" : "needs_extraction";
    } else if (decision === "review" || decision === "error") {
      usage = "review";
    } else {
      usage = "ready";
    }

    let state = "USABLE";
    if (structure === "sprite_sheet") {
      state = extractionAlreadyInFolder ? "REDUNDANT_SOURCE" : "SOURCE";
    } else if (d.atomicFolderContext?.protectedAtomic) {
      state = "COMPOSITE";
    }

    const sourceReasons = [];
    if (isSpriteSheetStructure) sourceReasons.push("filename_contains_source_hint");
    if (extractionAlreadyInFolder) sourceReasons.push("extracted_siblings_in_folder");

    return {
      structure,
      content,
      usage,
      state,
      contentHint: [`content:${content}`, visualLabel ? `ref:${visualLabel}` : null]
        .filter(Boolean)
        .join(" | "),
      visualLabel,
      extractionSatisfiedInFolder: extractionAlreadyInFolder,
      sourceReasons,
      recommendedAction:
        usage === "review"
          ? "Unified ingest: raise confidence (more/better reference_images) or assign label manually"
          : usage === "redundant_source"
            ? "Cut sprites already in this folder — archive or delete the master sheet; do not promote the sheet as final art"
            : usage === "needs_extraction"
              ? "Requires preprocessing before use as final art"
              : "OK as single asset",
      doNotUseDirectly: usage === "needs_extraction" || usage === "redundant_source",
      primaryNotUsable: usage === "needs_extraction" || usage === "redundant_source",
    };
  }

  const refinedByImage = Boolean(d.classifyMeta?.referenceVisual?.refined);
  const stage1TopFromMeta = d.classifyMeta?.referenceVisual?.textTop3Before?.[0]?.id;
  const stage1TextTop = refinedByImage
    ? stage1TopFromMeta
    : d.top3?.[0]?.id ?? stage1TopFromMeta;

  const visualLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
  const confidence = d.confidence ?? 0;
  const margin = d.margin ?? 0;
  const decision = d.decision;
  const low = refinedByImage ? false : isLowConfidenceForUsage(decision, confidence, margin);

  const clipSpriteSheet = visualLabel === "sprite_sheet";
  const stage1SaysSpriteSheet = stage1TextTop === "sprite_sheet";
  const nameLooksLikeSource = basenameSuggestsSourceBasename(fn);
  const isSpriteSheetStructure =
    clipSpriteSheet || stage1SaysSpriteSheet || nameLooksLikeSource;

  const isAtomic = Boolean(d.atomicFolderContext?.protectedAtomic);

  let structure;
  if (isSpriteSheetStructure) {
    structure = "sprite_sheet";
  } else if (isAtomic) {
    structure = "animation";
  } else {
    structure = "single_asset";
  }

  const extractionAlreadyInFolder =
    structure === "sprite_sheet" && folderShowsExtractedSpriteSiblings(d.file.absPath);

  const labels = REFERENCE_LABEL_NAMES || Object.keys(CATEGORY_BY_ID);
  let content;
  if (d.atomicFolderContext?.folderLabel) {
    content = d.atomicFolderContext.folderLabel;
  } else {
    const r = resolveLabelFromTokens(extractFilenameTokens(fn), labels);
    content = r.label ?? visualLabel ?? "unspecified";
  }

  let usage;
  if (structure === "sprite_sheet") {
    usage = extractionAlreadyInFolder ? "redundant_source" : "needs_extraction";
  } else if (low) {
    usage = "review";
  } else {
    usage = "ready";
  }

  let state;
  if (isSpriteSheetStructure) {
    state = extractionAlreadyInFolder ? "REDUNDANT_SOURCE" : "SOURCE";
  } else if (isAtomic) {
    state = "COMPOSITE";
  } else {
    state = "USABLE";
  }

  const contentHint = [`content:${content}`, visualLabel ? `clip:${visualLabel}` : null]
    .filter(Boolean)
    .join(" | ");

  const sourceReasons = [];
  if (clipSpriteSheet) sourceReasons.push("clip_predicted_sprite_sheet");
  if (stage1SaysSpriteSheet) sourceReasons.push("stage1_text_clip_sprite_sheet");
  if (nameLooksLikeSource) sourceReasons.push("filename_contains_source_hint");
  if (extractionAlreadyInFolder) sourceReasons.push("extracted_siblings_in_folder");

  const doNotUseDirectly = usage === "needs_extraction" || usage === "redundant_source";
  let recommendedAction;
  if (usage === "review") {
    recommendedAction = "Low confidence — verify manually before use or extraction";
  } else if (usage === "redundant_source") {
    recommendedAction =
      "Cut sprites already in this folder — remove or archive the master sheet; do not promote it as final art";
  } else if (usage === "needs_extraction") {
    recommendedAction =
      "Requires preprocessing — do not move into primary usable folders as final art (DO NOT USE DIRECTLY)";
  } else if (isAtomic) {
    recommendedAction = "Multi-frame folder — keep intact until integrated (protected)";
  } else {
    recommendedAction = "OK as a single in-game asset";
  }

  return {
    structure,
    content,
    usage,
    state,
    contentHint,
    visualLabel,
    extractionSatisfiedInFolder: extractionAlreadyInFolder,
    sourceReasons,
    recommendedAction,
    doNotUseDirectly,
    primaryNotUsable: doNotUseDirectly,
  };
}

/** Label vs CLIP agreement for reports: sprite_sheet is format, not a semantic mismatch vs content. */
function referenceAgreementForReport(nameLabel, visualLabel, ext) {
  if (ext.usage === "review") {
    return { key: "unknown", emoji: "❌", text: "UNKNOWN" };
  }
  if (ext.usage === "redundant_source") {
    return {
      key: "redundant",
      emoji: "♻️",
      text: "REDUNDANT SOURCE (cut cells already beside this file)",
    };
  }
  if (ext.structure === "sprite_sheet") {
    return { key: "format", emoji: "ℹ️", text: "OK (format vs content — not a semantic mismatch)" };
  }
  if (!nameLabel) {
    return { key: "unknown", emoji: "❌", text: "UNKNOWN" };
  }
  if (nameLabel.toLowerCase() === String(visualLabel).toLowerCase()) {
    return { key: "ready", emoji: "✅", text: "READY" };
  }
  return { key: "mismatch", emoji: "⚠️", text: "MISMATCH" };
}

function printReferenceAssetStateLines(ext) {
  console.log(`   structure: ${ext.structure}`);
  console.log(`   content: ${ext.content}`);
  console.log(`   usage: ${ext.usage}`);
  console.log(`   (bucket) ${ext.state}  |  ${ext.contentHint}`);
  console.log(`   recommended action: ${ext.recommendedAction}`);
  if (ext.doNotUseDirectly) {
    console.log(`   flags: DO NOT USE DIRECTLY — not for primary usable folders as final assets`);
  }
  if (ext.state === "SOURCE") {
    console.log(`   ❗ SOURCE material (atlas / packed):`);
    console.log(`      action: requires extraction before use`);
  }
  if (ext.state === "REDUNDANT_SOURCE") {
    console.log(`   ♻️ REDUNDANT master sheet — extracted sprites already in this folder`);
    console.log(`      action: archive or delete the sheet; do not auto-move as final art`);
  }
}

function reconcileUnifiedRedundantSourceDecisions(decisions) {
  let n = 0;
  for (const d of decisions) {
    if (!d.classifyMeta?.unifiedIngest) continue;
    const ext = d.referenceAssetExtension;
    if (!ext || ext.usage !== "redundant_source") continue;
    if (d.decision !== "auto") continue;
    d.decision = "review";
    d.reason = "redundant_source_sheet";
    delete d.destRel;
    n++;
  }
  if (n) attachMetadataToDecisions(decisions);
  return n;
}

function attachReferenceAssetExtension(decisions) {
  for (const d of decisions) {
    d.referenceAssetExtension = deriveReferenceClassificationModel(d);
  }
}

function printUsageStateReport(decisions) {
  const groups = {
    ready: [],
    needs_extraction: [],
    redundant_source: [],
    review: [],
  };
  for (const d of decisions) {
    const ext = d.referenceAssetExtension ?? deriveReferenceClassificationModel(d);
    const u = ext.usage;
    if (groups[u]) {
      groups[u].push(d.file.relPosix);
    }
  }
  console.log("\n=== USAGE STATE REPORT ===\n");
  for (const key of ["ready", "needs_extraction", "redundant_source", "review"]) {
    const list = [...groups[key]].sort();
    console.log(`--- ${key} (${list.length}) ---`);
    for (const p of list) {
      console.log(`   ${p}`);
    }
    console.log("");
  }
}

function printPrimaryPromoteReport(moved, skipped) {
  console.log("\n=== PRIMARY PROMOTE REPORT ===\n");
  if (FLAG_EFFECTIVE_DRY) {
    console.log("(dry-run — no files were moved)\n");
  }
  console.log(`--- moved (${moved.length}) ---`);
  for (const m of moved) {
    const tag = m.dry ? "[dry] " : "";
    console.log(
      `   ${tag}${m.type}: ${path.relative(ROOT, m.from)} → ${m.rel}`,
    );
  }
  console.log("");
  const order = [
    ["needs_extraction", "usage: needs_extraction (source / atlas — leave in place)"],
    ["redundant_source", "usage: redundant_source (master sheet — do not promote)"],
    ["review", "usage: review (low confidence — leave in place)"],
    ["no_mapping", "no PRIMARY route for content label"],
    ["not_in_inbox", "path not under assets/New_Arrivals"],
    ["error", "move error"],
  ];
  for (const [key, label] of order) {
    const list = skipped[key] || [];
    if (!list.length) continue;
    console.log(`--- skipped: ${label} (${list.length}) ---`);
    for (const p of [...list].sort()) {
      console.log(`   ${p}`);
    }
    console.log("");
  }
}

/**
 * Move usage:ready assets to assets/PRIMARY/… — entire atomic folders as one unit.
 * Only runs with --reference-labels --primary-promote. Never moves needs_extraction or review.
 */
async function primaryPromoteFromUsageDecisions(decisions) {
  const moved = [];
  const skipped = {
    needs_extraction: [],
    redundant_source: [],
    review: [],
    no_mapping: [],
    not_in_inbox: [],
    error: [],
  };

  const atomicByFolder = new Map();
  const singleDecisions = [];

  for (const d of decisions) {
    const ext = d.referenceAssetExtension;
    if (!ext) {
      skipped.review.push(d.file.relPosix);
      continue;
    }
    if (d.atomicFolderContext?.protectedAtomic && d.atomicFolderContext.atomicFolderAbs) {
      const k = d.atomicFolderContext.atomicFolderAbs;
      if (!atomicByFolder.has(k)) atomicByFolder.set(k, []);
      atomicByFolder.get(k).push(d);
    } else {
      singleDecisions.push(d);
    }
  }

  const promotedFileAbs = new Set();

  for (const [folderAbs, group] of atomicByFolder) {
    const sample = group[0];
    const ext = sample.referenceAssetExtension;
    if (!isPathUnderRoot(folderAbs, SOURCE_DIR)) {
      for (const d of group) skipped.not_in_inbox.push(d.file.relPosix);
      continue;
    }
    if (ext.usage !== "ready") {
      const key =
        ext.usage === "needs_extraction"
          ? "needs_extraction"
          : ext.usage === "redundant_source"
            ? "redundant_source"
            : "review";
      for (const d of group) skipped[key].push(d.file.relPosix);
      continue;
    }
    const destRel = primaryDestRelForContent(ext.content);
    if (!destRel) {
      for (const d of group) skipped.no_mapping.push(d.file.relPosix);
      continue;
    }
    const destParent = path.join(ROOT, destRel);
    const folderName = path.basename(folderAbs);
    let destFolder = path.join(destParent, folderName);
    try {
      if (!isPathUnderRoot(destFolder, ROOT)) {
        throw new Error("destination outside ROOT");
      }
      destFolder = await uniqueDestDirPath(destFolder);
      const relTo = path.relative(ROOT, destFolder).split(path.sep).join("/");
      if (FLAG_EFFECTIVE_DRY) {
        moved.push({
          type: "folder",
          dry: true,
          from: folderAbs,
          to: destFolder,
          rel: relTo,
        });
      } else {
        await fs.ensureDir(destParent);
        await fs.move(folderAbs, destFolder, { overwrite: false });
        moved.push({
          type: "folder",
          dry: false,
          from: folderAbs,
          to: destFolder,
          rel: relTo,
        });
      }
      for (const d of group) promotedFileAbs.add(d.file.absPath);
    } catch (e) {
      for (const d of group) {
        skipped.error.push(`${d.file.relPosix}: ${e?.message || e}`);
      }
    }
  }

  for (const d of singleDecisions) {
    if (promotedFileAbs.has(d.file.absPath)) continue;
    const ext = d.referenceAssetExtension;
    if (!ext) {
      skipped.review.push(d.file.relPosix);
      continue;
    }
    if (!isPathUnderRoot(d.file.absPath, SOURCE_DIR)) {
      skipped.not_in_inbox.push(d.file.relPosix);
      continue;
    }
    if (ext.usage !== "ready") {
      const key =
        ext.usage === "needs_extraction"
          ? "needs_extraction"
          : ext.usage === "redundant_source"
            ? "redundant_source"
            : "review";
      skipped[key].push(d.file.relPosix);
      continue;
    }
    const destRel = primaryDestRelForContent(ext.content);
    if (!destRel) {
      skipped.no_mapping.push(d.file.relPosix);
      continue;
    }
    const destDir = path.join(ROOT, destRel);
    const baseName = path.basename(d.file.absPath);
    let destPath = path.join(destDir, baseName);
    try {
      if (!FLAG_EFFECTIVE_DRY) {
        await fs.ensureDir(destDir);
        destPath = await uniqueDestPathPrimaryFile(destPath);
        await fs.move(d.file.absPath, destPath, { overwrite: false });
      } else {
        destPath = await uniqueDestPathPrimaryFile(destPath);
      }
      const relTo = path.relative(ROOT, destPath).split(path.sep).join("/");
      moved.push({
        type: "file",
        dry: FLAG_EFFECTIVE_DRY,
        from: d.file.absPath,
        to: destPath,
        rel: relTo,
      });
    } catch (e) {
      skipped.error.push(`${d.file.relPosix}: ${e?.message || e}`);
    }
  }

  printPrimaryPromoteReport(moved, skipped);
  await logJsonlLine({
    t: new Date().toISOString(),
    event: "primary_promote",
    dryRun: FLAG_EFFECTIVE_DRY,
    movedCount: moved.length,
    skipped,
  });
}

function printReferenceVisualSupplementLines(d) {
  const rv = d.classifyMeta?.referenceVisual;
  if (!rv) return;
  if (rv.refined && rv.textTop3Before?.length) {
    console.log(
      `   [stage1 text CLIP top3]: ${rv.textTop3Before.map((x) => `${x.id}:${x.confidence.toFixed(3)}`).join(", ")}`,
    );
    console.log(
      `   [stage2 image↔ref] promoted → ${d.clipId} | best cos ${Number(rv.bestCosine).toFixed(3)} | Δcos ${Number(rv.cosineMarginRaw).toFixed(3)}`,
    );
    return;
  }
  if (rv.refinementSkipped) {
    console.log(`   [stage2 image↔ref] skipped: ${rv.refinementSkipped}`);
  }
}

function printReferenceClassificationReport(decisions) {
  const labels = REFERENCE_LABEL_NAMES || Object.keys(CATEGORY_BY_ID);
  console.log("\n=== reference_images visual classification report ===\n");
  for (const d of decisions) {
    const fn = path.basename(d.file.absPath);
    const visualLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
    const confidence = d.confidence ?? 0;
    const margin = d.margin ?? 0;
    const ext = d.referenceAssetExtension ?? deriveReferenceClassificationModel(d);

    if (d.atomicFolderContext?.protectedAtomic) {
      const ctx = d.atomicFolderContext;
      const st = referenceAgreementForReport(ctx.folderLabel, visualLabel, ext);
      if (ext.state === "SOURCE") {
        console.log(`❗ SOURCE  ${fn}`);
      } else if (ext.state === "REDUNDANT_SOURCE") {
        console.log(`♻️ REDUNDANT SOURCE  ${fn}`);
      } else if (ext.state === "COMPOSITE") {
        console.log(`✅ COMPOSITE (protected)  ${fn}`);
      } else {
        const head = st.key === "ready" ? `✅ USABLE (${st.text})` : `${st.emoji} ${st.text}`;
        console.log(`${head}  ${fn}`);
      }
      console.log(`   PROTECTED - DO NOT SPLIT`);
      console.log(`   folder: ${ctx.folderRel}`);
      console.log(`   folder name tokens: ${ctx.folderTokens.join(", ") || "(none)"}`);
      if (ctx.labelAliasTrace?.length) {
        console.log(`   alias resolution (token -> mapped):`);
        for (const h of ctx.labelAliasTrace) {
          const note = h.accepted ? "" : " (no reference_images/<label> for this mapping)";
          console.log(`      "${h.original}" -> ${h.mapped} [${h.kind}]${note}`);
        }
      }
      if (ctx.folderLabelMatch) {
        console.log(`   folder label source: ${ctx.folderLabelMatch}`);
      }
      console.log(
        `   folder label: ${ctx.folderLabel ?? "(none)"}  |  predicted label: ${visualLabel ?? "(none)"}  |  confidence: ${confidence.toFixed(4)}  |  margin: ${margin.toFixed(4)}`,
      );
      printReferenceVisualSupplementLines(d);
      console.log(`   decision: ${d.decision}  reason: ${d.reason ?? ""}`);
      if (ext.sourceReasons?.length) {
        console.log(`   source signals: ${ext.sourceReasons.join(", ")}`);
      }
      printReferenceAssetStateLines(ext);
      console.log("");
      continue;
    }

    const tokens = extractFilenameTokens(fn);
    const resolved = resolveLabelFromTokens(tokens, labels);
    const filenameLabel = resolved.label;
    const st = referenceAgreementForReport(filenameLabel, visualLabel, ext);
    if (ext.state === "SOURCE") {
      console.log(`❗ SOURCE  ${fn}`);
    } else if (ext.state === "REDUNDANT_SOURCE") {
      console.log(`♻️ REDUNDANT SOURCE  ${fn}`);
    } else {
      const head = st.key === "ready" ? `✅ USABLE (${st.text})` : `${st.emoji} ${st.text}`;
      console.log(`${head}  ${fn}`);
    }
    console.log(`   filename tokens: ${tokens.join(", ") || "(none)"}`);
    if (resolved.tokenHits.length) {
      console.log(`   alias resolution (token -> mapped):`);
      for (const h of resolved.tokenHits) {
        const note = h.accepted ? "" : " (no matching reference label)";
        console.log(`      "${h.original}" -> ${h.mapped} [${h.kind}]${note}`);
      }
    }
    if (resolved.matchedBy) {
      console.log(`   filename label source: ${resolved.matchedBy}`);
    }
    console.log(
      `   filename label: ${filenameLabel ?? "(none)"}  |  predicted label: ${visualLabel ?? "(none)"}  |  confidence: ${confidence.toFixed(4)}  |  margin: ${margin.toFixed(4)}`,
    );
    printReferenceVisualSupplementLines(d);
    console.log(`   decision: ${d.decision}  reason: ${d.reason ?? ""}`);
    if (ext.sourceReasons?.length) {
      console.log(`   source signals: ${ext.sourceReasons.join(", ")}`);
    }
    printReferenceAssetStateLines(ext);
    console.log("");
  }
}

function printAtomicFolderReport(decisions) {
  const byFolder = new Map();
  for (const d of decisions) {
    const ctx = d.atomicFolderContext;
    if (!ctx?.protectedAtomic) continue;
    const k = ctx.folderAbs;
    if (!byFolder.has(k)) {
      byFolder.set(k, {
        ctx,
        decision: d,
        files: [],
      });
    }
    byFolder.get(k).files.push(path.basename(d.file.absPath));
  }

  console.log("\n=== ATOMIC FOLDER REPORT ===\n");
  console.log(`total atomic folders detected: ${byFolder.size}\n`);

  const protectedList = [];

  for (const [, { ctx, decision: d, files }] of byFolder) {
    const visualLabel = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
    const confidence = d.confidence ?? 0;
    const margin = d.margin ?? 0;
    const ext = d.referenceAssetExtension ?? deriveReferenceClassificationModel(d);
    const st = referenceAgreementForReport(ctx.folderLabel, visualLabel, ext);
    const folderRel = ctx.folderRel;
    protectedList.push(folderRel);
    if (ext.state === "SOURCE") {
      console.log(`❗ SOURCE (folder aggregate)`);
    } else if (ext.state === "REDUNDANT_SOURCE") {
      console.log(`♻️ REDUNDANT SOURCE (folder aggregate)`);
    } else if (ext.state === "COMPOSITE") {
      console.log(`✅ COMPOSITE (protected)`);
    } else {
      console.log(`${st.emoji} ${st.text}`);
    }
    console.log(`   folder: ${folderRel}`);
    console.log(
      `   structure: ${ext.structure} | content: ${ext.content} | usage: ${ext.usage}`,
    );
    console.log(`   asset state: ${ext.state}`);
    console.log(`   inferred label: ${visualLabel ?? "(none)"}  confidence: ${confidence.toFixed(4)}  margin: ${margin.toFixed(4)}`);
    console.log(`   folder label (direct + alias): ${ctx.folderLabel ?? "(none)"}`);
    if (ctx.labelAliasTrace?.length) {
      console.log(`   alias resolution (token -> mapped):`);
      for (const h of ctx.labelAliasTrace) {
        const note = h.accepted ? "" : " (no reference_images/<label> for this mapping)";
        console.log(`      "${h.original}" -> ${h.mapped} [${h.kind}]${note}`);
      }
    }
    if (ctx.folderLabelMatch) {
      console.log(`   folder label source: ${ctx.folderLabelMatch}`);
    }
    console.log(`   recommended action: ${ext.recommendedAction}`);
    if (ext.doNotUseDirectly) {
      console.log(`   flags: DO NOT USE DIRECTLY`);
    }
    console.log(`   files (${files.length}): ${files.sort().join(", ")}`);
    console.log("");
  }

  console.log("Protected folders (PROTECTED - DO NOT SPLIT):");
  for (const rel of protectedList.sort()) {
    console.log(` - ${rel}`);
  }
  console.log("");
}

function printUnifiedIngestSummary(decisions) {
  console.log("\n=== unified ingest (reference-only) ===\n");
  const by = { auto: 0, review: 0, error: 0 };
  for (const d of decisions) {
    by[d.decision] = (by[d.decision] || 0) + 1;
  }
  console.log(`   auto=${by.auto}  review=${by.review}  error=${by.error}`);
  console.log(
    `   move when cosine ≥ ${UNIFIED_HIGH_CONFIDENCE} and cosine-margin ≥ ${UNIFIED_MIN_PROB_MARGIN} (vs 2nd label)`,
  );
  console.log("");
}

/**
 * Classify each inbox raster by CLIP image embedding vs reference_images/ only (softmax over labels).
 * @returns {Promise<Array>} decisions aligned with `records`
 */
async function runUnifiedIngestDecisions(records, metrics) {
  const featureExtractor = await getImageFeatureExtractor();
  const refTable = await loadReferenceEmbeddingTable(featureExtractor);
  if (!refTable.ok) {
    throw new Error(
      "unified-ingest: need reference_images/<label>/**/*.png with at least one image per label",
    );
  }
  console.log(
    `[unified-ingest] reference embeddings: ${refTable.loaded} (${refTable.byLabel?.size ?? 0} labels, failed=${refTable.failed})`,
  );

  const embCache = new Map();
  const decisions = [];
  const tClass = performance.now();

  for (const rec of records) {
    const fn = path.basename(rec.absPath);

    if (basenameSuggestsSourceBasename(fn) && !folderShowsExtractedSpriteSiblings(rec.absPath)) {
      decisions.push(
        attachAtomicFolderContextUnified(rec, {
          file: { absPath: rec.absPath, relPosix: rec.relPosix, cacheKey: rec.cacheKey },
          top3: [],
          chosen: null,
          confidence: 0,
          margin: 0,
          decision: "review",
          reason: "source_atlas_filename_hint",
          clipId: null,
          classifyMeta: {
            mode: "unified_reference_visual",
            unifiedIngest: true,
            atlasHint: true,
          },
        }),
      );
      continue;
    }

    const inputNorm = await getInputEmbeddingNormReviewExport(
      rec,
      records,
      featureExtractor,
      embCache,
    );
    if (!inputNorm) {
      decisions.push(
        attachAtomicFolderContextUnified(rec, {
          file: { absPath: rec.absPath, relPosix: rec.relPosix, cacheKey: rec.cacheKey },
          top3: [],
          chosen: null,
          confidence: 0,
          margin: 0,
          decision: "error",
          reason: "input_embedding_failed",
          classifyMeta: { mode: "unified_reference_visual", unifiedIngest: true },
        }),
      );
      continue;
    }

    const cosByLabel = maxCosineByLabel(inputNorm, refTable.byLabel);

    // Sort by raw cosine — this is the primary confidence metric.
    // Softmax over 22+ labels with compressed game-art cosines (0.62–0.92 range)
    // never concentrates above ~0.15, making softmax-based thresholds unachievable.
    const sortedCos = [...cosByLabel.entries()].sort((a, b) => b[1] - a[1]);
    const bestC = sortedCos[0]?.[1] ?? 0;
    const secondC = sortedCos[1]?.[1] ?? null;
    const marginCos = secondC != null ? bestC - secondC : bestC;
    const chosenLabel = sortedCos[0]?.[0] ?? null;
    const secondLabel = sortedCos[1]?.[0] ?? null;

    // Also compute softmax for metadata/reporting only (not used for the gate).
    const visProbs = cosineMapToSoftmaxProbs(cosByLabel, VISUAL_SOFTMAX_TEMPERATURE);
    const ranked = [...visProbs.entries()]
      .map(([id, confidence]) => ({ id, confidence, dest: null }))
      .sort((a, b) => b.confidence - a.confidence);
    const top3 = categoryRankingToTop3(ranked);

    // chosen is the top raw-cosine label (not softmax), wrapped to match top3 shape.
    const chosen = chosenLabel ? { id: chosenLabel, confidence: bestC, dest: null } : null;
    const second = secondLabel ? { id: secondLabel, confidence: secondC ?? 0, dest: null } : null;

    const classifyMeta = {
      mode: "unified_reference_visual",
      unifiedIngest: true,
      referenceVisual: {
        softmaxTop3: top3,
        visualCosineTop3: sortedCos.slice(0, 3).map(([id, cosine]) => ({ id, cosine })),
        bestCosine: bestC,
        secondCosine: secondC,
        cosineMarginRaw: marginCos,
        refinementSkipped: "unified_authority_no_text_clip",
      },
    };

    const unifiedDestResolution = chosen ? resolveUnifiedDestination(chosen.id, bestC) : null;
    const dest = unifiedDestResolution?.dest ?? null;
    let decision;
    let reason;

    if (!chosen) {
      decision = "error";
      reason = "no_labels";
    } else if (!dest) {
      decision = "review";
      reason = "unknown_label_destination";
    } else if (bestC < UNIFIED_HIGH_CONFIDENCE || marginCos < UNIFIED_MIN_PROB_MARGIN) {
      decision = "review";
      const marginFail = marginCos < UNIFIED_MIN_PROB_MARGIN;
      const cosFail = bestC < UNIFIED_HIGH_CONFIDENCE;
      if (
        !cosFail &&
        marginFail &&
        isUnifiedHighConflictCosineTop2(chosenLabel, secondLabel)
      ) {
        reason = "high_conflict_low_margin";
      } else {
        reason = "unified_low_confidence_or_ambiguous";
      }
    } else {
      decision = "auto";
      reason = "unified_reference_confident";
    }

    decisions.push(
      attachAtomicFolderContextUnified(rec, {
        file: { absPath: rec.absPath, relPosix: rec.relPosix, cacheKey: rec.cacheKey },
        top3,
        chosen: chosen ?? null,
        unifiedDestResolution,
        // confidence and margin are now raw cosine values (0.0–1.0 scale),
        // matching UNIFIED_HIGH_CONFIDENCE and UNIFIED_MIN_PROB_MARGIN.
        confidence: bestC,
        margin: marginCos,
        decision,
        reason,
        clipId: chosen?.id ?? null,
        classifyMeta,
      }),
    );
  }

  metrics.classifyWallMsTotal += performance.now() - tClass;
  metrics.batchRuns += 1;
  metrics.batchTimesMs.push(performance.now() - tClass);
  return { decisions, featureExtractor, referenceVisualTable: refTable };
}

function attachAtomicFolderContextUnified(rec, dec) {
  if (!rec.isAtomicGroupMember || !rec.atomicFolderAbs) {
    return dec;
  }
  const refLabelsForAtomic = REFERENCE_LABEL_NAMES || Object.keys(CATEGORY_BY_ID);
  const folderName = path.basename(rec.atomicFolderAbs);
  const folderTokens = extractFilenameTokens(folderName);
  const resolved = resolveLabelFromTokens(folderTokens, refLabelsForAtomic);
  dec.atomicFolderContext = {
    folderAbs: rec.atomicFolderAbs,
    folderRel: path.relative(ROOT, rec.atomicFolderAbs).split(path.sep).join("/"),
    folderName,
    folderTokens,
    folderLabel: resolved.label,
    folderLabelMatch: resolved.matchedBy,
    labelAliasTrace: resolved.tokenHits,
    protectedAtomic: true,
  };
  return dec;
}

// --- orchestrator ---
async function runPipeline() {
  const tPipeline = performance.now();
  if (!FLAG_DRY_STRICT) {
    await fs.ensureDir(path.dirname(LOG_TEXT_PATH));
  }

  if (FLAG_EXPORT_REVIEW_LABELS && !FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    console.warn(
      "smart_catalog: --export-review-labels requires --reference-labels or use --unified-ingest (export will not run)",
    );
  }

  const metrics = {
    scanMs: 0,
    classifyWallMsTotal: 0,
    decisionMs: 0,
    moveMsTotal: 0,
    totalMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    filesTotal: 0,
    batchRuns: 0,
    batchTimesMs: [],
    decisions: { auto: 0, review: 0, error: 0 },
    configSignature: CONFIG_SIGNATURE,
    batchSizeInitial: BATCH_SIZE_CONFIG,
    batchAdaptive: FLAG_BATCH_ADAPTIVE,
  };

  const tScan = performance.now();
  const scannedAll = await scanStage(SCAN_ROOT);
  metrics.scanMs = performance.now() - tScan;

  if (!scannedAll.length) {
    console.log(
      "smart_catalog: no raster files under",
      path.relative(ROOT, SCAN_ROOT).split(path.sep).join("/"),
    );
    return;
  }

  const limited =
    Number.isFinite(MAX_FILES) && scannedAll.length > MAX_FILES
      ? scannedAll.slice(0, MAX_FILES)
      : scannedAll;
  if (limited.length < scannedAll.length) {
    console.warn(
      `smart_catalog: limiting run to ${MAX_FILES} of ${scannedAll.length} (--max-files=)`,
    );
  }

  metrics.filesTotal = limited.length;

  const pipelineScanned =
    FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST
      ? augmentScannedWithAtomic(limited, SOURCE_DIR)
      : limited;

  const cache = await loadCache();
  if (cache.signature !== CONFIG_SIGNATURE) {
    console.log(
      "smart_catalog: cache signature mismatch (categories/model/thresholds changed) — cold cache",
    );
  }

  const { records } = cacheFilterStage(pipelineScanned, cache);

  const toClassify = records.filter((r) => !r.fromCache);
  metrics.cacheHits = records.filter((r) => r.fromCache).length;
  metrics.cacheMisses = toClassify.length;

  let clipMap = new Map();
  if (!FLAG_UNIFIED_INGEST) {
    try {
      clipMap =
        toClassify.length > 0
          ? await classificationStageReferenceAware(toClassify, metrics)
          : new Map();
    } catch (stageErr) {
      console.error("smart_catalog: classification stage fatal:", stageErr?.message || stageErr);
      appendTextLog(`CLASSIFY_STAGE_FATAL ${String(stageErr?.message || stageErr)}`);
      for (const rec of toClassify) {
        clipMap.set(rec.absPath, {
          absPath: rec.absPath,
          sortedFlat: null,
          mode: "stage_fatal",
          classifyMs: 0,
          batchWallMs: 0,
          error: String(stageErr?.message || stageErr),
        });
      }
    }
  }

  const tDecide = performance.now();
  let decisions = [];
  let unifiedFeatureExtractor = null;
  let unifiedReferenceTable = null;
  const refLabelsForAtomic = REFERENCE_LABEL_NAMES || Object.keys(CATEGORY_BY_ID);

  function attachAtomicFolderContext(rec, dec) {
    if (
      (FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST) &&
      rec.isAtomicGroupMember &&
      rec.atomicFolderAbs
    ) {
      const folderName = path.basename(rec.atomicFolderAbs);
      const folderTokens = extractFilenameTokens(folderName);
      const resolved = resolveLabelFromTokens(folderTokens, refLabelsForAtomic);
      dec.atomicFolderContext = {
        folderAbs: rec.atomicFolderAbs,
        folderRel: path.relative(ROOT, rec.atomicFolderAbs).split(path.sep).join("/"),
        folderName,
        folderTokens,
        folderLabel: resolved.label,
        folderLabelMatch: resolved.matchedBy,
        labelAliasTrace: resolved.tokenHits,
        protectedAtomic: true,
      };
    }
    return dec;
  }

  if (FLAG_UNIFIED_INGEST) {
    const u = await runUnifiedIngestDecisions(records, metrics);
    decisions = u.decisions;
    unifiedFeatureExtractor = u.featureExtractor;
    unifiedReferenceTable = u.referenceVisualTable;
  } else {
    for (const rec of records) {
      try {
        if (rec.fromCache) {
          const dec = buildDecisionFromCache(rec, rec.cachedTop3, {
            mode: "cache",
            classifyMs: 0,
          });
          decisions.push(attachAtomicFolderContext(rec, dec));
          continue;
        }

        const cr = clipMap.get(rec.absPath);
        const classifyMeta = cr
          ? {
              mode: cr.mode,
              classifyMs: cr.classifyMs,
              batchWallMs: cr.batchWallMs,
              fallbackReason: cr.fallbackReason,
              error: cr.error,
            }
          : { mode: "missing", error: "no_classification_row" };

        const dec = decisionStage(rec, cr?.sortedFlat ?? null, classifyMeta);
        decisions.push(attachAtomicFolderContext(rec, dec));
      } catch (decErr) {
        decisions.push({
          file: {
            absPath: rec.absPath,
            relPosix: rec.relPosix,
            cacheKey: rec.cacheKey,
          },
          top3: [],
          chosen: null,
          confidence: 0,
          margin: 0,
          decision: "error",
          reason: "decision_stage_exception",
          classifyMeta: { error: String(decErr?.message || decErr) },
        });
      }
    }
  }
  metrics.decisionMs = performance.now() - tDecide;

  attachMetadataToDecisions(decisions);

  let referenceImageRefinementUpgrades = [];
  /** @type {null | { eligibleSeen: number, upgraded: number, failedInputEmbedding: number, failedGates: number, failedReasons?: Record<string, number> }} */
  let referenceImageRefinementStats = null;
  let featureExtractor = unifiedFeatureExtractor;
  let referenceVisualTable = unifiedReferenceTable;

  if (FLAG_UNIFIED_INGEST) {
    attachReferenceAssetExtension(decisions);
    reconcileUnifiedRedundantSourceDecisions(decisions);
    printUnifiedIngestSummary(decisions);
  } else if (FLAG_REFERENCE_LABELS) {
    attachReferenceAssetExtension(decisions);

    const nRefineEligible = decisions.filter(eligibleForImageRefinement).length;
    if (nRefineEligible > 0) {
      try {
        featureExtractor = await getImageFeatureExtractor();
        referenceVisualTable = await loadReferenceEmbeddingTable(featureExtractor);
        console.log(
          `[reference] stage 2 image refinement: ${nRefineEligible} eligible review asset(s); ` +
            `${referenceVisualTable.loaded} reference embedding(s) (${referenceVisualTable.byLabel.size} labels)`,
        );
        if (!referenceVisualTable.ok) {
          console.warn("[reference] refinement skipped — no usable embeddings in reference_images/");
        } else {
          const refPass = await runReferenceImageRefinementPass(
            decisions,
            records,
            featureExtractor,
            referenceVisualTable,
          );
          referenceImageRefinementUpgrades = refPass.upgrades;
          referenceImageRefinementStats = refPass.stats;
          attachMetadataToDecisions(decisions);
          attachReferenceAssetExtension(decisions);
        }
      } catch (e) {
        console.warn("[reference] image refinement failed:", e?.message || e);
      }
      printReferenceImageRefinementReport(
        referenceImageRefinementUpgrades,
        referenceImageRefinementStats,
        referenceVisualTable,
      );
    }
  }

  for (const d of decisions) {
    metrics.decisions[d.decision] = (metrics.decisions[d.decision] || 0) + 1;
  }

  let cacheDirty = false;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const d = decisions[i];
    if (!rec.fromCache && d.top3?.length && d.decision !== "error") {
      cache.entries[rec.cacheKey] = {
        signature: CONFIG_SIGNATURE,
        top3: d.top3,
        relPosix: rec.relPosix,
        mtimeMs: rec.mtimeMs,
        size: rec.size,
      };
      cacheDirty = true;
    }
    if (!rec.fromCache && d.decision === "error" && !clipMap.get(rec.absPath)?.sortedFlat) {
      /* classify failure — do not cache */
    }
  }

  if (FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    console.log(
      FLAG_PRIMARY_PROMOTE
        ? "smart_catalog: reference mode — legacy inbox moves disabled; PRIMARY promote runs after reports"
        : "smart_catalog: reference mode — no file moves (classification + reporting only)",
    );
  }
  if (FLAG_UNIFIED_INGEST) {
    if (FLAG_REPROCESS_REVIEW) {
      console.log(
        "smart_catalog: reprocess-review — assets/New_Arrivals/review/ only; auto-moves logged to tools/unified_move_log.json; surfacing review reasons → review.md + tools/unified_place_cards.json",
      );
    } else {
      console.log(
        "smart_catalog: unified-ingest — moves use raw cosine vs reference pool; cosine threshold",
        UNIFIED_HIGH_CONFIDENCE,
        "/ cosine-margin",
        UNIFIED_MIN_PROB_MARGIN,
      );
    }
  }

  const tMove = performance.now();
  const moveResults = await fileOperationsStage(decisions);
  metrics.moveMsTotal = performance.now() - tMove;

  for (const mr of moveResults) {
    const d = mr.d;
    const line = {
      t: new Date().toISOString(),
      file: d.file,
      top3: d.top3,
      chosen: d.chosen,
      confidence: d.confidence,
      margin: d.margin,
      decision: d.decision,
      predictions: d.top3,
      scores: d.top3.map((x) => x.confidence),
      reason: d.reason,
      clipId: d.clipId,
      classifyMeta: d.classifyMeta,
      assetMetadata: d.assetMetadata,
      atomicFolderContext: d.atomicFolderContext ?? null,
      referenceAssetExtension:
        FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST ? (d.referenceAssetExtension ?? null) : null,
      move: mr.ok ? mr.kind : "move_failed",
      dest: mr.destPath ? path.relative(ROOT, mr.destPath) : null,
      moveOk: mr.ok,
      moveError: mr.error,
      moveMs: mr.moveMs,
    };
    await logStructuredDecision(line);

    if (FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
      continue;
    }

    if (d.decision === "auto" && mr.ok) {
      const cls = d.assetMetadata?.classification;
      const typeStr = cls ? `${cls.type}/${cls.subtype}` : "";
      console.log(
        `${d.classifyMeta?.fromCache ? "[cache] " : ""}auto ->`,
        path.relative(ROOT, mr.destPath),
        typeStr,
        `(clip ${d.clipId || "n/a"})`,
      );
      appendTextLog(
        `AUTO ${d.file.absPath} -> ${path.relative(ROOT, mr.destPath)} | ${typeStr} | clip=${d.clipId || ""}`,
      );
    } else if (d.decision === "review" && mr.ok) {
      if (mr.kind === "unified_review_pending") {
        console.log(
          "review (pending place card, file unchanged) ->",
          path.relative(ROOT, d.file.absPath).split(path.sep).join("/"),
        );
      } else {
        console.log("review ->", path.relative(ROOT, mr.destPath || REVIEW_DIR));
      }
      appendTextLog(`REVIEW ${d.file.absPath} | margin=${d.margin.toFixed(4)}`);
    } else if (d.decision === "error" && mr.ok) {
      appendTextLog(`ERROR ${d.file.absPath} | ${d.reason}`);
    } else if (!mr.ok) {
      appendTextLog(`MOVE_FAIL ${d.file.absPath} | ${mr.error}`);
    }
  }

  if (FLAG_UNIFIED_INGEST || FLAG_REFERENCE_LABELS) {
    printReferenceClassificationReport(decisions);
    printAtomicFolderReport(decisions);
    printUsageStateReport(decisions);
  }
  if (FLAG_UNIFIED_INGEST) {
    try {
      await writeReviewLabelExports(decisions, records, featureExtractor, referenceVisualTable);
    } catch (e) {
      console.warn("smart_catalog: review export failed:", e?.message || e);
    }
    try {
      await writeUnifiedPlaceCards(decisions);
    } catch (e) {
      console.warn("smart_catalog: unified place cards failed:", e?.message || e);
    }
    if (FLAG_EFFECTIVE_DRY) {
      try {
        await writeUnifiedPreviewFile(decisions);
      } catch (e) {
        console.warn("smart_catalog: unified preview failed:", e?.message || e);
      }
    }
  } else if (FLAG_REFERENCE_LABELS) {
    if (FLAG_EXPORT_REVIEW_LABELS) {
      try {
        await writeReviewLabelExports(decisions, records, featureExtractor, referenceVisualTable);
      } catch (e) {
        console.warn("smart_catalog: review export failed:", e?.message || e);
      }
    }
    if (FLAG_EXPORT_GROUP_REVIEW) {
      try {
        const payload = await buildGroupReviewPayload(decisions, { mergeFromPath: REVIEW_GROUPS_JSON });
        await fs.writeJson(REVIEW_GROUPS_JSON, payload, { spaces: 2 });
        await fs.writeFile(REVIEW_GROUPS_MD, renderGroupReviewMarkdown(payload), "utf8");
        const ng = payload.folders?.reduce((a, f) => a + (f.groups?.length || 0), 0) ?? 0;
        const ns = payload.folders?.reduce((a, f) => a + (f.standalone?.length || 0), 0) ?? 0;
        const nu = payload.folders?.reduce((a, f) => a + (f.unresolved?.length || 0), 0) ?? 0;
        console.log(
          `smart_catalog: group review → ${path.relative(ROOT, REVIEW_GROUPS_JSON)} + ${path.relative(ROOT, REVIEW_GROUPS_MD)} (groups=${ng}, standalone=${ns}, unresolved=${nu})`,
        );
      } catch (e) {
        console.warn("smart_catalog: group review export failed:", e?.message || e);
      }
    }
    if (FLAG_PRIMARY_PROMOTE && FLAG_EXPORT_GROUP_REVIEW) {
      console.warn(
        "smart_catalog: skipping --primary-promote (--export-group-review: approve review_groups.json, then run node tools/execute_group_moves.mjs)",
      );
    } else if (FLAG_PRIMARY_PROMOTE) {
      await primaryPromoteFromUsageDecisions(decisions);
    }
  }

  metrics.totalMs = performance.now() - tPipeline;
  if (FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST) {
    metrics.imageRefinementUpgrades = referenceImageRefinementUpgrades.length;
    if (referenceImageRefinementStats) {
      metrics.imageRefinementStats = referenceImageRefinementStats;
    }
    if (referenceVisualTable) {
      metrics.referenceEmbeddingsLoaded = referenceVisualTable.loaded;
      metrics.referenceEmbeddingFailures = referenceVisualTable.failed;
    }
  }
  if (FLAG_UNIFIED_INGEST) {
    metrics.unifiedIngest = true;
  }
  const hitRate =
    metrics.filesTotal > 0 ? (metrics.cacheHits / metrics.filesTotal).toFixed(3) : "0";

  console.log("smart_catalog: metrics", {
    totalMs: Math.round(metrics.totalMs),
    scanMs: Math.round(metrics.scanMs),
    classifyWallMsTotal: Math.round(metrics.classifyWallMsTotal),
    decisionMs: Math.round(metrics.decisionMs),
    moveMsTotal: Math.round(metrics.moveMsTotal),
    cacheHits: metrics.cacheHits,
    cacheMisses: metrics.cacheMisses,
    cacheHitRate: hitRate,
    batchRuns: metrics.batchRuns,
    batchTimesMsSample: metrics.batchTimesMs.slice(0, 5).map((x) => Math.round(x)),
    decisions: metrics.decisions,
    signature: CONFIG_SIGNATURE.slice(0, 12) + "...",
    ...(FLAG_REFERENCE_LABELS || FLAG_UNIFIED_INGEST
      ? {
          imageRefinementUpgrades: metrics.imageRefinementUpgrades,
          ...(metrics.imageRefinementStats
            ? { imageRefinementStats: metrics.imageRefinementStats }
            : {}),
          ...(referenceVisualTable
            ? {
                referenceEmbeddingsLoaded: metrics.referenceEmbeddingsLoaded,
                referenceEmbeddingFailures: metrics.referenceEmbeddingFailures,
              }
            : {}),
          ...(FLAG_UNIFIED_INGEST ? { unifiedIngest: true } : {}),
        }
      : {}),
  });

  await logJsonlLine({
    t: new Date().toISOString(),
    event: "run_summary",
    metrics,
  });

  if (FLAG_VERBOSE_DECISIONS && decisions.length) {
    console.log("\n=== verbose-decisions ===\n");
    for (const d of decisions) {
      const rel = path.relative(ROOT, d.file.absPath).split(path.sep).join("/");
      const lab = d.clipId ?? d.chosen?.id ?? "(none)";
      const cf = d.confidence != null ? Number(d.confidence).toFixed(4) : "n/a";
      const mg = d.margin != null ? Number(d.margin).toFixed(4) : "n/a";
      console.log(`   ${rel} → label=${lab} conf=${cf} margin=${mg} decision=${d.decision} reason=${d.reason ?? ""}`);
    }
    console.log("");
  }

  if (cacheDirty && !FLAG_EFFECTIVE_DRY) {
    await saveCache(cache);
  }
  if (FLAG_EFFECTIVE_DRY && cacheDirty) {
    console.log("smart_catalog: dry-run (cache not written)");
  }
}

// --- watch ---
let processing = false;
let pendingRescan = false;

async function processAllInbox() {
  if (processing) {
    pendingRescan = true;
    return;
  }
  processing = true;
  try {
    await runPipeline();
  } finally {
    processing = false;
    if (pendingRescan) {
      pendingRescan = false;
      await processAllInbox();
    }
  }
}

function startWatch() {
  const watcher = chokidar.watch(SOURCE_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    ignored: [
      /(^|[\\/])_unclassified_clip([\\/]|$)/,
      /(^|[\\/])review([\\/]|$)/,
      /(^|[\\/])error([\\/]|$)/,
      /(^|[\\/])\.clip_temp([\\/]|$)/,
      /(^|[\\/])\./,
    ],
  });

  let debounce;
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      processAllInbox().catch((e) => console.error(e));
    }, 600);
  };

  watcher.on("add", (p) => {
    if (IMAGE_EXT.has(path.extname(p).toLowerCase())) {
      console.log("smart_catalog: new file", path.relative(ROOT, p));
      schedule();
    }
  });
  watcher.on("change", (p) => {
    if (IMAGE_EXT.has(path.extname(p).toLowerCase())) schedule();
  });

  console.log(
    "smart_catalog: watching",
    path.relative(ROOT, SOURCE_DIR),
    "(debounced). Ctrl+C to stop.",
  );
}

async function main() {
  if (!(await fs.pathExists(SOURCE_DIR))) {
    console.error("Missing source dir:", SOURCE_DIR);
    process.exit(1);
  }

  if (FLAG_PRIMARY_PROMOTE && !FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    console.error("smart_catalog: --primary-promote requires --reference-labels");
    process.exit(1);
  }

  if (FLAG_PRIMARY_PROMOTE && FLAG_UNIFIED_INGEST) {
    console.error(
      "smart_catalog: do not combine --primary-promote with --unified-ingest (unified already moves on confidence)",
    );
    process.exit(1);
  }

  if (FLAG_REPROCESS_REVIEW && !FLAG_UNIFIED_INGEST) {
    console.error("smart_catalog: --reprocess-review requires --unified-ingest");
    process.exit(1);
  }

  if (FLAG_REPROCESS_REVIEW && INBOX_SUBDIR_REL) {
    console.error("smart_catalog: do not combine --reprocess-review with --inbox-subdir");
    process.exit(1);
  }

  if (FLAG_REPROCESS_REVIEW) {
    await fs.ensureDir(REVIEW_DIR);
  }

  if (FLAG_UNIFIED_INGEST) {
    console.log(
      "smart_catalog: --unified-ingest — reference_images/ is the label set; CLIP image embeddings scored by cosine vs refs; auto-move if cosine ≥",
      UNIFIED_HIGH_CONFIDENCE,
      "and cosine-margin ≥",
      UNIFIED_MIN_PROB_MARGIN,
    );
  }

  if (FLAG_DRY_STRICT) {
    console.log(
      "smart_catalog: --dry-run-strict — no file moves, mkdir, cache, smart_catalog_log.txt, or smart_catalog.jsonl; review → *.preview.*; unified → tools/unified_preview.json",
    );
  } else if (FLAG_EFFECTIVE_DRY) {
    console.log(
      "smart_catalog: dry-run — no moves/cache; no mkdir for destinations; review → *.preview.*; unified → tools/unified_preview.json; logs still append unless --dry-run-strict",
    );
  }

  if (FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    console.log(
      "smart_catalog: reference label mode — CLIP classes mirror",
      REFERENCE_REL + "/",
      `(${REFERENCE_LABEL_NAMES?.length ?? 0} labels)`,
    );
    console.log(
      "\n[smart_catalog] Reference mode does not move files out of New_Arrivals (classification + reports only).\n" +
        "  To CLIP-sort into assets/ (auto + review/), run without --reference-labels, e.g.:\n" +
        "    npm run smart-catalog:move-to-assets\n" +
        "  To promote usage:ready into assets/PRIMARY after labeling, add --primary-promote.\n",
    );
  }

  if (FLAG_PRIMARY_PROMOTE) {
    console.log(
      "smart_catalog: PRIMARY promote enabled — only usage:ready → assets/PRIMARY/<route>/ (atomic folders move intact)",
    );
  }

  if (FLAG_EXPORT_GROUP_REVIEW && !FLAG_REFERENCE_LABELS && !FLAG_UNIFIED_INGEST) {
    console.error("smart_catalog: --export-group-review requires --reference-labels");
    process.exit(1);
  }
  if (FLAG_EXPORT_GROUP_REVIEW) {
    console.log(
      "smart_catalog: group review export — writes review_groups.json + review_groups.md (merges prior approvals); run execute_group_moves.mjs after editing",
    );
  }

  console.log(
    "smart_catalog:",
    CTU_CATEGORIES.length,
    "categories,",
    FLAT_LABELS.length,
    "CLIP labels | batch",
    BATCH_SIZE_CONFIG,
    FLAG_BATCH_ADAPTIVE ? "(adaptive)" : "",
  );
  console.log(
    `smart_catalog: auto if confidence>=${MIN_TOP_SCORE} and margin>=${MIN_MARGIN_VS_SECOND}; else review/`,
  );
  console.log("smart_catalog: model", MODEL_ID, "| cache sig", CONFIG_SIGNATURE.slice(0, 12) + "...");

  if (INBOX_SUBDIR_REL) {
    if (!(await fs.pathExists(SCAN_ROOT))) {
      console.error("smart_catalog: --inbox-subdir path not found:", SCAN_ROOT);
      process.exit(1);
    }
    const normSource = path.normalize(SOURCE_DIR);
    const normScan = path.normalize(SCAN_ROOT);
    if (normScan !== normSource && !normScan.startsWith(normSource + path.sep)) {
      console.error("smart_catalog: --inbox-subdir must stay under", SOURCE_DIR);
      process.exit(1);
    }
    console.log(
      "smart_catalog: inbox scope",
      path.relative(ROOT, SCAN_ROOT).split(path.sep).join("/"),
    );
  }

  await processAllInbox();

  if (FLAG_WATCH) {
    startWatch();
    process.on("SIGINT", () => {
      console.log("\nsmart_catalog: exiting watch.");
      process.exit(0);
    });
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
