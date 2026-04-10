/**
 * Build assets/ui_unified/: cyberpunk frames (copy) + color-matched metal (from attached_assets/ui).
 * Does not modify originals. PNG/JPG preserved at native size; alpha kept on PNG.
 *
 * Re-run: node tools/unify_metal_ui_assets.mjs
 */
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const framesSrc = path.join(root, "assets", "ui_master", "cyberpunk_blue");
const cyberOut = path.join(root, "assets", "ui_unified", "cyberpunk");
const metalSrc = path.join(root, "attached_assets", "ui");
const metalOut = path.join(root, "assets", "ui_unified", "metal");

/** Bronze/military → cyan/teal band; tuned between combat_frame_cyber and craftpix bonus */
const HUE_SHIFT = 145;
const SATURATION = 1.07;
const BRIGHTNESS = 0.99;

async function copyCyberFrames() {
  const names = (await fs.readdir(framesSrc)).filter((f) => /\.png$/i.test(f));
  await fs.mkdir(cyberOut, { recursive: true });
  for (const name of names.sort()) {
    await fs.copyFile(path.join(framesSrc, name), path.join(cyberOut, name));
  }
  return names.length;
}

async function processMetalAsset(file, report) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") return;

  const srcPath = path.join(metalSrc, file);
  const destPath = path.join(metalOut, file);

  const before = await sharp(srcPath).metadata();

  let pipeline = sharp(srcPath).ensureAlpha();
  pipeline = pipeline.modulate({
    hue: HUE_SHIFT,
    saturation: SATURATION,
    brightness: BRIGHTNESS,
  });

  if (ext === ".png") {
    await pipeline.png({ compressionLevel: 9 }).toFile(destPath);
  } else {
    await pipeline.jpeg({ quality: 95, mozjpeg: true }).toFile(destPath);
  }

  const after = await sharp(destPath).metadata();
  report.push({
    file,
    before: { w: before.width, h: before.height, format: before.format },
    after: { w: after.width, h: after.height, format: after.format },
  });
}

async function main() {
  const nCopied = await copyCyberFrames();
  console.log(`Copied ${nCopied} PNG(s) → assets/ui_unified/cyberpunk/`);

  await fs.mkdir(metalOut, { recursive: true });
  const entries = await fs.readdir(metalSrc);
  const report = [];

  for (const file of entries.sort()) {
    const full = path.join(metalSrc, file);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    await processMetalAsset(file, report);
  }

  console.log(`Processed ${report.length} metal asset(s) → assets/ui_unified/metal/\n`);
  console.log("--- Report (dimensions must match) ---");
  for (const r of report) {
    const ok = r.before.w === r.after.w && r.before.h === r.after.h;
    console.log(
      `${r.file}\t${r.before.w}×${r.before.h} -> ${r.after.w}×${r.after.h}${ok ? "" : "\tSIZE MISMATCH"}`
    );
  }
  console.log(
    `\nModulate: hue +${HUE_SHIFT}°, saturation ×${SATURATION}, brightness ×${BRIGHTNESS}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
