/**
 * World-space VFX (explosion + smoke) drawn on the battle canvas after terrain/units.
 * Uses CraftPix PNG City explosions + PNG smoke sequences.
 */
const EXP_BASE =
  "attached_assets/craftpix_pack/city/PNG City/Explosion1";
const SMOKE_BASE =
  "attached_assets/craftpix_pack/effects/PNG smoke/smoke_middle_gray/smoke1";

export class FxLayer {
  constructor() {
    /** @type {{ cx: number, cy: number, frames: string[], t0: number, dur: number, scale: number }[]} */
    this.bursts = [];
    this._cache = new Map();
  }

  _img(path) {
    if (this._cache.has(path)) return this._cache.get(path);
    const img = new Image();
    img.src = path;
    const e = { img, ok: false };
    img.onload = () => {
      e.ok = true;
    };
    img.onerror = () => {
      e.ok = false;
    };
    this._cache.set(path, e);
    return e;
  }

  explosionAndSmoke(cx, cy, cellSize) {
    const expFrames = [];
    for (let i = 1; i <= 10; i++) {
      expFrames.push(`${EXP_BASE}/Explosion1_${i}.png`);
    }
    const smokeFrames = [];
    for (let i = 1; i <= 7; i++) {
      smokeFrames.push(`${SMOKE_BASE}/smoke1_${i}.png`);
    }
    const scale = Math.max(0.6, (cellSize / 48) * 0.85);
    this.bursts.push({
      cx,
      cy,
      frames: expFrames,
      t0: performance.now(),
      dur: 520,
      scale,
    });
    this.bursts.push({
      cx,
      cy: cy + cellSize * 0.08,
      frames: smokeFrames,
      t0: performance.now() + 180,
      dur: 640,
      scale: scale * 1.1,
    });
  }

  draw(ctx, timeMs) {
    if (!this.bursts.length) return;
    const now = timeMs ?? performance.now();
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const keep = [];
    for (const b of this.bursts) {
      const elapsed = now - b.t0;
      if (elapsed < 0) {
        keep.push(b);
        continue;
      }
      const t = Math.min(1, elapsed / b.dur);
      if (t >= 1) continue;
      const fi = Math.min(b.frames.length - 1, Math.floor(t * b.frames.length));
      const path = b.frames[fi];
      const entry = this._img(path);
      const img = entry.img;
      if (!entry.ok || !img.naturalWidth) {
        keep.push(b);
        continue;
      }
      const w = img.naturalWidth * b.scale;
      const h = img.naturalHeight * b.scale;
      ctx.globalAlpha = 1 - t * 0.15;
      ctx.drawImage(img, b.cx - w / 2, b.cy - h / 2, w, h);
      keep.push(b);
    }
    this.bursts = keep;
    ctx.restore();
  }

  clear() {
    this.bursts = [];
  }
}
