#!/usr/bin/env node
/**
 * Optional batch pass: push Craftpix-style neon GUI toward CTU tactical palette.
 * Uses sharp (already a devDependency). Does not modify sources unless --in-place.
 *
 * Usage:
 *   node tools/recolor_cyberpunk_gui.mjs --src "assets/New_Arrivals/cyberpunk GUI plus more" --out assets/ui/cyberpunk-tactical
 *   node tools/recolor_cyberpunk_gui.mjs --src ... --out ... --dry-run
 *
 * Defaults tune toward --phosphor (matches css/style.css --phosphor #8fb394).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--in-place") out.inPlace = true;
    else if (a === "--phosphor") {
      out.tint = { r: 143, g: 179, b: 148 };
    } else if (a === "--military") {
      out.tint = { r: 79, g: 91, b: 65 };
    } else if (a === "--no-tint") out.noTint = true;
    else if (a === "--src" && argv[i + 1]) {
      out.src = argv[++i];
    } else if (a === "--out" && argv[i + 1]) {
      out.out = argv[++i];
    } else if (a === "--saturation" && argv[i + 1]) {
      out.saturation = Number(argv[++i]);
    } else if (a === "--brightness" && argv[i + 1]) {
      out.brightness = Number(argv[++i]);
    } else if (a === "--hue" && argv[i + 1]) {
      out.hue = Number(argv[++i]);
    }     else if (a === "--tint") {
      const r = Number(argv[++i]);
      const g = Number(argv[++i]);
      const b = Number(argv[++i]);
      if ([r, g, b].some((n) => Number.isNaN(n))) {
        console.error("--tint requires three numbers: R G B (0–255)");
        process.exit(1);
      }
      out.tint = { r, g, b };
    }
  }
  return out;
}

async function* walkImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkImages(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) yield full;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const srcRoot = args.src;
  let outRoot = args.out;

  if (!srcRoot) {
    console.error("Missing --src <folder>");
    process.exit(1);
  }
  if (!args.inPlace && !outRoot) {
    console.error("Provide --out <folder> or use --in-place (overwrites sources)");
    process.exit(1);
  }
  if (args.inPlace) outRoot = srcRoot;

  const saturation = Number.isFinite(args.saturation) ? args.saturation : 0.52;
  const brightness = Number.isFinite(args.brightness) ? args.brightness : 1;
  const hue = Number.isFinite(args.hue) ? args.hue : 0;
  const tint = args.noTint ? null : args.tint ?? { r: 143, g: 179, b: 148 };

  let count = 0;
  for await (const abs of walkImages(srcRoot)) {
    const rel = path.relative(srcRoot, abs);
    const dest = args.inPlace ? abs : path.join(outRoot, rel);
    if (args.dryRun) {
      console.log(rel);
      count++;
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let pipe = sharp(abs).ensureAlpha();
    const mod = { saturation, brightness };
    if (hue !== 0) mod.hue = hue;
    pipe = pipe.modulate(mod);
    if (tint) pipe = pipe.tint(tint);
    await pipe.png({ compressionLevel: 9 }).toFile(dest);
    count++;
  }

  console.log(
    args.dryRun ? `[dry-run] ${count} raster files` : `Wrote ${count} files under ${outRoot}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
