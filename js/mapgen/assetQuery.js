/**
 * Query js/config/assetManifest.json (loaded in browser via fetch) for mapgen.
 */

/**
 * @param {object|null|undefined} manifest
 * @param {object} [filters]
 * @param {string} [filters.type] gun | building | tile | obstacle
 * @param {string} [filters.theme] urban | desert | grass
 * @param {string} [filters.footprint] small | medium | large | fortified
 * @param {string} [filters.gunClass] handgun | rifle | machine_gun
 * @param {string} [filters.tag]
 * @returns {object[]}
 */
export function findAssets(manifest, filters = {}) {
  if (!manifest?.assets?.length) return [];
  return manifest.assets.filter((a) => {
    if (filters.type && a.type !== filters.type) return false;
    if (filters.theme != null && a.theme != null && a.theme !== filters.theme) return false;
    if (filters.footprint && a.footprint !== filters.footprint) return false;
    if (filters.gunClass && a.gunClass !== filters.gunClass) return false;
    if (filters.tag && !(a.tags || []).includes(filters.tag)) return false;
    return true;
  });
}

/**
 * Building art paths for generator: theme + footprint (e.g. Urban + Fortified).
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"} theme
 * @param {"small"|"medium"|"large"|"fortified"} footprint
 * @returns {string[]}
 */
export function findBuildingsByThemeAndFootprint(manifest, theme, footprint) {
  const pool = manifest?.index?.buildingsByThemeFootprint?.[theme]?.[footprint];
  return Array.isArray(pool) ? [...pool] : [];
}

/**
 * Obstacle props for tactical scatter (kind + sprite path).
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"} themeId
 * @returns {{ kind: string, sprite: string }[]}
 */
export function obstacleVisualKindsForTheme(manifest, themeId) {
  const list = manifest?.index?.obstaclesByTheme?.[themeId];
  if (!list?.length) return [];
  return list.map((o) => ({ kind: o.kind, sprite: o.sprite }));
}

/**
 * Merge manifest foundationHints over defaults (terrain type keys for GameState).
 * @param {object} baseProfile from internal defaults
 * @param {object|null|undefined} manifest
 * @param {string} themeId
 */
export function applyFoundationHints(baseProfile, manifest, themeId) {
  const hints = manifest?.foundationHints?.[themeId];
  if (!hints || typeof hints !== "object") return { ...baseProfile };
  return { ...baseProfile, ...hints };
}
