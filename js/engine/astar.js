import { inBounds, neighbors8 } from "./grid.js";

function key(x, y) { return x + "," + y; }

/**
 * A* pathfinding using 8-directional movement (diagonal allowed).
 * Diagonal steps cost the same as cardinal steps — the terrain moveCost
 * of the destination tile applies in both cases.
 */
export function findPath(grid, start, goal, costAt) {
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
    for (const [nx, ny] of neighbors8(cx, cy)) {
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
 * Flood-fill reachable tiles within moveBudget using 8-directional movement.
 */
export function reachableTiles(grid, ox, oy, moveBudget, costAt) {
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
    for (const [nx, ny] of neighbors8(x, y)) {
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
