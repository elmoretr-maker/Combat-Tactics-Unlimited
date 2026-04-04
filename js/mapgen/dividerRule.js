/**
 * Step 2 — Divider rule: if impassable divider terrain isolates spawns, open
 * connector tiles (bridges / fords) until the graph connects, then ensure at
 * least two internally vertex-disjoint A* paths between some player and enemy
 * spawn pair (8-directional movement, same as js/engine/astar.js).
 */

import { inBounds, neighbors4 } from "../engine/grid.js";
import { findPath } from "../engine/astar.js";
import { mapObjectBlocksMoveAt } from "../battle-plane/mapObjects.js";
import { BLOCKED_MOVE_COST } from "../battle-plane/pathfindingCost.js";
import { gridFromTerrain, terrainCostAt } from "./gridCost.js";

function key(x, y) {
  return `${x},${y}`;
}

function cloneTerrain(terrain) {
  return terrain.map((row) => [...row]);
}

/**
 * Passable cells reachable from seeds (4-connected passability for "sections"
 * separated by dividers; A* still uses 8 dirs when validating paths).
 */
function floodPassable4(cells, tileTypes, seeds) {
  const h = cells.length;
  const w = h ? cells[0].length : 0;
  const grid = { width: w, height: h, cells };
  const costAt = terrainCostAt(grid, tileTypes);
  const seen = new Set();
  const q = [];
  for (const [sx, sy] of seeds) {
    if (sy >= 0 && sy < h && sx >= 0 && sx < w && costAt(sx, sy) < 99) {
      const k = key(sx, sy);
      if (!seen.has(k)) {
        seen.add(k);
        q.push([sx, sy]);
      }
    }
  }
  let qi = 0;
  while (qi < q.length) {
    const [x, y] = q[qi++];
    for (const [nx, ny] of neighbors4(x, y)) {
      if (!inBounds(grid, nx, ny)) continue;
      if (costAt(nx, ny) >= 99) continue;
      const nk = key(nx, ny);
      if (seen.has(nk)) continue;
      seen.add(nk);
      q.push([nx, ny]);
    }
  }
  return seen;
}

function spawnsConnected(cells, tileTypes, playerSpawns, enemySpawns) {
  const reach = floodPassable4(cells, tileTypes, playerSpawns);
  return enemySpawns.some(([ex, ey]) => reach.has(key(ex, ey)));
}

/**
 * Impassable divider cells (4-adjacent to passable cells in reach).
 */
function dividerFrontierCandidates(cells, tileTypes, reach, dividerTypes) {
  const div = new Set(dividerTypes);
  const h = cells.length;
  const w = h ? cells[0].length : 0;
  const grid = { width: w, height: h, cells };
  const costAt = terrainCostAt(grid, tileTypes);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (costAt(x, y) < 99) continue;
      const t = cells[y][x];
      if (!div.has(t)) continue;
      let touchesReach = false;
      for (const [nx, ny] of neighbors4(x, y)) {
        if (!inBounds(grid, nx, ny)) continue;
        if (reach.has(key(nx, ny)) && costAt(nx, ny) < 99) {
          touchesReach = true;
          break;
        }
      }
      if (touchesReach) out.push([x, y]);
    }
  }
  return out;
}

function minManhattanToSeeds(x, y, seeds) {
  let m = Infinity;
  for (const [sx, sy] of seeds) {
    const d = Math.abs(x - sx) + Math.abs(y - sy);
    if (d < m) m = d;
  }
  return m;
}

export function placeConnectorsForConnectivity(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
  {
    dividerTypes = ["water"],
    connectorTerrain = "road",
    maxOpens = 80,
  } = {},
) {
  const cells = cloneTerrain(terrain);
  const opens = [];
  let n = 0;
  while (!spawnsConnected(cells, tileTypes, playerSpawns, enemySpawns) && n < maxOpens) {
    const reach = floodPassable4(cells, tileTypes, playerSpawns);
    const cand = dividerFrontierCandidates(cells, tileTypes, reach, dividerTypes);
    if (!cand.length) break;
    cand.sort(
      (a, b) =>
        minManhattanToSeeds(a[0], a[1], enemySpawns) -
        minManhattanToSeeds(b[0], b[1], enemySpawns),
    );
    const [x, y] = cand[0];
    const before = cells[y][x];
    cells[y][x] = connectorTerrain;
    opens.push({ x, y, before, after: connectorTerrain });
    n++;
  }
  return { terrain: cells, opens };
}

function pathInteriorKeys(path) {
  const s = new Set();
  if (!path || path.length < 3) return s;
  for (let i = 1; i < path.length - 1; i++) {
    s.add(key(path[i][0], path[i][1]));
  }
  return s;
}

/**
 * Two internally vertex-disjoint paths for some pair (s,g), s in playerSpawns, g in enemySpawns.
 */
