#!/usr/bin/env node
/**
 * Conservative reference_images/ refines (moves only; no deletes).
 * Run: node tools/reference_images_refine_once.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REF = path.join(ROOT, "reference_images");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function uniqueDest(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let i = 1;
  let c;
  do {
    c = path.join(dir, `${base}_moved${i}${ext}`);
    i++;
  } while (fs.existsSync(c));
  return c;
}

async function meta(abs) {
  try {
    const m = await sharp(abs).metadata();
    return { w: m.width || 0, h: m.height || 0 };
  } catch {
    return { w: 0, h: 0 };
  }
}

function movePair(fromAbs, toDirRel, log) {
  const base = path.basename(fromAbs);
  const toDir = path.join(REF, ...toDirRel.split("/"));
  ensureDir(toDir);
  let toAbs = path.join(toDir, base);
  toAbs = uniqueDest(toAbs);
  fs.renameSync(fromAbs, toAbs);
  log.push({ from: path.relative(REF, fromAbs).split(path.sep).join("/"), to: path.relative(REF, toAbs).split(path.sep).join("/") });
}

const moves = [];

// 1) ui_button: huge atlas sheets → sprite_sheet
for (const name of ["button_2.png", "button_3.png"]) {
  const abs = path.join(REF, "ui_button", name);
  if (fs.existsSync(abs)) movePair(abs, "sprite_sheet", moves);
}

// 2) ui: full panel art → ui_panel
for (const name of ["Stone Bricks UI Panel.png", "Wood UI Panel.png"]) {
  const abs = path.join(REF, "ui", name);
  if (fs.existsSync(abs)) movePair(abs, "ui_panel", moves);
}

// 3) terrain: tiny sprite scraps → debris
const terrainDir = path.join(REF, "terrain");
if (fs.existsSync(terrainDir)) {
  for (const name of fs.readdirSync(terrainDir)) {
    if (!/^sprite_/i.test(name) || !/\.(png|webp|jpg|jpeg)$/i.test(name)) continue;
    const abs = path.join(terrainDir, name);
    if (fs.statSync(abs).isFile()) movePair(abs, "debris", moves);
  }
}

// 4) foliage/shrubs: obvious tiny scraps → debris
for (const name of ["sprite_0056.png", "sprite_0057.png", "sprite_0060.png"]) {
  const abs = path.join(REF, "foliage/shrubs", name);
  if (fs.existsSync(abs)) movePair(abs, "debris", moves);
}

// 5) structure/building: very small sprites (max dim <= 100) → prop/building_fragments
const sb = path.join(REF, "structure/building");
if (fs.existsSync(sb)) {
  const files = fs.readdirSync(sb).filter((n) => /^sprite_/i.test(n) && n.endsWith(".png"));
  for (const name of files) {
    const abs = path.join(sb, name);
    if (!fs.statSync(abs).isFile()) continue;
    const { w, h } = await meta(abs);
    const mx = Math.max(w, h);
    if (mx > 0 && mx <= 100) movePair(abs, "prop/building_fragments", moves);
  }
}

console.log(JSON.stringify({ ok: true, moveCount: moves.length, moves }, null, 2));
