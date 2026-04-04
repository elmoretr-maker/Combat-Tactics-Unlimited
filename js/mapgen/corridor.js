/**
 * Tactical corridor mask: L∞ dilation of a shortest A* path between spawn regions.
 * Step 3 must not place blocking props/building footprint inside this ribbon
 * (keeps primary lanes ≥ ~2 tiles clear of obstacles in practice).
 */

import { findPath } from "../engine/astar.js";
import { gridFromTerrain, terrainCostAt } from "./gridCost.js";

/**
 * @param {string[][]} terrain
 * @param {Record<string, object>} tileTypes
 * @param {[number, number][]} playerSpawns
 * @param {[number, number][]} enemySpawns
 * @param {number} [chebyshevRadius] default 2 — cells within this L∞ distance of any path cell
 * @returns {Set<string>} keys "x,y"
 */
export function computeProtectedRibbon(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
  chebyshevRadius = 2,
) {
  const grid = gridFromTerrain(terrain);
  const costAt = terrainCostAt(grid, tileTypes);
  let path = null;
  outer: for (const s of playerSpawns) {
    for (const g of enemySpawns) {
      if (costAt(s[0], s[1]) >= 99 || costAt(g[0], g[1]) >= 99) continue;
      const p = findPath(grid, s, g, costAt);
      if (p && p.length >= 2) {
        path = p;
        break outer;
      }
    }
  }
  const out = new Set();
  if (!path) return out;
  const w = grid.width;
  const h = grid.height;
  const r = Math.max(0, chebyshevRadius);
  for (const [px, py] of path) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) > r) continue;
        const x = px + dx;
        const y = py + dy;
        if (x >= 0 && x < w && y >= 0 && y < h) out.add(`${x},${y}`);
      }
    }
  }
  return out;
}
