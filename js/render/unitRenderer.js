export class UnitRenderer {
  constructor(spriteAnimations) {
    this.spriteAnimations = spriteAnimations;
    this.cache = new Map();
  }

  resolveFramePath(setId, clip, index) {
    const cfg = this.spriteAnimations[setId];
    const clips = cfg?.craftpixClips;
    if (clips) {
      const arr = clips[clip] || clips.idle || [];
      if (!arr.length) return "";
      const i = Math.min(index, arr.length - 1);
      return arr[i];
    }
    return `attached_assets/sprites/${setId}/${clip}/${index}.png`;
  }

  framePath(setId, clip, index) {
    return this.resolveFramePath(setId, clip, index);
  }

  getImage(path) {
    if (!path) return { img: new Image(), ok: false };
    if (this.cache.has(path)) return this.cache.get(path);
    const img = new Image();
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

  pickClip(unit, isMoving) {
    if (unit.hp <= 0) return "dead";
    const cfg = this.spriteAnimations[unit.mapSpriteSet];
    const firing =
      unit._fireVisualUntil && performance.now() < unit._fireVisualUntil;

    if (cfg?.treadVehicle) {
      if (firing && (cfg.frameCounts?.shot ?? 0) > 0) return "shot";
      return "run";
    }
    if (isMoving) return "run";
    if (unit.prone && cfg?.specialAbility === "prone" && firing) {
      return "shot";
    }
    if (
      unit.prone &&
      cfg?.specialAbility === "prone" &&
      (cfg.frameCounts?.prone ?? 0) > 0
    ) {
      return "prone";
    }
    if (firing && cfg?.attackClip) {
      const ac = cfg.attackClip;
      if ((cfg.frameCounts?.[ac] ?? 0) > 0) return ac;
    }
    return "idle";
  }

  frameIndex(setId, clip, timeMs, isMoving) {
    const cfg = this.spriteAnimations[setId];
    if (cfg?.treadVehicle) {
      if (clip === "dead") return 0;
      if (clip === "shot") {
        const n = cfg.frameCounts?.shot ?? 1;
        const spd = 95;
        return Math.floor(timeMs / spd) % n;
      }
      const n = cfg.frameCounts?.run ?? 1;
      if (!isMoving) return 0;
      const spd = 70;
      return Math.floor(timeMs / spd) % n;
    }
    if (!cfg) return 0;
    const n = (cfg.frameCounts && cfg.frameCounts[clip]) || 1;
    const spd = clip === "run" ? 80 : clip === "prone" ? 140 : 220;
    return Math.floor(timeMs / spd) % n;
  }

  /** Map logical clip to folder name (tread vehicles use `run` for dead frame). */
  storageClip(setId, clip) {
    const cfg = this.spriteAnimations[setId];
    if (cfg?.treadVehicle && clip === "dead") return "run";
    return clip;
  }

  portraitSrc(unit) {
    if (!unit?.portrait) return "";
    return `attached_assets/units/${unit.portrait}`;
  }

  drawPortraitFallback(ctx, unit, half, cellSize) {
    const src = this.portraitSrc(unit);
    if (!src) return false;
    const entry = this.getImage(src);
    const img = entry.img;
    if (!entry.ok || !img.complete || !img.naturalWidth) return false;
    const scale = (cellSize * 0.92) / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return true;
  }

  drawPlaceholderBlock(ctx, unit, half) {
    ctx.fillStyle = unit.owner === 0 ? "#6b8cae" : "#c45c5c";
    ctx.fillRect(-half, -half * 0.7, half * 2, half * 1.4);
  }

  drawUnit(ctx, unit, px, py, cellSize, timeMs, isMoving, facingLeft, faceRad) {
    const setId = unit.mapSpriteSet;
    const mode = unit.mapRenderMode || "side";
    const clip = this.pickClip(unit, isMoving);
    const fi = this.frameIndex(setId, clip, timeMs, isMoving);
    const diskClip = this.storageClip(setId, clip);
    const path = setId ? this.framePath(setId, diskClip, fi) : "";
    const bob = mode === "side" ? Math.sin(timeMs / 300) * (isMoving ? 3 : 1.5) : 0;
    const cx = px + cellSize / 2;
    const cy = py + cellSize / 2 + bob;
    ctx.save();
    ctx.translate(cx, cy);
    if (mode === "topdown" && typeof faceRad === "number") {
      ctx.rotate(faceRad - Math.PI / 2);
    } else if (facingLeft) {
      ctx.scale(-1, 1);
    }
    const half = cellSize * 0.45;
    if (!setId) {
      if (!this.drawPortraitFallback(ctx, unit, half, cellSize)) {
        ctx.fillStyle = unit.owner === 0 ? "#5cadff" : "#ff6b6b";
        ctx.beginPath();
        ctx.arc(0, 0, half * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const entry = this.getImage(path);
    const img = entry.img;
    if (entry.ok && img.complete && img.naturalWidth) {
      const scale = (cellSize * 1.1) / Math.max(img.naturalWidth, img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.imageSmoothingEnabled = false;
      if (clip === "dead" && this.spriteAnimations[setId]?.treadVehicle) {
        ctx.globalAlpha = 0.55;
      }
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      if (!this.drawPortraitFallback(ctx, unit, half, cellSize)) {
        this.drawPlaceholderBlock(ctx, unit, half);
      }
    }
    ctx.restore();
  }
}
