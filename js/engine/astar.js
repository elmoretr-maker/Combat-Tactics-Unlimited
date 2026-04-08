import { inBounds, neighbors4, neighbors8 } from "./grid.js";

function key(x, y) { return x + "," + y; }

function neighborsFor(x, y, connectivity) {
  return connectivity === 4 ? neighbors4(x, y) : neighbors8(x, y);
}

/**
 * A* pathfinding. `connectivity`: 4 = N/E/S/W only (no diagonal corner-cutting);
 * 8 = diagonals allowed (default for mapgen tools).
 *
 * Pass a unit-specific `costAt` from GameState.costAtForUnit (infantry vs vehicle).
 */
export function findPath(grid, start, goal, costAt, opts = {}) {
  const connectivity = opts.connectivity ?? 8;
  const open = new Set([key(start[0], start[1])]);
  const dist = new Map([[key(start[0], start[1]), 0]]);
  const prev = new Map();
  while (open.size) {
    let bestK = null;
    let bestD = Infinity;
    for (const k of open) {
      const d = dist.get(k);
      if (d < bestD) { bestD = d; bestK = k; }
    }
    if (bestK == null) break;
    open.delete(bestK);
    const [cx, cy] = bestK.split(",").map(Number);
    if (cx === goal[0] && cy === goal[1]) {
      const path = [];
      let cur = bestK;
      while (cur) { path.push(cur.split(",").map(Number)); cur = prev.get(cur); }
      path.reverse();
      return path;
    }
    for (const [nx, ny] of neighborsFor(cx, cy, connectivity)) {
      if (!inBounds(grid, nx, ny)) continue;
      const step = costAt(nx, ny);
      if (step >= 99) continue;
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
 * Flood-fill reachable tiles within moveBudget.
 * `costAt` should come from GameState.costAtForUnit for movement-class rules.
 */
export function reachableTiles(grid, ox, oy, moveBudget, costAt, opts = {}) {
  const connectivity = opts.connectivity ?? 8;
  const visited = new Map();
  const open = new Set([key(ox, oy)]);
  visited.set(key(ox, oy), 0);
  while (open.size) {
    let pick = null;
    let best = Infinity;
    for (const k of open) {
      const v = visited.get(k);
      if (v < best) { best = v; pick = k; }
    }
    if (pick == null) break;
    open.delete(pick);
    const [x, y] = pick.split(",").map(Number);
    for (const [nx, ny] of neighborsFor(x, y, connectivity)) {
      if (!inBounds(grid, nx, ny)) continue;
      const c = costAt(nx, ny);
      if (c >= 99) continue;
      const nk = key(nx, ny);
      const next = best + c;
      if (next > moveBudget + 1e-6) continue;
      if (next < (visited.get(nk) ?? Infinity)) {
        visited.set(nk, next);
        open.add(nk);
      }
    }
  }
  return visited;
}
