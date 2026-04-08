/** Milliseconds to play one full attack clip (wind-up before damage). */
export function attackVisualDurationMs(spriteAnimations, setId) {
  const cfg = spriteAnimations?.[setId];
  if (!cfg) return 0;
  if (cfg.treadVehicle) {
    const n = cfg.frameCounts?.shot ?? 0;
    if (n <= 0) return 0;
    const spd = 95;
    return n * spd;
  }
  const ac = cfg.attackClip;
  if (ac && (cfg.frameCounts?.[ac] ?? 0) > 0) {
    const n = cfg.frameCounts[ac];
    const spd = 220;
    return n * spd;
  }
  return 0;
}

/**
 * Top-down composite with hull plus a separate turret and/or barrel layer.
 * Those layers rotate for cursor aim; hull follows move / idle facing.
 * Set `compositeTopdown.independentTurret: false` to keep a single rigid sprite.
 * @param {object | null | undefined} comp
 */
export function compositeUsesIndependentTurret(comp) {
  if (!comp?.hull) return false;
  if (comp.independentTurret === false) return false;
  return !!(comp.turret || comp.barrel);
}

export class UnitRenderer {
  constructor(spriteAnimations) {
    this.spriteAnimations = spriteAnimations;
    this.cache = new Map();
  }

  resolveFramePath(setId, clip, index, facing) {
    const cfg = this.spriteAnimations[setId];
    const clips = cfg?.craftpixClips;
    if (clips) {
      const dirKey =
        facing && ["up", "down", "left", "right"].includes(facing)
          ? `${clip}_${facing}`
          : null;
      const arr =
        (dirKey && clips[dirKey]?.length ? clips[dirKey] : null) ||
        clips[clip] ||
        clips.idle ||
        [];
      if (!arr.length) return "";
      const i = Math.min(index, arr.length - 1);
      return arr[i];
    }
    return `attached_assets/sprites/${setId}/${clip}/${index}.png`;
  }

  framePath(setId, clip, index, facing) {
    return this.resolveFramePath(setId, clip, index, facing);
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
    const legacyFire =
      unit._fireVisualUntil && performance.now() < unit._fireVisualUntil;
    const attacking =
      unit.state === "attack" || (legacyFire && unit.state !== "move");

    if (cfg?.treadVehicle) {
      if (attacking && (cfg.frameCounts?.shot ?? 0) > 0) return "shot";
      return "run";
    }
    if (isMoving || unit.state === "move") return "run";
    if (unit.prone && cfg?.specialAbility === "prone" && attacking) {
      return "shot";
    }
    if (
      unit.prone &&
      cfg?.specialAbility === "prone" &&
      (cfg.frameCounts?.prone ?? 0) > 0
    ) {
      return "prone";
    }
    if (attacking && cfg?.attackClip) {
      const ac = cfg.attackClip;
      if ((cfg.frameCounts?.[ac] ?? 0) > 0) return ac;
    }
    return "idle";
  }

