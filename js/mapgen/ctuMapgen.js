/**
 * CTU-driven scatter: placement tags + behavior only (no folder/filename inference).
 * @see tools/asset_metadata.mjs — sidecars merged into manifest as asset.ctu
 */

import { effectiveObstacleKind } from "./tacticalPlacement.js";

export const WATER_TERRAIN_IDS = new Set(["water", "water_desert", "water_urban"]);

const LAND_SURFACES = new Set(["grass", "urban", "desert", "interior"]);

const THEME_SURFACE_ALLOW = {
  desert: ["desert"],
  grass: ["grass"],
  arctic: ["grass"],
  urban: ["urban", "grass", "interior"],
};

/**
 * @param {object|null|undefined} ctu
 * @returns {string[]}
 */
export function normalizePlacementTags(ctu) {
  if (!ctu) return [];
  const p = ctu.placement;
  if (Array.isArray(p)) return p.map(String);
  if (p && typeof p === "object" && Array.isArray(p.allowedSurfaces)) {
    return legacySurfacesToPlacementTags(p.allowedSurfaces);
  }
  return [];
}

/** v1 sidecar: migrate allowedSurfaces → tag list; empty → ["none"]. */
export function legacySurfacesToPlacementTags(surfaces) {
  if (!surfaces?.length) return ["none"];
  const landTags = ["grass", "urban", "desert", "interior"];
  const sset = new Set(surfaces);
  const hasWater = sset.has("water");
  const landPresent = landTags.filter((x) => sset.has(x));
  const allLand = landPresent.length === 4;
  if (hasWater && allLand) return ["water", "land"];
  if (!hasWater && allLand && !sset.has("air")) return ["land"];
  if (hasWater && landPresent.length === 0) return ["water"];
  return [...sset].filter((s) => s !== "air");
}

/** True if this placement may appear in world scatter pools. */
export function placementAllowsWorldScatter(tags) {
  if (!tags?.length) return false;
  if (tags.includes("none")) return false;
  return true;
}

/**
 * @param {object|null|undefined} cls ctu.classification
 */
export function isWorldScatterClassification(cls) {
  if (!cls?.type) return false;
  const { type, subtype } = cls;
  if (type === "ui" || type === "effect" || type === "weapon") return false;
  if (type === "building") return false;
  if (type === "environment" && subtype === "tile") return false;
  if (type === "unit" && subtype !== "boat") return false;
  return true;
}

/**
 * @param {string[]} tags normalizePlacementTags
 * @param {"urban"|"desert"|"grass"|"arctic"} themeId
 */
export function scatterPoolIncludesAssetForTheme(tags, themeId) {
  if (!placementAllowsWorldScatter(tags)) return false;
  if (tags.length === 1 && tags[0] === "water") return true;
  return placementTagsMatchTheme(tags, themeId);
}

function placementTagsMatchTheme(tags, themeId) {
  if (tags.includes("any")) return true;
  if (tags.includes("land")) return true;
  const want = THEME_SURFACE_ALLOW[themeId] || THEME_SURFACE_ALLOW.urban;
  return want.some((w) => tags.includes(w));
}

export function terrainIdToPlacementSurface(terrainId) {
  if (WATER_TERRAIN_IDS.has(terrainId)) return "water";
  if (terrainId === "desert") return "desert";
  if (
    terrainId === "plains" ||
    terrainId === "forest" ||
    terrainId === "hill" ||
    terrainId === "snow"
  ) {
    return "grass";
  }
  if (
    terrainId === "urban" ||
    terrainId === "cp_grass" ||
    terrainId === "cp_road" ||
    terrainId === "road" ||
    terrainId === "cp_building" ||
    terrainId === "cp_rubble" ||
    terrainId === "building_block"
  ) {
    return "urban";
  }
  return "grass";
}

function cellTouchesNonWater(terrain, x, y) {
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
    if (!WATER_TERRAIN_IDS.has(terrain[ny][nx])) return true;
  }
  return false;
}

