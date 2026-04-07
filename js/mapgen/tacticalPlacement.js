/**
 * Tactical prop placement: terrain rules, spacing, noise clusters, orthogonal pathways.
 * Used by tacticalAssets.js (procedural maps) and scatterObstacles.js (battle-plane boards).
 */

import { inBounds, neighbors4, chebyshev } from "../engine/grid.js";
import { gridFromTerrain, terrainCostAt } from "./gridCost.js";

const BLOCKED = 99;

/**
 * Reject if placing a new blocking prop would create a run of ≥3 blocking props in a row
 * on the same row or column (orthogonal only).
 */
export function wouldCompleteOrthogonalBlockingLineOfThree(
  mapObjects,
  x,
  y,
  w,
  h,
  willBlockNew,
) {
  if (!willBlockNew) return false;

  const blocksAt = (tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    for (const o of mapObjects) {
      if (o.x !== tx || o.y !== ty) continue;
      if (o.blocksMove === false) continue;
      const k = (o.visualKind || "").toLowerCase();
      if (k === "plane") continue;
      return true;
    }
    return false;
  };

  let left = 0;
  for (let tx = x - 1; tx >= 0 && blocksAt(tx, y); tx--) left++;
  let right = 0;
  for (let tx = x + 1; tx < w && blocksAt(tx, y); tx++) right++;
  if (left + right + 1 >= 3) return true;

  let up = 0;
  for (let ty = y - 1; ty >= 0 && blocksAt(x, ty); ty--) up++;
  let down = 0;
  for (let ty = y + 1; ty < h && blocksAt(x, ty); ty++) down++;
  return up + down + 1 >= 3;
}

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
 * Spacing check for a candidate placement. Per-kind exclusion zones:
 *
 * - tree:  no other tree within Chebyshev 2 (5×5 zone). Forces forest blobs,
 *          not lines. 3-cell minimum gap between tree centres.
 * - crate: no spacing restriction — small clutter can sit adjacent freely.
 * - other blocking props (rock, ruins, barrel, …): full Chebyshev-1 exclusion
 *          (3×3 zone). Prevents every-other-cell diagonal fills that produce
 *          visible lines while still allowing organic single-cell clusters.
 *
 * @param {{ x: number, y: number, visualKind?: string, blocksMove?: boolean }[]} mapObjects
 * @param {number} x
 * @param {number} y
 * @param {string} kindForNew  effective visual kind of the candidate
 * @param {boolean} [newBlocksMove]
 */
export function treeSpacingOk(mapObjects, x, y, kindForNew, newBlocksMove = true) {
  const k = (kindForNew || "").toLowerCase();

  for (const o of mapObjects) {
    const dist = chebyshev(o.x, o.y, x, y);

    /* Trees: no other tree within Chebyshev 2 (3-cell gap, all directions). */
    if (k === "tree") {
      const ov = (o.visualKind || "").toLowerCase();
      if (ov === "tree" && dist <= 2) return false;
    }

    /* Solid blocking props (rocks, ruins, barrels — not trees or crates):
       Full Chebyshev-1 exclusion around every placed blocking prop.
       This closes the diagonal gaps that the old axis-aligned rule left open,
       which was the source of every-other-cell diagonal lines. */
    if (k !== "crate" && k !== "tree" && newBlocksMove && o.blocksMove !== false) {
      if (dist <= 1) return false;
    }
  }
  return true;
}

/**
 * Build a fast Set of cells that are occupied or adjacent (Chebyshev 1) to existing blocking props.
 * Used to pre-filter candidates before the expensive path check.
 * @param {{ x: number, y: number, blocksMove?: boolean }[]} mapObjects
 * @returns {Set<string>}
 */
export function buildBlockedNeighbourSet(mapObjects) {
  const s = new Set();
  for (const o of mapObjects) {
    if (o.blocksMove === false) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        s.add(key(o.x + dx, o.y + dy));
      }
    }
  }
  return s;
}

/**
 * Expand a pathway reserve Set by 1 cardinal tile so props cannot be placed
 * immediately adjacent to the free lane (would close diagonal bypasses).
 * @param {Set<string>} reserve
 * @param {number} w
 * @param {number} h
 */
export function expandPathwayReserve(reserve, w, h) {
  const expanded = new Set(reserve);
  for (const k of reserve) {
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) expanded.add(`${nx},${ny}`);
    }
  }
  return expanded;
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

/** Tier biases scatter frequency only — not pool membership. */
export function tierScatterWeight(tier) {
  if (tier === "high") return 2;
  if (tier === "legacy") return 0.5;
  return 1;
}

/**
 * Noise-biased pick weighted by manifest tier.
 * @param {number} n01 tactical density ~[0,1]
 * @param {{ manifestAsset?: { tier?: string } }[]} entries
 */
export function pickScatterEntryIndex(n01, entries, x, y, rnd) {
  const len = entries.length;
  if (len <= 1) return 0;
  const weights = entries.map((e) => tierScatterWeight(e.manifestAsset?.tier));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return pickKindIndexFromNoise(n01, len, x, y, rnd);
  const jitter = hash01(777, x, y);
  let u = (n01 * 0.82 + jitter * 0.18) * total;
  for (let i = 0; i < len; i++) {
    u -= weights[i];
    if (u <= 0) return i;
  }
  return len - 1;
}
