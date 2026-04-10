#!/usr/bin/env node
/**
 * Import human labels from review_labels.json into reference_images/<label>/.
 *
 * - Reads only review_labels.json and copies from assets/New_Arrivals/ into reference_images/.
 * - Does not touch classification, PRIMARY, or other pipelines.
 *
 * Usage:
 *   node tools/import_review_labels_to_reference.mjs
 *   node tools/import_review_labels_to_reference.mjs --dry-run
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REVIEW_LABELS_JSON = path.join(ROOT, "review_labels.json");
const NEW_ARRIVALS = path.join(ROOT, "assets", "New_Arrivals");
const REFERENCE_REL = "reference_images";

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");

/**
 * Map a filled-in correct_label to a single reference folder name (matches reference_images/* style).
 */
function normalizeReferenceLabel(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.includes("..") || /[/\\]/.test(s)) return null;
  const slug = s
    .replace(/[^a-zA-Z0-9_\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return slug || null;
}

function posixToAbsUnderNewArrivals(relPosix) {
  const parts = String(relPosix)
    .split(/[/\\]+/)
    .filter(Boolean)
    .filter((p) => p !== "..");
  return path.join(NEW_ARRIVALS, ...parts);
}

async function main() {
  if (!(await fs.pathExists(REVIEW_LABELS_JSON))) {
    console.error(`import_review_labels_to_reference: missing ${path.relative(ROOT, REVIEW_LABELS_JSON)}`);
    process.exitCode = 1;
    return;
  }

  const data = await fs.readJson(REVIEW_LABELS_JSON);
  const items = Array.isArray(data.items) ? data.items : [];

  /** Distinct reference folders created (or that would be created in --dry-run). */
  const dirsCreated = new Set();
  /** @type {Map<string, number>} */
  const addedByLabel = new Map();
  let copied = 0;
  let skippedDestExists = 0;
  let skippedNoSource = 0;
  let skippedBadLabel = 0;

  for (const it of items) {
    const correct = it.correct_label;
    if (correct == null || String(correct).trim() === "") continue;

    const label = normalizeReferenceLabel(correct);
    if (!label) {
      skippedBadLabel += 1;
      console.warn(
        `import_review_labels_to_reference: skip (invalid correct_label): ${JSON.stringify(correct)} | path=${it.path}`,
      );
      continue;
    }

    const rel = it.path;
    if (!rel || typeof rel !== "string") {
      skippedBadLabel += 1;
      continue;
    }

    const src = posixToAbsUnderNewArrivals(rel);
    const fileName = path.basename(src);
    const destDir = path.join(ROOT, REFERENCE_REL, label);
    const dest = path.join(destDir, fileName);

    if (!(await fs.pathExists(src))) {
      skippedNoSource += 1;
      console.warn(`import_review_labels_to_reference: source missing: ${path.relative(ROOT, src)}`);
      continue;
    }
    const st = await fs.stat(src).catch(() => null);
    if (!st?.isFile()) {
      skippedNoSource += 1;
      console.warn(`import_review_labels_to_reference: not a file: ${path.relative(ROOT, src)}`);
      continue;
    }

    if (await fs.pathExists(dest)) {
      skippedDestExists += 1;
      continue;
    }

    if (DRY) {
      if (!(await fs.pathExists(destDir))) {
        dirsCreated.add(path.normalize(destDir));
      }
      addedByLabel.set(label, (addedByLabel.get(label) ?? 0) + 1);
      copied += 1;
      continue;
    }

    const dirExisted = await fs.pathExists(destDir);
    await fs.ensureDir(destDir);
    if (!dirExisted) dirsCreated.add(path.normalize(destDir));

    await fs.copy(src, dest, { overwrite: false });
    copied += 1;
    addedByLabel.set(label, (addedByLabel.get(label) ?? 0) + 1);
  }

  const labelsSorted = [...addedByLabel.keys()].sort();

  console.log(DRY ? "\n=== import review → reference_images (dry-run) ===\n" : "\n=== import review → reference_images ===\n");
  console.log(`   new folders created: ${dirsCreated.size}`);
  console.log(`   images copied: ${copied}${DRY ? " (would copy)" : ""}`);
  console.log(`   skipped (destination already exists): ${skippedDestExists}`);
  console.log(`   skipped (source missing / not a file): ${skippedNoSource}`);
  console.log(`   skipped (invalid correct_label): ${skippedBadLabel}`);
  console.log("");
  if (labelsSorted.length) {
    console.log("   images added per label:");
    for (const lb of labelsSorted) {
      console.log(`      ${REFERENCE_REL}/${lb}/  →  ${addedByLabel.get(lb)}`);
    }
  } else {
    console.log("   (no items with non-empty correct_label produced imports)");
  }
  console.log("");
}

main().catch((e) => {
  console.error("import_review_labels_to_reference:", e?.message || e);
  process.exitCode = 1;
});
