/**
 * Build assets/ui_master/cyberpunk_green_UI/ from cyberpunk_blue:
 * 1) military-grade pipeline (olive base)
 * 2) Per-image RGB gain so mean color aligns with military_metal_original_green_UI
 *
 * Does not modify cyberpunk_blue or reference folder. Overwrites cyberpunk_green_UI/*.png
 *
 * Run: node tools/align_cyberpunk_green_ui.mjs
 */
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { militaryGradePipeline } from "./lib/military_green_pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const blueDir = path.join(root, "assets", "ui_master", "cyberpunk_blue");
const greenOut = path.join(root, "assets", "ui_master", "cyberpunk_green_UI");
const refDir = path.join(root, "assets", "ui_master", "military_metal_original_green_UI");

const GAIN_MIN = 0.55;
const GAIN_MAX = 2.4;
/** How strongly to snap means toward reference (1 = full gain correction) */
const MATCH_STRENGTH = 0.92;

function clamp255(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Alpha-weighted mean RGB for one raw RGBA buffer.
 */
function meanRgbWeighted(data) {
  let sr = 0,
    sg = 0,
    sb = 0,
    w = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.02) continue;
    sr += data[i] * a;
    sg += data[i + 1] * a;
    sb += data[i + 2] * a;
    w += a;
  }
  if (w < 1e-6) return { r: 128, g: 128, b: 128 };
  return { r: sr / w, g: sg / w, b: sb / w };
}

async function folderMeanRgb(dir) {
  const names = (await fs.readdir(dir)).filter((f) => /\.png$/i.test(f));
  const means = [];
  for (const name of names) {
    const p = path.join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    const { data } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    means.push(meanRgbWeighted(data));
  }
  if (!means.length) throw new Error(`No PNGs in ${dir}`);
  const r = means.reduce((s, m) => s + m.r, 0) / means.length;
  const g = means.reduce((s, m) => s + m.g, 0) / means.length;
  const b = means.reduce((s, m) => s + m.b, 0) / means.length;
  return { r, g, b };
}

function clampGain(ref, m) {
  const g = ref / (m + 1e-6);
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, g));
}

async function processOne(srcPath, destPath, refMean) {
  const { data: graded, info } = await militaryGradePipeline(srcPath).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const m = meanRgbWeighted(graded);

  const gR = clampGain(refMean.r, m.r);
  const gG = clampGain(refMean.g, m.g);
  const gB = clampGain(refMean.b, m.b);

  const s = MATCH_STRENGTH;
  const gRf = 1 + (gR - 1) * s;
  const gGf = 1 + (gG - 1) * s;
  const gBf = 1 + (gB - 1) * s;

  for (let i = 0; i < graded.length; i += 4) {
    if (graded[i + 3] === 0) continue;
    graded[i] = clamp255(graded[i] * gRf);
    graded[i + 1] = clamp255(graded[i + 1] * gGf);
    graded[i + 2] = clamp255(graded[i + 2] * gBf);
  }

  await sharp(graded, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(destPath);
}

async function main() {
  const refMean = await folderMeanRgb(refDir);
  console.log(
    "Reference mean RGB (military_metal_original_green_UI):",
    refMean.r.toFixed(1),
    refMean.g.toFixed(1),
    refMean.b.toFixed(1)
  );

  await fs.mkdir(greenOut, { recursive: true });

  const names = (await fs.readdir(blueDir))
    .filter((f) => /\.png$/i.test(f) && f.startsWith("cp_frame_"))
    .sort();

  if (!names.length) {
    console.error("No cp_frame_*.png in cyberpunk_blue");
    process.exit(1);
  }

  for (const name of names) {
    const src = path.join(blueDir, name);
    const dest = path.join(greenOut, name);
    await processOne(src, dest, refMean);
    console.log("wrote", path.relative(root, dest));
  }

  console.log(`\nDone: ${names.length} file(s) → cyberpunk_green_UI`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
