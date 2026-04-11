/**
 * Full procedural pipeline: Foundation → Divider rule → Tactical assets → scenario JSON.
 */

import { moveCostAt } from "../engine/terrain.js";
import { generateFoundation } from "./foundation.js";
import { getThemeProfile } from "./themeProfiles.js";
import { MAP_TEMPLATES } from "./templates.js";
import { imageToTerrain } from "./imageTemplates.js";
import { applyDividerRule, buildFlowConnectorLayer } from "./dividerRule.js";
import { computeProtectedRibbon } from "./corridor.js";
import { placeTacticalAssets } from "./tacticalAssets.js";
import { mulberry32 } from "./rng.js";
import { hasTwoVertexDisjointPathsWithObjects } from "./dividerRule.js";
import { gridFromTerrain } from "./gridCost.js";
import { resolvePipelineThemeSpec, biomeDisplayName } from "./biome.js";

/**
 * Map template placeholders → theme terrain ids (see MAP_TEMPLATES).
 * @param {string[][]} terrain
 * @param {ReturnType<typeof getThemeProfile>} profile
 */
function normalizeTemplateTerrainInPlace(terrain, profile) {
  const waterId = profile.dividerTerrain;
  const landId = profile.baseTerrain;
  for (let y = 0; y < terrain.length; y++) {
    const row = terrain[y];
    for (let x = 0; x < row.length; x++) {
      const t = row[x];
      if (t === "water") row[x] = waterId;
      else if (t === "plains") row[x] = landId;
    }
  }
}

/**
 * Default spawn columns can sit on water for island-style templates; stamp land so
 * divider/props have valid starting cells (matches full-rectangle foundation behavior).
 * @param {string[][]} terrain
 * @param {ReturnType<typeof getThemeProfile>} profile
 * @param {[number, number][]} playerSpawns
 * @param {[number, number][]} enemySpawns
 */
function ensureSpawnsOnPassableLand(
  terrain,
  profile,
  playerSpawns,
  enemySpawns,
) {
  const land = profile.baseTerrain;
  for (const [x, y] of [...playerSpawns, ...enemySpawns]) {
    if (y >= 0 && y < terrain.length && x >= 0 && x < terrain[y].length) {
      terrain[y][x] = land;
    }
  }
}

/**
 * Size-based pools + seeded pick for every tier (small / medium / large).
 * Same `seed` → same template; explicit `spec.template` (not "auto") is unchanged.
 * @param {object} spec
 * @param {number} width
 * @param {number} seed
 * @returns {string|undefined}
 */
function resolveEffectiveTemplate(spec, width, seed) {
  if (!spec.template || spec.template === "auto") {
    const rnd = mulberry32(seed >>> 0);

    let pool = [];

    if (width <= 12) {
      pool = ["arena_cross", "small_dual_islands"];
    } else if (width <= 18) {
      pool = ["central_stronghold", "three_lane_battle"];
    } else {
      pool = [
        "island_cluster_large",
        "ring_map",
        "choke_valley",
        "broken_grid",
      ];
    }

    spec.template = pool[Math.floor(rnd() * pool.length)];
  }
  return spec.template;
}

/**
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.seed
 * @param {"urban"|"desert"|"grass"|"arctic"} [spec.theme] legacy mapgen theme
 * @param {"forest"|"desert"|"winter"|"urban"} [spec.biome] preferred; overrides theme mapping when set
 * @param {string} [spec.template] MAP_TEMPLATES key, or "auto" / omit for size-based selection
 * @param {unknown} [spec.imageTemplate] future: raster → terrain (stub throws)
 * @param {Record<string, object>} spec.tileTypes — tileTextures.types only
 * @param {object|null|undefined} [spec.assetManifest] from assetManifest.json
 * @param {boolean} [spec.addRiverStrip] meandering water segment for divider/connectors (see foundation.js)
 * @param {number} [spec.maxGenerationAttempts] default 6
 */