/** 4-neighbor touches impassable water divider. */
export function cellTouchesWaterTerrain(terrain, x, y) {
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
    if (WATER_TERRAIN_IDS.has(terrain[ny][nx])) return true;
  }
  return false;
}

/**
 * Strict CTU from manifest only (merged .ctu.asset.json). No filename inference.
 * @param {object} asset manifest.assets entry
 * @returns {object|null} normalized { ...ctu, placement: string[] }
 */
export function strictManifestCtu(asset) {
  if (!asset?.ctu) return null;
  let placement = asset.ctu.placement;
  if (placement && typeof placement === "object" && !Array.isArray(placement)) {
    const legacy = placement.allowedSurfaces;
    if (!Array.isArray(legacy)) return null;
    placement = legacySurfacesToPlacementTags(legacy);
  }
  if (!Array.isArray(placement) || !placement.length) return null;
  if (placement.includes("none")) return null;
  return { ...asset.ctu, placement };
}

/**
 * @param {object} ctu
 * @param {string[][]} terrain rows terrain[y][x]
 */
export function terrainMatchesCtuPlacement(ctu, terrain, x, y) {
  const terrainId = terrain[y][x];
  const isWaterCell = WATER_TERRAIN_IDS.has(terrainId);
  const surface = terrainIdToPlacementSurface(terrainId);
  const tags = normalizePlacementTags(ctu);
  const subtype = ctu?.classification?.subtype;

  if (!tags.length) return false;
  if (tags.includes("none")) return false;

  if (subtype === "bridge" || tags.includes("bridge")) {
    if (!isWaterCell) return false;
    if (!cellTouchesNonWater(terrain, x, y)) return false;
    return tags.includes("water") || tags.includes("any") || tags.includes("land");
  }

  if (isWaterCell) {
    return tags.includes("water") || tags.includes("any");
  }

  const waterOnly =
    tags.includes("water") &&
    !tags.some((t) => t === "any" || t === "land" || LAND_SURFACES.has(t));
  if (waterOnly) return false;

  if (tags.includes("any")) return true;
  if (tags.includes("land") && LAND_SURFACES.has(surface)) return true;
  if (tags.includes(surface)) return true;
  return false;
}

export function mapObjectExtraFromCtuBehavior(ctu, cellSize = 48) {
  const b = ctu?.behavior || {};
  const extra = {};
  if (b.walkable === true) {
    extra.blocksMove = false;
    extra.blocksLos = b.blocksLos === true;
  } else if (b.blocking === false) {
    extra.blocksMove = false;
    if (b.blocksLos === false) extra.blocksLos = false;
  } else {
    extra.blocksMove = true;
    if (b.blocksLos === false) extra.blocksLos = false;
    else extra.blocksLos = true;
  }
  if (typeof b.pyOffset === "number" && Number.isFinite(b.pyOffset)) {
    extra.pyOffset = Math.round(b.pyOffset * (cellSize / 48));
  }
  return extra;
}

export function scatterVisualKind(entry) {
  const st = entry.ctu?.classification?.subtype;
  if (st === "foliage") return "tree";
  if (st) return String(st);
  return effectiveObstacleKind(entry.kind, entry.sprite);
}

/**
 * Scatter pool from manifest.assets — requires merged ctu from sidecar; tier does not gate membership.
 */
export function scatterObstacleEntriesFromManifest(manifest, themeId) {
  const assets = manifest?.assets;
  if (!Array.isArray(assets) || !assets.length) return [];

  const seen = new Set();
  const out = [];
  for (const a of assets) {
    const path = a.path;
    if (!path || seen.has(path)) continue;

    const ctu = strictManifestCtu(a);
    if (!ctu || !isWorldScatterClassification(ctu.classification)) continue;

    const ptags = normalizePlacementTags(ctu);
    if (!scatterPoolIncludesAssetForTheme(ptags, themeId)) continue;

    seen.add(path);
    out.push({
      kind: effectiveObstacleKind(a.obstacleKind || "crate", path),
      sprite: path,
      tags: Array.isArray(a.tags) ? [...a.tags] : [],
      manifestAsset: a,
      ctu,
    });
  }
  return out;
}
