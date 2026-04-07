#!/usr/bin/env node
/**
 * CLIP vision sort — staged pipeline: classify (batched) | decide (pure) | file ops | log.
 *
 * Usage:
 *   node tools/smart_catalog.mjs [--watch] [--dry-run] [--max-files=N]
 *   node tools/smart_catalog.mjs --batch-size=12
 *   node tools/smart_catalog.mjs --batch-adaptive   (shrink batch after fallback; grow after clean batch)
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

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

/** Bump when on-disk cache schema changes */
const CACHE_VERSION = 3;
const MODEL_ID = "Xenova/clip-vit-base-patch32";

const HYPOTHESIS = { hypothesis_template: "This is a photo of {}." };

const MIN_TOP_SCORE = 0.22;
const MIN_MARGIN_VS_SECOND = 0.035;

const BATCH_MIN = 1;
const BATCH_MAX = 32;
const BATCH_DEFAULT = 12;

// --- CLI ---
const ARGS = new Set(process.argv.slice(2));
const FLAG_WATCH = ARGS.has("--watch");
const FLAG_DRY = ARGS.has("--dry-run");
const FLAG_BATCH_ADAPTIVE = ARGS.has("--batch-adaptive");

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

// --- categories: multiple prompts per CTU bucket (aggregated after CLIP softmax) ---
const CTU_CATEGORIES = [
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
    dest: "assets/units/urban",
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
    dest: "assets/tiles/urban",
    prompts: [
      "ground tile, terrain patch, repeating floor texture, grass sand or pavement map cell",
      "isometric or top-down ground texture tile for a tile map",
    ],
  },
  {
    id: "buildings_structures",
    dest: "assets/buildings/medium",
    prompts: [
      "house, warehouse, bunker, hangar, or large building roof seen from top-down orthographic view",
      "rooftop, structure, or architectural mass seen from above",
    ],
  },
  {
    id: "vfx_combat",
    dest: "assets/vfx",
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

/** Flat CLIP labels + owner category id per index */
const FLAT_LABELS = [];
const LABEL_CATEGORY_ID = [];
for (const cat of CTU_CATEGORIES) {
  for (const p of cat.prompts) {
    FLAT_LABELS.push(p);
    LABEL_CATEGORY_ID.push(cat.id);
  }
}

const CATEGORY_BY_ID = Object.fromEntries(CTU_CATEGORIES.map((c) => [c.id, c]));

function computeConfigSignature() {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    model: MODEL_ID,
    hypothesis: HYPOTHESIS.hypothesis_template,
    minTop: MIN_TOP_SCORE,
    minMargin: MIN_MARGIN_VS_SECOND,
    categories: CTU_CATEGORIES.map((c) => ({ id: c.id, dest: c.dest, prompts: c.prompts })),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

const CONFIG_SIGNATURE = computeConfigSignature();

// --- model ---
let classifierPromise = null;

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = pipeline("zero-shot-image-classification", MODEL_ID);
  }
  return classifierPromise;
}

