import { findPath } from "../engine/astar.js";
import { moveCostAt } from "../engine/terrain.js";

const IMPASSABLE_TERRAIN = new Set(["water", "water_desert", "water_urban"]);
import { isBlockedMoveCost, BLOCKED_MOVE_COST } from "./pathfindingCost.js";
import { makeMapObject, mapObjectBlocksMoveAt } from "./mapObjects.js";
import {
  computeOrthogonalPathwayReserve,
  expandPathwayReserve,
  tacticalDensity,
  pickKindIndexFromNoise,
  placementSpecForKind,
  terrainAllowsPlacement,
  treeSpacingOk,
  effectiveObstacleKind,
} from "../mapgen/tacticalPlacement.js";

/**
 * Scatter props — CraftPix PNG City / PNG City 2 (same licensed tree as `tileTextures.json` cp_*).
 * `assets/props/*.png` was a stub path; real art lives under attached_assets/craftpix_pack/.
 */
const CP_CITY = "attached_assets/craftpix_pack/city";
const PROP_TYPES = [
  {
    kind: "crate",
    sprite: `${CP_CITY}/PNG City/Crates Barrels/TDS04_0018_Box1.png`,
  },
  {
    kind: "barrel",
    sprite: `${CP_CITY}/PNG City/Crates Barrels/TDS04_0016_Barrel.png`,
  },
  {
    kind: "ruins",
    sprite:
      `${CP_CITY}/PNG City 2/broken_small_houses/Elements/small_house1_carcass1.png`,
  },
  {
    kind: "tree",
    sprite: `${CP_CITY}/PNG City/Trees Bushes/TDS04_0022_Tree1.png`,
  },
  {
    kind: "house",
    sprite:
      `${CP_CITY}/PNG City 2/small_houses/Details/small_house1_color1_roof.png`,
  },
];

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

/**
 * Random obstacle props into `mapObjects` (movement + LOS) with tactical rules:
 * terrain-locked kinds (ships/planes/strips), tree spacing, noise clusters,
 * orthogonal pathway free of blocking props.
 */
export function generateBattleObstacles(scenario, grid, tileTypes, mapObjects) {
  const cfg = scenario.proceduralBoard;
  if (!cfg?.enabled) return;

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
  /* Expand pathway reserve by 1 tile so props can't flank the free lane */
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
  /* 1-cell inward margin: props on the outermost row/column look unnatural
     and can interact poorly with spawn zones placed at grid edges. */
  for (let y = 1; y < grid.height - 1; y++) {
    for (let x = 1; x < grid.width - 1; x++) {
      if (reserved.has(key(x, y))) continue;
      const t = grid.cells[y][x];
      if (t === "building_block") continue;
      candidates.push([x, y]);
    }
  }

  /* Shuffle candidates so props are tried in random spatial order.
     Noise still controls placement probability via the rnd() gate in tryPlaceAt,
     so high-density areas still get more props — but no longer in sequential
     ridge order that causes line formation. */
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

  const tryPlaceAt = (x, y, force = false) => {
    const t = grid.cells[y][x];

    if (!IMPASSABLE_TERRAIN.has(t)) {
      const c = moveCostAt(grid, tileTypes, x, y);
      if (isBlockedMoveCost(c)) return false;
    }

    const valid = PROP_TYPES.filter((ob) => {
      const spec = placementSpecForKind(ob.kind, ob.sprite);
      return terrainAllowsPlacement(t, spec.allowTerrain);
    });
    if (!valid.length) return false;

    const d = tacticalDensity(noiseSeed, x, y);
    if (!force && rnd() > 0.2 + d * 0.75) return false;

    const pick = valid[pickKindIndexFromNoise(d, valid.length, x, y, rnd)];
    const vk = effectiveObstacleKind(pick.kind, pick.sprite);
    const spec = placementSpecForKind(pick.kind, pick.sprite);
    const willBlock = spec.placement !== "air" && spec.blocksMove !== false;

    /* Spacing: trees need 1-cell isolation; all blocking props need orthogonal clearance */
    if (!treeSpacingOk(mapObjects, x, y, vk, willBlock)) return false;

    /* Pathway guard */
    if (willBlock && pathwayReserve.has(key(x, y))) return false;

    const extra = {};
    if (spec.placement === "air") {
      extra.pyOffset = Math.round(-cs * 0.36);
      extra.blocksMove = false;
      extra.blocksLos = false;
    } else {
      if (spec.blocksMove === false) extra.blocksMove = false;
      if (spec.blocksLos === false) extra.blocksLos = false;
    }

    const obj = makeMapObject(x, y, pick.sprite, undefined, vk, extra);
    mapObjects.push(obj);
    if (!pathStillExists(grid, tileTypes, mapObjects, scenario)) {
      mapObjects.pop();
      return false;
    }
    return true;
  };

  /* Primary pass */
  for (let i = 0; i < candidates.length && mapObjects.length < target; i++) {
    const [x, y] = candidates[i];
    if (mapObjects.some((o) => o.x === x && o.y === y)) continue;
    tryPlaceAt(x, y, false);
  }

  /* Fill pass: cap at 75% of target so we don't pack solid walls */
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
