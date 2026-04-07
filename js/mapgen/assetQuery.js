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
 * Obstacle props for tactical scatter (kind + sprite path + optional manifest tags).
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"} themeId
 * @returns {{ kind: string, sprite: string, tags?: string[] }[]}
 */
export function obstacleVisualKindsForTheme(manifest, themeId) {
  const list = manifest?.index?.obstaclesByTheme?.[themeId];
  if (!list?.length) return [];
  return list.map((o) => ({
    kind: o.kind,
    sprite: o.sprite,
    tags: Array.isArray(o.tags) ? [...o.tags] : [],
  }));
}

/**
 * Props tagged `placementRule` wall_anchored | central — interior layout only (not battlefield scatter).
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"} themeId
 * @returns {{ kind: string, sprite: string, placementRule: string }[]}
 */
export function interiorFurnitureKindsForTheme(manifest, themeId) {
  const list = manifest?.index?.interiorFurnitureByTheme?.[themeId];
  if (!list?.length) return [];
  return list.map((o) => ({
    kind: o.kind,
    sprite: o.sprite,
    placementRule: o.placementRule,
  }));
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

/**
 * Pick tile art for river/road autotiling (4-neighbor mask → variant string).
 * Prefers `flowVariant` on manifest entries; else tag `flow:<variant>`;
 * else a horizontal `spriteSheet` tile tagged `flowConnector` (frame index = mask 0–15).
 *
 * @param {object|null|undefined} manifest
 * @param {"urban"|"desert"|"grass"} themeId
 * @param {string} variant e.g. end_n, straight_ns, t_nes, cross
 * @param {{ flowKind?: "water"|"road" }} [opts]
 * @returns {{ path: string, spriteSheetFrame?: number } | null}
 */
export function resolveFlowConnectorAsset(manifest, themeId, variant, opts = {}) {
  if (!manifest?.assets?.length) return null;
  const wantedKind = opts.flowKind ?? "water";
  const tagFlow = `flow:${variant}`;

  const matchesTheme = (a) =>
    a.theme == null || a.theme === themeId || a.theme === "urban";

  const flowTileOk = (a) =>
    a.type === "tile" &&
    a.flowConnector === true &&
    a.tier !== "legacy";

  const tryKind = (flowKind) => {
    const exact = manifest.assets.find(
      (a) =>
        flowTileOk(a) &&
        matchesTheme(a) &&
        a.flowVariant === variant &&
        (a.flowKind == null || a.flowKind === flowKind),
    );
    if (exact) return { path: exact.path, spriteSheetFrame: 0, flowSheet: null };

    const byTag = manifest.assets.find(
      (a) =>
        flowTileOk(a) &&
        matchesTheme(a) &&
        (a.tags || []).includes(tagFlow) &&
        (a.flowKind == null || a.flowKind === flowKind),
    );
    if (byTag) return { path: byTag.path, spriteSheetFrame: 0, flowSheet: null };

    const sheet = manifest.assets.find(
      (a) =>
        flowTileOk(a) &&
        matchesTheme(a) &&
        a.spriteSheet?.columns &&
        ["horizontal", "grid"].includes(a.spriteSheet.layout || "horizontal") &&
        (a.flowKind == null || a.flowKind === flowKind),
    );
    if (!sheet?.spriteSheet?.columns) return null;

    const maskIdx = variantToMaskIndex(variant);
    const cols = sheet.spriteSheet.columns;
    const rows = sheet.spriteSheet.rows ?? 1;
    const layout = sheet.spriteSheet.layout || "horizontal";

    if (layout === "horizontal") {
      const col = Math.min(Math.max(0, maskIdx), cols - 1);
      const fw = sheet.spriteSheet.frameW;
      const fh = sheet.spriteSheet.frameH;
      return {
        path: sheet.path,
        spriteSheetFrame: col,
        flowSheet:
          fw && fh
            ? { columns: cols, rows: 1, frameW: fw, frameH: fh }
            : null,
      };
    }

    const total = cols * rows;
    const frameIdx = total > 0 ? maskIdx % total : 0;
    return {
      path: sheet.path,
      spriteSheetFrame: frameIdx,
      flowSheet: {
        columns: cols,
        rows,
        frameW: sheet.spriteSheet.frameW,
        frameH: sheet.spriteSheet.frameH,
      },
    };
  };

  let r = tryKind(wantedKind);
  /* Fords use `road` terrain; reuse the water-channel sheet when no road-specific flow tile exists. */
  if (!r && wantedKind === "road") r = tryKind("water");
  return r;
}

/** Variant id → mask value (sprite-sheet column when frames are ordered 0–15 by mask). */
const FLOW_VARIANT_TO_MASK = {
  isolated: 0,
  end_n: 1,
  end_e: 2,
  end_s: 4,
  end_w: 8,
  straight_ns: 5,
  straight_ew: 10,
  corner_ne: 3,
  corner_se: 6,
  corner_nw: 9,
  corner_sw: 12,
  t_nes: 7,
  t_new: 11,
  t_nsw: 13,
  t_esw: 14,
  cross: 15,
};

function variantToMaskIndex(variant) {
  return FLOW_VARIANT_TO_MASK[variant] ?? 0;
}