export function generateProceduralScenario(spec) {
  const {
    width,
    height,
    seed,
    tileTypes,
    assetManifest = null,
    addRiverStrip = true,
    maxGenerationAttempts = 6,
  } = spec;

  const { theme, biome } = resolvePipelineThemeSpec(spec);

  const cellSize = spec.cellSize ?? 48;

  /* Raster path: stub throws until imageToTerrain exists. Then: terrain → normalize → ensureSpawns → divider… */
  if (spec.imageTemplate != null) {
    imageToTerrain(spec.imageTemplate);
  }

  const effectiveTemplate = resolveEffectiveTemplate(spec, width, seed);

  for (let attempt = 0; attempt < maxGenerationAttempts; attempt++) {
    const s = (seed + attempt * 0x9e3779b9) >>> 0;

    let t0;
    let profile;
    const templateFn =
      effectiveTemplate && MAP_TEMPLATES[effectiveTemplate]
        ? MAP_TEMPLATES[effectiveTemplate]
        : null;

    if (templateFn) {
      profile = getThemeProfile(theme, assetManifest);
      t0 = templateFn(width, height, s);
      normalizeTemplateTerrainInPlace(t0, profile);
      ensureSpawnsOnPassableLand(
        t0,
        profile,
        defaultPlayerSpawns(width, height),
        defaultEnemySpawns(width, height),
      );
    } else {
      const gen = generateFoundation({
        width,
        height,
        seed: s,
        theme,
        addRiverStrip,
        assetManifest,
      });
      t0 = gen.terrain;
      profile = gen.profile;
    }

    const playerSpawns = defaultPlayerSpawns(width, height);
    const enemySpawns = defaultEnemySpawns(width, height);

    const fordRnd = mulberry32((s ^ 0xf07dface) >>> 0);
    const div = applyDividerRule(
      t0,
      tileTypes,
      playerSpawns,
      enemySpawns,
      {
        dividerTypes: profile.dividerTypes,
        connectorTerrain: profile.roadTerrain,
        naturalFordTerrain: profile.baseTerrain,
        fordRnd,
      },
    );

    if (!div.ok) continue;

    let terrain = div.terrain;
    const ribbon = computeProtectedRibbon(
      terrain,
      tileTypes,
      playerSpawns,
      enemySpawns,
      2,
    );

    const rnd = mulberry32(s ^ 0xdeadbeef);
    const step3 = placeTacticalAssets({
      terrain,
      tileTypes,
      playerSpawns,
      enemySpawns,
      protectedRibbon: ribbon,
      profile,
      rnd,
      assetManifest,
      placementSeed: s >>> 0,
      cellSize,
      /* Desert has no building tile art — skip buildings so urban cobblestone
         footprints don't appear on sandy terrain. */
      numBuildings: spec.numBuildings ?? (profile.id === "desert" ? 0 : 1),
      maxObstacles: spec.maxObstacles ?? 12,
    });

    terrain = step3.terrain;
    if (
      !hasTwoVertexDisjointPathsWithObjects(
        terrain,
        tileTypes,
        step3.mapObjects,
        playerSpawns,
        enemySpawns,
      )
    ) {
      continue;
    }

    const skirmishDeploy = playerSpawns.map(([x, y]) => ({ x, y }));
    const presetEnemies = defaultPresetEnemies(width, height, terrain, tileTypes);
    const flowConnectors = buildFlowConnectorLayer(terrain, profile, assetManifest, theme);
    const bridgeCells = div.connectorLog
      .filter(
        (e) =>
          e &&
          ["water", "water_desert", "water_urban"].includes(e.before) &&
          e.fordStyle !== "natural" &&
          [profile.roadTerrain, "road", "cp_road"].includes(e.after),
      )
      .map((e) => ({ x: e.x, y: e.y }));

    /** @type {object} */
    const scenario = {
      id: `procedural_${theme}_${s}`,
      name: `Procedural ${biomeDisplayName(biome)} (${width}×${height})`,
      biome,
      width,
      height,
      cellSize,
      terrain,
      units: [],
      presetEnemies,
      skirmishDeploy,
      mapObjects: step3.mapObjects,
      buildings: step3.buildings,
      /* Top-level copy so renderers do not depend on nested generator (survives merges / tools). */
      bridgeCells,
      generator: {
        version: 1,
        seed: s,
        theme,
        biome,
        dividerConnectorCount: div.connectorLog.length,
        /** Cells where impassable divider was replaced with a road/ford (exact bridge positions). */
        connectorLog: div.connectorLog,
        flowConnectors,
      },
      winCondition: { type: "eliminate" },
      fogOfWar: false,
      ambientEffects: [
        {
          x: Math.max(1, Math.floor(width / 2) - 2),
          y: Math.max(1, Math.floor(height / 2)),
          spritePath: "assets/tiles/urban/fire_animation.png",
          frameCount: 8,
          fps: 10,
        },
        {
          x: Math.min(width - 2, Math.floor(width / 2) + 2),
          y: Math.max(1, Math.floor(height / 2)),
          spritePath: "assets/tiles/urban/fire_animation2.png",
          frameCount: 8,
          fps: 9,
        },
      ],
    };

    return scenario;
  }

  return null;
}

function defaultPlayerSpawns(w, h) {
  const ys = [1, 3, 5, Math.min(h - 2, 7)].filter((y) => y > 0 && y < h - 1);
  return ys.slice(0, 4).map((y) => [1, y]);
}

function defaultEnemySpawns(w, h) {
  const x = Math.max(2, w - 2);
  const ys = [2, 4, Math.min(h - 3, 6)].filter((y) => y > 0 && y < h - 1);
  return ys.slice(0, 3).map((y) => [x, y]);
}

function defaultPresetEnemies(w, h, terrain, tileTypes) {
  const grid = gridFromTerrain(terrain);
  const tryCell = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    if (moveCostAt(grid, tileTypes, x, y) >= 99) return null;
    if (terrain[y][x] === "building_block") return null;
    return { templateId: "grunt_red", owner: 1, x, y };
  };
  const out = [];
  const a = tryCell(w - 2, Math.max(1, Math.min(h - 2, Math.floor(h / 2))));
  if (a) out.push(a);
  const b = tryCell(w - 3, Math.max(1, Math.min(h - 2, 2)));
  if (b) out.push(b);
  if (!out.length) {
    const c = tryCell(w - 2, h - 2);
    if (c) out.push(c);
  }
  return out.length ? out : [{ templateId: "grunt_red", owner: 1, x: w - 2, y: 1 }];
}
