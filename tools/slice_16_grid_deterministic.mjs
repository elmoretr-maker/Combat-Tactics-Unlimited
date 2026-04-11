#!/usr/bin/env node
/**
 * Deterministic 16×16 sprite sheet slicer — no guessing, no ML.
 *
 * Usage:
 *   node tools/slice_16_grid_deterministic.mjs --input <file.png> [--input <file2.png> ...]
 *   node tools/slice_16_grid_deterministic.mjs --dir assets/New_Arrivals/urban_tiles_and_assets
 *
 * Output: assets/processed/<source_folder_name>/
 * Tile files: <sanitized_basename>_<col>_<row>.png
 *
 * Rules:
 * - Tile size fixed at 16×16; sheet width/height must be divisible by 16 or abort.
 * - Skips tiles that are fully transparent OR a single solid color (all pixels identical).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const TILE = 16;

function parseArgs(argv) {
  const inputs = [];
  let dir = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputs.push(path.resolve(REPO_ROOT, argv[++i]));
    } else if (a === "--dir" && argv[i + 1]) {
      dir = path.resolve(REPO_ROOT, argv[++i]);
      i++;
    }
  }
  return { inputs, dir };
}

/** Safe filename stem from original basename (no extension). */
function sanitizeBasename(base) {
  return base
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * @param {Buffer} rgba — length width*height*4
 * @param {number} w
 * @param {number} h
 * @returns {"ok"|"skip_transparent"|"skip_solid"}
 */
function classifyTilePixels(rgba, w, h) {
  const n = w * h;
  if (n === 0) return "skip_transparent";
  let allTransparent = true;
  let r0 = rgba[0];
  let g0 = rgba[1];
  let b0 = rgba[2];
  let a0 = rgba[3];
  let allSame = true;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (a !== 0) allTransparent = false;
    if (r !== r0 || g !== g0 || b !== b0 || a !== a0) allSame = false;
    if (!allTransparent && !allSame) return "ok";
  }
  if (allTransparent) return "skip_transparent";
  if (allSame) return "skip_solid";
  return "ok";
}

/**
 * @param {string} absInput
 * @param {string} outDirAbs — assets/processed/<folderName>/
 */
async function sliceSheet(absInput, outDirAbs) {
  const base = path.basename(absInput);
  const stem = sanitizeBasename(base);
  const report = {
    sheet: path.relative(REPO_ROOT, absInput).replace(/\\/g, "/"),
    width: 0,
    height: 0,
    columns: 0,
    rows: 0,
    expectedTiles: 0,
    written: 0,
    skippedTransparent: 0,
    skippedSolid: 0,
    error: null,
  };

  if (!fs.existsSync(absInput)) {
    report.error = "file not found";
    return report;
  }

  let meta;
  try {
    meta = await sharp(absInput).metadata();
  } catch (e) {
    report.error = String(e.message || e);
    return report;
  }

  const { width, height } = meta;
  if (!width || !height) {
    report.error = "missing width/height in metadata";
    return report;
  }

  report.width = width;
  report.height = height;

  if (width % TILE !== 0 || height % TILE !== 0) {
    report.error = `dimensions ${width}×${height} not divisible by ${TILE} — aborting sheet`;
    return report;
  }

  const columns = width / TILE;
  const rows = height / TILE;
  report.columns = columns;
  report.rows = rows;
  report.expectedTiles = columns * rows;

  fs.mkdirSync(outDirAbs, { recursive: true });

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const left = col * TILE;
      const top = row * TILE;

      const { data, info } = await sharp(absInput)
        .extract({ left, top, width: TILE, height: TILE })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      if (info.width !== TILE || info.height !== TILE) {
        report.error = `internal: extracted region not ${TILE}×${TILE} at (${col},${row})`;
        return report;
      }

      const kind = classifyTilePixels(data, info.width, info.height);
      if (kind === "skip_transparent") {
        report.skippedTransparent++;
        continue;
      }
      if (kind === "skip_solid") {
        report.skippedSolid++;
        continue;
      }

      const outName = `${stem}_${col}_${row}.png`;
      const outPath = path.join(outDirAbs, outName);

      await sharp(data, {
        raw: {
          width: TILE,
          height: TILE,
          channels: 4,
        },
      })
        .png()
        .toFile(outPath);

      report.written++;
    }
  }

  return report;
}

function collectPngsFromDir(dirAbs) {
  const out = [];
  if (!fs.existsSync(dirAbs)) return out;
  for (const name of fs.readdirSync(dirAbs)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dirAbs, name);
    const st = fs.statSync(full);
    if (st.isFile() && name.toLowerCase().endsWith(".png")) {
      out.push(full);
    }
  }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function main() {
  const { inputs: argInputs, dir } = parseArgs(process.argv);

  let inputs = [...argInputs];
  if (dir) {
    inputs.push(...collectPngsFromDir(dir));
  }

  if (inputs.length === 0) {
    const defaultDir = path.join(
      REPO_ROOT,
      "assets",
      "New_Arrivals",
      "urban_tiles_and_assets",
    );
    inputs = collectPngsFromDir(defaultDir);
  }

  if (inputs.length === 0) {
    console.error("No input PNGs. Use --input <file> or --dir <folder>.");
    process.exit(1);
  }

  const allReports = [];

  for (const absInput of inputs) {
    const parentName = path.basename(path.dirname(absInput));
    const outDirAbs = path.join(REPO_ROOT, "assets", "processed", parentName);

    console.log("\n---");
    console.log("Input:", path.relative(REPO_ROOT, absInput));
    console.log("Output dir:", path.relative(REPO_ROOT, outDirAbs));

    const report = await sliceSheet(absInput, outDirAbs);
    allReports.push(report);

    if (report.error && !report.columns) {
      console.error("ERROR:", report.error);
      continue;
    }
    if (report.error) {
      console.error("ERROR:", report.error);
    }

    console.log(`Grid: ${report.columns}×${report.rows} (${report.expectedTiles} cells)`);
    console.log(`Written: ${report.written} PNGs`);
    console.log(`Skipped (fully transparent): ${report.skippedTransparent}`);
    console.log(`Skipped (solid single color): ${report.skippedSolid}`);
  }

  const invalid = allReports.filter((r) => r.error && r.error.includes("not divisible"));
  if (invalid.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
