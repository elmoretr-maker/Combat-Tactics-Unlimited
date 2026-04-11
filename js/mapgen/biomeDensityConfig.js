/**
 * Target-driven scatter: per-biome category fractions of total grid cells.
 * Categories map to visualKind / CTU subtype aliases (see CATEGORY_MAP).
 */

/** Minimum targets per category (scaled down on very small maps in targetDrivenMapObjects). */
export const MIN_PER_CATEGORY = 7;

/**
 * @typedef {Record<string, number>} DensityRow — keys: tree | rock | structure | cactus | debris (fractions 0–1)
 */

/** @type {Record<string, DensityRow>} */
export const BIOME_DENSITY = {
  arctic: {
    tree: 0.18,
    rock: 0.1,
    structure: 0.04,
  },
  grass: {
    tree: 0.28,
    rock: 0.1,
    structure: 0.05,
  },
  forest: {
    tree: 0.4,
    rock: 0.08,
    structure: 0.03,
  },
  desert: {
    cactus: 0.12,
    rock: 0.12,
    structure: 0.04,
  },
  urban: {
    structure: 0.35,
    debris: 0.1,
    tree: 0.05,
  },
};

/**
 * Category → visualKind / subtype strings to match manifest scatter entries.
 * Matching is case-insensitive substring or equality on scatterVisualKind + subtype.
 */
export const CATEGORY_MAP = {
  tree: ["tree", "dead_tree", "pine", "foliage"],
  rock: ["rock", "boulder"],
  cactus: ["cactus"],
  structure: ["building", "house", "ruin", "ruins"],
  debris: ["crate", "barrel", "wreck"],
};

/**
 * Map mapgen theme + catalog biome to a BIOME_DENSITY key.
 * @param {"urban"|"desert"|"grass"|"arctic"} theme
 * @param {import("./biome.js").Biome | string | undefined} biome
 * @returns {keyof typeof BIOME_DENSITY}
 */
export function resolveDensityProfileId(theme, biome) {
  const b = biome != null ? String(biome).toLowerCase() : "";
  if (b === "forest") return "forest";
  if (b === "winter" || theme === "arctic") return "arctic";
  if (theme === "urban" || b === "urban") return "urban";
  if (theme === "desert" || b === "desert") return "desert";
  if (theme === "grass") return "grass";
  return "grass";
}
