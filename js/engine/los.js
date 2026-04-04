import { inBounds } from "./grid.js";
import { mapObjectInterruptsDirectLos } from "../battle-plane/mapObjects.js";

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

/** True if this cell blocks direct LOS (terrain or large map object). */
export function losHardBlockAt(grid, tileTypes, mapObjects, x, y) {
  if (!inBounds(grid, x, y)) return true;
  if (mapObjects?.length && mapObjectInterruptsDirectLos(mapObjects, x, y)) {
    return true;
  }
  const terr = grid.cells[y][x];
  return tileBlocksLos(tileTypes, terr);
}

/**
 * Indirect fire cannot hit a target in the "deadzone": the target cell is the
 * tile immediately after the first LOS-hard blocker on the Bresenham line from attacker.
 */
export function isIndirectDeadzoneBlock(
  grid,
  tileTypes,
  ax,
  ay,
  tx,
  ty,
  options = {},
) {
  const mapObjects = options.mapObjects;
  const line = bresenhamLine(ax, ay, tx, ty);
  if (line.length <= 2) return false;
  for (let i = 1; i < line.length - 1; i++) {
    const [x, y] = line[i];
    if (!losHardBlockAt(grid, tileTypes, mapObjects, x, y)) continue;
    const next = line[i + 1];
    return !!(next && next[0] === tx && next[1] === ty);
  }
  return false;
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
    if (
      options.mapObjects?.length &&
      mapObjectInterruptsDirectLos(options.mapObjects, x, y)
    ) {
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

/**
 * Cells within `sightRange` (Chebyshev) of (ax, ay) that have no clear LOS from the viewer.
 * Used to dim tiles hidden behind buildings / large obstacles.
 */
export function losShadowCellKeys(grid, tileTypes, ax, ay, sightRange, options = {}) {
  const out = new Set();
  const budget =
    options.sightBudget != null && Number.isFinite(options.sightBudget)
      ? options.sightBudget
      : Infinity;
  const mapObjects = options.mapObjects;
  const w = grid.width;
  const h = grid.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === ax && y === ay) continue;
      const d = Math.max(Math.abs(x - ax), Math.abs(y - ay));
      if (d > sightRange) continue;
      if (
        hasLineOfSight(grid, tileTypes, ax, ay, x, y, {
          sightBudget: budget,
          mapObjects,
        })
      ) {
        continue;
      }
      out.add(`${x},${y}`);
    }
  }
  return out;
}
