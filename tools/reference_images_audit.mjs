#!/usr/bin/env node
/**
 * One-off audit: dimensions + paths for reference_images/ (read-only analysis).
 * Usage: node tools/reference_images_audit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REF = path.join(ROOT, "reference_images");

const EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

const files = [];
walk(REF, files);

const rows = [];
for (const abs of files.sort((a, b) => a.localeCompare(b))) {
  const rel = path.relative(REF, abs).split(path.sep).join("/");
  const folder = rel.split("/")[0];
  let w = 0,
    h = 0,
    err = null;
  try {
    const m = await sharp(abs).metadata();
    w = m.width || 0;
    h = m.height || 0;
  } catch (e) {
    err = String(e.message || e);
  }
  rows.push({ rel, folder, w, h, max: Math.max(w, h), err });
}

console.log(JSON.stringify(rows, null, 0));
