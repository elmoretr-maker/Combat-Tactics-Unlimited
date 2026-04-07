/**
 * CTU asset metadata — authoritative for gameplay; folders are optional layout hints.
 * CLIP (or other vision hints) populate clipSuggestions only; rules finalize type/subtype/placement/behavior.
 */

import path from "path";
import fs from "fs-extra";

export const ASSET_METADATA_SCHEMA_VERSION = 2;
/** Sidecar filename: Tile_Foo.png -> Tile_Foo.ctu.asset.json */
export const METADATA_SUFFIX = ".ctu.asset.json";

/** @typedef {'environment'|'unit'|'obstacle'|'ui'|'effect'|'weapon'|'building'|'unknown'} AssetType */

/**
 * Map CLIP pack category ids → soft defaults (overridden by filename + global rules).
 */
export const CLIP_CATEGORY_HINTS = {
  tactical_vehicles: { type: "unit", subtype: "vehicle" },
  soldiers_infantry: { type: "unit", subtype: "soldier" },
  weapons_firearms: { type: "weapon", subtype: "firearm" },
  urban_ruins: { type: "environment", subtype: "ruins" },
  urban_props: { type: "obstacle", subtype: "prop" },
  foliage: { type: "environment", subtype: "foliage" },
  desert_scatter: { type: "environment", subtype: "scatter" },
  terrain_tiles: { type: "environment", subtype: "tile" },
  buildings_structures: { type: "building", subtype: "structure" },
  vfx_combat: { type: "effect", subtype: "combat" },
  ui_hud: { type: "ui", subtype: "hud" },
  loot_icons: { type: "ui", subtype: "icon" },
};

const SURFACE_ALL_LAND = ["grass", "urban", "desert", "interior"];
const SURFACE_WATER = "water";
const SURFACE_AIR = "air";

function emptyBehavior() {
  return {
    walkable: false,
    blocking: true,
    animated: false,
    interactive: false,
  };
}

/** @param {string[]} surfaces grass|urban|desert|interior|water|air */
export function compactPlacementTagsFromSurfaces(surfaces) {
  if (!surfaces?.length) return ["none"];
  const landTags = ["grass", "urban", "desert", "interior"];
  const sset = new Set(surfaces);
  const hasWater = sset.has(SURFACE_WATER);
  const landPresent = landTags.filter((x) => sset.has(x));
  const allLand = landPresent.length === 4;
  if (hasWater && allLand) return [SURFACE_WATER, "land"];
  if (!hasWater && allLand && !sset.has(SURFACE_AIR)) return ["land"];
  if (hasWater && landPresent.length === 0) return [SURFACE_WATER];
  return [...sset].filter((s) => s !== SURFACE_AIR);
}

function defaultSurfacesForType(type) {
  if (type === "ui" || type === "effect" || type === "weapon") return [];
  if (type === "unit" || type === "obstacle" || type === "environment" || type === "building") {
    return [...SURFACE_ALL_LAND];
  }
  return [...SURFACE_ALL_LAND];
}

/**
 * @param {string} fileName
 * @param {{ id: string, confidence: number }[]} clipTop3
 * @param {string|null} primaryClipId
 * @param {{ reviewPending?: boolean, ingestError?: boolean }} [options]
 */
