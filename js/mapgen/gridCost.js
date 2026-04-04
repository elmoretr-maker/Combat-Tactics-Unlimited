/**
 * Helpers for map generation: align with GameState terrain + tileTextures.types.
 * @see js/engine/terrain.js — moveCostAt
 * @see js/config/tileTextures.json — per-type moveCost / blocksMove / blocksLos
 */

import { moveCostAt } from "../engine/terrain.js";

/**
 * @param {string[][]} terrain rows terrain[y][x]
 * @returns {{ width: number, height: number, cells: string[][] }}
 */
export function gridFromTerrain(terrain) {
  const h = terrain.length;
  const w = h ? terrain[0].length : 0;
  return { width: w, height: h, cells: terrain };
}

/**
 * Same movement cost as combat (no mapObjects).
 * @param {{ width: number, height: number, cells: string[][] }} grid
 * @param {Record<string, object>} tileTypes from tileTextures.types
 */
export function terrainCostAt(grid, tileTypes) {
  return (x, y) => moveCostAt(grid, tileTypes, x, y);
}

/** @param {Record<string, object>} tileTypes */
export function blocksLosAt(grid, tileTypes, x, y) {
  const type = grid.cells[y]?.[x];
  const info = tileTypes[type] || tileTypes.plains || {};
  return !!info.blocksLos;
}
