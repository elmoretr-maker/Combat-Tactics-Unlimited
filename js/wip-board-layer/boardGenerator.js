import { findPath } from "./astar.js";
import { moveCostAt } from "./terrain.js";
import { isBlockedMoveCost, BLOCKED_MOVE_COST } from "./pathfindingCost.js";
import { makeMapObject, mapObjectBlocksMoveAt } from "./mapObjects.js";

const OBSTACLE_SPRITES = [
  "assets/props/crate.png",
  "assets/props/barrel.png",
  "assets/props/ruins.png",
];

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function costWithObjects(grid, tileTypes, mapObjects, x, y) {
  if (mapObjectBlocksMoveAt(mapObjects, x, y)) return BLOCKED_MOVE_COST;
  return moveCostAt(grid, tileTypes, x, y);
}

function pathStillExists(grid, tileTypes, mapObjects, scenario) {
  const units = scenario.units || [];
  const start = teamCentroid(units, 0);
  const end = teamCentroid(units, 1);
  if (!start || !end) return true;
  const costAt = (x, y) => costWithObjects(grid, tileTypes, mapObjects, x, y);
  return !!findPath(grid, start, end, costAt);
}

const SCATTER_FLOOR = new Set(["cp_grass", "plains", "desert", "snow"]);

/**
 * Random 5–10 obstacle props into `mapObjects` (movement + LOS). Does not mutate terrain type.
 */
export function generateBoard(scenario, grid, tileTypes, mapObjects) {
  const cfg = scenario.proceduralBoard;
  if (!cfg?.enabled) return;

  const str = String(cfg.seed ?? scenario.id ?? "board");
  const seed = str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const rnd = mulberry32(seed >>> 0);
  const reserved = reserveCriticalCells(grid, tileTypes, scenario);

  const candidates = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (reserved.has(`${x},${y}`)) continue;
      const t = grid.cells[y][x];
      if (!SCATTER_FLOOR.has(t)) continue;
      const c = moveCostAt(grid, tileTypes, x, y);
      if (isBlockedMoveCost(c)) continue;
      candidates.push([x, y]);
    }
  }

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const minO = cfg.minObstacles ?? 5;
  const maxO = cfg.maxObstacles ?? 10;
  const span = Math.max(0, maxO - minO);
  const target = Math.min(
    candidates.length,
    minO + Math.floor(rnd() * (span + 1)),
  );

  for (let i = 0; i < target; i++) {
    const pair = candidates[i];
    if (!pair) break;
    const [x, y] = pair;
    const sprite = OBSTACLE_SPRITES[Math.floor(rnd() * OBSTACLE_SPRITES.length)];
    const obj = makeMapObject(x, y, sprite);
    mapObjects.push(obj);
    if (!pathStillExists(grid, tileTypes, mapObjects, scenario)) {
      mapObjects.pop();
    }
  }
}
