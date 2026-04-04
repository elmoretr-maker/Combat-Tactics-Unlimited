/**
 * World-space VFX (explosion + smoke) drawn on the battle canvas after terrain/units.
 * Uses CraftPix PNG City explosions + PNG smoke sequences.
 */
const EXPLOSION_IDS = [1, 2, 3, 4, 5, 6];
const SMOKE_VARIANTS = [
  "attached_assets/craftpix_pack/effects/PNG smoke/smoke_middle_gray/smoke1",
  "attached_assets/craftpix_pack/effects/PNG smoke/smoke_dark_gray/smoke1",
  "attached_assets/craftpix_pack/effects/PNG smoke/smoke_bright_gray/smoke1",
  "attached_assets/craftpix_pack/effects/PNG smoke/smoke_brown/smoke1",
];

export class FxLayer {
  constructor() {
    /** @type {{ cx: number, cy: number, frames: string[], t0: number, dur: number, scale: number, alphaMul?: number }[]} */
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
    const expId =
      EXPLOSION_IDS[Math.floor(Math.random() * EXPLOSION_IDS.length)] || 1;
    const expBase = `attached_assets/craftpix_pack/city/PNG City/Explosion${expId}`;
    const expFrames = [];
    for (let i = 1; i <= 10; i++) {
      expFrames.push(`${expBase}/Explosion${expId}_${i}.png`);
    }
    const smokeRoot =
      SMOKE_VARIANTS[Math.floor(Math.random() * SMOKE_VARIANTS.length)] ||
      SMOKE_VARIANTS[0];
    const smokeFrames = [];
    for (let i = 1; i <= 7; i++) {
      smokeFrames.push(`${smokeRoot}/smoke1_${i}.png`);
    }
    const scale = Math.max(0.6, (cellSize / 48) * 0.85);
    const shadowFrames = [];
    for (let i = 1; i <= 10; i++) {
      shadowFrames.push(
        `attached_assets/craftpix_pack/city/PNG City/Shadows/Explosion${expId}_${i}.png`
      );
    }
    this.bursts.push({
      cx: cx + 1,
      cy: cy + cellSize * 0.1,
      frames: shadowFrames,
      t0: performance.now(),
      dur: 520,
      scale: scale * 0.92,
      alphaMul: 0.42,
    });
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
      ctx.globalAlpha = (1 - t * 0.15) * (b.alphaMul ?? 1);
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
