/**
 * Step 3 — Tactical obstacles & buildings with protected corridor + entry tiles.
 */

import { moveCostAt } from "../engine/terrain.js";
import { makeMapObject } from "../battle-plane/mapObjects.js";
import { gridFromTerrain } from "./gridCost.js";

const IMPASSABLE_TERRAIN = new Set(["water", "water_desert", "water_urban"]);
import { hasTwoVertexDisjointPathsWithObjects } from "./dividerRule.js";
import { shuffleInPlace } from "./rng.js";
import {
  computeOrthogonalPathwayReserve,
  expandPathwayReserve,
  tacticalDensity,
  pickKindIndexFromNoise,
  placementSpecForKind,
  terrainAllowsPlacement,
  treeSpacingOk,
  effectiveObstacleKind,
  obstaclePassesPlacementTags,
  wouldCompleteOrthogonalBlockingLineOfThree,
} from "./tacticalPlacement.js";
import { applyPlacementRatioMix } from "./placementRatios.js";
import {
  findBuildingsByThemeAndFootprint,
  interiorFurnitureKindsForTheme,
} from "./assetQuery.js";

function key(x, y) {
  return `${x},${y}`;
}

/** True if any 4-neighbor cell is water / divider water. */
function cellTouchesWater(terrain, x, y) {
  const h = terrain.length;
  const w = terrain[0].length;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    if (IMPASSABLE_TERRAIN.has(terrain[ny][nx])) return true;
  }
  return false;
}

function spawnKeySet(playerSpawns, enemySpawns) {
  const s = new Set();
  for (const [x, y] of playerSpawns) s.add(key(x, y));
  for (const [x, y] of enemySpawns) s.add(key(x, y));
  return s;
}

/**
 * @param {string[][]} terrain
 * @param {Record<string, object>} tileTypes
 * @param {Set<string>} protectedRibbon
 * @param {Set<string>} spawns
 * @param {number} bw
 * @param {number} bh
 * @param {() => number} rnd
 * @param {{ roadTerrain: string, id: string }} profile
 * @param {object|null|undefined} manifest
 * @returns {object | null} building record
 */
function tryPlaceOneBuilding(terrain, tileTypes, protectedRibbon, spawns, bw, bh, rnd, profile, manifest) {
  const h = terrain.length;
  const w = terrain[0].length;
  const grid = () => gridFromTerrain(terrain);
  for (let attempt = 0; attempt < 50; attempt++) {
    const bx = 2 + Math.floor(rnd() * Math.max(1, w - bw - 4));
    const by = 2 + Math.floor(rnd() * Math.max(1, h - bh - 4));
    const cells = [];
    for (let dy = 0; dy < bh; dy++) {
      for (let dx = 0; dx < bw; dx++) {
        cells.push([bx + dx, by + dy]);
      }
    }
    let ok = true;
    for (const [cx, cy] of cells) {
      if (protectedRibbon.has(key(cx, cy))) {
        ok = false;
        break;
      }
      if (spawns.has(key(cx, cy))) {
        ok = false;
        break;
      }
      const t = terrain[cy][cx];
      if (t === "building_block" || IMPASSABLE_TERRAIN.has(t)) {
        ok = false;
        break;
      }
      if (moveCostAt(grid(), tileTypes, cx, cy) >= 99) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const footprintSet = new Set(cells.map(([x, y]) => key(x, y)));
    const neigh = [];
    for (const [cx, cy] of cells) {
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        const k = key(nx, ny);
        if (footprintSet.has(k)) continue;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        neigh.push([nx, ny]);
      }
    }
    shuffleInPlace(neigh, rnd);
    let entry = null;
    for (const [ex, ey] of neigh) {
      if (footprintSet.has(key(ex, ey))) continue;
      if (IMPASSABLE_TERRAIN.has(terrain[ey][ex])) continue;
      entry = [ex, ey];
      break;
    }
    if (!entry) continue;

    for (const [cx, cy] of cells) {
      terrain[cy][cx] = "building_block";
    }
    const [ex, ey] = entry;
    terrain[ey][ex] = profile.roadTerrain;

    let facadeSprite = null;
    if (manifest) {
      const themeKey = profile.id === "grass" ? "grass" : profile.id;
      const footprintClass = bw * bh <= 4 ? "small" : "medium";
      let pool = findBuildingsByThemeAndFootprint(manifest, themeKey, footprintClass);
      if (!pool.length) {
        pool = findBuildingsByThemeAndFootprint(manifest, themeKey, "fortified");
      }
      if (!pool.length) {
        pool = findBuildingsByThemeAndFootprint(manifest, "urban", "medium");
      }
      if (pool.length) facadeSprite = pool[Math.floor(rnd() * pool.length)];
    }

    return {
      id: `bld_${bx}_${by}`,
      footprint: cells.map(([x, y]) => ({ x, y })),
      entry: { x: ex, y: ey },
      facadeSprite,
      interiorProps: [],
    };
  }
  return null;
}

