/**
 * Step 1 — Foundation: theme-based base grid (terrain[y][x] strings).
 * moveCost / blocksLos / blocksMove come from tileTextures.types (not duplicated here).
 */

import { getThemeProfile } from "./themeProfiles.js";

/**
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.seed
 * @param {"urban"|"desert"|"grass"} opts.theme
 * @param {object|null|undefined} [opts.assetManifest] assetManifest.json object
 * @param {boolean} [opts.addRiverStrip] default true — horizontal impassable strip to invoke Step 2 connectors
 * @returns {{ terrain: string[][], profile: ReturnType<typeof getThemeProfile> }}
 */
export function generateFoundation(opts) {
  const {
    width,
    height,
    seed,
    theme,
    addRiverStrip = true,
    assetManifest = null,
  } = opts;
  const profile = getThemeProfile(theme, assetManifest);
  const terrain = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      row.push(profile.baseTerrain);
    }
    terrain.push(row);
  }

  /* Continuous divider strip — gaps were read as “wrong” land bridges and mixed
   * animated vs static cells in the same river row. Connectors from Step 2 are
   * the only intentional crossings. */
  if (addRiverStrip && height >= 5 && width >= 7) {
    const mid = Math.floor(height / 2);
    for (let x = 1; x < width - 1; x++) {
      terrain[mid][x] = profile.dividerTerrain;
    }
  }

  return { terrain, profile };
}
