/**
 * Step 1 — Foundation: theme-based base grid (terrain[y][x] strings).
 * moveCost / blocksLos / blocksMove come from tileTextures.types (not duplicated here).
 */

import { getThemeProfile } from "./themeProfiles.js";
import { mulberry32 } from "./rng.js";

/**
 * Seeded meandering river: one column at a time, vertical jitter up to ±2 rows,
 * filling the vertical span each step so the channel stays 4-connected.
 *
 * @param {number} seed
 * @param {number} width
 * @param {number} height
 * @param {string} dividerTerrain
 * @param {string[][]} terrain — mutated in place (base terrain already filled)
 */
export function paintMeanderingDividerStrip(seed, width, height, dividerTerrain, terrain) {
  const rnd = mulberry32(seed >>> 0);
  /* 30–70% band, clamped to playable interior [1, height - 2] */
  const yMin = Math.max(1, Math.floor(height * 0.3));
  const yMax = Math.min(height - 2, Math.ceil(height * 0.7) - 1);
  const span = Math.max(0, yMax - yMin);
  let y =
    span > 0
      ? yMin + Math.floor(rnd() * (span + 1))
      : Math.max(1, Math.min(height - 2, Math.floor(height * 0.5)));

  for (let x = 1; x < width - 1; x++) {
    const jitter = Math.floor(rnd() * 5) - 2; /* -2 .. +2 */
    let nextY = y + jitter;
    nextY = Math.max(1, Math.min(height - 2, nextY));

    const y0 = Math.min(y, nextY);
    const y1 = Math.max(y, nextY);
    for (let yy = y0; yy <= y1; yy++) {
      terrain[yy][x] = dividerTerrain;
    }
    y = nextY;
  }
}

/**
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.seed
 * @param {"urban"|"desert"|"grass"|"arctic"} opts.theme
 * @param {object|null|undefined} [opts.assetManifest] assetManifest.json object
 * @param {boolean} [opts.addRiverStrip] default true — impassable divider path to invoke Step 2 connectors
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

  /* Meandering divider — continuous under 4-connectivity within each column slice.
   * Connectors from Step 2 are the only intentional crossings. */
  if (addRiverStrip && height >= 5 && width >= 7) {
    paintMeanderingDividerStrip(
      seed,
      width,
      height,
      profile.dividerTerrain,
      terrain,
    );
  }

  return { terrain, profile };
}
