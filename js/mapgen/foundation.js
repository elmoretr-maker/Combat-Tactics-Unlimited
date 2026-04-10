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
/**
 * Low-density terrain jitter so maps are not a single flat colour when the tactical
 * asset manifest yields zero scatter props (common). Does not depend on water strip.
 */
function scatterOrganicGround(rnd, terrain, profile) {
  const h = terrain.length;
  const w = h ? terrain[0].length : 0;
  if (w < 3 || h < 3) return;
  const base = profile.baseTerrain;
  const road = profile.roadTerrain;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (terrain[y][x] !== base) continue;
      const r = rnd();
      if (profile.id === "grass") {
        if (r < 0.1) terrain[y][x] = "forest";
        else if (r < 0.16) terrain[y][x] = "hill";
        else if (r < 0.2) terrain[y][x] = road;
      } else if (profile.id === "arctic") {
        if (r < 0.08) terrain[y][x] = "forest";
        else if (r < 0.14) terrain[y][x] = "hill";
        else if (r < 0.18) terrain[y][x] = road;
      } else if (profile.id === "desert") {
        if (r < 0.07) terrain[y][x] = "hill";
        else if (r < 0.13) terrain[y][x] = road;
        else if (r < 0.2) terrain[y][x] = "plains";
      } else if (profile.id === "urban") {
        if (r < 0.09) terrain[y][x] = "cp_road";
      }
    }
  }
}

/**
 * Seeded meandering river: paints only a **horizontal segment** of columns (not the full
 * width), so thumbnails are not all “one blue line across the whole minimap”.
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

  const innerW = Math.max(1, width - 2);
  const segFrac = 0.38 + rnd() * 0.48;
  let segLen = Math.max(3, Math.floor(innerW * segFrac));
  segLen = Math.min(segLen, innerW);
  const slack = Math.max(0, innerW - segLen);
  const xStart = 1 + (slack > 0 ? Math.floor(rnd() * (slack + 1)) : 0);
  const xEnd = Math.min(width - 2, xStart + segLen - 1);

  for (let x = xStart; x <= xEnd; x++) {
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
 * @param {boolean} [opts.addRiverStrip] meandering water segment (divider for connectors); default true
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

  const groundRnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  scatterOrganicGround(groundRnd, terrain, profile);

  /* Optional meandering divider — segment width varies by seed (not full-map trench). */
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
