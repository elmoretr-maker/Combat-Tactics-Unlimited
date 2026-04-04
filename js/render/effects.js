/**
 * Ambient battlefield loops (fire / smoke strips) — time-driven, independent of unit movement.
 */

const _stripCache = new Map();

function getStrip(path) {
  if (!path) return null;
  if (_stripCache.has(path)) return _stripCache.get(path);
  const img = new Image();
  const entry = { img, ok: false, path };
  img.onload = () => {
    entry.ok = true;
  };
  img.onerror = () => {
    entry.ok = false;
  };
  img.src = path;
  _stripCache.set(path, entry);
  return entry;
}

/**
 * @param {object} opts
 * @param {string} opts.spritePath repo-relative URL
 * @param {number} [opts.frameCount] columns in horizontal strip (default 8)
 * @param {number} [opts.fps] default 10
 */
export function createStripLoop(opts) {
  const frameCount = Math.max(1, opts.frameCount ?? 8);
  const fps = Math.max(1, opts.fps ?? 10);
  const path = opts.spritePath;
  return {
    path,
    frameCount,
    fps,
    /** @param {number} timeMs */
    frameIndex(timeMs) {
      const frameMs = 1000 / fps;
      return Math.floor(timeMs / frameMs) % frameCount;
    },
    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} destX
     * @param {number} destY
     * @param {number} destW
     * @param {number} destH
     * @param {number} timeMs
     */
    draw(ctx, destX, destY, destW, destH, timeMs) {
      const entry = getStrip(path);
      if (!entry?.ok || !entry.img.naturalWidth) return;
      const img = entry.img;
      const fw = Math.floor(img.naturalWidth / frameCount);
      const fh = img.naturalHeight;
      if (fw < 1 || fh < 1) return;
      const fi = this.frameIndex(timeMs);
      const sx = fi * fw;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, sx, 0, fw, fh, destX, destY, destW, destH);
      ctx.restore();
    },
  };
}

/**
 * Manager for several ambient strips at grid cells.
 */
export class BattleAmbientEffects {
  constructor() {
    /** @type {{ x: number, y: number, loop: ReturnType<typeof createStripLoop>, cellSize: number }[]} */
    this.placements = [];
  }

  /**
   * @param {Array<{ x: number, y: number, spritePath: string, frameCount?: number, fps?: number }>} defs
   * @param {number} cellSize
   */
  setFromDefs(defs, cellSize) {
    this.placements = [];
    if (!defs?.length) return;
    for (const d of defs) {
      if (!d.spritePath) continue;
      this.placements.push({
        x: d.x,
        y: d.y,
        cellSize,
        loop: createStripLoop({
          spritePath: d.spritePath,
          frameCount: d.frameCount,
          fps: d.fps,
        }),
      });
    }
  }

  clear() {
    this.placements = [];
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} offsetX grid pixel origin
   * @param {number} offsetY
   * @param {number} timeMs
   */
  draw(ctx, offsetX, offsetY, timeMs) {
    for (const p of this.placements) {
      const cs = p.cellSize;
      const px = offsetX + p.x * cs + cs * 0.15;
      const py = offsetY + p.y * cs + cs * 0.1;
      const w = cs * 0.7;
      const h = cs * 0.75;
      p.loop.draw(ctx, px, py, w, h, timeMs);
    }
  }
}

/** Single layer instance — placements synced from scenario in main.js `bootBattle`. */
export const sharedBattleAmbient = new BattleAmbientEffects();
