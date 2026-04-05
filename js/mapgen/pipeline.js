/**
 * Full procedural pipeline: Foundation → Divider rule → Tactical assets → scenario JSON.
 */

import { moveCostAt } from "../engine/terrain.js";
import { generateFoundation } from "./foundation.js";
import { applyDividerRule, buildFlowConnectorLayer } from "./dividerRule.js";
import { computeProtectedRibbon } from "./corridor.js";
import { placeTacticalAssets } from "./tacticalAssets.js";
import { mulberry32 } from "./rng.js";
import { hasTwoVertexDisjointPathsWithObjects } from "./dividerRule.js";
import { gridFromTerrain } from "./gridCost.js";

/**
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} spec.seed
 * @param {"urban"|"desert"|"grass"} spec.theme
 * @param {Record<string, object>} spec.tileTypes — tileTextures.types only
 * @param {object|null|undefined} [spec.assetManifest] from assetManifest.json
 * @param {boolean} [spec.addRiverStrip]
 * @param {number} [spec.maxGenerationAttempts] default 6
 */
export function generateProceduralScenario(spec) {
  const {
    width,
    height,
    seed,
    theme,
    tileTypes,
    assetManifest = null,
    addRiverStrip = true,
    maxGenerationAttempts = 6,
  } = spec;

  const cellSize = spec.cellSize ?? 48;

  for (let attempt = 0; attempt < maxGenerationAttempts; attempt++) {
    const s = (seed + attempt * 0x9e3779b9) >>> 0;
    const { terrain: t0, profile } = generateFoundation({
      width,
      height,
      seed: s,
      theme,
      addRiverStrip,
      assetManifest,
    });

    const playerSpawns = defaultPlayerSpawns(width, height);
    const enemySpawns = defaultEnemySpawns(width, height);

    const div = applyDividerRule(
      t0,
      tileTypes,
      playerSpawns,
      enemySpawns,
      {
        dividerTypes: profile.dividerTypes,
        connectorTerrain: profile.roadTerrain,
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
      numBuildings: spec.numBuildings ?? 1,
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

    /** @type {object} */
    const scenario = {
      id: `procedural_${theme}_${s}`,
      name: `Procedural ${theme} (${width}×${height})`,
      width,
      height,
      cellSize,
      terrain,
      units: [],
      presetEnemies,
      skirmishDeploy,
      mapObjects: step3.mapObjects,
      buildings: step3.buildings,
      generator: {
        version: 1,
        seed: s,
        theme,
        dividerConnectorCount: div.connectorLog.length,
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
