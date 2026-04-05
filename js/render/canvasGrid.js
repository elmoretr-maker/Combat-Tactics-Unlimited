import { terrainColor } from "../engine/terrain.js";

/*
 * TILE MANIFEST
 * Maps each terrain type to a list of tile_NNN.png indices.
 * The renderer picks among them deterministically (no random each frame)
 * using the cell position as a seed, so the map looks varied but stable.
 *
 * Adjust indices here if you want different tiles for a terrain type.
 * See attached_assets/tiles/ for all tile_000 – tile_257 images.
 *
 * Key visual tile groups (from the provided tileset):
 *  0        = pure water (sky blue)
 *  1        = grass/plains base
 *  9-11     = water centre variants
 *  14,18,26 = desert/scrubland
 *  19-21    = dense forest/brush
 *  22,28    = rocky hill
 *  25,27    = desert decorations (cactus, palm)
 *  30-32    = grass with wildflowers
 *  94-97    = stone/dirt (road)
 * 118-121   = brick/cobblestone (urban)
 * 129-132   = snow / light ground
 */
const TILE_MAP = {
  plains:  [1, 1, 1, 30, 1, 31, 1, 1, 32, 1, 30],
  water:   [0, 0, 9, 0, 0, 10, 0, 11, 0],
  forest:  [19, 20, 21, 19, 20, 21],
  hill:    [22, 28, 22, 28],
  road:    [94, 95, 96, 97],
  urban:   [118, 119, 120, 121],
  desert:  [14, 26, 14, 18, 26, 25, 14, 27],
  snow:    [129, 130, 131, 132],
};

/* ── Image cache ──────────────────────────────────────────── */
const _tileImgCache = new Map();
const _craftpixTileCache = new Map();

function getCraftpixTileImage(url) {
  if (!url) return null;
  if (_craftpixTileCache.has(url)) return _craftpixTileCache.get(url);
  const img = new Image();
  img.src = url;
  const entry = { img, ok: false };
  img.onload = () => {
    entry.ok = true;
  };
  img.onerror = () => {
    entry.ok = false;
  };
  _craftpixTileCache.set(url, entry);
  return entry;
}

function getTileImage(idx) {
  const k = `tile_${String(idx).padStart(3, "0")}`;
  if (_tileImgCache.has(k)) return _tileImgCache.get(k);
  const img = new Image();
  /* omit crossOrigin — matches unit/portrait loading for local/file use */
  img.src = `attached_assets/tiles/${k}.png`;
  const entry = { img, ok: false };
  img.onload  = () => { entry.ok = true; };
  img.onerror = () => { entry.ok = false; };
  _tileImgCache.set(k, entry);
  return entry;
}

/** Deterministically pick a tile index for this cell (no per-frame randomness). */
function pickTileIdx(terrainType, gx, gy) {
  const arr = TILE_MAP[terrainType];
  if (!arr || !arr.length) return null;
  return arr[Math.abs(gx * 7 + gy * 13) % arr.length];
}