function partitionBuildingWallsAndFloor(footprint) {
  if (!footprint?.length) return { wall: new Set(), floor: new Set() };
  const xs = footprint.map((c) => c.x);
  const ys = footprint.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const wall = new Set();
  const floor = new Set();
  for (const c of footprint) {
    const k = key(c.x, c.y);
    if (c.x === minX || c.x === maxX || c.y === minY || c.y === maxY) wall.add(k);
    else floor.add(k);
  }
  return { wall, floor };
}

function neighKeys4(x, y) {
  return [key(x + 1, y), key(x - 1, y), key(x, y + 1), key(x, y - 1)];
}

function wallAnchoredFloorCells(floor, wall) {
  const out = [];
  for (const k of floor) {
    const [x, y] = k.split(",").map(Number);
    if (neighKeys4(x, y).some((nk) => wall.has(nk))) out.push([x, y]);
  }
  return out;
}

/** “Central” = all four cardinals are interior floor (one tile clear of the wall ring). */
function centralFloorCells(floor) {
  const out = [];
  for (const k of floor) {
    const [x, y] = k.split(",").map(Number);
    if (neighKeys4(x, y).every((nk) => floor.has(nk))) out.push([x, y]);
  }
  return out;
}

function placeInteriorFurniture(buildings, manifest, profile, rnd) {
  if (!buildings.length || !manifest) return;
  const themeKey = profile.id === "grass" ? "grass" : profile.id;
  let pool = interiorFurnitureKindsForTheme(manifest, themeKey);
  if (!pool.length) pool = interiorFurnitureKindsForTheme(manifest, "urban");
  if (!pool.length) return;

  const wallPool = pool.filter((p) => p.placementRule === "wall_anchored");
  const centralPool = pool.filter((p) => p.placementRule === "central");

  for (const b of buildings) {
    if (!b.interiorProps) b.interiorProps = [];
    const { wall, floor } = partitionBuildingWallsAndFloor(b.footprint);
    if (floor.size === 0) continue;

    const wa = wallAnchoredFloorCells(floor, wall);
    const ce = centralFloorCells(floor);
    shuffleInPlace(wa, rnd);
    shuffleInPlace(ce, rnd);

    b.interiorProps.length = 0;

    if (wallPool.length && wa.length) {
      const pick = wallPool[Math.floor(rnd() * wallPool.length)];
      const [tx, ty] = wa[0];
      b.interiorProps.push({
        x: tx,
        y: ty,
        sprite: pick.sprite,
        placementRule: pick.placementRule,
        visualKind: pick.kind,
      });
    }
    if (centralPool.length && ce.length) {
      const pick = centralPool[Math.floor(rnd() * centralPool.length)];
      const [tx, ty] = ce[0];
      b.interiorProps.push({
        x: tx,
        y: ty,
        sprite: pick.sprite,
        placementRule: pick.placementRule,
        visualKind: pick.kind,
      });
    }
  }
}

/**
 * @param {object} opts
 * @param {string[][]} opts.terrain — mutated
 * @param {Record<string, object>} opts.tileTypes
 * @param {[number, number][]} opts.playerSpawns
 * @param {[number, number][]} opts.enemySpawns
 * @param {Set<string>} opts.protectedRibbon
 * @param {ReturnType<typeof import("./themeProfiles.js").getThemeProfile>} opts.profile
 * @param {() => number} opts.rnd
 * @param {object|null|undefined} [opts.assetManifest]
 * @param {number} [opts.placementSeed] — deterministic noise field for clusters
 * @param {number} [opts.cellSize] — canvas cell size (aircraft pyOffset)
 * @param {number} [opts.numBuildings]
 * @param {number} [opts.maxObstacles]
 */
