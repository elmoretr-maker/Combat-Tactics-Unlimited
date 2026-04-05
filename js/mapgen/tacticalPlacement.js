/**
 * Tactical prop placement: terrain rules, spacing, noise clusters, orthogonal pathways.
 * Used by tacticalAssets.js (procedural maps) and scatterObstacles.js (battle-plane boards).
 */

import { inBounds, neighbors4, chebyshev } from "../engine/grid.js";
import { gridFromTerrain, terrainCostAt } from "./gridCost.js";

const BLOCKED = 99;

/** Walkable “open lane” terrains for the reserved 4-neighbor pathway (grass / dirt / road). */
export const PATHWAY_TERRAIN = new Set([
  "plains",
  "cp_grass",
  "road",
  "cp_road",
  "desert",
  "snow",
]);

/** Grass / dirt–like ground for trees (not water, not building cells). */
export const TREE_GROUND = new Set([
  "plains",
  "cp_grass",
  "road",
  "cp_road",
  "desert",
  "forest",
]);

function key(x, y) {
  return `${x},${y}`;
}

/**
 * Fix manifest mistakes: e.g. kind "crate" with a Tree sprite path.
 * @param {string} kind
 * @param {string} [sprite]
 */
export function effectiveObstacleKind(kind, sprite = "") {
  const k = (kind || "crate").toLowerCase();
  const s = (sprite || "").toLowerCase();
  if (/tree|bush|spruce|pine|oak/.test(s)) return "tree";
  if (/ship|boat|vessel|dinghy|yacht|hull/.test(s)) return "ship";
  if (/plane|jet|aircraft|heli|chopper|uav|drone|fighter|bomber/.test(s)) {
    return "plane";
  }
  return k;
}

/**
 * @returns {{ placement: "terrain"|"water"|"air"|"strip", allowTerrain: Set<string>|null, pyOffset?: number, blocksMove?: boolean, blocksLos?: boolean }}
 */
export function placementSpecForKind(kind, sprite = "") {
  const eff = effectiveObstacleKind(kind, sprite);
  const s = (sprite || "").toLowerCase();

  if (
    eff === "ship" ||
    /ship|boat|vessel|dinghy|yacht|hull/.test(eff) ||
    /ship|boat|vessel/.test(s)
  ) {
    return {
      placement: "water",
      allowTerrain: new Set(["water"]),
      blocksMove: true,
      blocksLos: true,
    };
  }

  if (
    eff === "plane" ||
    /plane|jet|aircraft|heli|chopper|uav|drone|fighter|bomber/.test(eff) ||
    /plane|jet|heli|aircraft|fighter|bomber/.test(s)
  ) {
    return {
      placement: "air",
      allowTerrain: new Set([
        "plains",
        "cp_grass",
        "road",
        "cp_road",
        "desert",
        "snow",
        "urban",
        "forest",
        "hill",
      ]),
      pyOffset: -17,
      blocksMove: false,
      blocksLos: false,
    };
  }

  if (eff === "strip") {
    return {
      placement: "strip",
      allowTerrain: new Set(["road", "cp_road"]),
      blocksMove: true,
      blocksLos: false,
    };
  }

  if (eff === "tree") {
    return {
      placement: "terrain",
      allowTerrain: TREE_GROUND,
      blocksMove: true,
      blocksLos: true,
    };
  }

  if (eff === "house" || eff === "ruins") {
    return {
      placement: "terrain",
      allowTerrain: new Set([
        ...TREE_GROUND,
        "urban",
        "cp_building",
        "cp_rubble",
        "building_block",
      ]),
      blocksMove: true,
      blocksLos: true,
    };
  }

  /* crate, barrel, default clutter */
  return {
    placement: "terrain",
    allowTerrain: new Set([
      ...TREE_GROUND,
      "urban",
      "snow",
    ]),
    blocksMove: true,
    blocksLos: eff === "barrel" ? false : true,
  };
}

export function terrainAllowsPlacement(terrainId, allowTerrain) {
  if (!allowTerrain || !allowTerrain.size) return true;
  return allowTerrain.has(terrainId);
}

/**
 * Trees: no other tree within Chebyshev distance ≤ 1 (i.e. require ≥ 2 for another tree center).
 * @param {{ x: number, y: number, visualKind?: string }[]} mapObjects
 */
