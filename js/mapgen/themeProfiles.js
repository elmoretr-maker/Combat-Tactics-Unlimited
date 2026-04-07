/**
 * Step 1 — Theme maps to terrain type keys in js/config/tileTextures.json.
 * Scatter props come only from manifest.assets with merged `.ctu.asset.json` metadata.
 */

import {
  applyFoundationHints,
  obstacleVisualKindsForTheme,
} from "./assetQuery.js";

/**
 * @returns {Omit<ReturnType<typeof getThemeProfile>, never>}
 */
function baseThemeProfile(themeId) {
  if (themeId === "desert") {
    return {
      id: "desert",
      baseTerrain: "desert",
      roadTerrain: "road",
      dividerTerrain: "water_desert",
      dividerTypes: ["water_desert"],
      obstacleVisualKinds: [],
    };
  }
  if (themeId === "grass") {
    return {
      id: "grass",
      baseTerrain: "plains",
      roadTerrain: "road",
      dividerTerrain: "water",
      dividerTypes: ["water"],
      obstacleVisualKinds: [],
    };
  }
  return {
    id: "urban",
    baseTerrain: "cp_grass",
    roadTerrain: "cp_road",
    dividerTerrain: "water_urban",
    dividerTypes: ["water_urban"],
    obstacleVisualKinds: [],
  };
}

/**
 * @param {"urban"|"desert"|"grass"} themeId
 * @param {object|null|undefined} manifest loaded assetManifest.json
 */
export function getThemeProfile(themeId, manifest = null) {
  let p = baseThemeProfile(themeId);
  p = applyFoundationHints(p, manifest, themeId);
  p.obstacleVisualKinds = obstacleVisualKindsForTheme(manifest, themeId);
  return p;
}

export const DEFAULT_THEMES = ["urban", "desert", "grass"];
