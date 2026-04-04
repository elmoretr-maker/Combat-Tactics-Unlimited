import { inBounds } from "./grid.js";

/** Bresenham integer line between two grid cells (inclusive). */
export function bresenhamLine(x0, y0, x1, y1) {
  const out = [];
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export function tileBlocksLos(tileTypes, terrainType) {
  const info = tileTypes[terrainType];
  return !!(info && info.blocksLos);
}

/**
 * Clear LOS from attacker cell to target cell for direct fire.
 * Endpoints are not checked. Interior: `blocksLos` fails immediately; else `sightCost` sums against `sightBudget`.
 */
export function hasLineOfSight(grid, tileTypes, ax, ay, tx, ty, options = {}) {
  const budget =
    options.sightBudget != null && Number.isFinite(options.sightBudget)
      ? options.sightBudget
      : Infinity;
  let costSum = 0;
  const line = bresenhamLine(ax, ay, tx, ty);
  if (line.length <= 2) return true;
  for (let i = 1; i < line.length - 1; i++) {
    const [x, y] = line[i];
    if (!inBounds(grid, x, y)) return false;
    if (options.mapObjects?.length && mapObjectBlocksLosAt(options.mapObjects, x, y)) {
      return false;
    }
    const terr = grid.cells[y][x];
    if (tileBlocksLos(tileTypes, terr)) return false;
    const info = tileTypes[terr];
    const c = Number(info?.sightCost) || 0;
    costSum += c;
    if (costSum > budget) return false;
  }
  return true;
}
