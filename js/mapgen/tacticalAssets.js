/**
 * Step 3 — Tactical obstacles & buildings with protected corridor + entry tiles.
 */

import { moveCostAt } from "../engine/terrain.js";
import { gridFromTerrain } from "./gridCost.js";

const IMPASSABLE_TERRAIN = new Set(["water", "water_desert", "water_urban"]);
import { shuffleInPlace } from "./rng.js";
import {
  findBuildingsByThemeAndFootprint,
  interiorFurnitureKindsForTheme,
} from "./assetQuery.js";
import { placeTargetDrivenMapObjects } from "./targetDrivenMapObjects.js";

function key(x, y) {
  return `${x},${y}`;
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
      const themeKey =
        profile.id === "grass" || profile.id === "arctic" ? "grass" : profile.id;
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
  const themeKey =
    profile.id === "grass" || profile.id === "arctic" ? "grass" : profile.id;
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
 * @param {string} [opts.biome] — catalog biome (forest, winter, …) for density profile
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
    biome: biomeOpt,
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

  const { warnings } = placeTargetDrivenMapObjects({
    terrain,
    tileTypes,
    playerSpawns,
    enemySpawns,
    protectedRibbon,
    profile,
    rnd,
    assetManifest,
    placementSeed,
    cellSize,
    mapgenTheme: profile.id,
    biome: biomeOpt,
    mapObjects,
  });
  for (const wmsg of warnings) {
    console.warn(wmsg);
  }

  placeInteriorFurniture(buildings, assetManifest, profile, rnd);

  return { terrain, mapObjects, buildings };
}
