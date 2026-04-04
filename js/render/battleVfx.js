/**
 * Short-lived combat overlays (muzzle, etc.). Paths under attached_assets/vfx/.
 */
export class BattleVfx {
  constructor() {
    this.queue = [];
    this.cache = new Map();
  }

  getImage(filename) {
    if (!filename) return null;
    const path =
      filename.startsWith("attached_assets/")
        ? filename
        : `attached_assets/vfx/${filename}`;
    if (this.cache.has(path)) return this.cache.get(path);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = path;
    const entry = { img, ok: false };
    img.onload = () => {
      entry.ok = true;
    };
    img.onerror = () => {
      entry.ok = false;
    };
    this.cache.set(path, entry);
    return entry;
  }

  /**
   * @param {{ muzzle?: string, projectile?: string, durationMs?: number }} profile
   * @param {{ x: number, y: number }} attackerCell center in pixels (tile origin)
   * @param {{ x: number, y: number }} targetCell optional
   * @param {number} cellSize
   */
  spawnFromProfile(profile, attackerCell, targetCell, cellSize) {
    if (!profile || !profile.muzzle) return;
    const dur = profile.durationMs ?? 120;
    const t0 = performance.now();
    this.queue.push({
      type: "muzzle",
      file: profile.muzzle,
      cx: attackerCell.x + cellSize / 2,
      cy: attackerCell.y + cellSize / 2,
      t0,
      durationMs: dur,
    });
    if (profile.projectile && targetCell) {
      this.queue.push({
        type: "projectile",
        file: profile.projectile,
        x0: attackerCell.x + cellSize / 2,
        y0: attackerCell.y + cellSize / 2,
        x1: targetCell.x + cellSize / 2,
        y1: targetCell.y + cellSize / 2,
        t0,
        durationMs: Math.max(dur, 180),
      });
    }
  }

  draw(ctx, now) {
    this.queue = this.queue.filter((fx) => now - fx.t0 < fx.durationMs);
    for (const fx of this.queue) {
      const t = (now - fx.t0) / fx.durationMs;
      const e = Math.min(1, t);
      if (fx.type === "muzzle") {
        const entry = this.getImage(fx.file);
        if (!entry?.ok || !entry.img.naturalWidth) continue;
        const img = entry.img;
        const s = 48;
        ctx.save();
        ctx.globalAlpha = 1 - e * 0.4;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, fx.cx - s / 2, fx.cy - s / 2, s, s);
        ctx.restore();
      } else if (fx.type === "projectile") {
        const entry = this.getImage(fx.file);
        if (!entry?.ok || !entry.img.naturalWidth) continue;
        const x = fx.x0 + (fx.x1 - fx.x0) * e;
        const y = fx.y0 + (fx.y1 - fx.y0) * e;
        const s = 32;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(entry.img, x - s / 2, y - s / 2, s, s);
        ctx.restore();
      }
    }
  }
}
