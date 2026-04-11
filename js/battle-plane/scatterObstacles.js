import { findPath } from "../engine/astar.js";
import { moveCostAt } from "../engine/terrain.js";
import { placeTargetDrivenMapObjects } from "../mapgen/targetDrivenMapObjects.js";
import { getThemeProfile } from "../mapgen/themeProfiles.js";
import { biomeToMapgenTheme } from "../mapgen/biome.js";

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(x, y) {
  return `${x},${y}`;
}

function teamCentroid(units, owner) {
  const us = units.filter((u) => u.owner === owner);
  if (!us.length) return null;
  const sx = us.reduce((a, u) => a + u.x, 0) / us.length;
  const sy = us.reduce((a, u) => a + u.y, 0) / us.length;
  return [Math.round(sx), Math.round(sy)];
}

function reserveCriticalCells(grid, tileTypes, scenario) {
  const units = scenario.units || [];
  const reserved = new Set();
  const start = teamCentroid(units, 0);
  const end = teamCentroid(units, 1);
  if (start && end) {
    const costAt = (x, y) => moveCostAt(grid, tileTypes, x, y);
    const path = findPath(grid, start, end, costAt);
    if (path) {
      for (const [x, y] of path) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            reserved.add(`${x + dx},${y + dy}`);
          }
        }
      }
    }
  }
  for (const u of units) {
    reserved.add(`${u.x},${u.y}`);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      reserved.add(`${u.x + dx},${u.y + dy}`);
    }
  }
  return reserved;
}

function battleThemeId(scenario) {
  const t = scenario.generator?.theme || scenario.theme || scenario.mapTheme;
  if (t === "desert" || t === "grass" || t === "arctic") return t;
  const b = scenario.generator?.biome || scenario.biome;
  if (b) return biomeToMapgenTheme(b);
  return "urban";
}

/**
 * Props using manifest CTU + target-driven category counts (same engine as procedural mapgen).
 */
export function generateBattleObstacles(scenario, grid, tileTypes, mapObjects) {
  const cfg = scenario.proceduralBoard;
  if (!cfg?.enabled) return;

  const manifest = scenario.assetManifest;
  const themeId = battleThemeId(scenario);
  const profile = getThemeProfile(themeId, manifest);
  if (!profile.obstacleVisualKinds?.length) return;

  const str = String(cfg.seed ?? scenario.id ?? "board");
  const seed0 = str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const seed = seed0 >>> 0;
  const rnd = mulberry32(seed);
  const reserved = reserveCriticalCells(grid, tileTypes, scenario);
  const cs = grid.cellSize || scenario.cellSize || 48;

  const u0 = (scenario.units || []).filter((u) => u.owner === 0);
  const u1 = (scenario.units || []).filter((u) => u.owner === 1);
  const playerSpawns =
    u0.length > 0
      ? u0.map((u) => [u.x, u.y])
      : [[1, Math.floor(grid.height / 2)]];
  const enemySpawns =
    u1.length > 0
      ? u1.map((u) => [u.x, u.y])
      : [[grid.width - 2, Math.floor(grid.height / 2)]];

  const biome = scenario.generator?.biome || scenario.biome;

  const { warnings } = placeTargetDrivenMapObjects({
    terrain: grid.cells,
    tileTypes,
    playerSpawns,
    enemySpawns,
    protectedRibbon: reserved,
    profile,
    rnd,
    assetManifest: manifest,
    placementSeed: seed ^ 0x51a11ed,
    cellSize: cs,
    mapgenTheme: profile.id,
    biome,
    mapObjects,
  });
  for (const wmsg of warnings) {
    console.warn(wmsg);
  }
}
