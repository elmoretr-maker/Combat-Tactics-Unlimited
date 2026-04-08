/**
 * Validates mapCatalog entries: biome enum and every terrain cell in each scenario
 * exists in js/config/tileTextures.json types.
 * Exits with code 1 on any error (no silent ignore).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const BIOMES = new Set(["forest", "desert", "winter", "urban"]);

const tilePath = path.join(root, "js/config/tileTextures.json");
const catPath = path.join(root, "js/config/mapCatalog.json");

let errors = 0;

function err(msg) {
  console.error(msg);
  errors += 1;
}

let types;
try {
  const tiles = JSON.parse(fs.readFileSync(tilePath, "utf8"));
  types = tiles.types;
  if (!types || typeof types !== "object") {
    console.error("[validate] tileTextures.json missing types object");
    process.exit(1);
  }
} catch (e) {
  console.error(`[validate] cannot read tileTextures.json: ${e.message}`);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catPath, "utf8"));
} catch (e) {
  console.error(`[validate] cannot read mapCatalog.json: ${e.message}`);
  process.exit(1);
}

for (const m of catalog.maps || []) {
  const id = m.id || m.path || "?";
  if (m.biome != null && !BIOMES.has(m.biome)) {
    err(
      `[validate] ${id}: invalid catalog biome "${m.biome}" (expected one of: ${[...BIOMES].join(", ")})`,
    );
  }

  const rel = m.path;
  if (!rel || typeof rel !== "string") {
    err(`[validate] ${id}: missing path`);
    continue;
  }

  const scenPath = path.join(root, rel);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(scenPath, "utf8"));
  } catch (e) {
    err(`[validate] ${id}: cannot read scenario ${rel}: ${e.message}`);
    continue;
  }

  const terrain = data.terrain;
  if (!Array.isArray(terrain) || !terrain.length) {
    err(`[validate] ${id}: missing or empty terrain array`);
    continue;
  }

  for (let y = 0; y < terrain.length; y++) {
    const row = terrain[y];
    if (!Array.isArray(row)) {
      err(`[validate] ${id}: terrain[${y}] is not an array`);
      continue;
    }
    for (let x = 0; x < row.length; x++) {
      const tid = row[x];
      if (typeof tid !== "string") {
        err(`[validate] ${id}: terrain[${y}][${x}] is not a string (got ${typeof tid})`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(types, tid)) {
        err(
          `[validate] ${id}: unknown terrain id "${tid}" at [${x},${y}]  not in tileTextures.types`,
        );
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n[validate] Failed with ${errors} error(s).`);
  process.exit(1);
}

console.log("[validate] map catalog terrain: OK.");
