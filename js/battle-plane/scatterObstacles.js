import { findPath } from "../engine/astar.js";
import { moveCostAt } from "../engine/terrain.js";
import { isBlockedMoveCost, BLOCKED_MOVE_COST } from "./pathfindingCost.js";
import { makeMapObject, mapObjectBlocksMoveAt } from "./mapObjects.js";
import {
  computeOrthogonalPathwayReserve,
  expandPathwayReserve,
  tacticalDensity,
  pickScatterEntryIndex,
  treeSpacingOk,
  wouldCompleteOrthogonalBlockingLineOfThree,
} from "../mapgen/tacticalPlacement.js";
import {
  terrainMatchesCtuPlacement,
  mapObjectExtraFromCtuBehavior,
  scatterObstacleEntriesFromManifest,
  scatterVisualKind,
  cellTouchesWaterTerrain,
} from "../mapgen/ctuMapgen.js";
import { applyPlacementRatioMix } from "../mapgen/placementRatios.js";
import { biomeToMapgenTheme } from "../mapgen/biome.js";

const IMPASSABLE_TERRAIN = new Set(["water", "water_desert", "water_urban"]);

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

function battleThemeId(scenario) {
  const t = scenario.generator?.theme || scenario.theme || scenario.mapTheme;
  if (t === "desert" || t === "grass" || t === "arctic") return t;
  const b = scenario.generator?.biome || scenario.biome;
  if (b) return biomeToMapgenTheme(b);
  return "urban";
}

function inferRoadTerrain(tileTypes) {
  if (tileTypes?.cp_road && !tileTypes.cp_road.blocksMove) return "cp_road";
  if (tileTypes?.road && !tileTypes.road.blocksMove) return "road";
  return "road";
}

/**
 * Random props using manifest CTU only (same rules as procedural mapgen).
 */
export function generateBattleObstacles(scenario, grid, tileTypes, mapObjects) {
  const cfg = scenario.proceduralBoard;
  if (!cfg?.enabled) return;

  const manifest = scenario.assetManifest;
  const themeId = battleThemeId(scenario);
  const pool = scatterObstacleEntriesFromManifest(manifest, themeId);
  if (!pool.length) return;

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
  const pathwayReserve = expandPathwayReserve(
    computeOrthogonalPathwayReserve(
      grid.cells,
      tileTypes,
      playerSpawns,
      enemySpawns,
    ),
    grid.width,
    grid.height,
  );

  const candidates = [];
  for (let y = 1; y < grid.height - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      if (reserved.has(key(x, y))) continue;
      const t = grid.cells[y][x];
      if (t === "building_block") continue;
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

  const noiseSeed = seed ^ 0x51a11ed;
  const roadTerrain = inferRoadTerrain(tileTypes);

  const tryPlaceAt = (x, y, force = false) => {
    const cells = grid.cells;
    const t = cells[y][x];

    if (!IMPASSABLE_TERRAIN.has(t)) {
      const c = moveCostAt(grid, tileTypes, x, y);
      if (isBlockedMoveCost(c)) return false;
    }

    let valid = pool.filter((ob) => terrainMatchesCtuPlacement(ob.ctu, cells, x, y));
    if (!valid.length) return false;

    const tw = cellTouchesWaterTerrain(cells, x, y);
    valid = applyPlacementRatioMix(themeId, valid, tw, rnd);
    if (!valid.length) return false;

    const d = tacticalDensity(noiseSeed, x, y);
    if (!force && rnd() > 0.2 + d * 0.75) return false;

    const idx = pickScatterEntryIndex(d, valid, x, y, rnd);
    const pick = valid[idx];
    if (!terrainMatchesCtuPlacement(pick.ctu, cells, x, y)) return false;

    const vk = scatterVisualKind(pick);
    const extra = mapObjectExtraFromCtuBehavior(pick.ctu, cs);
    const willBlock = extra.blocksMove !== false;

    if (!treeSpacingOk(mapObjects, x, y, vk, willBlock)) return false;

    if (
      wouldCompleteOrthogonalBlockingLineOfThree(
        mapObjects,
        x,
        y,
        grid.width,
        grid.height,
        willBlock,
      )
    ) {
      return false;
    }

    if (willBlock && pathwayReserve.has(key(x, y))) return false;

    const prevTerrain = cells[y][x];
    const isBridge =
      pick.ctu?.classification?.subtype === "bridge" && pick.ctu?.behavior?.walkable === true;
    if (isBridge) {
      cells[y][x] = roadTerrain;
    }

    const vkLow = (vk || "").toLowerCase();
    if (vkLow === "tree" || vkLow === "ruins" || vkLow === "house") {
      extra.propAnchor = extra.propAnchor || "bottom";
    }

    const obj = makeMapObject(x, y, pick.sprite, undefined, vk, extra);
    mapObjects.push(obj);
    if (!pathStillExists(grid, tileTypes, mapObjects, scenario)) {
      mapObjects.pop();
      cells[y][x] = prevTerrain;
      return false;
    }
    return true;
  };

  for (let i = 0; i < candidates.length && mapObjects.length < target; i++) {
    const [x, y] = candidates[i];
    if (mapObjects.some((o) => o.x === x && o.y === y)) continue;
    tryPlaceAt(x, y, false);
  }

  const fillTarget = Math.min(target, Math.ceil(target * 0.75));
  if (mapObjects.length < fillTarget) {
    const fillPool = [...candidates];
    for (let i = fillPool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [fillPool[i], fillPool[j]] = [fillPool[j], fillPool[i]];
    }
    let fillTries = Math.min(200, fillPool.length);
    for (const [x, y] of fillPool) {
      if (mapObjects.length >= fillTarget) break;
      if (fillTries-- <= 0) break;
      if (mapObjects.some((o) => o.x === x && o.y === y)) continue;
      tryPlaceAt(x, y, true);
    }
  }
}
