#!/usr/bin/env node
/**
 * Apply rehome_log path substitutions to js/ (maps, render) and restore archived
 * rasters that are still referenced by source paths.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REHOME = path.join(ROOT, "tools", "rehome_log.txt");
const ARCHIVE = path.join(ROOT, "assets", "archive_for_deletion");

function parseRehomeMap() {
  const text = fs.readFileSync(REHOME, "utf8");
  const pairs = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("assets/")) continue;
    const sep = line.includes(" -> ") ? " -> " : line.includes(" ? ") ? " ? " : null;
    if (!sep) continue;
    const q = line.split(sep);
    if (q.length < 2) continue;
    const from = q[0].trim();
    const rest = q[1].split(" | ")[0].trim();
    if (from && rest && from !== rest) pairs.push([from, rest]);
  }
  return pairs;
}

function walkDir(dir, acc) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkDir(full, acc);
    else if (/\.(js|json|md)$/.test(name.name)) acc.push(full);
  }
}

function applyReplacements(pairs) {
  const jsRoot = path.join(ROOT, "js");
  const files = [];
  walkDir(jsRoot, files);
  let total = 0;
  for (const file of files) {
    let s = fs.readFileSync(file, "utf8");
    const orig = s;
    for (const [from, to] of pairs) {
      if (s.includes(from)) {
        s = s.split(from).join(to);
      }
    }
    if (s !== orig) {
      fs.writeFileSync(file, s, "utf8");
      total++;
    }
  }
  console.log("Patched files:", total);
}

function referencedAssetPaths() {
  const jsRoot = path.join(ROOT, "js");
  const files = [];
  walkDir(jsRoot, files);
  const refs = new Set();
  const re = /assets\/(?:tiles|obstacles|buildings|guns|units|vfx)\/[a-zA-Z0-9_./-]+\.(?:png|webp|jpg|jpeg|gif)/g;
  for (const file of files) {
    const s = fs.readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(s)) !== null) refs.add(m[0]);
  }
  return refs;
}

function restoreArchivedIfReferenced() {
  const refs = referencedAssetPaths();
  let n = 0;
  if (!fs.existsSync(ARCHIVE)) return n;
  for (const name of fs.readdirSync(ARCHIVE)) {
    const ext = path.extname(name).toLowerCase();
    if (![".png", ".webp", ".jpg", ".jpeg", ".gif"].includes(ext)) continue;
    const candidates = [...refs].filter((r) => r.endsWith(name));
    for (const targetPosix of candidates) {
      const dest = path.join(ROOT, ...targetPosix.split("/"));
      if (fs.existsSync(dest)) break;
      const src = path.join(ARCHIVE, name);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      console.log("Restored", targetPosix);
      n++;
      break;
    }
  }
  return n;
}

const pairs = parseRehomeMap();
console.log("Rehome pairs:", pairs.length);
applyReplacements(pairs);
const restored = restoreArchivedIfReferenced();
console.log("Restored from archive:", restored);