export function hasTwoVertexDisjointPaths(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
) {
  const grid = gridFromTerrain(terrain);
  const baseCost = terrainCostAt(grid, tileTypes);

  for (const s of playerSpawns) {
    for (const g of enemySpawns) {
      if (baseCost(s[0], s[1]) >= 99 || baseCost(g[0], g[1]) >= 99) continue;
      const p1 = findPath(grid, s, g, baseCost);
      if (!p1 || p1.length < 2) continue;
      const forbidden = pathInteriorKeys(p1);
      const cost2 = (x, y) => (forbidden.has(key(x, y)) ? 99 : baseCost(x, y));
      const p2 = findPath(grid, s, g, cost2);
      if (p2 && p2.length >= 2) return true;
    }
  }
  return false;
}

/**
 * Same as hasTwoVertexDisjointPaths but movement cost includes blocking mapObjects.
 */
export function hasTwoVertexDisjointPathsWithObjects(
  terrain,
  tileTypes,
  mapObjects,
  playerSpawns,
  enemySpawns,
) {
  const grid = gridFromTerrain(terrain);
  const baseCost = terrainCostAt(grid, tileTypes);
  const costAt = (x, y) =>
    mapObjectBlocksMoveAt(mapObjects, x, y) ? BLOCKED_MOVE_COST : baseCost(x, y);

  for (const s of playerSpawns) {
    for (const g of enemySpawns) {
      if (costAt(s[0], s[1]) >= 99 || costAt(g[0], g[1]) >= 99) continue;
      const p1 = findPath(grid, s, g, costAt);
      if (!p1 || p1.length < 2) continue;
      const forbidden = pathInteriorKeys(p1);
      const cost2 = (x, y) =>
        forbidden.has(key(x, y)) ? 99 : costAt(x, y);
      const p2 = findPath(grid, s, g, cost2);
      if (p2 && p2.length >= 2) return true;
    }
  }
  return false;
}

export function widenUntilTwoDisjointPaths(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
  {
    dividerTypes = ["water"],
    connectorTerrain = "road",
    maxExtraOpens = 60,
  } = {},
) {
  const cells = cloneTerrain(terrain);
  const opens = [];
  let n = 0;
  while (
    !hasTwoVertexDisjointPaths(cells, tileTypes, playerSpawns, enemySpawns) &&
    n < maxExtraOpens
  ) {
    if (!spawnsConnected(cells, tileTypes, playerSpawns, enemySpawns)) break;
    const reach = floodPassable4(cells, tileTypes, playerSpawns);
    const cand = dividerFrontierCandidates(cells, tileTypes, reach, dividerTypes);
    if (!cand.length) break;
    cand.sort(
      (a, b) =>
        minManhattanToSeeds(a[0], a[1], enemySpawns) -
        minManhattanToSeeds(b[0], b[1], enemySpawns),
    );
    const [x, y] = cand[0];
    const before = cells[y][x];
    if (before === connectorTerrain) break;
    cells[y][x] = connectorTerrain;
    opens.push({ x, y, before, after: connectorTerrain });
    n++;
  }
  return { terrain: cells, opens };
}

/**
 * Full Step 2: connectivity via connectors, then ≥2 disjoint A* routes.
 * @returns {{
 *   terrain: string[][],
 *   connectorLog: { x: number, y: number, before: string, after: string }[],
 *   ok: boolean,
 *   connected: boolean,
 *   twoDisjointPaths: boolean,
 * }}
 */
export function applyDividerRule(
  terrain,
  tileTypes,
  playerSpawns,
  enemySpawns,
  options = {},
) {
  const dividerTypes = options.dividerTypes ?? ["water"];
  const connectorTerrain = options.connectorTerrain ?? "road";
  const maxOpens = options.maxOpens ?? 80;
  const maxExtraOpens = options.maxExtraOpens ?? 60;

  const log = [];
  const a = placeConnectorsForConnectivity(terrain, tileTypes, playerSpawns, enemySpawns, {
    dividerTypes,
    connectorTerrain,
    maxOpens,
  });
  log.push(...a.opens);

  const connected = spawnsConnected(a.terrain, tileTypes, playerSpawns, enemySpawns);
  let cells = a.terrain;
  let twoDisjoint = false;

  if (connected) {
    twoDisjoint = hasTwoVertexDisjointPaths(
      cells,
      tileTypes,
      playerSpawns,
      enemySpawns,
    );
    if (!twoDisjoint) {
      const w = widenUntilTwoDisjointPaths(
        cells,
        tileTypes,
        playerSpawns,
        enemySpawns,
        { dividerTypes, connectorTerrain, maxExtraOpens },
      );
      log.push(...w.opens);
      cells = w.terrain;
      twoDisjoint = hasTwoVertexDisjointPaths(
        cells,
        tileTypes,
        playerSpawns,
        enemySpawns,
      );
    }
  }

  return {
    terrain: cells,
    connectorLog: log,
    connected,
    twoDisjointPaths: twoDisjoint,
    ok: connected && twoDisjoint,
  };
}
