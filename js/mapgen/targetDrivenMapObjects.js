/**
 * Target-driven mapObjects placement: biome category quotas, no per-cell probability gate.
 * Keeps: CTU placement, disjoint paths, pathway reserve, spacing (with optional relax pass).
 */

import { moveCostAt } from "../engine/terrain.js";
import { makeMapObject } from "../battle-plane/mapObjects.js";
import { gridFromTerrain } from "./gridCost.js";
import { hasTwoVertexDisjointPathsWithObjects } from "./dividerRule.js";
import { chebyshev } from "../engine/grid.js";
import {
  computeOrthogonalPathwayReserve,
  expandPathwayReserve,
  tacticalDensity,
  pickScatterEntryIndex,
  treeSpacingOk,
  wouldCompleteOrthogonalBlockingLineOfThree,
} from "./tacticalPlacement.js";
import {
  terrainMatchesCtuPlacement,
  mapObjectExtraFromCtuBehavior,
  scatterVisualKind,
} from "./ctuMapgen.js";
import {
  BIOME_DENSITY,
  CATEGORY_MAP,
  MIN_PER_CATEGORY,
  resolveDensityProfileId,
} from "./biomeDensityConfig.js";

const IMPASSABLE_TERRAIN = new Set(["water", "water_desert", "water_urban"]);

const MAX_TRIES_PER_CATEGORY = 1000;

function key(x, y) {
  return `${x},${y}`;
}

/** @param {import("../battle-plane/mapObjects.js").MapObjectLike[]} mapObjects */
function treeSpacingOkRelaxed(mapObjects, x, y, kindForNew, newBlocksMove, relaxed) {
  if (!relaxed) return treeSpacingOk(mapObjects, x, y, kindForNew, newBlocksMove);
  const k = (kindForNew || "").toLowerCase();
  for (const o of mapObjects) {
    const dist = chebyshev(o.x, o.y, x, y);
    if (k === "tree") {
      const ov = (o.visualKind || "").toLowerCase();
      if (ov === "tree" && dist <= 1) return false;
    }
    if (k !== "crate" && k !== "tree" && newBlocksMove && o.blocksMove !== false) {
      if (dist <= 1) return false;
    }
  }
  return true;
}

/**
 * @param {object} entry scatter pool entry
 * @param {string} category
 */
function entryMatchesCategory(entry, category) {
  const aliases = CATEGORY_MAP[category];
  if (!aliases?.length) return false;
  const vk = scatterVisualKind(entry).toLowerCase();
  const sub = String(entry.ctu?.classification?.subtype || "").toLowerCase();
  const kind = String(entry.kind || "").toLowerCase();
  for (const a of aliases) {
    if (vk === a || vk.includes(a)) return true;
    if (sub === a || sub.includes(a)) return true;
    if (kind.includes(a)) return true;
  }
  return false;
}

/**
 * @param {{ ctu?: object, kind?: string, sprite?: string }[]} pool
 * @param {string} category
 */
function filterPoolForCategory(pool, category) {
  return pool.filter((e) => entryMatchesCategory(e, category));
}

/**
 * @param {string[][]} terrain
 * @param {number} x
 * @param {number} y
 */
/**
 * @param {object} opts
 * @param {string[][]} opts.terrain
 * @param {Record<string, object>} opts.tileTypes
 * @param {[number, number][]} opts.playerSpawns
 * @param {[number, number][]} opts.enemySpawns
 * @param {Set<string>} opts.protectedRibbon
 * @param {object} opts.profile
 * @param {() => number} opts.rnd
 * @param {object|null|undefined} opts.assetManifest
 * @param {number} opts.placementSeed
 * @param {number} opts.cellSize
 * @param {"urban"|"desert"|"grass"|"arctic"} opts.mapgenTheme
 * @param {string|undefined} opts.biome — Biome id (forest, winter, …)
 * @param {{ x: number, y: number }[]} opts.mapObjects — mutated in place
 * @returns {{ warnings: string[], placedByCategory: Record<string, number> }}
 */