/* ── Programmatic fallback decorations ───────────────────── */
const TERRAIN_DRAW_FALLBACK = {
  plains(ctx, x, y, cs) {
    ctx.strokeStyle = "rgba(100,180,100,0.35)";
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 4; i++) {
      const gx = x + cs * (0.18 + i * 0.2);
      const gy = y + cs * 0.68;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx - 2, gy - cs * 0.18);
      ctx.lineTo(gx + 2, gy - cs * 0.18);
      ctx.stroke();
    }
  },
  forest(ctx, x, y, cs) {
    const cx = x + cs / 2, cy = y + cs / 2;
    ctx.fillStyle = "rgba(30,100,45,0.7)";
    const sz = cs * 0.28;
    for (let d = 0; d < 3; d++) {
      const ox = d === 0 ? 0 : d === 1 ? -cs * 0.2 : cs * 0.2;
      const oy = d === 0 ? -cs * 0.15 : cs * 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy + oy - sz);
      ctx.lineTo(cx + ox - sz * 0.9, cy + oy + sz * 0.55);
      ctx.lineTo(cx + ox + sz * 0.9, cy + oy + sz * 0.55);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "rgba(80,50,25,0.5)";
    ctx.fillRect(cx - 2, cy + cs * 0.22, 4, cs * 0.15);
  },
  hill(ctx, x, y, cs) {
    const cx = x + cs / 2, cy = y + cs / 2;
    ctx.strokeStyle = "rgba(140,130,90,0.55)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const r = cs * (0.15 + i * 0.1);
      ctx.beginPath();
      ctx.arc(cx, cy + cs * 0.1, r, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
  },
  road(ctx, x, y, cs) {
    ctx.fillStyle = "rgba(200,180,140,0.3)";
    ctx.fillRect(x + cs * 0.35, y, cs * 0.3, cs);
    ctx.setLineDash([cs * 0.12, cs * 0.1]);
    ctx.strokeStyle = "rgba(240,220,160,0.4)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + cs / 2, y);
    ctx.lineTo(x + cs / 2, y + cs);
    ctx.stroke();
    ctx.setLineDash([]);
  },
  water(ctx, x, y, cs) {
    ctx.strokeStyle = "rgba(130,200,255,0.45)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const wy = y + cs * (0.28 + i * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + 4, wy);
      for (let wx = x + 4; wx < x + cs - 4; wx += 6) {
        ctx.quadraticCurveTo(wx + 3, wy - 3, wx + 6, wy);
      }
      ctx.stroke();
    }
  },
  urban(ctx, x, y, cs) {
    ctx.strokeStyle = "rgba(180,180,200,0.4)";
    ctx.lineWidth = 0.8;
    const bsz = cs * 0.2;
    const pad = cs * 0.15;
    for (let bi = 0; bi < 2; bi++) {
      for (let bj = 0; bj < 2; bj++) {
        const bx = x + pad + bi * (bsz + pad * 0.6);
        const by = y + pad + bj * (bsz + pad * 0.6);
        ctx.strokeRect(bx, by, bsz, bsz);
        ctx.beginPath();
        ctx.moveTo(bx + bsz * 0.45, by);
        ctx.lineTo(bx + bsz * 0.45, by + bsz);
        ctx.stroke();
      }
    }
  },
  desert(ctx, x, y, cs) {
    ctx.strokeStyle = "rgba(200,170,80,0.4)";
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 5; i++) {
      const dx = x + cs * (0.1 + (i % 3) * 0.3 + (i > 2 ? 0.15 : 0));
      const dy = y + cs * (0.25 + Math.floor(i / 3) * 0.45);
      ctx.beginPath();
      ctx.arc(dx, dy, cs * 0.04, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  snow(ctx, x, y, cs) {
    ctx.fillStyle = "rgba(220,235,255,0.5)";
    for (let i = 0; i < 6; i++) {
      const sx = x + cs * (0.12 + (i % 3) * 0.35);
      const sy = y + cs * (0.2 + Math.floor(i / 3) * 0.55);
      ctx.beginPath();
      ctx.arc(sx, sy, cs * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};

function drawTerrainFallback(ctx, terrainType, x, y, cs) {
  const fn = TERRAIN_DRAW_FALLBACK[terrainType];
  if (!fn) return;
  ctx.save();
  fn(ctx, x, y, cs);
  ctx.restore();
}

/* ── Main grid draw function ─────────────────────────────── */
export function drawGrid(ctx, game, tileTypes, options) {
  const g  = game.grid;
  const cs = g.cellSize;
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;
  const planeStack = options.stackMode === "plane";
  ctx.save();
  ctx.translate(ox, oy);

  /* ── Pass 1: tile fills (edge-to-edge, no inset/padding) ── */
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const t  = g.cells[y][x];
      /* Integer pixel coords — Math.floor prevents sub-pixel gap artifacts
         when the CSS-transform zoom produces non-integer CSS-pixel boundaries. */
      const px = Math.floor(x * cs);
      const py = Math.floor(y * cs);
      /* Draw one pixel wider/taller so adjacent tiles share the boundary pixel
         and no canvas-background bleed-through occurs at any zoom level. */
      const pw = Math.floor((x + 1) * cs) - px;
      const ph = Math.floor((y + 1) * cs) - py;

      let drewImage = false;
      if (planeStack) {
        ctx.fillStyle =
          (x + y) % 2 === 0
            ? "rgba(255,255,255,0.05)"
            : "rgba(0,0,0,0.07)";
        ctx.fillRect(px, py, pw, ph);
        drewImage = true;
      }
      if (!planeStack) {
        const craftUrl = tileTypes[t]?.tileImage;
        if (craftUrl) {
          const cent = getCraftpixTileImage(craftUrl);
          if (cent?.ok && cent.img.complete && cent.img.naturalWidth) {
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(cent.img, px, py, pw, ph);
            ctx.restore();
            drewImage = true;
          }
        }
      }
      if (!planeStack) {
        if (!drewImage) {
          const tileIdx = pickTileIdx(t, x, y);
          if (tileIdx !== null) {
            const entry = getTileImage(tileIdx);
            if (entry.ok && entry.img.complete && entry.img.naturalWidth) {
              ctx.save();
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(entry.img, px, py, pw, ph);
              ctx.restore();
              drewImage = true;
            }
          }
        }
        if (!drewImage) {
          ctx.fillStyle = terrainColor(tileTypes, t);
          ctx.fillRect(px, py, pw, ph);
          drawTerrainFallback(ctx, t, px, py, cs);
        }
        /* Subtle terrain label for non-plains tiles when no image loaded */
        if (!drewImage && tileTypes[t] && t !== "plains") {
          ctx.save();
          ctx.font = `bold ${Math.round(cs * 0.2)}px monospace`;
          ctx.fillStyle = "rgba(255,255,255,0.28)";
          ctx.textBaseline = "top";
          ctx.fillText(t[0].toUpperCase(), px + 3, py + 2);
          ctx.restore();
        }
      }
    }
  }

  /* ── Pass 2: grid lines — single path, lineWidth=1, half-pixel offset for
       crisp rendering. Drawn AFTER all tiles so no inset gap is created inside
       each cell. Using Math.floor(n*cs)+0.5 aligns lines to the shared pixel
       boundary between adjacent tiles at any integer or fractional cell size. ── */
  {
    const gw = Math.floor(g.width  * cs);
    const gh = Math.floor(g.height * cs);
    ctx.save();
    ctx.lineWidth = 1;
    if (planeStack) {
      for (let xi = 0; xi <= g.width; xi++) {
        const lx = Math.floor(xi * cs) + 0.5;
        ctx.strokeStyle = xi % 2 === 0 ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.62)";
        ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, gh); ctx.stroke();
      }
      for (let yi = 0; yi <= g.height; yi++) {
        const ly = Math.floor(yi * cs) + 0.5;
        ctx.strokeStyle = yi % 2 === 0 ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.62)";
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(gw, ly); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      for (let xi = 0; xi <= g.width; xi++) {
        const lx = Math.floor(xi * cs) + 0.5;
        ctx.moveTo(lx, 0); ctx.lineTo(lx, gh);
      }
      for (let yi = 0; yi <= g.height; yi++) {
        const ly = Math.floor(yi * cs) + 0.5;
        ctx.moveTo(0, ly); ctx.lineTo(gw, ly);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── Movement reach overlay ── */
  if (options.reachable) {
    ctx.fillStyle = "rgba(61,158,255,0.28)";
    for (const k of options.reachable.keys()) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.fillRect(tx * cs + 3, ty * cs + 3, cs - 6, cs - 6);
    }
    ctx.strokeStyle = "rgba(61,158,255,0.75)";
    ctx.lineWidth = 2;
    for (const k of options.reachable.keys()) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.strokeRect(tx * cs + 3, ty * cs + 3, cs - 6, cs - 6);
    }
  }

  /* ── LOS shadow (tiles hidden behind cover from selected unit) ── */
  if (options.losShadowCells?.size) {
    ctx.fillStyle = "rgba(10, 16, 28, 0.4)";
    for (const k of options.losShadowCells) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.fillRect(tx * cs + 2, ty * cs + 2, cs - 4, cs - 4);
    }
  }

  /* ── Attack range ring (orange, no-target preview) ── */
  if (options.attackRange?.size) {
    ctx.fillStyle = "rgba(255,140,0,0.15)";
    ctx.strokeStyle = "rgba(255,140,0,0.55)";
    ctx.lineWidth = 1.5;
    for (const k of options.attackRange) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.fillRect(tx * cs + 2, ty * cs + 2, cs - 4, cs - 4);
      ctx.strokeRect(tx * cs + 2, ty * cs + 2, cs - 4, cs - 4);
    }
  }

  /* ── Attackable targets (red outline) ── */
  if (options.attackableCells?.size) {
    ctx.strokeStyle = "rgba(255,80,80,0.95)";
    ctx.lineWidth = 2.5;
    ctx.fillStyle = "rgba(255,60,60,0.12)";
    for (const k of options.attackableCells) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.fillRect(tx * cs + 4, ty * cs + 4, cs - 8, cs - 8);
      ctx.strokeRect(tx * cs + 4, ty * cs + 4, cs - 8, cs - 8);
    }
  }

  /* ── Selected unit highlight (yellow ring) ── */
  if (options.selected) {
    const u = options.selected;
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 3;
    ctx.strokeRect(u.x * cs + 2, u.y * cs + 2, cs - 4, cs - 4);
  }

  /* ── Coach pulse tiles (gold animated) ── */
  if (options.highlightCells?.size && options.timeMs != null) {
    const pulse = 0.42 + 0.38 * Math.sin(options.timeMs / 320);
    ctx.strokeStyle = `rgba(255,214,79,${pulse})`;
    ctx.lineWidth = 3;
    for (const k of options.highlightCells) {
      const [tx, ty] = k.split(",").map(Number);
      ctx.strokeRect(tx * cs + 3, ty * cs + 3, cs - 6, cs - 6);
    }
  }

  /* ── Fog of War ── */
  if (options.fogCells) {
    for (let fy = 0; fy < g.height; fy++) {
      for (let fx = 0; fx < g.width; fx++) {
        if (!options.fogCells.has(`${fx},${fy}`)) {
          ctx.fillStyle = "rgba(0,0,0,0.60)";
          ctx.fillRect(fx * cs, fy * cs, cs, cs);
        }
      }
    }
    /* soft vignette on fog edges */
    for (let fy = 0; fy < g.height; fy++) {
      for (let fx = 0; fx < g.width; fx++) {
        const k = `${fx},${fy}`;
        if (!options.fogCells.has(k)) continue;
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dy] of dirs) {
          if (!options.fogCells.has(`${fx+dx},${fy+dy}`)) {
            const grd = ctx.createLinearGradient(
              fx * cs + (dx === 1 ? cs : dx === -1 ? 0 : 0),
              fy * cs + (dy === 1 ? cs : dy === -1 ? 0 : 0),
              fx * cs + (dx === 1 ? cs * 0.5 : dx === -1 ? cs * 0.5 : 0),
              fy * cs + (dy === 1 ? cs * 0.5 : dy === -1 ? cs * 0.5 : 0),
            );
            grd.addColorStop(0, "rgba(0,0,0,0.45)");
            grd.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grd;
            ctx.fillRect(fx * cs, fy * cs, cs, cs);
          }
        }
      }
    }
  }

  /* Fog sat on top of per-cell grid strokes — redraw tactical grid so it stays readable */
  if (options.fogCells && planeStack) {
    for (let gy = 0; gy < g.height; gy++) {
      for (let gx = 0; gx < g.width; gx++) {
        const px = gx * cs;
        const py = gy * cs;
        ctx.strokeStyle =
          (gx + gy) % 2 === 0
            ? "rgba(255,255,255,0.62)"
            : "rgba(0,0,0,0.72)";
        ctx.lineWidth = 1.25;
        ctx.strokeRect(px + 0.5, py + 0.5, cs - 1, cs - 1);
      }
    }
  }

  ctx.restore();
}
