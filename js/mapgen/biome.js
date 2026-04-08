/**
 * Unified biomes for Map Theater + procedural mapgen + CTU scatter.
 * Catalog uses `biome` (preferred) and legacy `environment`.
 * Mapgen internal themes: urban | desert | grass | arctic
 */

/** @typedef {"forest"|"desert"|"winter"|"urban"} Biome */

export const BIOMES = /** @type {const} */ ([
  "forest",
  "desert",
  "winter",
  "urban",
]);

export const LEGACY_MAPGEN_THEMES = /** @type {const} */ ([
  "urban",
  "desert",
  "grass",
  "arctic",
]);

/** Map catalog `environment` -> `biome` (when `biome` field absent). */
export function environmentToBiome(environment) {
  const e = String(environment || "").toLowerCase();
  switch (e) {
    case "wild":
      return "forest";
    case "arctic":
      return "winter";
    case "urban":
      return "urban";
    case "desert":
      return "desert";
    case "mixed":
      return "forest";
    default:
      return "urban";
  }
}

/**
 * @param {{ biome?: string, environment?: string }} catalogEntry
 * @returns {Biome}
 */
export function getBiomeForCatalogEntry(catalogEntry) {
  if (!catalogEntry) return "urban";
  const b = catalogEntry.biome;
  if (b && BIOMES.includes(/** @type {Biome} */ (b))) return /** @type {Biome} */ (b);
  return environmentToBiome(catalogEntry.environment);
}

/** Player-facing biome label */
export function biomeDisplayName(biome) {
  switch (biome) {
    case "forest":
      return "Forest";
    case "desert":
      return "Desert";
    case "winter":
      return "Winter";
    case "urban":
      return "Urban";
    default:
      return String(biome);
  }
}

/**
 * Mapgen foundation / CTU scatter theme (not the same as biome names).
 * @param {Biome} biome
 * @returns {"urban"|"desert"|"grass"|"arctic"}
 */
export function biomeToMapgenTheme(biome) {
  switch (biome) {
    case "forest":
      return "grass";
    case "desert":
      return "desert";
    case "winter":
      return "arctic";
    case "urban":
      return "urban";
    default:
      return "urban";
  }
}

/** Inverse for generator metadata when only legacy theme was used. */
export function mapgenThemeToBiome(theme) {
  const t = String(theme || "").toLowerCase();
  if (t === "grass") return "forest";
  if (t === "arctic") return "winter";
  if (t === "desert") return "desert";
  return "urban";
}

/**
 * @param {string} [input] hub procTheme, CLI, or biome name
 * @returns {{ biome: Biome, theme: "urban"|"desert"|"grass"|"arctic" }}
 */
export function resolveProceduralThemeArg(input) {
  const s = String(input ?? "urban").toLowerCase();
  if (BIOMES.includes(/** @type {Biome} */ (s))) {
    return {
      biome: /** @type {Biome} */ (s),
      theme: biomeToMapgenTheme(/** @type {Biome} */ (s)),
    };
  }
  if (LEGACY_MAPGEN_THEMES.includes(/** @type {(typeof LEGACY_MAPGEN_THEMES)[number]} */ (s))) {
    return {
      biome: mapgenThemeToBiome(s),
      theme: /** @type {"urban"|"desert"|"grass"|"arctic"} */ (s),
    };
  }
  return { biome: "urban", theme: "urban" };
}

/**
 * @param {{ biome?: string, theme?: string }} spec - pipeline input
 * @returns {{ biome: Biome, theme: "urban"|"desert"|"grass"|"arctic" }}
 */
export function resolvePipelineThemeSpec(spec) {
  if (spec?.biome != null) {
    const raw = String(spec.biome).toLowerCase();
    if (!BIOMES.includes(/** @type {Biome} */ (raw))) {
      console.warn(
        "[CTU] Unknown biome",
        spec.biome,
        "- using urban. Expected one of:",
        BIOMES.join(", "),
      );
      return { biome: "urban", theme: "urban" };
    }
    const biome = /** @type {Biome} */ (raw);
    return { biome, theme: biomeToMapgenTheme(biome) };
  }
  return resolveProceduralThemeArg(spec?.theme ?? "urban");
}
