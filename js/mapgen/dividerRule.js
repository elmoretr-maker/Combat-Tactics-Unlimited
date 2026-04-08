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
import { resolveFlowConnectorAsset } from "./assetQuery.js";

function key(x, y) {
  return `${x},${y}`;
}

/* ── River / road cardinal bitmask (same-type 4-neighbor connectivity) ─────
 * Bits: N=1, E=2, S=4, W=8. y-1 = north, x+1 = east, y+1 = south, x-1 = west.
 * Variant ids match manifest `flowVariant` / tag `flow:<variant>` for Tile_*WaterStrip* etc.
 */
export const FLOW_BIT_N = 1;
export const FLOW_BIT_E = 2;
export const FLOW_BIT_S = 4;
export const FLOW_BIT_W = 8;

/**
 * Full 4-bit neighbor mask → connector topology id (for manifest lookup).
 * 1 neighbor = end cap; 2 opposite = straight; 2 adjacent = corner; 3 = T; 4 = cross.
 */
export const FLOW_VARIANT_BY_MASK = Object.freeze({
  0: "isolated",
  1: "end_n",
  2: "end_e",
  4: "end_s",
  8: "end_w",
  5: "straight_ns",
  10: "straight_ew",
  3: "corner_ne",
  6: "corner_se",
  9: "corner_nw",
  12: "corner_sw",
  7: "t_nes",
  11: "t_new",
  13: "t_nsw",
  14: "t_esw",
  15: "cross",
});

/**
 * @param {Set<string>|string[]} sameTerrainIds terrain strings that count as “connected” for this layer
 * @returns {number} mask 0–15
 */
export function computeCardinalFlowMask(terrain, x, y, sameTerrainIds) {
  const h = terrain.length;
  const w = h ? terrain[0].length : 0;
  const set = sameTerrainIds instanceof Set ? sameTerrainIds : new Set(sameTerrainIds);
  const t = (nx, ny) => {
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
    return set.has(terrain[ny][nx]);
  };
  let m = 0;
  if (t(x, y - 1)) m |= FLOW_BIT_N;
  if (t(x + 1, y)) m |= FLOW_BIT_E;
  if (t(x, y + 1)) m |= FLOW_BIT_S;
  if (t(x - 1, y)) m |= FLOW_BIT_W;
  return m;
}

export function flowConnectorVariantFromMask(mask) {
  const v = FLOW_VARIANT_BY_MASK[mask];
  return v ?? "isolated";
}

/**
 * Per-cell flow/road connector hints for rendering (bitmask + optional manifest path / sheet frame).
 * @param {string[][]} terrain
 * @param {{ dividerTypes?: string[], roadTerrain?: string }} profile from theme profile
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"|"arctic"} themeId
 * @returns {{ x: number, y: number, terrainId: string, mask: number, variant: string, spritePath: (string|null), spriteSheetFrame: number }[]}
 */
export function buildFlowConnectorLayer(terrain, profile, manifest, themeId) {
  const dividerTypes = profile.dividerTypes ?? ["water"];
  const roadTerrain = profile.roadTerrain ?? "road";
  const waterSet = new Set(dividerTypes);
  const roadSet = new Set([roadTerrain].filter(Boolean));

  const h = terrain.length;
  const w = h ? terrain[0].length : 0;
  const out = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tid = terrain[y][x];
      if (waterSet.has(tid)) {
        const mask = computeCardinalFlowMask(terrain, x, y, waterSet);
        const variant = flowConnectorVariantFromMask(mask);
        const resolved = resolveFlowConnectorAsset(manifest, themeId, variant, {
          flowKind: "water",
        });
        out.push({
          x,
          y,
          terrainId: tid,
          mask,
          variant,
          spritePath: resolved?.path ?? null,
          spriteSheetFrame: resolved?.spriteSheetFrame ?? mask,
          flowSheet: resolved?.flowSheet ?? null,
        });
      } else if (roadSet.has(tid)) {
        const mask = computeCardinalFlowMask(terrain, x, y, roadSet);
        const variant = flowConnectorVariantFromMask(mask);
        const resolved = resolveFlowConnectorAsset(manifest, themeId, variant, {
          flowKind: "road",
        });
        out.push({
          x,
          y,
          terrainId: tid,
          mask,
          variant,
          spritePath: resolved?.path ?? null,
          spriteSheetFrame: resolved?.spriteSheetFrame ?? mask,
          flowSheet: resolved?.flowSheet ?? null,
        });
      }
    }
  }
  return out;
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
    fordRnd = null,
    naturalFordTerrain = null,
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
    let after = connectorTerrain;
    let fordStyle = "bridge";
    if (
      naturalFordTerrain &&
      typeof naturalFordTerrain === "string" &&
      fordRnd &&
      fordRnd() < 0.5
    ) {
      after = naturalFordTerrain;
      fordStyle = "natural";
    }
    cells[y][x] = after;
    opens.push({ x, y, before, after, fordStyle });
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
    fordRnd = null,
    naturalFordTerrain = null,
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
    let after = connectorTerrain;
    let fordStyle = "bridge";
    if (
      naturalFordTerrain &&
      typeof naturalFordTerrain === "string" &&
      fordRnd &&
      fordRnd() < 0.5
    ) {
      after = naturalFordTerrain;
      fordStyle = "natural";
    }
    if (before === after) break;
    cells[y][x] = after;
    opens.push({ x, y, before, after, fordStyle });
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
  const fordRnd = options.fordRnd ?? null;
  const naturalFordTerrain = options.naturalFordTerrain ?? null;

  const fordOpts = {
    dividerTypes,
    connectorTerrain,
    maxOpens,
    fordRnd,
    naturalFordTerrain,
  };

  const log = [];
  const a = placeConnectorsForConnectivity(
    terrain,
    tileTypes,
    playerSpawns,
    enemySpawns,
    fordOpts,
  );
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
        {
          dividerTypes,
          connectorTerrain,
          maxExtraOpens,
          fordRnd,
          naturalFordTerrain,
        },
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
