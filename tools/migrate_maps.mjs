// Global map migration: regenerate catalog maps with procedural pipeline
// (divider rule, 2-tile corridor ribbon, furniture rules, flowConnectors).
// Usage: node tools/migrate_maps.mjs [--only=id1,id2] [--dry-run] [--force]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateProceduralScenario } from "../js/mapgen/pipeline.js";
import { getBiomeForCatalogEntry } from "../js/mapgen/biome.js";
import { moveCostAt } from "../js/engine/terrain.js";
import { mapObjectBlocksMoveAt } from "../js/battle-plane/mapObjects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MAPS_DIR = path.join(ROOT, "js", "config", "scenarios", "maps");
const ARCHIVE_DIR = path.join(MAPS_DIR, "archive_for_review");
const CATALOG_PATH = path.join(ROOT, "js", "config", "mapCatalog.json");
const TILE_TYPES_PATH = path.join(ROOT, "js", "config", "tileTextures.json");
const MANIFEST_PATH = path.join(ROOT, "js", "config", "assetManifest.json");
const LOG_PATH = path.join(ROOT, "tools", "migration_log.txt");

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry-run");
const FORCE = ARGS.includes("--force");
const ONLY_ARG = ARGS.find((a) => a.startsWith("--only="));
const ONLY = ONLY_ARG
  ? new Set(
      ONLY_ARG.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean),
    )
  : null;

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line, "utf8");
  console.log(msg);
}

function stableSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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

function riverFlowStats(terrain, flowConnectors) {
  const divider = new Set(["water"]);
  let waterCells = 0;
  for (let y = 0; y < terrain.length; y++) {
    for (let x = 0; x < terrain[y].length; x++) {
      if (divider.has(terrain[y][x])) waterCells++;
    }
  }
  const byVariant = {};
  for (const f of flowConnectors || []) {
    byVariant[f.variant] = (byVariant[f.variant] || 0) + 1;
  }
  return { waterCells, flowConnectorCount: flowConnectors?.length ?? 0, byVariant };
}

function buildMigratedScenario(catalogEntry, oldScenario, proc, tileTypes) {
  const { terrain, mapObjects, buildings, generator } = proc;
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
  const rightPool = collectFlankSlots(terrain, tileTypes, mapObjects, "right", nP2);

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
    catalogEntry.environment === "urban" || catalogEntry.environment === "mixed"
      ? proc.ambientEffects ?? []
      : [];

  const displayBase = String(catalogEntry.name || "").replace(/\s+v2$/i, "").trim() || catalogEntry.id;

  return {
    id: catalogEntry.id,
    name: `${displayBase} v2`,
    width: w,
    height: h,
    cellSize: oldScenario.cellSize ?? proc.cellSize ?? 48,
    winCondition: oldScenario.winCondition ?? { type: "eliminate" },
    terrain: proc.terrain,
    units: [],
    presetEnemies,
    skirmishDeploy,
    p1DeploymentSlots,
    p2DeploymentSlots,
    mapObjects: proc.mapObjects ?? [],
    buildings: proc.buildings ?? [],
    generator: {
      ...generator,
      migration: {
        tool: "migrate_maps.mjs",
        catalogId: catalogEntry.id,
        migratedAt: new Date().toISOString(),
        environment: catalogEntry.environment,
        preservedPresetCount: presetEnemies.length,
      },
    },
    fogOfWar: oldScenario.fogOfWar ?? false,
    ambientEffects,
  };
}

function main() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (!fs.existsSync(LOG_PATH) || !DRY) {
    fs.appendFileSync(
      LOG_PATH,
      `\n======== Map migration run ${new Date().toISOString()} ========\n`,
      "utf8",
    );
  }

  const tileTextures = JSON.parse(fs.readFileSync(TILE_TYPES_PATH, "utf8"));
  const tileTypes = tileTextures.types || {};
  let assetManifest = null;
  try {
    assetManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    logLine("WARN: assetManifest.json missing; flowConnector sprite paths may be null.");
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  const maps = catalog.maps || [];

  for (const entry of maps) {
    if (ONLY && !ONLY.has(entry.id)) continue;

    const rel = entry.path.replace(/\//g, path.sep);
    const mapPath = path.join(ROOT, rel);
    if (!fs.existsSync(mapPath)) {
      logLine(`SKIP (missing file): ${entry.id} -> ${entry.path}`);
      continue;
    }

    const oldRaw = fs.readFileSync(mapPath, "utf8");
    const oldScenario = JSON.parse(oldRaw);
    if (oldScenario.generator?.migration && !FORCE && !DRY) {
      logLine(`SKIP (already v2): ${entry.id} -- use --force to regenerate`);
      continue;
    }

    const biome = getBiomeForCatalogEntry(entry);
    const seed = stableSeed(`ctu_map_v2_${entry.id}`);
    const area = entry.width * entry.height;
    const maxObstacles = Math.min(28, Math.max(8, Math.floor(area / 12)));

    const beforeStats = riverFlowStats(oldScenario.terrain, []);

    const proc = generateProceduralScenario({
      width: entry.width,
      height: entry.height,
      seed,
      biome,
      tileTypes,
      assetManifest,
      addRiverStrip: true,
      maxGenerationAttempts: 40,
      numBuildings: 1,
      maxObstacles,
    });

    if (!proc) {
      logLine(
        `FAIL two_disjoint_paths/connectivity: ${entry.id} biome=${biome} seed=${seed} (main map unchanged; see archive_for_review)`,
      );
      const failPath = path.join(
        ARCHIVE_DIR,
        `${entry.id}__FAILED_REGEN__${Date.now()}.json`,
      );
      if (!DRY) {
        fs.writeFileSync(failPath, oldRaw, "utf8");
        logLine(`  Wrote failure snapshot -> ${path.relative(ROOT, failPath)}`);
      }
      continue;
    }

    const afterStats = riverFlowStats(proc.terrain, proc.generator?.flowConnectors);

    const migrated = buildMigratedScenario(entry, oldScenario, proc, tileTypes);

    const archivePath = path.join(ARCHIVE_DIR, `${entry.id}__pre_v2.json`);
    if (!DRY) {
      fs.writeFileSync(archivePath, oldRaw, "utf8");
      fs.writeFileSync(mapPath, JSON.stringify(migrated, null, 2) + "\n", "utf8");
    }

    logLine(`OK ${entry.id} (biome=${biome}) seed=${proc.generator.seed}`);
    logLine(
      `  River/flow BEFORE: waterCells=${beforeStats.waterCells} (no flowConnectors in JSON)`,
    );
    logLine(
      `  River/flow AFTER:  waterCells=${afterStats.waterCells} flowLayers=${afterStats.flowConnectorCount} variants=${JSON.stringify(afterStats.byVariant)}`,
    );
    logLine(
      `  Archived: ${path.relative(ROOT, archivePath)} -> wrote v2 -> ${path.relative(ROOT, mapPath)}`,
    );
  }

  logLine("Migration pass complete.");
}

main();
