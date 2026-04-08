#!/usr/bin/env node
/**
 * Sprite sheet -> per-frame PNGs under attached_assets/sprites/{unit}/
 * + optional merge into js/config/spriteAnimations.json (never overwrites existing keys/files).
 *
 * Usage:
 *   node tools/sprite_sheet_slice.mjs scan [--root attached_assets] [--min-cells 2]
 *   node tools/sprite_sheet_slice.mjs slice --input path/to/sheet.png --unit my_unit --cols 4 --rows 3
 *   node tools/sprite_sheet_slice.mjs slice --input sheet.png --unit my_unit --frame 64x72 --clips run:8,shot:2
 *   node tools/sprite_sheet_slice.mjs slice --input sheet.png --config sheet.sheet.json
 *
 * Flags:
 *   --dry-run          Print actions only
 *   --no-json          Do not update spriteAnimations.json
 *   --json-out PATH    Default: js/config/spriteAnimations.json
 */

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_SPRITES_ROOT = path.join(REPO_ROOT, "attached_assets", "sprites");
const DEFAULT_JSON = path.join(REPO_ROOT, "js", "config", "spriteAnimations.json");

const IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg"]);

/** Sheets: large enough to plausibly hold multiple frames; excludes extreme strips. */
const SCAN_MIN_SHORT_SIDE = 200;
const SCAN_MIN_LONG_SIDE = 320;
const SCAN_MAX_ASPECT = 4;

