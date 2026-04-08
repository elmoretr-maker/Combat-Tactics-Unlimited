#!/usr/bin/env node
/**
 * Rewrite spriteAnimations.json: attached_assets → assets only where mapped dest file exists.
 * Does not change keys, frame counts, or structure — string paths only.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mapAttachedPath } from "./pathMapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const JSON_PATH = path.join(ROOT, "js/config/spriteAnimations.json");
const REPORT_PATH = path.join(ROOT, "tools/reports/sprite_animations_path_migration.json");

function transform(obj, updated, skipped) {
  if (typeof obj === "string") {
    if (!obj.startsWith("attached_assets/")) return obj;
    const m = mapAttachedPath(obj);
    if (m.type === "unknown") {
      skipped.push({ oldPath: obj, reason: "unmapped_type", candidate: m.newPath });
      return obj;
    }
    const dest = path.join(ROOT, m.newPath.replace(/\\/g, "/"));
    if (fs.existsSync(dest) && fs.statSync(dest).isFile()) {
      updated.push({ oldPath: obj, newPath: m.newPath });
      return m.newPath;
    }
    skipped.push({ oldPath: obj, newPath: m.newPath, reason: "dest_missing" });
    return obj;
  }
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((x) => transform(x, updated, skipped));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = transform(v, updated, skipped);
  }
  return out;
}

const raw = fs.readFileSync(JSON_PATH, "utf8");
const data = JSON.parse(raw);
const updated = [];
const skipped = [];
const next = transform(data, updated, skipped);

fs.writeFileSync(JSON_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");

const uniqueUpdated = [];
const seen = new Set();
for (const r of updated) {
  const k = `${r.oldPath}→${r.newPath}`;
  if (!seen.has(k)) {
    seen.add(k);
    uniqueUpdated.push(r);
  }
}

const uniqueSkipped = [];
const seenS = new Set();
for (const r of skipped) {
  const k = `${r.oldPath}|${r.reason}`;
  if (!seenS.has(k)) {
    seenS.add(k);
    uniqueSkipped.push(r);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    pathOccurrencesUpdated: updated.length,
    uniqueOldPathsUpdated: uniqueUpdated.length,
    uniqueOldPathsSkipped: uniqueSkipped.length,
  },
  updated: uniqueUpdated,
  skipped: uniqueSkipped,
};

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify(report.summary, null, 2));
console.log(`Report: ${path.relative(ROOT, REPORT_PATH)}`);
