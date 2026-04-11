/**
 * Batch-regenerate scenario JSON files with template-based procedural pipeline.
 * Writes to js/config/scenarios_v2/** — originals under js/config/scenarios/ are untouched.
 *
 * Usage: node tools/regenerate_maps_v2.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateProceduralScenario } from "../js/mapgen/pipeline.js";
import {
  getBiomeForCatalogEntry,
  BIOMES,
  environmentToBiome,
} from "../js/mapgen/biome.js";
import { moveCostAt } from "../js/engine/terrain.js";
import { mapObjectBlocksMoveAt } from "../js/battle-plane/mapObjects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCENARIOS_ROOT = path.join(ROOT, "js", "config", "scenarios");
const OUT_ROOT = path.join(ROOT, "js", "config", "scenarios_v2");
const CATALOG_PATH = path.join(ROOT, "js", "config", "mapCatalog.json");
const TILE_TYPES_PATH = path.join(ROOT, "js", "config", "tileTextures.json");
const MANIFEST_PATH = path.join(ROOT, "js", "config", "assetManifest.json");

/** @param {string} name */
function stableSeedFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function walkJsonFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "archive_for_review") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJsonFiles(full, out);
    else if (ent.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function cellPassable(terrain, tileTypes, mapObjects, x, y) {
  const w = terrain[0].length;
  const h = terrain.length;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (terrain[y][x] === "building_block") return false;
  if (mapObjectBlocksMoveAt(mapObjects, x, y)) return false;
  const grid = { width: w, height: h, cells: terrain };
  return moveCostAt(grid, tileTypes, x, y) < 99;
}

function collectFlankSlots(terrain, tileTypes, mapObjects, side, want) {
  const w = terrain[0].length;
  const h = terrain.length;
  const cols =
    side === "left"
      ? [0, 1, 2, 3, 4, 5]
      : [w - 1, w - 2, w - 3, w - 4, w - 5, w - 6];
  const out = [];
  for (const x of cols) {
    if (x < 0 || x >= w) continue;
    for (let y = 0; y < h; y++) {
      if (out.length >= want) return out;
      if (cellPassable(terrain, tileTypes, mapObjects, x, y)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function filterPresetEnemies(oldPresets, terrain, tileTypes, mapObjects) {
  if (!Array.isArray(oldPresets)) return [];
  return oldPresets.filter((e) =>
    cellPassable(terrain, tileTypes, mapObjects, e.x, e.y),
  );
}

/**
 * @param {object} oldScenario
 * @param {object} proc
 * @param {{ environment?: string } | null} catalogEntry
 * @param {Record<string, object>} tileTypes
 */
function buildV2Scenario(oldScenario, proc, catalogEntry, tileTypes) {
  const terrain = proc.terrain;
  const mapObjects = proc.mapObjects ?? [];
  const w = proc.width;
  const h = proc.height;

  const nSkirm = Math.max(1, oldScenario.skirmishDeploy?.length ?? 4);
  const nP1 = Math.max(1, oldScenario.p1DeploymentSlots?.length ?? 8);
  const nP2 = Math.max(1, oldScenario.p2DeploymentSlots?.length ?? 8);

  const leftPool = collectFlankSlots(
    terrain,
    tileTypes,
    mapObjects,
    "left",
    Math.max(nSkirm, nP1),
  );
  const rightPool = collectFlankSlots(
    terrain,
    tileTypes,
    mapObjects,
    "right",
    nP2,
  );

  const skirmishDeploy = leftPool.slice(0, nSkirm);
  const p1DeploymentSlots = leftPool.slice(0, nP1);
  const p2DeploymentSlots = rightPool.slice(0, nP2);

  let presetEnemies = filterPresetEnemies(
    oldScenario.presetEnemies,
    terrain,
    tileTypes,
    mapObjects,
  );
  if (!presetEnemies.length) {
    presetEnemies = proc.presetEnemies;
  }

  const ambientEffects =
    catalogEntry &&
    (catalogEntry.environment === "urban" || catalogEntry.environment === "mixed")
      ? proc.ambientEffects ?? []
      : oldScenario.ambientEffects ?? proc.ambientEffects ?? [];

  const base = {
    id: oldScenario.id,
    name: oldScenario.name,
    width: w,
    height: h,
    cellSize: oldScenario.cellSize ?? proc.cellSize ?? 48,
    winCondition: oldScenario.winCondition ?? { type: "eliminate" },
    terrain: proc.terrain,
    units: [],
    presetEnemies,
    skirmishDeploy,
    mapObjects,
    buildings: proc.buildings ?? [],
    bridgeCells: proc.bridgeCells,
    generator: {
      ...proc.generator,
      migrationV2: {
        tool: "regenerate_maps_v2.mjs",
        templateUsed: proc._templateUsed ?? null,
        migratedAt: new Date().toISOString(),
      },
    },
    fogOfWar: oldScenario.fogOfWar ?? false,
    ambientEffects,
  };

  if (oldScenario.p1DeploymentSlots?.length) {
    base.p1DeploymentSlots = p1DeploymentSlots;
  }
  if (oldScenario.p2DeploymentSlots?.length) {
    base.p2DeploymentSlots = p2DeploymentSlots;
  }

  const optionalKeys = [
    "battlePlaneLayer",
    "destructibles",
    "soloTags",
    "tags",
    "difficulty",
    "biome",
  ];
  for (const k of optionalKeys) {
    if (oldScenario[k] !== undefined) base[k] = oldScenario[k];
  }

  return base;
}

function findCatalogEntryByPath(catalog, posixPath) {
  const maps = catalog.maps || [];
  return maps.find((m) => m.path === posixPath) ?? null;
}

function resolveBiome(oldScenario, catalogEntry) {
  if (catalogEntry) return getBiomeForCatalogEntry(catalogEntry);
  const b = oldScenario.biome;
  if (b && BIOMES.includes(b)) return b;
  return environmentToBiome(oldScenario.environment) || "urban";
}

function tryGenerate(width, height, biome, seedBase, tileTypes, assetManifest) {
  const maxObstacles = Math.min(28, Math.max(8, Math.floor((width * height) / 12)));
  for (let k = 0; k < 24; k++) {
    const seed = (seedBase + k * 0x9e3779b9) >>> 0;
    const spec = {
      width,
      height,
      biome,
      template: "auto",
      seed,
      tileTypes,
      assetManifest,
      addRiverStrip: true,
      maxGenerationAttempts: 48,
      maxObstacles,
      numBuildings: biome === "desert" ? 0 : 1,
    };
    const proc = generateProceduralScenario(spec);
    if (proc) {
      proc._templateUsed = spec.template;
      return proc;
    }
  }
  return null;
}

function main() {
  const tileTextures = JSON.parse(fs.readFileSync(TILE_TYPES_PATH, "utf8"));
  const tileTypes = tileTextures.types || {};
  let assetManifest = null;
  try {
    assetManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    console.warn("WARN: assetManifest.json missing");
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

  const files = walkJsonFiles(SCENARIOS_ROOT);
  let ok = 0;
  let fail = 0;

  for (const abs of files) {
    const rel = path.relative(SCENARIOS_ROOT, abs);
    const posixRel = toPosix(rel);
    const raw = fs.readFileSync(abs, "utf8");
    let scenario;
    try {
      scenario = JSON.parse(raw);
    } catch {
      console.error(`SKIP (invalid JSON): ${posixRel}`);
      fail++;
      continue;
    }

    const w = scenario.width;
    const h = scenario.height;
    if (typeof w !== "number" || typeof h !== "number") {
      console.log(`SKIP (no width/height): ${posixRel}`);
      continue;
    }
    /* Procedural template + divider pipeline expects playable interior; tiny fixtures (e.g. LOS tests) stay skipped. */
    if (w < 6 || h < 5) {
      console.log(`SKIP (dimensions too small for v2 regen): ${posixRel} (${w}x${h})`);
      continue;
    }

    const catalogPath = toPosix(path.join("js/config/scenarios", rel));
    const catalogEntry = findCatalogEntryByPath(catalog, catalogPath);
    const biome = resolveBiome(scenario, catalogEntry);
    const id = scenario.id || path.basename(rel, ".json");
    const seedBase = stableSeedFromName(id);

    const proc = tryGenerate(w, h, biome, seedBase, tileTypes, assetManifest);
    if (!proc) {
      console.error(`FAIL (no valid generation): ${posixRel} biome=${biome}`);
      fail++;
      continue;
    }

    const merged = buildV2Scenario(scenario, proc, catalogEntry, tileTypes);

    const outName = `${path.basename(rel, ".json")}_v2.json`;
    const outDir = path.join(OUT_ROOT, path.dirname(rel));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);
    fs.writeFileSync(
      outPath,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8",
    );

    console.log(
      `OK ${posixRel} -> ${toPosix(path.relative(ROOT, outPath))} template=${proc._templateUsed} ${w}x${h}`,
    );
    ok++;
  }

  console.log(`\nDone. ${ok} written, ${fail} failed/skipped.`);
  if (fail) process.exitCode = 1;
}

main();
