/**
 * Run: node js/battle-plane/verifyLosBuilding.mjs
 * Sniper cannot shoot grunt through a ruins mapObject (same row).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GameState } from "../engine/gameState.js";
import { hasLineOfSight } from "../engine/los.js";
import { canAttack } from "../engine/combat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const mapPath = path.join(
  ROOT,
  "js",
  "config",
  "scenarios",
  "maps",
  "map_test_los_building.json",
);
const scenario = loadJson(mapPath);
const units = loadJson(path.join(ROOT, "js", "config", "units.json"));
const tiles = loadJson(path.join(ROOT, "js", "config", "tileTextures.json"));
const tileTypes = tiles.types;

const game = new GameState(scenario, units, tileTypes);
const sniper = game.units.find((u) => u.templateId === "sniper");
const grunt = game.units.find((u) => u.templateId === "grunt_red");
if (!sniper || !grunt) {
  console.error("Missing sniper or grunt on test map.");
  process.exit(1);
}

const ctx = game.losCtx();
const losClear = hasLineOfSight(
  game.grid,
  game.tileTypes,
  sniper.x,
  sniper.y,
  grunt.x,
  grunt.y,
  { sightBudget: ctx.sightBudget, mapObjects: ctx.mapObjects },
);
const canShoot = canAttack(sniper, grunt, game.units, ctx);

console.log("LOS building / ruin obstruction test (map_test_los_building.json)");
console.log("  Sniper at", sniper.x, sniper.y, "→ grunt at", grunt.x, grunt.y);
console.log("  Ruin mapObject blocks LOS on interior cell (2,1).");
console.log("  hasLineOfSight:", losClear ? "CLEAR (FAIL)" : "blocked (ok)");
console.log("  canAttack:", canShoot ? "true (FAIL)" : "false (ok)");
console.log("");
console.log("  In-game: select sniper; grunt is not attackable; explainAttackFailure → Line of sight is blocked.");
console.log("");

if (losClear || canShoot) {
  process.exit(1);
}