  frameIndex(setId, clip, timeMs, isMoving, unit) {
    const cfg = this.spriteAnimations[setId];
    if (cfg?.treadVehicle) {
      if (clip === "dead") return 0;
      if (clip === "shot") {
        const n = cfg.frameCounts?.shot ?? 1;
        const spd = 95;
        return Math.floor(timeMs / spd) % n;
      }
      const n = cfg.frameCounts?.run ?? 1;
      const animateRun = isMoving || unit?.state === "move";
      if (!animateRun) return 0;
      const spd = 70;
      return Math.floor(timeMs / spd) % n;
    }
    if (!cfg) return 0;
    const n = (cfg.frameCounts && cfg.frameCounts[clip]) || 1;
    /* Slower run = readable walk cycle (tread vehicles use branch above). */
    const spd =
      clip === "run" ? 118 : clip === "prone" ? 140 : 220;
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

  /**
   * True when craftpix has `clip_facing` frames (art already oriented); skip down-default spin.
   */
  hasDirectedSideClip(cfg, diskClip, facing) {
    const clips = cfg?.craftpixClips;
    if (!clips || !facing) return false;
    const k = `${diskClip}_${facing}`;
    return Array.isArray(clips[k]) && clips[k].length > 0;
  }

  /**
   * Legacy side sprites face **down** (+y). Rotate into grid facings (right/up/left).
   */
  applySideFacingRotation(ctx, cfg, diskClip, facing) {
    const f = facing || "down";
    if (
      cfg &&
      this.hasDirectedSideClip(cfg, diskClip, f)
    ) {
      return false;
    }
    if (f === "right") ctx.rotate(-Math.PI / 2);
    else if (f === "left") ctx.rotate(Math.PI / 2);
    else if (f === "up") ctx.rotate(Math.PI);
    return true;
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

  /**
   * Modular top-down vehicle: hull + turret + barrel from separate PNGs
   * (see `compositeTopdown` in spriteAnimations.json). Optional `comp.vfx` layers
   * reuse attached_assets effect strips (glow orbs) as muzzle / motion / wreck FX —
   * those files are not the vehicle silhouette.
   * @param {object} [vfxOpts]
   * @param {number} [vfxOpts.frameIndex]
   * @param {boolean} [vfxOpts.isMoving]
   */
  drawCompositeTopdown(ctx, comp, cellSize, clip, vfxOpts = {}) {
    const base = cellSize * 1.08;
    const {
      frameIndex = 0,
      isMoving = false,
      turretOffsetRad = 0,
    } = vfxOpts;
    const splitTurret = compositeUsesIndependentTurret(comp);

    const drawLayer = (path, scaleMul = 1, offsetYFrac = 0) => {
      if (!path) return false;
      const entry = this.getImage(path);
      const img = entry.img;
      if (!entry.ok || !img.complete || !img.naturalWidth) return false;
      const scale =
        (base * scaleMul) / Math.max(img.naturalWidth, img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      const oy = offsetYFrac * cellSize;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, -w / 2, -h / 2 + oy, w, h);
      return true;
    };

    const dead = clip === "dead";
    const vfx = comp.vfx;

    if (dead) {
      drawLayer(comp.hull, comp.hullScale ?? 1, comp.hullOffsetY ?? 0);
      if (vfx?.destroyed) {
        const prevA = ctx.globalAlpha;
        ctx.globalAlpha = Math.min(1, prevA + (comp.vfxDestroyedAlphaBoost ?? 0.35));
        drawLayer(
          vfx.destroyed,
          comp.vfxDestroyedScale ?? 1.2,
          comp.vfxDestroyedOffsetY ?? 0,
        );
        ctx.globalAlpha = prevA;
      }
      return;
    }

    drawLayer(comp.hull, comp.hullScale ?? 1, comp.hullOffsetY ?? 0);

    const drawTurretStack = () => {
      drawLayer(comp.turret, comp.turretScale ?? 1, comp.turretOffsetY ?? 0);
      if (comp.barrel) {
        drawLayer(comp.barrel, comp.barrelScale ?? 1, comp.barrelOffsetY ?? 0);
      }
    };

    if (splitTurret) {
      ctx.save();
      ctx.rotate(turretOffsetRad);
      drawTurretStack();
      if (vfx && clip === "shot" && vfx.shot?.length) {
        const i = Math.max(0, Math.min(vfx.shot.length - 1, frameIndex));
        const blend = comp.vfxShotBlend || "lighter";
        const prev = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = blend;
        drawLayer(
          vfx.shot[i],
          comp.vfxShotScale ?? 0.95,
          comp.vfxShotOffsetY ?? -0.36,
        );
        ctx.globalCompositeOperation = prev;
      }
      ctx.restore();
      if (!vfx) return;
      if (clip === "run" && isMoving && vfx.run?.length) {
        const i = Math.max(0, Math.min(vfx.run.length - 1, frameIndex));
        drawLayer(
          vfx.run[i],
          comp.vfxRunScale ?? 0.72,
          comp.vfxRunOffsetY ?? 0.06,
        );
      }
      return;
    }

    drawTurretStack();

    if (!vfx) return;

    if (clip === "shot" && vfx.shot?.length) {
      const i = Math.max(0, Math.min(vfx.shot.length - 1, frameIndex));
      const blend = comp.vfxShotBlend || "lighter";
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = blend;
      drawLayer(
        vfx.shot[i],
        comp.vfxShotScale ?? 0.95,
        comp.vfxShotOffsetY ?? -0.36,
      );
      ctx.globalCompositeOperation = prev;
    } else if (clip === "run" && isMoving && vfx.run?.length) {
      const i = Math.max(0, Math.min(vfx.run.length - 1, frameIndex));
      drawLayer(
        vfx.run[i],
        comp.vfxRunScale ?? 0.72,
        comp.vfxRunOffsetY ?? 0.06,
      );
    }
  }

  drawUnit(ctx, unit, px, py, cellSize, timeMs, isMoving, facingLeft, faceRad) {
    const setId = unit.mapSpriteSet;
    const mode = unit.mapRenderMode || "side";
    const clip = this.pickClip(unit, isMoving);
    const fi = this.frameIndex(setId, clip, timeMs, isMoving, unit);
    const diskClip = this.storageClip(setId, clip);
    const cfg = setId ? this.spriteAnimations[setId] : null;
    const cfgSheet = cfg?.spriteSheet ?? null;
    const path = setId ? this.framePath(setId, diskClip, fi, unit.facing) : "";
    const bob = mode === "side" ? Math.sin(timeMs / 300) * (isMoving ? 3 : 1.5) : 0;
    const cx = px + cellSize / 2;
    const cy = py + cellSize / 2 + bob;
    ctx.save();
    ctx.translate(cx, cy);
    /* Tactical underlay — separates unit from busy battle mats */
    const half = cellSize * 0.45;
    const sy = half * 0.52;
    const rg = ctx.createRadialGradient(0, sy, 0, 0, sy, half * 1.05);
    rg.addColorStop(0, "rgba(0,0,0,0.38)");
    rg.addColorStop(0.55, "rgba(0,0,0,0.18)");
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.ellipse(0, sy, half * 0.92, half * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    if (mode === "topdown" && typeof faceRad === "number") {
      /* Hull/turret PNGs face **up** (−y); map grid facings (faceRad) onto that default. */
      const adj =
        typeof unit.topdownFacingAdjustRad === "number"
          ? unit.topdownFacingAdjustRad
          : 0;
      ctx.rotate(faceRad + Math.PI / 2 + adj);
    } else if (mode === "side") {
      const usedSpin = this.applySideFacingRotation(
        ctx,
        cfg,
        diskClip,
        unit.facing,
      );
      if (!usedSpin && facingLeft) {
        ctx.scale(-1, 1);
      }
    } else if (facingLeft) {
      ctx.scale(-1, 1);
    }

    const compositeTopdown = setId
      ? this.spriteAnimations[setId]?.compositeTopdown
      : null;
    if (mode === "topdown" && compositeTopdown) {
      if (clip === "dead" && this.spriteAnimations[setId]?.treadVehicle) {
        ctx.globalAlpha = 0.55;
      }
      this.drawCompositeTopdown(ctx, compositeTopdown, cellSize, clip, {
        frameIndex: fi,
        isMoving,
        turretOffsetRad: unit.turretOffsetRad ?? 0,
      });
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }

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
    const colsCfg = cfgSheet?.columns;
    const hasColGrid =
      cfgSheet?.atlas &&
      (typeof colsCfg === "number" && colsCfg > 0
        ? true
        : typeof cfgSheet.frameW === "number" &&
          cfgSheet.frameW > 0 &&
          typeof cfgSheet.frameH === "number" &&
          cfgSheet.frameH > 0);
    if (hasColGrid) {
      const atlasPath = cfgSheet.atlas;
      const entryS = this.getImage(atlasPath);
      const imgS = entryS.img;
      if (entryS.ok && imgS.complete && imgS.naturalWidth) {
        const colsDef = colsCfg;
        let fw =
          typeof cfgSheet.frameW === "number" && cfgSheet.frameW > 0
            ? cfgSheet.frameW
            : 0;
        let fh =
          typeof cfgSheet.frameH === "number" && cfgSheet.frameH > 0
            ? cfgSheet.frameH
            : 0;
        if (colsDef && colsDef > 0 && (!fw || fw <= 0)) {
          fw = Math.max(1, Math.floor(imgS.naturalWidth / colsDef));
        }
        if (!fh || fh <= 0) {
          fh = imgS.naturalHeight;
        }
        const cols =
          colsDef && colsDef > 0
            ? colsDef
            : Math.max(1, Math.floor(imgS.naturalWidth / Math.max(1, fw)));
        const rows =
          cfgSheet.rows ?? Math.max(1, Math.floor(imgS.naturalHeight / fh));
        const total = cols * rows;
        const idx = total > 0 ? fi % total : 0;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const scale =
          (cellSize * 1.1) / Math.max(fw, fh);
        const w = fw * scale;
        const h = fh * scale;
        ctx.imageSmoothingEnabled = false;
        if (clip === "dead" && this.spriteAnimations[setId]?.treadVehicle) {
          ctx.globalAlpha = 0.55;
        }
        ctx.drawImage(
          imgS,
          col * fw,
          row * fh,
          fw,
          fh,
          -w / 2,
          -h / 2,
          w,
          h,
        );
        ctx.restore();
        return;
      }
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
