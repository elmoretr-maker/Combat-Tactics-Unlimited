/**
 * Canonical asset folder layout for CTU librarian + ingestion.
 * Game logic uses manifest + `.ctu.asset.json`; paths here are the default physical layout.
 */

/** @typedef {'guns'|'buildings'|'tiles'|'obstacles'|'vfx'|'ui'|'units'|null} ManifestBucket */

/**
 * Manifest bucket from repo-relative raster path (forward slashes).
 * @param {string} relPosix
 * @returns {ManifestBucket}
 */
function under(prefix, n) {
  return n === prefix || n.startsWith(`${prefix}/`);
}

export function assetBucketForRel(relPosix) {
  const n = relPosix.replace(/\\/g, "/").toLowerCase();
  if (under("assets/guns", n)) return "guns";
  if (under("assets/buildings", n)) return "buildings";
  if (under("assets/tiles/structures", n)) return "buildings";
  if (under("assets/effects", n)) return "vfx";
  if (under("assets/vfx", n)) return "vfx";
  if (under("assets/ui", n)) return "ui";
  if (under("assets/units", n)) return "units";
  if (under("assets/obstacles", n)) return "obstacles";
  if (under("assets/tiles", n)) return "tiles";
  return null;
}

/**
 * Terrain theme for tile manifest records (urban | desert | grass).
 * @param {string} relPosix
 */
export function tileThemeFromRel(relPosix) {
  const p = relPosix.replace(/\\/g, "/").split("/").filter(Boolean);
  if (p[1] !== "tiles") return "urban";
  if (p[2] === "terrain") return p[3] || "urban";
  if (p[2] === "structures") return "urban";
  return p[2] || "urban";
}

/**
 * Building footprint segment from path, or null to fall back to filename classifier.
 * @param {string} relPosix
 * @returns {string|null}
 */
export function buildingFootprintSegmentFromRel(relPosix) {
  const p = relPosix.replace(/\\/g, "/").split("/").filter(Boolean);
  if (p[0] !== "assets") return null;
  if (p[1] === "buildings") return p[2] || null;
  if (p[1] === "tiles" && p[2] === "structures") return p[3] || null;
  return null;
}

/**
 * Choose effects/ subfolder from basename heuristics (explosions | muzzle | smoke).
 * @param {string} baseLower basename lowercase with extension
 */
export function effectsSubfolderFromBaseName(baseLower) {
  const stem = baseLower.replace(/\.(png|webp|gif|jpe?g|bmp|tif|tiff)$/i, "");
  if (/\b(smoke|smog|dust|cloud)\b/i.test(stem)) return "smoke";
  if (/\b(muzzle|flash|shot|shell|tracer|spark)\b/i.test(stem)) return "muzzle";
  if (/\b(explosion|explode|burst|impact|deton|boom|flame|fire)\b/i.test(stem)) return "explosions";
  return "explosions";
}

/**
 * Map CLIP / librarian category id ? coarse family for reports and tooling (not game CTU types).
 * @param {string} clipCategoryId
 */
export function mapClipCategoryToCoarseFamily(clipCategoryId) {
  switch (clipCategoryId) {
    case "tactical_vehicles":
    case "soldiers_infantry":
    case "weapons_firearms":
      return "unit";
    case "terrain_tiles":
    case "buildings_structures":
    case "urban_ruins":
    case "urban_props":
    case "foliage":
    case "desert_scatter":
      return "tile";
    case "vfx_combat":
      return "effect";
    case "ui_hud":
    case "loot_icons":
      return "ui";
    default:
      return "unknown";
  }
}
