/**
 * assets/ui_master/cyberpunk_blue/ → assets/ui_master/military_green/
 * Same filenames; PNG only; no resize; alpha preserved. Sources unchanged.
 * (Legacy ui_unified path removed — use assets/ui_master as source of truth.)
 *
 * Re-run: node tools/cyberpunk_to_military_unified.mjs
 */
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { militaryGradePipeline } from "./lib/military_green_pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcRoot = path.join(root, "assets", "ui_master", "cyberpunk_blue");
const dstRoot = path.join(root, "assets", "ui_master", "military_green");

async function* walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full);
    else if (e.isFile()) yield full;
  }
}

async function main() {
  let n = 0;
  const mismatches = [];

  try {
    await fs.access(srcRoot);
  } catch {
    console.error("Missing source folder:", path.relative(root, srcRoot));
    process.exit(1);
  }

  for await (const srcPath of walkFiles(srcRoot)) {
    if (!/\.png$/i.test(srcPath)) continue;

    const rel = path.relative(srcRoot, srcPath);
    const dstPath = path.join(dstRoot, rel);
    await fs.mkdir(path.dirname(dstPath), { recursive: true });

    const before = await sharp(srcPath).metadata();

    await militaryGradePipeline(srcPath).png({ compressionLevel: 9 }).toFile(dstPath);

    const after = await sharp(dstPath).metadata();
    if (before.width !== after.width || before.height !== after.height) {
      mismatches.push(rel);
    }
    n++;
    console.log("wrote", path.relative(root, dstPath));
  }

  if (n === 0) {
    console.warn("No PNGs found under", path.relative(root, srcRoot));
  }

  console.log(`\nDone: ${n} file(s). See tools/lib/military_green_pipeline.mjs`);
  if (mismatches.length) console.warn("Size mismatches:", mismatches);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
