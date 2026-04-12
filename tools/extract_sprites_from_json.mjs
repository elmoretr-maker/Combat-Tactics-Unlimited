#!/usr/bin/env node
/**
 * Crop regions from a sprite sheet using a JSON map (x, y, width, height per sprite).
 * Writes PNGs with alpha preserved (sharp default for PNG extract).
 *
 * Usage:
 *   node tools/extract_sprites_from_json.mjs --sheet spritesheet.png --map sprites.json
 *   node tools/extract_sprites_from_json.mjs --sheet ./path/sheet.png --map ./path/sprites.json --out assets/extracted
 *
 * JSON shapes supported:
 *   - Array: [ { "name": "idle_0", "x": 0, "y": 0, "width": 32, "height": 32 }, ... ]
 *   - Object map: { "idle_0": { "x": 0, "y": 0, "width": 32, "height": 32 }, ... }
 *   - Optional wrapper: { "sprites": [ ... ] } or { "frames": { ... } } (same inner shape)
 *
 * Aliases: w/h for width/height; top-level numeric array uses index as name.
 */

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "assets", "extracted");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) {
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

function sanitizeFileBase(name) {
  const s = String(name).trim() || "sprite";
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "_").slice(0, 200);
}

function pickRect(obj) {
  if (!obj || typeof obj !== "object") return null;
  const x = Number(obj.x ?? obj.left);
  const y = Number(obj.y ?? obj.top);
  const w = Number(obj.width ?? obj.w);
  const h = Number(obj.height ?? obj.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0) return null;
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(w), height: Math.floor(h) };
}

/**
 * Normalize JSON into iterable { name, rect }[]
 */
function entriesFromJson(data) {
  const list = [];

  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      const rect = pickRect(item);
      const name =
        item?.name ??
        item?.id ??
        item?.key ??
        `sprite_${i}`;
      if (rect) list.push({ name: String(name), rect });
    });
    return list;
  }

  if (data && typeof data === "object") {
    if (data.sprites && Array.isArray(data.sprites)) {
      return entriesFromJson(data.sprites);
    }
    if (data.frames && typeof data.frames === "object" && !Array.isArray(data.frames)) {
      return entriesFromJson(data.frames);
    }
    for (const [key, val] of Object.entries(data)) {
      if (["sprites", "frames", "meta", "version", "image", "sheet"].includes(key)) continue;
      const rect = pickRect(val);
      if (rect) list.push({ name: key, rect });
    }
  }

  return list;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.sheet && !args.map)) {
    console.log(`
Extract sprites from a sheet using a JSON map.

  --sheet PATH   Path to spritesheet.png (or any image sharp reads)
  --map PATH     Path to sprites.json
  --out DIR      Output directory (default: assets/extracted)

Example:
  node tools/extract_sprites_from_json.mjs --sheet spritesheet.png --map sprites.json
`);
    process.exit(args.help ? 0 : 1);
  }

  const sheetPath = path.resolve(process.cwd(), args.sheet);
  const mapPath = path.resolve(process.cwd(), args.map);
  const outDir = path.resolve(process.cwd(), args.out || DEFAULT_OUT);

  if (!fs.existsSync(sheetPath)) {
    console.error(`Sheet not found: ${sheetPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(mapPath)) {
    console.error(`JSON not found: ${mapPath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  } catch (e) {
    console.error(`Invalid JSON: ${mapPath}`, e.message);
    process.exit(1);
  }

  const entries = entriesFromJson(raw);
  if (entries.length === 0) {
    console.error("No valid sprite entries found (need x,y,width,height per entry).");
    process.exit(1);
  }

  const meta = await sharp(sheetPath).metadata();
  const sw = meta.width ?? 0;
  const sh = meta.height ?? 0;

  fs.mkdirSync(outDir, { recursive: true });

  let ok = 0;
  let skipped = 0;
  const usedNames = new Map();

  for (let i = 0; i < entries.length; i++) {
    const { name, rect } = entries[i];
    const { x, y, width, height } = rect;

    if (x + width > sw || y + height > sh) {
      console.warn(`Skip (out of bounds): ${name} rect=${JSON.stringify(rect)} sheet=${sw}x${sh}`);
      skipped++;
      continue;
    }

    let base = sanitizeFileBase(name);
    const prev = usedNames.get(base) ?? 0;
    usedNames.set(base, prev + 1);
    if (prev > 0) base = `${base}_${prev}`;

    const outPath = path.join(outDir, `${base}.png`);

    try {
      await sharp(sheetPath)
        .extract({ left: x, top: y, width, height })
        .png()
        .toFile(outPath);
      ok++;
      console.log(outPath);
    } catch (e) {
      console.warn(`Skip (extract failed): ${name}`, e.message);
      skipped++;
    }
  }

  console.error(`Done: ${ok} written, ${skipped} skipped, sheet ${sw}x${sh} -> ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