export function placeTargetDrivenMapObjects(opts) {
  const {
    terrain,
    tileTypes,
    playerSpawns,
    enemySpawns,
    protectedRibbon,
    profile,
    rnd,
    assetManifest: _manifest,
    placementSeed = 0xaced1234,
    cellSize = 48,
    mapgenTheme,
    biome,
    mapObjects,
  } = opts;

  const warnings = [];
  /** @type {Record<string, number>} */
  const placedByCategory = {};

  const pool = profile.obstacleVisualKinds || [];
  if (!pool.length) {
    warnings.push(
      "[CTU] placeTargetDrivenMapObjects: obstacleVisualKinds empty — no scatter assets.",
    );
    return { warnings, placedByCategory };
  }

  const w = terrain[0].length;
  const h = terrain.length;
  const totalCells = w * h;
  const g = gridFromTerrain(terrain);
  const noiseSeed = placementSeed >>> 0;

  const pathwayReserve = expandPathwayReserve(
    computeOrthogonalPathwayReserve(
      terrain,
      tileTypes,
      playerSpawns,
      enemySpawns,
    ),
    w,
    h,
  );

  const spawnSet = new Set();
  for (const [sx, sy] of playerSpawns) spawnSet.add(key(sx, sy));
  for (const [sx, sy] of enemySpawns) spawnSet.add(key(sx, sy));

  const candidates = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (protectedRibbon.has(key(x, y))) continue;
      if (spawnSet.has(key(x, y))) continue;
      if (terrain[y][x] === "building_block") continue;
      candidates.push([x, y]);
    }
  }

  const profileId = resolveDensityProfileId(mapgenTheme, biome);
  const densityRow = BIOME_DENSITY[profileId] || BIOME_DENSITY.grass;
  const categories = Object.keys(densityRow);

  const minPer = Math.min(
    MIN_PER_CATEGORY,
    Math.max(2, Math.floor(candidates.length / Math.max(4, categories.length + 2))),
  );

  /** @type {Record<string, number>} */
  const targets = {};
  for (const cat of categories) {
    const pct = densityRow[cat];
    if (typeof pct !== "number" || pct <= 0) continue;
    targets[cat] = Math.max(minPer, Math.floor(totalCells * pct));
  }

  let sumTargets = Object.values(targets).reduce((a, b) => a + b, 0);
  const maxFill = Math.min(
    candidates.length,
    Math.max(sumTargets, Math.floor(totalCells * 0.65)),
  );
  if (sumTargets > maxFill && sumTargets > 0) {
    const scale = maxFill / sumTargets;
    for (const c of Object.keys(targets)) {
      targets[c] = Math.max(1, Math.floor(targets[c] * scale));
    }
    sumTargets = Object.values(targets).reduce((a, b) => a + b, 0);
  }

  /** @returns {Set<string>} */
  const occupied = () =>
    new Set(mapObjects.map((o) => key(o.x, o.y)));

  /**
   * @param {string} category
   * @param {typeof pool} catPool
   */
  const tryPlaceOne = (category, catPool, relaxedSpacing, skipLineOfThree) => {
    const occ = occupied();
    const free = candidates.filter(([x, y]) => !occ.has(key(x, y)));
    if (!free.length) return false;

    /* Bias: trees prefer high tacticalDensity; rocks/debris prefer mid/low */
    const scored = free.map(([x, y]) => {
      const d = tacticalDensity(noiseSeed, x, y);
      let score = d;
      if (category === "rock" || category === "debris" || category === "cactus") {
        score = 1 - d * 0.85;
      }
      return { x, y, d, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const head = scored.slice(0, Math.min(scored.length, 48));
    const chosen =
      head[Math.floor(rnd() * head.length)] ||
      scored[Math.floor(rnd() * scored.length)];

    const { x, y } = chosen;
    const t = terrain[y][x];
    const isWaterCell = IMPASSABLE_TERRAIN.has(t);

    if (moveCostAt(g, tileTypes, x, y) >= 99 && !isWaterCell) return false;

    let validAtCell = catPool.filter(
      (ob) => ob.ctu && terrainMatchesCtuPlacement(ob.ctu, terrain, x, y),
    );
    if (!validAtCell.length) return false;

    const d = tacticalDensity(noiseSeed, x, y);
    const ki = pickScatterEntryIndex(d, validAtCell, x, y, rnd);
    const pickEntry = validAtCell[ki];
    if (!terrainMatchesCtuPlacement(pickEntry.ctu, terrain, x, y)) return false;

    const vk = scatterVisualKind(pickEntry);
    const extra = mapObjectExtraFromCtuBehavior(pickEntry.ctu, cellSize);
    const willBlock = extra.blocksMove !== false;

    if (
      !treeSpacingOkRelaxed(mapObjects, x, y, vk, willBlock, relaxedSpacing)
    ) {
      return false;
    }

    if (
      !skipLineOfThree &&
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

    if (willBlock && pathwayReserve.has(key(x, y))) return false;

    const prevTerrain = terrain[y][x];
    const isBridge =
      pickEntry.ctu?.classification?.subtype === "bridge" &&
      pickEntry.ctu?.behavior?.walkable === true;
    if (isBridge) {
      terrain[y][x] = profile.roadTerrain;
    }

    const vkLow = (vk || "").toLowerCase();
    if (vkLow === "tree" || vkLow === "ruins" || vkLow === "house") {
      extra.propAnchor = extra.propAnchor || "bottom";
    }

    const obj = makeMapObject(x, y, pickEntry.sprite, undefined, vk, extra);
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
      terrain[y][x] = prevTerrain;
      return false;
    }

    mapObjects.push(obj);
    placedByCategory[category] = (placedByCategory[category] || 0) + 1;
    return true;
  };

  for (const category of categories) {
    const pct = densityRow[category];
    if (typeof pct !== "number" || pct <= 0) continue;

    let catPool = filterPoolForCategory(pool, category);
    if (!catPool.length) {
      const fallback = ["rock", "debris", "structure"].includes(category)
        ? filterPoolForCategory(pool, "debris").length
          ? "debris"
          : filterPoolForCategory(pool, "rock").length
            ? "rock"
            : null
        : category === "tree"
          ? filterPoolForCategory(pool, "structure").length
            ? "structure"
            : null
          : null;
      if (fallback && CATEGORY_MAP[fallback]) {
        warnings.push(
          `[CTU] No valid assets for category "${category}" in biome ${profileId} — falling back to "${fallback}".`,
        );
        catPool = filterPoolForCategory(pool, fallback);
      } else {
        warnings.push(
          `[CTU] No valid assets for category "${category}" in biome ${profileId} — skipping category.`,
        );
        continue;
      }
    }

    const target = targets[category] ?? 0;
    if (target <= 0) continue;

    let tries = 0;
    let relaxed = false;
    let skipLine = false;

    while (
      (placedByCategory[category] || 0) < target &&
      tries < MAX_TRIES_PER_CATEGORY
    ) {
      tries++;
      if (tries === 400) relaxed = true;
      if (tries === 700) skipLine = true;

      tryPlaceOne(category, catPool, relaxed, skipLine);
    }

    if ((placedByCategory[category] || 0) < minPer) {
      warnings.push(
        `[CTU] Category "${category}" placed ${placedByCategory[category] || 0} / target ${target} (min ${minPer}) — map constraints or manifest pool.`,
      );
    }
  }

  const expectedSum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (mapObjects.length < expectedSum * 0.4 && expectedSum > 5) {
    warnings.push(
      `[CTU] Total mapObjects ${mapObjects.length} below ~40% of summed targets ${expectedSum} — check connectivity and manifest.`,
    );
  }

  return { warnings, placedByCategory };
}
