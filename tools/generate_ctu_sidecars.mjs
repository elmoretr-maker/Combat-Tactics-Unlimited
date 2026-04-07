#!/usr/bin/env node
/**
 * Auto-generate `.ctu.asset.json` sidecars for PNGs under assets/New_Arrivals/review/.
 * Does not overwrite existing sidecars. Filename heuristics only (review bootstrap).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REVIEW_DIR = path.join(ROOT, "assets", "New_Arrivals", "review");
const SIDE_SUFFIX = ".ctu.asset.json";

function buildPayload(rule) {
  return {
    version: 2,
    classification: { ...rule.classification },
    placement: JSON.parse(JSON.stringify(rule.placement)),
    behavior: { ...rule.behavior },
    render: { ...rule.render },
    tags: [],
    source: {
      origin: "auto-generated",
      confidence: 0.6,
    },
  };
}

const RULE_WEAPON = {
  classification: { type: "weapon", subtype: "gun" },
  placement: { mode: "none" },
  behavior: { walkable: false, blocking: false },
  render: { layer: "object", anchor: "center" },
};

const RULE_EFFECT = {
  classification: { type: "effect", subtype: "explosion" },
  placement: { mode: "none" },
  behavior: { walkable: false, blocking: false },
  render: { layer: "effect", anchor: "center" },
};

const RULE_DEFAULT = {
  classification: { type: "environment", subtype: "unknown" },
  placement: { mode: "surface", surfaces: ["land"] },
  behavior: { walkable: false, blocking: true },
  render: { layer: "object", anchor: "bottom" },
};

function classifyFromFileName(baseName) {
  const lower = baseName.toLowerCase();
  if (lower.includes("gun")) return RULE_WEAPON;
  if (
    lower.includes("explosion") ||
    lower.includes("smoke") ||
    lower.includes("flame") ||
    lower.includes("flash") ||
    lower.includes("fire")
  ) {
    return RULE_EFFECT;
  }
  return RULE_DEFAULT;
}

function* walkPngFiles(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkPngFiles(full);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".png")) {
      yield full;
    }
  }
}

function main() {
  fs.mkdirSync(REVIEW_DIR, { recursive: true });

  let created = 0;
  for (const pngPath of walkPngFiles(REVIEW_DIR)) {
    const ext = path.extname(pngPath);
    const sidecarPath = `${pngPath.slice(0, -ext.length)}${SIDE_SUFFIX}`;
    if (fs.existsSync(sidecarPath)) continue;

    const baseName = path.basename(pngPath, ext);
    const rule = classifyFromFileName(baseName);
    const payload = buildPayload(rule);
    fs.writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    created += 1;
    console.log(`Created metadata for: ${path.relative(ROOT, pngPath).split(path.sep).join("/")}`);
  }

  if (created === 0) {
    console.log("No new sidecars created (none missing or no PNGs found).");
  }
}

main();