export function treeSpacingOk(mapObjects, x, y, kindForNew) {
  const k = (kindForNew || "").toLowerCase();
  if (k !== "tree") return true;
  for (const o of mapObjects) {
    const ok = (o.visualKind || "").toLowerCase();
    if (ok !== "tree") continue;
    if (chebyshev(o.x, o.y, x, y) <= 1) return false;
  }
  return true;
}

/** 4-neighbor A* / uniform-step path for orthogonal corridor. */
function findPath4(grid, start, goal, costAt) {
  const open = new Set([key(start[0], start[1])]);
  const dist = new Map([[key(start[0], start[1]), 0]]);
  const prev = new Map();
  while (open.size) {
    let bestK = null;
    let bestD = Infinity;
    for (const k of open) {
      const d = dist.get(k);
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    if (bestK == null) break;
    open.delete(bestK);
    const [cx, cy] = bestK.split(",").map(Number);
    if (cx === goal[0] && cy === goal[1]) {
      const path = [];
      let cur = bestK;
      while (cur) {
        path.push(cur.split(",").map(Number));
        cur = prev.get(cur);
      }
      path.reverse();
      return path;
    }
    for (const [nx, ny] of neighbors4(cx, cy)) {
      if (!inBounds(grid, nx, ny)) continue;
      const step = costAt(nx, ny);
      if (step >= BLOCKED) continue;
      const nk = key(nx, ny);
      const alt = bestD + step;
      if (alt < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, alt);
        prev.set(nk, bestK);
        open.add(nk);
      }
    }
  }
  return null;
}

/**
 * Cells that must stay free of blocking (blocksMove) props so a 1-tile-wide orthogonal lane exists.
 * @param {string[][]} terrain
 * @param {Record<string, object>} tileTypes
 * @param {[number, number][]} playerSpawns
 * @param {[number, number][]} enemySpawns
 */
export function computeOrthogonalPathwayReserve(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
) {
  const grid = gridFromTerrain(terrain);
  const baseCost = terrainCostAt(grid, tileTypes);
  const costAt = (x, y) => {
    const t = terrain[y][x];
    if (!PATHWAY_TERRAIN.has(t)) return BLOCKED;
    const c = baseCost(x, y);
    if (c >= BLOCKED) return BLOCKED;
    return c;
  };

  const reserve = new Set();
  outer: for (const s of playerSpawns) {
    for (const g of enemySpawns) {
      if (costAt(s[0], s[1]) >= BLOCKED || costAt(g[0], g[1]) >= BLOCKED) {
        continue;
      }
      const path = findPath4(grid, s, g, costAt);
      if (path && path.length >= 2) {
        for (const [x, y] of path) reserve.add(key(x, y));
        break outer;
      }
    }
  }

  if (reserve.size === 0) {
    const h = terrain.length;
    const w = h ? terrain[0].length : 0;
    const midY = Math.floor(h / 2);
    for (let x = 1; x < w - 1; x++) {
      if (costAt(x, midY) < BLOCKED) reserve.add(key(x, midY));
    }
  }

  return reserve;
}

function hash01(seed, ix, iy) {
  let h = seed ^ (ix * 374761393) ^ (iy * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0,1], suitable for cluster bias. */
export function clusterNoise(seed, x, y, scale) {
  const sx = x / scale;
  const sy = y / scale;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const fade = (t) => t * t * (3 - 2 * t);
  const u = fade(fx);
  const v = fade(fy);
  const n00 = hash01(seed, x0, y0);
  const n10 = hash01(seed, x0 + 1, y0);
  const n01 = hash01(seed, x0, y0 + 1);
  const n11 = hash01(seed, x0 + 1, y0 + 1);
  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

/**
 * Layered noise → stronger clumps (higher values cluster).
 */
export function tacticalDensity(seed, x, y) {
  const a = clusterNoise(seed, x, y, 3.2);
  const b = clusterNoise(seed + 101, x, y, 7.5);
  const c = clusterNoise(seed + 509, x, y, 14);
  return 0.5 * a + 0.32 * b + 0.18 * c;
}

/**
 * Pick obstacle index using noise (not uniform random).
 * @param {number} n01 density in ~[0,1]
 * @param {number} len pool length
 * @param {() => number} rnd fallback
 */
export function pickKindIndexFromNoise(n01, len, x, y, rnd) {
  if (len <= 1) return 0;
  const jitter = hash01(777, x, y);
  const t = (n01 * 0.82 + jitter * 0.18) % 1;
  return Math.min(len - 1, Math.floor(t * len));
}