export function placeTacticalAssets(opts) {
  const {
    terrain,
    tileTypes,
    playerSpawns,
    enemySpawns,
    protectedRibbon,
    profile,
    rnd,
    assetManifest = null,
    placementSeed = 0xaced1234,
    cellSize = 48,
    numBuildings = 1,
    maxObstacles = 10,
  } = opts;

  const spawns = spawnKeySet(playerSpawns, enemySpawns);
  /** @type {object[]} */
  const buildings = [];
  for (let i = 0; i < numBuildings; i++) {
    const b = tryPlaceOneBuilding(
      terrain,
      tileTypes,
      protectedRibbon,
      spawns,
      2,
      2,
      rnd,
      profile,
      assetManifest,
    );
    if (b) buildings.push(b);
  }

  const mapObjects = [];
  const w = terrain[0].length;
  const h = terrain.length;
  const g = gridFromTerrain(terrain);
  const noiseSeed = placementSeed >>> 0;

  /* ── Pathway reserve (expanded 1 tile so props can't flank it) ── */
  const pathwayRaw = computeOrthogonalPathwayReserve(
    terrain,
    tileTypes,
    playerSpawns,
    enemySpawns,
  );
  const pathwayReserve = expandPathwayReserve(pathwayRaw, w, h);

  /* ── Candidate cells ── */
  const candidates = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (protectedRibbon.has(key(x, y))) continue;
      if (spawns.has(key(x, y))) continue;
      const t = terrain[y][x];
      if (t === "building_block") continue;
      /* water cells only valid for water-locked kinds */
      candidates.push([x, y]);
    }
  }

  /* Shuffle candidates so props are tried in random spatial order.
     Noise still controls placement probability (high-density cells pass
     the rnd() gate far more often), but we no longer process cells along
     a density ridge sequentially — which was the root cause of line formation. */
  shuffleInPlace(candidates, rnd);

  /**
   * Try to place a single obstacle.
   * Returns true if placement was accepted.
   * @param {number} x
   * @param {number} y
   * @param {boolean} relaxNoise  if true, skip the noise-threshold roll (fill pass)
   */
  const tryPlace = (x, y, relaxNoise) => {
    const t = terrain[y][x];
    const isWaterCell = IMPASSABLE_TERRAIN.has(t);

    if (moveCostAt(g, tileTypes, x, y) >= 99 && !isWaterCell) return false;

    const d = tacticalDensity(noiseSeed, x, y);
    if (!relaxNoise && rnd() > 0.18 + d * 0.72) return false;

    let validKinds = (profile.obstacleVisualKinds || []).filter((ob) => {
      const spec = placementSpecForKind(ob.kind, ob.sprite);
      if (isWaterCell) {
        if (spec.placement !== "water") return false;
      } else if (!terrainAllowsPlacement(t, spec.allowTerrain)) {
        return false;
      }
      return obstaclePassesPlacementTags(ob, t, profile.id, isWaterCell);
    });
    if (!validKinds.length) return false;

    const tw = cellTouchesWater(terrain, x, y);
    validKinds = applyPlacementRatioMix(profile.id, validKinds, tw, rnd);
    if (!validKinds.length) return false;

    const ki = pickKindIndexFromNoise(d, validKinds.length, x, y, rnd);
    const pick = validKinds[ki];
    const vk = effectiveObstacleKind(pick.kind, pick.sprite);
    const spec = placementSpecForKind(pick.kind, pick.sprite);
    const willBlock = spec.placement !== "air" && spec.blocksMove !== false;

    /* ── Spacing: apply to all blocking props, not just trees ── */
    if (!treeSpacingOk(mapObjects, x, y, vk, willBlock)) return false;

    if (
      wouldCompleteOrthogonalBlockingLineOfThree(
        mapObjects,
        x,
        y,
        w,
        h,
        willBlock,
      )
    ) {
      return false;
    }

    /* ── Pathway guard: blocking props may not touch the free lane ── */
    if (willBlock && pathwayReserve.has(key(x, y))) return false;

    const extra = {};
    if (spec.placement === "air") {
      extra.pyOffset = Math.round(-cellSize * 0.36);
      extra.blocksMove = false;
      extra.blocksLos = false;
    } else {
      if (spec.blocksMove === false) extra.blocksMove = false;
      if (spec.blocksLos === false) extra.blocksLos = false;
      if (typeof spec.pyOffset === "number") {
        extra.pyOffset = Math.round(spec.pyOffset * (cellSize / 48));
      }
    }

    const vkLow = (vk || "").toLowerCase();
    if (vkLow === "tree" || vkLow === "ruins" || vkLow === "house") {
      extra.propAnchor = "bottom";
    }

    const obj = makeMapObject(x, y, pick.sprite, undefined, vk, extra);

    /* ── Disjoint-path guard: still ensure two routes survive ── */
    const trial = [...mapObjects, obj];
    if (
      !hasTwoVertexDisjointPathsWithObjects(
        terrain,
        tileTypes,
        trial,
        playerSpawns,
        enemySpawns,
      )
    ) {
      return false;
    }

    mapObjects.push(obj);
    return true;
  };

  const kinds = profile.obstacleVisualKinds;
  if (kinds.length) {
    /* ── Primary pass: noise-sorted, respects probability threshold ── */
    for (const [x, y] of candidates) {
      if (mapObjects.length >= maxObstacles) break;
      if (mapObjects.some((o) => o.x === x && o.y === y)) continue;
      tryPlace(x, y, false);
    }

    /* ── Fill pass: reach a minimum floor without opening walls.
         Uses the same spacing + pathway rules; only relaxes the noise roll.
         Cap at 75% of maxObstacles so we never pack the board solid. ── */
    const fillTarget = Math.min(maxObstacles, Math.ceil(maxObstacles * 0.75));
    if (mapObjects.length < fillTarget) {
      /* Shuffle candidates for fill so we don't always retry the same dense spots */
      const fillPool = [...candidates];
      for (let i = fillPool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [fillPool[i], fillPool[j]] = [fillPool[j], fillPool[i]];
      }
      let fillTries = Math.min(300, fillPool.length);
      for (const [x, y] of fillPool) {
        if (mapObjects.length >= fillTarget) break;
        if (fillTries-- <= 0) break;
        if (mapObjects.some((o) => o.x === x && o.y === y)) continue;
        tryPlace(x, y, true);
      }
    }
  }

  placeInteriorFurniture(buildings, assetManifest, profile, rnd);

  return { terrain, mapObjects, buildings };
}
