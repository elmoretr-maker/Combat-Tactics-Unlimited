/**
 * Step 3 — Tactical obstacles & buildings with protected corridor + entry tiles.
 */

import { moveCostAt } from "../engine/terrain.js";
import { makeMapObject } from "../battle-plane/mapObjects.js";
import { gridFromTerrain } from "./gridCost.js";
import { hasTwoVertexDisjointPathsWithObjects } from "./dividerRule.js";
import { shuffleInPlace } from "./rng.js";
import { findBuildingsByThemeAndFootprint } from "./assetQuery.js";

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
      if (t === "building_block" || t === "water") {
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
      if (terrain[ey][ex] === "water") continue;
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
    };
  }
  return null;
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
  const candidates = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (protectedRibbon.has(key(x, y))) continue;
      if (spawns.has(key(x, y))) continue;
      const t = terrain[y][x];
      if (t === "water" || t === "building_block") continue;
      const g = gridFromTerrain(terrain);
      if (moveCostAt(g, tileTypes, x, y) >= 99) continue;
      candidates.push([x, y]);
    }
  }
  shuffleInPlace(candidates, rnd);
  const kinds = profile.obstacleVisualKinds;

  for (const [x, y] of candidates) {
    if (mapObjects.length >= maxObstacles) break;
    const pick = kinds[Math.floor(rnd() * kinds.length)];
    const obj = makeMapObject(x, y, pick.sprite, undefined, pick.kind);
    const trial = [...mapObjects, obj];
    if (
      hasTwoVertexDisjointPathsWithObjects(
        terrain,
        tileTypes,
        trial,
        playerSpawns,
        enemySpawns,
      )
    ) {
      mapObjects.push(obj);
    }
  }

  return { terrain, mapObjects, buildings };
}
