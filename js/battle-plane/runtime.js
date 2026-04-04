/**
 * Single integration surface for main.js — keeps battle-plane logic out of the hot path
 * when `battlePlaneLayer.enabled` is false.
 *
 * Move tweens and ambient strip loops (`render/tween.js`, `render/effects.js`) are applied
 * from `main.js` so legacy and plane-stack battles share one draw order: mat → grid → ambients → props → units.
 */
import { BattlePlaneManager, isBattlePlaneEnabled } from "./planeManager.js";
import { generateBattleObstacles } from "./scatterObstacles.js";
import { drawMapObjects } from "../render/mapObjectLayer.js";

export { isBattlePlaneEnabled };

/**
 * @param {import("../engine/gameState.js").GameState} game
 * @param {object} tileTypes
 * @returns {Promise<{ drawBackground: Function, drawProps: Function, dispose: Function } | null>}
 */
export async function createBattlePlaneController(game, tileTypes) {
  if (!isBattlePlaneEnabled(game.scenario)) return null;

  const mgr = new BattlePlaneManager(game.scenario);
  await mgr.loadPlane();

  if (game.scenario.proceduralBoard?.enabled) {
    generateBattleObstacles(
      game.scenario,
      game.grid,
      tileTypes,
      game.mapObjects,
    );
  }

  return {
    drawBackground(ctx, offsetX, offsetY) {
      const cs = game.grid.cellSize;
      const w = game.grid.width * cs;
      const h = game.grid.height * cs;
      mgr.drawMatAndOverlay(ctx, offsetX, offsetY, w, h);
    },

    drawProps(ctx, offsetX, offsetY) {
      drawMapObjects(ctx, game, offsetX, offsetY);
    },

    dispose() {
      /* image caches are global; nothing to tear down */
    },
  };
}