export function buildAssetMetadata(fileName, clipTop3, primaryClipId, options = {}) {
  const rulesApplied = [];
  const baseHint =
    (primaryClipId && CLIP_CATEGORY_HINTS[primaryClipId]) || { type: "unknown", subtype: "unknown" };

  let type = /** @type {AssetType} */ (baseHint.type);
  let subtype = baseHint.subtype;

  const clipSuggestions = {
    note: "Vision/CLIP outputs are suggestions only; classification.type/subtype are rule-finalized.",
    topCategories: (clipTop3 || []).slice(0, 5).map((c) => ({
      clipCategoryId: c.id,
      confidence: c.confidence,
    })),
  };

  const stem = path.basename(fileName, path.extname(fileName));
  const lower = `${fileName} ${stem}`.toLowerCase();
  const stemLower = stem.toLowerCase();
  const stemTokens = stemLower.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(stemTokens);
  const hasToken = (w) => tokenSet.has(w);

  /* Terrain / movement rules before generic UI (avoid "boat_icon" losing boat semantics).
   * Use stem tokens so `bridge_01` matches (JS \\b does not treat `_` as a word break). */
  if (hasToken("bridge") || hasToken("ford")) {
    type = "environment";
    subtype = hasToken("bridge") ? "bridge" : subtype;
    rulesApplied.push("bridges_water_walkable");
  }

  const boatish =
    hasToken("boat") ||
    hasToken("ship") ||
    hasToken("yacht") ||
    hasToken("barge") ||
    hasToken("naval") ||
    hasToken("gunboat") ||
    hasToken("ferry") ||
    hasToken("submarine") ||
    hasToken("vessel") ||
    /gunboat|battleship|destroyer|warship/i.test(stemLower);
  if (boatish) {
    type = "unit";
    subtype = "boat";
    rulesApplied.push("boats_water_only");
  }

  if (
    hasToken("tree") ||
    hasToken("trees") ||
    hasToken("bush") ||
    hasToken("bushes") ||
    hasToken("hedge") ||
    hasToken("sapling") ||
    hasToken("oak") ||
    hasToken("pine") ||
    hasToken("palm") ||
    hasToken("cactus") ||
    hasToken("foliage") ||
    hasToken("forest") ||
    hasToken("wood") ||
    /\b(tree|bush|foliage)\b/i.test(lower)
  ) {
    if (type === "unknown" || type === "environment" || type === "obstacle") {
      type = "environment";
      subtype = "foliage";
    }
    rulesApplied.push("trees_block_movement");
  }

  if (/\b(hud|gui|menu|button|panel|minimap|icon|cursor|tooltip|health\s*bar|mana)\b/i.test(lower)) {
    type = "ui";
    subtype = /\bicon\b/i.test(lower) ? "icon" : "panel";
    rulesApplied.push("filename_ui_tokens");
  }

  if (/anim|strip|sheet|sprites|sequence|frames/i.test(lower)) {
    rulesApplied.push("animated_filename_heuristic");
  }

  let surfaces = defaultSurfacesForType(type);
  const behavior = emptyBehavior();

  if (type === "ui") {
    surfaces = [];
    rulesApplied.push("ui_never_world_placed");
  }

  if (rulesApplied.includes("boats_water_only") || subtype === "boat") {
    surfaces = [SURFACE_WATER];
  }

  if (rulesApplied.includes("bridges_water_walkable")) {
    surfaces = [SURFACE_WATER, ...SURFACE_ALL_LAND];
    behavior.walkable = true;
    behavior.blocking = false;
  }

  if (rulesApplied.includes("trees_block_movement")) {
    behavior.blocking = true;
    behavior.walkable = false;
  }

  if (rulesApplied.includes("animated_filename_heuristic")) {
    behavior.animated = true;
  }

  if (type === "effect") {
    surfaces = [];
  }

  const placementTags = compactPlacementTagsFromSurfaces(surfaces);

  return {
    schemaVersion: ASSET_METADATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceImage: null,
    classification: {
      type,
      subtype,
      decidedBy: "rules",
      clipPrimaryHintId: primaryClipId || null,
      reviewPending: Boolean(options.reviewPending),
      ingestError: Boolean(options.ingestError),
    },
    clipSuggestions,
    placement: placementTags,
    behavior,
    rulesApplied,
    pipeline: {
      folderLayoutHint: null,
      note: "folderLayoutHint is optional librarian layout; game logic must use this JSON, not folders.",
    },
  };
}

/**
 * Optional folder layout from finalized metadata (non-authoritative).
 * @param {object} metadata - from buildAssetMetadata
 * @param {'urban'|'desert'|'grass'} themeHint
 */
export function suggestedDestRelFromMetadata(metadata, themeHint = "urban") {
  const t = metadata?.classification?.type;
  const st = metadata?.classification?.subtype;
  const th = themeHint === "desert" || themeHint === "grass" ? themeHint : "urban";

  switch (t) {
    case "unit":
      if (st === "soldier") return `assets/units/${th}`;
      return "assets/units/vehicles";
    case "weapon":
      return "assets/guns/rifle";
    case "ui":
      return "assets/ui/panels";
    case "effect":
      return "assets/vfx";
    case "building":
      return "assets/buildings/medium";
    case "environment":
      if (st === "tile") return `assets/tiles/${th}`;
      return `assets/obstacles/${th}`;
    case "obstacle":
      return `assets/obstacles/${th}`;
    default:
      return `assets/obstacles/${th}`;
  }
}

export function themeHintFromRelPosix(relPosix) {
  const s = (relPosix || "").replace(/\\/g, "/").toLowerCase();
  if (/\b(desert|sand|dune|arid)\b/.test(s) || /\/desert\//i.test(s)) return "desert";
  if (/\bgrass\b/.test(s) || /\/grass\//i.test(s)) return "grass";
  return "urban";
}

export function metadataSidecarPath(imageAbsPath) {
  const ext = path.extname(imageAbsPath);
  const base = ext ? imageAbsPath.slice(0, -ext.length) : imageAbsPath;
  return `${base}${METADATA_SUFFIX}`;
}

export async function writeAssetMetadataSidecar(imageAbsPath, metadata, dryRun) {
  const p = metadataSidecarPath(imageAbsPath);
  const payload = {
    ...metadata,
    sourceImage: path.basename(imageAbsPath),
  };
  if (dryRun) return { path: p, skipped: true };
  await fs.writeJson(p, payload, { spaces: 2 });
  return { path: p, skipped: false };
}

/**
 * For librarian / filename-only pipelines (no CLIP): rules + basename heuristics.
 */
export function buildAssetMetadataFromFileNameOnly(fileName) {
  return buildAssetMetadata(fileName, [], null, {});
}
