#!/usr/bin/env node
/**
 * Sync manual labels from review.md → review_items[].correct_label in review_labels.json.
 * Does not run classification or change schema (same keys; only correct_label values updated).
 *
 * If **Correct label:** `=` then correct_label is set from the JSON item's predicted_label.
 * Digits `1`–`9` map to Quick select (same order as review.md); out-of-range numbers are skipped with a warning.
 *
 * Usage:
 *   node tools/sync_review_md_to_json.mjs
 *   node tools/sync_review_md_to_json.mjs --dry-run
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { REVIEW_QUICK_SELECT_LABELS } from "./review_quick_select_labels.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REVIEW_MD = path.join(ROOT, "review.md");
const REVIEW_LABELS_JSON = path.join(ROOT, "review_labels.json");

const PREFIX = "assets/New_Arrivals/";
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");

/** Map link target → JSON path (posix, relative under New_Arrivals). */
function linkTargetToPathKey(target) {
  const t = String(target).trim().replace(/\\/g, "/");
  if (t.startsWith(PREFIX)) return t.slice(PREFIX.length);
  const i = t.indexOf("New_Arrivals/");
  if (i >= 0) return t.slice(i + "New_Arrivals/".length);
  return null;
}

/**
 * First line of a section: ## [title](url) or ## [title](<url>)
 * @returns {string|null} path key under New_Arrivals
 */
function pathKeyFromHeadingLine(line) {
  const m = line.match(/^##\s+.+\]\(\s*(?:<([^>]+)>|([^)]+))\s*\)\s*$/);
  if (!m) return null;
  const raw = (m[1] || m[2]).trim();
  return linkTargetToPathKey(raw);
}

/** @returns {string|null} inner text of backticks, or null if line doesn't match */
function labelFromCorrectLine(line) {
  const m = line.match(/^\*\*Correct label(?:\s*\(fill in\))?:\*\*\s*`([^`]*)`\s*$/);
  return m ? m[1] : null;
}

function isPlaceholderOrEmpty(labelInner) {
  const s = String(labelInner ?? "").trim();
  if (!s) return true;
  if (/^_{3,}$/.test(s)) return true;
  return false;
}

async function main() {
  if (!(await fs.pathExists(REVIEW_MD))) {
    console.error(`sync_review_md_to_json: missing ${path.relative(ROOT, REVIEW_MD)}`);
    process.exitCode = 1;
    return;
  }
  if (!(await fs.pathExists(REVIEW_LABELS_JSON))) {
    console.error(`sync_review_md_to_json: missing ${path.relative(ROOT, REVIEW_LABELS_JSON)}`);
    process.exitCode = 1;
    return;
  }

  const md = await fs.readFile(REVIEW_MD, "utf8");
  const data = await fs.readJson(REVIEW_LABELS_JSON);
  if (!Array.isArray(data.items)) {
    console.error("sync_review_md_to_json: review_labels.json items[] missing or not an array");
    process.exitCode = 1;
    return;
  }

  /** @type {Map<string, string>} path posix → raw label from md */
  const fromMd = new Map();

  const chunks = md.split(/\n(?=##\s)/);
  for (const chunk of chunks) {
    if (!chunk.startsWith("##")) continue;
    const lines = chunk.split("\n");
    const pathKey = pathKeyFromHeadingLine(lines[0]);
    if (!pathKey) continue;

    let labelInner = null;
    for (const line of lines) {
      if (line.includes("**Correct label")) {
        const parsed = labelFromCorrectLine(line.trim());
        if (parsed !== null) {
          labelInner = parsed;
          break;
        }
      }
    }
    if (labelInner === null) continue;

    const normPath = pathKey.split(/[/\\]+/).filter(Boolean).join("/");
    fromMd.set(normPath, labelInner);
  }

  const indexByPath = new Map();
  for (let i = 0; i < data.items.length; i++) {
    const p = data.items[i]?.path;
    if (typeof p === "string") {
      indexByPath.set(p.split(/[/\\]+/).filter(Boolean).join("/"), i);
    }
  }

  let updated = 0;
  let emptySkipped = 0;
  let notInJson = 0;
  let acceptPredicted = 0;
  let numericShortcut = 0;
  let skippedInvalidNumeric = 0;

  const quickMax = REVIEW_QUICK_SELECT_LABELS.length;

  for (const [pathKey, rawInner] of fromMd.entries()) {
    if (isPlaceholderOrEmpty(rawInner)) {
      emptySkipped += 1;
      continue;
    }
    let label = String(rawInner).trim();
    const idx = indexByPath.get(pathKey);
    if (idx == null) {
      notInJson += 1;
      console.warn(`sync_review_md_to_json: no JSON item for path: ${pathKey}`);
      continue;
    }
    if (label === "=") {
      const pred = data.items[idx].predicted_label;
      if (pred == null || String(pred).trim() === "") {
        emptySkipped += 1;
        console.warn(
          `sync_review_md_to_json: Correct label is '=' but predicted_label is empty — ${pathKey}`,
        );
        continue;
      }
      label = String(pred).trim();
      acceptPredicted += 1;
    } else if (/^\d+$/.test(label)) {
      const n = parseInt(label, 10);
      if (n < 1 || n > quickMax) {
        skippedInvalidNumeric += 1;
        console.warn(
          `sync_review_md_to_json: numeric shortcut "${label}" out of range (1–${quickMax}) — ${pathKey}`,
        );
        continue;
      }
      label = REVIEW_QUICK_SELECT_LABELS[n - 1];
      numericShortcut += 1;
    }
    if (data.items[idx].correct_label === label) {
      continue;
    }
    if (!DRY) {
      data.items[idx].correct_label = label;
    }
    updated += 1;
  }

  if (!DRY && updated > 0) {
    await fs.writeJson(REVIEW_LABELS_JSON, data, { spaces: 2 });
  }

  console.log(DRY ? "\n=== sync review.md → review_labels.json (dry-run) ===\n" : "\n=== sync review.md → review_labels.json ===\n");
  console.log(`   labels updated: ${updated}${DRY ? " (would write)" : ""}`);
  if (acceptPredicted) {
    console.log(`   of which accepted predicted (\`=\`): ${acceptPredicted}`);
  }
  if (numericShortcut) {
    console.log(`   of which numeric quick select (1–${quickMax}): ${numericShortcut}`);
  }
  console.log(`   empty / placeholder labels skipped: ${emptySkipped}`);
  if (skippedInvalidNumeric) {
    console.log(`   invalid numeric shortcut (out of range): ${skippedInvalidNumeric}`);
  }
  if (notInJson) {
    console.log(`   paths in review.md not found in JSON: ${notInJson}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("sync_review_md_to_json:", e?.message || e);
  process.exitCode = 1;
});