const BOOL_FLAGS = new Set(["dry-run", "no-json", "help"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const n = argv[i + 1];
      if (BOOL_FLAGS.has(key)) {
        out[key] = true;
      } else if (n && !n.startsWith("--")) {
        out[key] = n;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function suggestGrids(width, height) {
  const candidates = [];
  const maxDiv = 48;
  for (let cols = 1; cols <= maxDiv; cols++) {
    if (width % cols !== 0) continue;
    const fw = width / cols;
    for (let rows = 1; rows <= maxDiv; rows++) {
      if (height % rows !== 0) continue;
      const fh = height / rows;
      const ar = fw / Math.max(1, fh);
      if (ar < 0.4 || ar > 2.5) continue;
      if (fw < 12 || fh < 12) continue;
      if (fw > 2048 || fh > 2048) continue;
      const n = cols * rows;
      if (n > 400) continue;
      const squareness = 1 - Math.abs(Math.log(ar)) * 0.35;
      const sizePref = fw >= 32 && fh >= 32 && fw <= 512 && fh <= 512 ? 0.2 : 0;
      const notHugeGrid = n <= 120 ? 0.1 : 0;
      const score = squareness + sizePref + notHugeGrid - (n > 60 ? 0.15 : 0);
      candidates.push({ cols, rows, frameW: fw, frameH: fh, frames: n, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8);
}

async function isLikelySheet(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;
  try {
    const m = await sharp(absPath).metadata();
    if (!m.width || !m.height) return null;
    const w = m.width;
    const h = m.height;
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    const aspect = long / Math.max(1, short);
    if (aspect > SCAN_MAX_ASPECT) return null;
    if (short < SCAN_MIN_SHORT_SIDE || long < SCAN_MIN_LONG_SIDE) return null;
    const grids = suggestGrids(w, h);
    return {
      path: absPath,
      rel: path.relative(REPO_ROOT, absPath).replace(/\\/g, "/"),
      width: w,
      height: h,
      grids,
    };
  } catch {
    return null;
  }
}

async function walkScan(rootAbs, out = []) {
  if (!fs.existsSync(rootAbs)) return out;
  const st = fs.statSync(rootAbs);
  if (st.isFile()) {
    const hit = await isLikelySheet(rootAbs);
    if (hit) out.push(hit);
    return out;
  }
  for (const name of fs.readdirSync(rootAbs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(rootAbs, name);
    const s = fs.statSync(full);
    if (s.isDirectory()) await walkScan(full, out);
    else {
      const hit = await isLikelySheet(full);
      if (hit) out.push(hit);
    }
  }
  return out;
}

function parseFrameSpec(s) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(s).trim());
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function parseClipsSpec(spec, totalFrames) {
  if (!spec) return [{ name: "idle", count: totalFrames }];
  const parts = String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const [name, n] = seg.split(":");
      const count = parseInt(String(n).trim(), 10);
      if (!name || !Number.isFinite(count) || count < 1) {
        throw new Error(`Bad clip segment "${seg}" (use name:count)`);
      }
      return { name: name.trim(), count };
    });
  const sum = parts.reduce((a, p) => a + p.count, 0);
  if (sum !== totalFrames) {
    throw new Error(
      `Clip counts sum to ${sum} but grid has ${totalFrames} cells. Adjust --clips or grid.`,
    );
  }
  return parts;
}

function loadSidecarConfig(inputAbs) {
  const side = `${inputAbs}.sheet.json`;
  if (!fs.existsSync(side)) return null;
  const raw = fs.readFileSync(side, "utf8");
  return JSON.parse(raw);
}

async function sliceSheet({
  inputAbs,
  unit,
  cols,
  rows,
  clips,
  dryRun,
  writeJson,
  jsonPath,
}) {
  const meta = await sharp(inputAbs).metadata();
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error("Could not read image dimensions");

  const fw = Math.floor(W / cols);
  const fh = Math.floor(H / rows);
  if (fw * cols !== W || fh * rows !== H) {
    throw new Error(
      `Image ${W}x${H} is not evenly divisible by grid ${cols}x${rows}`,
    );
  }

  const total = cols * rows;
  const clipPlan = parseClipsSpec(clips, total);

  const outBase = path.join(DEFAULT_SPRITES_ROOT, unit);
  const relPrefix = `attached_assets/sprites/${unit}`;

  /** @type {Record<string, string[]>} */
  const craftpixClips = {};
  /** @type {Record<string, number>} */
  const frameCounts = {};

  let cellIndex = 0;
  for (const clip of clipPlan) {
    const paths = [];
    for (let i = 0; i < clip.count; i++) {
      const idxInGrid = cellIndex++;
      const gr = Math.floor(idxInGrid / cols);
      const gc = idxInGrid % cols;
      const left = gc * fw;
      const top = gr * fh;
      const outDir = path.join(outBase, clip.name);
      const outFile = path.join(outDir, `${i}.png`);
      const relPath = `${relPrefix}/${clip.name}/${i}.png`.replace(/\\/g, "/");

      if (fs.existsSync(outFile)) {
        console.log(`  skip (exists): ${relPath}`);
        paths.push(relPath);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(outDir, { recursive: true });
        await sharp(inputAbs)
          .extract({ left, top, width: fw, height: fh })
          .png()
          .toFile(outFile);
      }
      console.log(`  write ${relPath}`);
      paths.push(relPath);
    }
    craftpixClips[clip.name] = paths;
    frameCounts[clip.name] = clip.count;
  }

  if (cellIndex !== total) {
    throw new Error("Internal: clip assignment did not fill grid");
  }

  if (!writeJson || dryRun) {
    console.log(dryRun ? "(dry-run) JSON merge skipped" : "--no-json: skip spriteAnimations.json");
    return;
  }

  const jsonRaw = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(jsonRaw);
  if (data[unit]) {
    console.log(`  skip JSON: key "${unit}" already exists in spriteAnimations.json`);
    return;
  }

  const attackClip =
    clipPlan.find((c) => c.name === "shot" || c.name === "shoot")?.name ??
    clipPlan[0]?.name ??
    "idle";

  data[unit] = {
    attackClip,
    frameCounts,
    craftpixClips,
  };

  const ordered = { ...data };
  fs.writeFileSync(jsonPath, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  console.log(`  merged new key "${unit}" -> ${path.relative(REPO_ROOT, jsonPath)}`);
}

function pickDisplayGrid(grids, minCells) {
  if (!grids?.length) return null;
  const ok = grids.filter((g) => g.frames >= minCells);
  return ok[0] || grids[0];
}

async function cmdScan(args) {
  const minCells = Math.max(
    1,
    parseInt(String(args["min-cells"] ?? "2"), 10) || 2,
  );

  const roots = args.root
    ? [path.resolve(REPO_ROOT, args.root)]
    : [
        path.join(REPO_ROOT, "attached_assets"),
        path.join(REPO_ROOT, "attached_assets", "sprite_sheets"),
      ];

  const seen = new Set();
  const all = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    await walkScan(r, all);
  }
  const uniq = [];
  for (const h of all) {
    const k = path.resolve(h.path);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(h);
  }

  if (!uniq.length) {
    console.log("No candidate sprite sheets found (try lowering thresholds or add --root).");
    return;
  }

  console.log(
    `Found ${uniq.length} candidate image(s) (suggested grid favors ${minCells}+ cells; use --min-cells 1 for any).\n`,
  );
  for (const h of uniq) {
    const top = pickDisplayGrid(h.grids, minCells);
    console.log(`${h.rel}  (${h.width}x${h.height})`);
    if (top) {
      console.log(
        `  suggested grid: ${top.cols}x${top.rows} cells -> ${top.frameW}x${top.frameH} px (${top.frames} frames)`,
      );
    }
    const alts = h.grids.filter((g) => g !== top).slice(0, 4);
    if (alts.length) {
      console.log(
        `  alternatives: ${alts.map((g) => `${g.cols}x${g.rows}(${g.frameW}x${g.frameH})`).join(" | ")}`,
      );
    }
    console.log("");
  }
}

async function cmdSlice(args) {
  const dryRun = !!args["dry-run"];
  const writeJson = !args["no-json"];
  const jsonPath = path.resolve(REPO_ROOT, args["json-out"] || DEFAULT_JSON);

  const inputAbs = args.input
    ? path.resolve(REPO_ROOT, args.input)
    : null;
  if (!inputAbs || !fs.existsSync(inputAbs)) {
    console.error("Missing or invalid --input path");
    process.exit(1);
  }

  let unit = args.unit;
  let cols = args.cols ? parseInt(args.cols, 10) : null;
  let rows = args.rows ? parseInt(args.rows, 10) : null;
  let clips = args.clips || null;

  const cfgPath = args.config ? path.resolve(REPO_ROOT, args.config) : null;
  const sidecar = cfgPath
    ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
    : loadSidecarConfig(inputAbs);

  if (sidecar) {
    if (sidecar.unit) unit = sidecar.unit;
    if (Number.isFinite(sidecar.cols)) cols = sidecar.cols;
    if (Number.isFinite(sidecar.rows)) rows = sidecar.rows;
    if (Array.isArray(sidecar.clips)) {
      clips = sidecar.clips.map((c) => `${c.name}:${c.count}`).join(",");
    } else if (typeof sidecar.clips === "string") {
      clips = sidecar.clips;
    }
    if (Number.isFinite(sidecar.frameW) && Number.isFinite(sidecar.frameH)) {
      const m = await sharp(inputAbs).metadata();
      cols = Math.floor(m.width / sidecar.frameW);
      rows = Math.floor(m.height / sidecar.frameH);
      if (cols * sidecar.frameW !== m.width || rows * sidecar.frameH !== m.height) {
        throw new Error(
          "sidecar frameW x frameH does not divide sheet evenly; use cols/rows instead",
        );
      }
    }
  }

  if (args.frame) {
    const fh = parseFrameSpec(args.frame);
    if (!fh) {
      console.error("Use --frame WIDTHxHEIGHT e.g. --frame 64x64");
      process.exit(1);
    }
    const m = await sharp(inputAbs).metadata();
    if (m.width % fh.w !== 0 || m.height % fh.h !== 0) {
      console.error("Sheet dimensions not divisible by frame size");
      process.exit(1);
    }
    cols = m.width / fh.w;
    rows = m.height / fh.h;
  }

  if (!unit || !unit.trim()) {
    console.error('Set --unit name or "unit" in .sheet.json sidecar');
    process.exit(1);
  }
  unit = unit.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

  if (!cols || !rows || cols < 1 || rows < 1) {
    const m = await sharp(inputAbs).metadata();
    const g = suggestGrids(m.width, m.height)[0];
    if (!g) {
      console.error("Could not infer grid; pass --cols N --rows M or --frame WxH");
      process.exit(1);
    }
    console.log(
      `Using auto grid ${g.cols}x${g.rows} (${g.frameW}x${g.frameH}px). Override with --cols/--rows/--frame if wrong.`,
    );
    cols = g.cols;
    rows = g.rows;
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}Slicing ${path.relative(REPO_ROOT, inputAbs)} -> sprites/${unit}/ (${cols}x${rows})`,
  );

  await sliceSheet({
    inputAbs,
    unit,
    cols,
    rows,
    clips,
    dryRun,
    writeJson,
    jsonPath,
  });
}

function printHelp() {
  console.log(`
sprite_sheet_slice.mjs - cut uniform sprite sheets into PNG frames

  node tools/sprite_sheet_slice.mjs scan [--root attached_assets] [--min-cells 2]
  node tools/sprite_sheet_slice.mjs slice --input FILE --unit ID [options]

Options:
  --cols N --rows M     Grid layout (optional if auto-detect works)
  --frame 64x72         Cell size; derives cols/rows from image size
  --clips run:6,shot:2  Clip names and frame counts (row-major order)
  --config FILE.json    Sidecar (see below)
  --dry-run
  --no-json             Do not write spriteAnimations.json
  --json-out PATH

Sidecar (optional): same path as sheet + ".sheet.json" or --config:
  {
    "unit": "my_unit",
    "cols": 4,
    "rows": 2,
    "clips": [{ "name": "run", "count": 6 }, { "name": "shot", "count": 2 }]
  }

Existing PNG paths and JSON keys are never overwritten.
`);
}

const args = parseArgs(process.argv);
const cmd = args._[0] || "help";

try {
  if (cmd === "scan") await cmdScan(args);
  else if (cmd === "slice") await cmdSlice(args);
  else printHelp();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
