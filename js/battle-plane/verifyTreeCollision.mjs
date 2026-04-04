/**
 * Run from repo root: node js/battle-plane/verifyTreeCollision.mjs
 * Asserts tree mapObjects block movement and prints the battle toast string.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GameState } from "../engine/gameState.js";
import { moveCostAt, buildTerrainGrid } from "../engine/terrain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function describeMoveBlockerName(game, x, y) {
  const mo = game.mapObjects?.find(
    (o) => o.x === x && o.y === y && o.blocksMove !== false,
  );
  if (mo?.visualKind) {
    const k = String(mo.visualKind);
    return k.charAt(0).toUpperCase() + k.slice(1);
  }
  const t = game.grid.cells[y]?.[x];
  const tt = game.tileTypes?.[t];
  if (tt?.displayName) return tt.displayName;
  if (t === "water") return "Water";
  if (t === "building_block" || t === "cp_building") return "Building";
  if (t) {
    return String(t)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "Terrain";
}

const mapPath = path.join(
  ROOT,
  "js",
  "config",
  "scenarios",
  "maps",
  "map_theater_arctic.json",
);
const scenario = loadJson(mapPath);
const units = loadJson(path.join(ROOT, "js", "config", "units.json"));
const tiles = loadJson(path.join(ROOT, "js", "config", "tileTextures.json"));
const tileTypes = tiles.types;

const tree = (scenario.mapObjects || []).find((o) => o.visualKind === "tree");
if (!tree) {
  console.error("No tree mapObject in map_theater_arctic.json");
  process.exit(1);
}

const game = new GameState(scenario, units, tileTypes);
const { x, y } = tree;
const infantryLike = { movementClass: "infantry" };
const vehicleLike = { movementClass: "vehicle" };
const costInf = game.costAtForUnit(infantryLike, x, y);
const costVeh = game.costAtForUnit(vehicleLike, x, y);
const grid = buildTerrainGrid(scenario, { defaultType: "plains" });
const terrainOnly = moveCostAt(grid, tileTypes, x, y);

const name = describeMoveBlockerName(game, x, y);
const toast = `That position is blocked by ${name}.`;

console.log("Tree movement verification");
console.log("  Tile:", x, y, "| visualKind:", tree.visualKind);
console.log("  Terrain-only move cost:", terrainOnly);
console.log("  Infantry costAtForUnit:", costInf, "(expect 2 on plains+tree)");
console.log("  Vehicle costAtForUnit:", costVeh, "(expect >= 99)");
console.log("");
console.log("  Vehicle blocked toast would use:", '"' + toast + '"');
console.log("");

if (costVeh < 99 || costInf >= 99) {
  process.exit(1);
}