// --- utils ---
function shouldSkipDir(name) {
  return (
    name.startsWith(".") ||
    name === "_unclassified_clip" ||
    name === "review" ||
    name === "error" ||
    name === "README.md"
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
    const idx = FLAT_LABELS.indexOf(row.label);
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

// --- Stage: cache filter ---
function cacheFilterStage(scanned, cache) {
  const records = scanned.map((s) => {
    const key = cacheKey(s.relPosix, s.mtimeMs, s.size);
    const hit = cache.entries[key];
    if (
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
    const theme = themeHintFromRelPosix(d.file.relPosix);
    const clipTop3 = (d.top3 || []).map(({ id, confidence }) => ({ id, confidence }));
    const primaryClipId = d.chosen?.id ?? d.top3?.[0]?.id ?? null;
    d.assetMetadata = buildAssetMetadata(fn, clipTop3, primaryClipId, {
      reviewPending: d.decision === "review",
      ingestError: d.decision === "error",
    });
    const layoutHint = suggestedDestRelFromMetadata(d.assetMetadata, theme);
    d.assetMetadata.pipeline.folderLayoutHint = layoutHint;
    if (d.decision === "auto") {
      d.destRel = layoutHint;
    }
  }
}

// --- Stage: file operations (movement only) ---
async function fileOperationsStage(decisions) {
  const results = [];
  for (const d of decisions) {
    const absPath = d.file.absPath;
    const t0 = performance.now();

    try {
      if (d.decision === "auto" && d.destRel) {
        const destDir = path.join(ROOT, d.destRel);
        await fs.ensureDir(destDir);
        const baseName = path.basename(absPath);
        let destPath = path.join(destDir, baseName);
        destPath = await uniqueDestPath(destPath);
        if (FLAG_DRY) {
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
        await fs.ensureDir(REVIEW_DIR);
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
        if (!FLAG_DRY) {
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
          dry: FLAG_DRY,
        });
        continue;
      }

      await fs.ensureDir(ERROR_DIR);
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
      if (!FLAG_DRY) {
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
        dry: FLAG_DRY,
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
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_TEXT_PATH, `[${ts}] ${line}\n`, "utf8");
}

async function logJsonlLine(obj) {
  await fs.ensureDir(path.dirname(LOG_JSONL_PATH));
  fs.appendFileSync(LOG_JSONL_PATH, `${JSON.stringify(obj)}\n`, "utf8");
}

function logStructuredDecision(jsonlPayload) {
  return logJsonlLine(jsonlPayload);
}

// --- orchestrator ---
async function runPipeline() {
  const tPipeline = performance.now();
  await fs.ensureDir(path.dirname(LOG_TEXT_PATH));

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
  const scannedAll = await scanStage(SOURCE_DIR);
  metrics.scanMs = performance.now() - tScan;

  if (!scannedAll.length) {
    console.log("smart_catalog: no raster files under", path.relative(ROOT, SOURCE_DIR));
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

  const cache = await loadCache();
  if (cache.signature !== CONFIG_SIGNATURE) {
    console.log(
      "smart_catalog: cache signature mismatch (categories/model/thresholds changed) � cold cache",
    );
  }

  const { records } = cacheFilterStage(limited, cache);

  const toClassify = records.filter((r) => !r.fromCache);
  metrics.cacheHits = records.filter((r) => r.fromCache).length;
  metrics.cacheMisses = toClassify.length;

  let clipMap = new Map();
  try {
    clipMap =
      toClassify.length > 0 ? await classificationStage(toClassify, metrics) : new Map();
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

  const tDecide = performance.now();
  const decisions = [];

  for (const rec of records) {
    try {
      if (rec.fromCache) {
        decisions.push(
          buildDecisionFromCache(rec, rec.cachedTop3, {
            mode: "cache",
            classifyMs: 0,
          }),
        );
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

      decisions.push(decisionStage(rec, cr?.sortedFlat ?? null, classifyMeta));
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
  metrics.decisionMs = performance.now() - tDecide;

  attachMetadataToDecisions(decisions);

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
      move: mr.ok ? mr.kind : "move_failed",
      dest: mr.destPath ? path.relative(ROOT, mr.destPath) : null,
      moveOk: mr.ok,
      moveError: mr.error,
      moveMs: mr.moveMs,
    };
    await logStructuredDecision(line);

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
      console.log("review ->", path.relative(ROOT, mr.destPath || REVIEW_DIR));
      appendTextLog(`REVIEW ${d.file.absPath} | margin=${d.margin.toFixed(4)}`);
    } else if (d.decision === "error" && mr.ok) {
      appendTextLog(`ERROR ${d.file.absPath} | ${d.reason}`);
    } else if (!mr.ok) {
      appendTextLog(`MOVE_FAIL ${d.file.absPath} | ${mr.error}`);
    }
  }

  metrics.totalMs = performance.now() - tPipeline;
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
  });

  await logJsonlLine({
    t: new Date().toISOString(),
    event: "run_summary",
    metrics,
  });

  if (cacheDirty && !FLAG_DRY) {
    await saveCache(cache);
  }
  if (FLAG_DRY && cacheDirty) {
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
