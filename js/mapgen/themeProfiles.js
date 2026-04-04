/**
 * Step 1 — Theme maps to terrain type keys in js/config/tileTextures.json.
 * Optional `assetManifest` (from js/config/assetManifest.json) overrides
 * foundation hints and obstacle sprites via js/mapgen/assetQuery.js.
 *
 * CraftPix linkage when no manifest obstacles exist is filled by the Librarian
 * into assetManifest.json (legacy CraftPix paths).
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
      dividerTerrain: "water",
      dividerTypes: ["water"],
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
    dividerTerrain: "water",
    dividerTypes: ["water"],
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
  const obs = obstacleVisualKindsForTheme(manifest, themeId);
  if (obs.length) {
    p.obstacleVisualKinds = obs;
  } else {
    /* last-resort if manifest missing index */
    const CP = "attached_assets/craftpix_pack/city";
    p.obstacleVisualKinds = [
      { kind: "tree", sprite: `${CP}/PNG City/Trees Bushes/TDS04_0022_Tree1.png` },
      {
        kind: "ruins",
        sprite: `${CP}/PNG City 2/broken_small_houses/Elements/small_house1_carcass1.png`,
      },
      { kind: "crate", sprite: `${CP}/PNG City/Crates Barrels/TDS04_0018_Box1.png` },
      { kind: "barrel", sprite: `${CP}/PNG City/Crates Barrels/TDS04_0016_Barrel.png` },
    ];
  }
  return p;
}

export const DEFAULT_THEMES = ["urban", "desert", "grass"];
