import { terrainColor } from "../engine/terrain.js";

/* All terrain IDs that count as water (used in Pass 3 shore logic) */
const WATER_TERRAIN_SET = new Set(["water", "water_desert", "water_urban"]);

const ROAD_TERRAIN_SET = new Set(["road", "cp_road"]);

/* Shore/coast bitmask tileset — 2 animation columns × 4 topology rows, each frame 176×112 px.
 * Used by the flow connector layer (dividerRule / assetQuery) for river channel rendering.
 * Preloaded here so the asset is cached before the flow connector system needs it. */
const SHORE_SPRITE_URL = "assets/tiles/urban/Water_coasts_animation.png";

/**
 * Convert a 6-digit CSS hex colour and a 0-1 alpha into an rgba() string.
 * Using rgba() keeps compatibility with all canvas implementations.
 */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/**
 * Cells that should render a ford/bridge deck: generator log, top-level bridgeCells,
 * then a terrain heuristic so crossings still paint if metadata is missing.
 */
function dividerBridgeKeySet(game) {
  const s = new Set();
  const top = game?.scenario?.bridgeCells;
  if (Array.isArray(top)) {
    for (const c of top) {
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) s.add(`${c.x},${c.y}`);
    }
  }
  const log = game?.scenario?.generator?.connectorLog;
  if (Array.isArray(log)) {
    for (const e of log) {
      if (!e || !WATER_TERRAIN_SET.has(e.before)) continue;
      if (e.fordStyle === "natural") continue;
      if (!ROAD_TERRAIN_SET.has(e.after)) continue;
      s.add(`${e.x},${e.y}`);
    }
  }
  if (s.size > 0 || !game?.grid?.cells) return s;

  const cells = game.grid.cells;
  const h = cells.length;
  const w = h ? cells[0].length : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = cells[y][x];
      if (!ROAD_TERRAIN_SET.has(t)) continue;
      const wN = y > 0 && WATER_TERRAIN_SET.has(cells[y - 1][x]);
      const wS = y < h - 1 && WATER_TERRAIN_SET.has(cells[y + 1][x]);
      const wE = x < w - 1 && WATER_TERRAIN_SET.has(cells[y][x + 1]);
      const wW = x > 0 && WATER_TERRAIN_SET.has(cells[y][x - 1]);
      if ((wE && wW) || (wN && wS)) s.add(`${x},${y}`);
    }
  }
  return s;
}

/** @returns {Map<string, object>} key "x,y" → flow connector row from generator */
function flowConnectorIndex(game) {
  const map = new Map();
  const list = game?.scenario?.generator?.flowConnectors;
  if (!Array.isArray(list)) return map;
  for (const e of list) {
    if (e && e.spritePath && Number.isFinite(e.x) && Number.isFinite(e.y)) {
      map.set(`${e.x},${e.y}`, e);
    }
  }
  return map;
}

/**
 * Draw manifest flow tile (single image or sprite-sheet frame) edge-to-edge in cell — no padding.
 * @returns {boolean} true if something was drawn
 */
function drawFlowConnectorRaster(ctx, entry, px, py, pw, ph) {
  if (!entry?.spritePath) return false;
  const ent = getCraftpixTileImage(entry.spritePath);
  if (!ent?.ok || !ent.img.complete || !ent.img.naturalWidth) return false;
  const fs = entry.flowSheet;
  if (
    fs?.frameW &&
    fs?.frameH &&
    fs.columns &&
    Number.isFinite(entry.spriteSheetFrame)
  ) {
    const col = entry.spriteSheetFrame % fs.columns;
    const row = Math.floor(entry.spriteSheetFrame / fs.columns);
    const sx = col * fs.frameW;
    const sy = row * fs.frameH;
    ctx.drawImage(ent.img, sx, sy, fs.frameW, fs.frameH, px, py, pw, ph);
    return true;
  }
  ctx.drawImage(ent.img, px, py, pw, ph);
  return true;
}

/** Land-adjacency bitmask (N=1,E=2,S=4,W=8) for a water cell — map edge to coast art */
function landAdjacencyMask4(cells, gx, gy, gw, gh) {
  const landAt = (tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= gw || ty >= gh) return true;
    return !WATER_TERRAIN_SET.has(cells[ty][tx]);
  };
  let m = 0;
  if (landAt(gx, gy - 1)) m |= 1;
  if (landAt(gx + 1, gy)) m |= 2;
  if (landAt(gx, gy + 1)) m |= 4;
  if (landAt(gx - 1, gy)) m |= 8;
  return m;
}

/**
 * Shore tileset: 2 animation columns × 4 topology rows (176×112 px cells in asset).
 * Picks row from how many sides touch land; column from time.
 */
function drawWaterShoreSprite(ctx, cells, gx, gy, px, py, pw, ph, timeMs) {
  const mask = landAdjacencyMask4(cells, gx, gy, cells[0].length, cells.length);
  if (mask === 0) return false;
  const ent = getCraftpixTileImage(SHORE_SPRITE_URL);
  if (!ent?.ok || !ent.img.complete || !ent.img.naturalWidth) return false;
  const iw = ent.img.naturalWidth;
  const ih = ent.img.naturalHeight;
  const cols = 2;
  const rows = 4;
  const fw = Math.floor(iw / cols);
  const fh = Math.floor(ih / rows);
  if (fw < 4 || fh < 4) return false;
  let bits = 0;
  for (const b of [1, 2, 4, 8]) if (mask & b) bits++;
  const row = Math.min(rows - 1, Math.max(0, bits - 1));
  const col =
    timeMs != null
      ? Math.floor(timeMs / 320) % cols
      : 0;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    ent.img,
    col * fw,
    row * fh,
    fw,
    fh,
    px,
    py,
    pw,
    ph,
  );
  ctx.restore();
  return true;
}

/**
 * Opaque wooden ford / bridge deck over the sandy road art underneath.
 * Only used for `dividerBridgeKeySet` cells — not every road tile beside water.
 */
function drawDividerBridgeDeck(ctx, cells, gx, gy, px, py, pw, ph, cs) {
  const gh = cells.length;
  const gw = gh ? cells[0].length : 0;
  const hasWaterN = gy > 0 && WATER_TERRAIN_SET.has(cells[gy - 1][gx]);
  const hasWaterS = gy < gh - 1 && WATER_TERRAIN_SET.has(cells[gy + 1][gx]);
  const hasWaterE = gx < gw - 1 && WATER_TERRAIN_SET.has(cells[gy][gx + 1]);
  const hasWaterW = gx > 0 && WATER_TERRAIN_SET.has(cells[gy][gx - 1]);
  const isVerticalBridge = hasWaterN || hasWaterS;
  const margin = Math.max(2, Math.round(cs * 0.04));
  const plankCount = 6;

  ctx.save();
  /* Stone abutments against open water */
  ctx.fillStyle = "#3d3d45";
  const pier = Math.max(margin, Math.round(cs * 0.07));
  if (hasWaterW) ctx.fillRect(px, py + margin, pier, ph - margin * 2);
  if (hasWaterE) ctx.fillRect(px + pw - pier, py + margin, pier, ph - margin * 2);
  if (hasWaterN) ctx.fillRect(px + margin, py, pw - margin * 2, pier);
  if (hasWaterS) ctx.fillRect(px + margin, py + ph - pier, pw - margin * 2, pier);

  const ix0 = px + (hasWaterW ? pier : margin);
  const iy0 = py + (hasWaterN ? pier : margin);
  const ix1 = px + pw - (hasWaterE ? pier : margin);
  const iy1 = py + ph - (hasWaterS ? pier : margin);
  const iw = Math.max(1, ix1 - ix0);
  const ih = Math.max(1, iy1 - iy0);

  ctx.fillStyle = "#6b4e2e";
  ctx.fillRect(ix0, iy0, iw, ih);
  ctx.strokeStyle = "rgba(40, 22, 8, 0.65)";
  ctx.lineWidth = Math.max(1, Math.round(cs * 0.02));
  for (let pi = 1; pi < plankCount; pi++) {
    const frac = pi / plankCount;
    ctx.beginPath();
    if (isVerticalBridge) {
      const lx = ix0 + Math.round(iw * frac);
      ctx.moveTo(lx, iy0);
      ctx.lineTo(lx, iy1);
    } else {
      const ly = iy0 + Math.round(ih * frac);
      ctx.moveTo(ix0, ly);
      ctx.lineTo(ix1, ly);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = "#d4a84b";
  ctx.lineWidth = Math.max(2, Math.round(cs * 0.055));
  const rl = Math.round(ctx.lineWidth / 2);
  if (hasWaterN) {
    ctx.beginPath();
    ctx.moveTo(ix0, py + rl);
    ctx.lineTo(ix1, py + rl);
    ctx.stroke();
  }
  if (hasWaterS) {
    ctx.beginPath();
    ctx.moveTo(ix0, py + ph - rl);
    ctx.lineTo(ix1, py + ph - rl);
    ctx.stroke();
  }
  if (hasWaterE) {
    ctx.beginPath();
    ctx.moveTo(px + pw - rl, iy0);
    ctx.lineTo(px + pw - rl, iy1);
    ctx.stroke();
  }
  if (hasWaterW) {
    ctx.beginPath();
    ctx.moveTo(px + rl, iy0);
    ctx.lineTo(px + rl, iy1);
    ctx.stroke();
  }
  ctx.restore();
}

/* ── High-resolution terrain tile overrides ──────────────────
 * Maps each terrain type to a list of high-res PNG paths (repo-relative).
 * Checked BEFORE the pixel-art TILE_MAP fallback below.
 * Variant selection uses a deterministic XOR hash (no per-frame randomness)
 * that avoids the diagonal stripe artifacts of a linear modulo hash.
 *
 * Only include tiles confirmed to exist on disk as solid ground textures.
 * The three urban tiles below are the curated ground-appropriate subset.
 */
const HIRES_TILE_MAP = {
  /* Urban / city ground */
  urban:       [
    "assets/tiles/urban/Tile_Urban_Tile_691e5367.png",
    "assets/tiles/urban/Tile_Urban_Tile_df1dd40d.png",
    "assets/tiles/urban/Tile_Urban_Tile_ff2db801.png",
  ],
  cp_grass:    [
    "assets/tiles/urban/Tile_Urban_Tile_691e5367.png",
    "assets/tiles/urban/Tile_Urban_Tile_df1dd40d.png",
    "assets/tiles/urban/Tile_Urban_Tile_ff2db801.png",
  ],
  cp_road:     [
    "assets/tiles/urban/Tile_Urban_Tile_691e5367.png",
    "assets/tiles/urban/Tile_Urban_Tile_df1dd40d.png",
  ],
  /* Desert ground — all 10 tiles are confirmed solid ground textures */
  desert:      [
    "assets/tiles/desert/Tile_Desert_Tile_4c54db55.png",
    "assets/tiles/desert/Tile_Desert_Tile_8501cf17.png",
    "assets/tiles/desert/Tile_Desert_Tile_a97a3f77.png",
    "assets/tiles/desert/Tile_Desert_Tile_c085f0b5.png",
    "assets/tiles/desert/Tile_Desert_Tile_e374f7b5.png",
    "assets/tiles/desert/Tile_Desert_Tile_f8a9863d.png",
    "assets/tiles/desert/Tile_Desert_Tile_f8aca067.png",
    "assets/tiles/desert/Tile_Desert_Tile_13a4ce6c.png",
    "assets/tiles/desert/Tile_Desert_Tile_73893cba.png",
    "assets/tiles/desert/Tile_Desert_Tile_9584eb62.png",
  ],
};

/**
 * Deterministic XOR-based spatial hash — avoids diagonal stripe patterns
 * that appear with a linear hash like (gx*7 + gy*13) % N.
 * Returns an integer in [0, len).
 */
function hiresVariantIndex(gx, gy, len) {
  let h = (gx * 374761393) ^ (gy * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % len;
}

/*
 * TILE MANIFEST (pixel-art fallback)
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
  plains:        [1, 1, 1, 30, 1, 31, 1, 1, 32, 1, 30],
  water:         [0, 0, 9, 0, 0, 10, 0, 11, 0],
  forest:        [19, 20, 21, 19, 20, 21],
  hill:          [22, 28, 22, 28],
  road:          [94, 95, 96, 97],
  urban:         [118, 119, 120, 121],
  desert:        [14, 26, 14, 18, 26, 25, 14, 27],
  snow:          [129, 130, 131, 132],
  /* Biome-specific water variants — no matching pixel-art tiles, so these
     intentionally fall through to terrainColor fill + TERRAIN_DRAW_FALLBACK. */
  water_desert:  [],
  water_urban:   [],
  /* Craftpix / procedural terrain aliases — map to existing tile art */
  cp_grass:      [1, 1, 30, 1, 31, 1, 32],
  cp_road:       [94, 95, 96, 97],
  cp_building:   [118, 119, 120, 121],
  cp_rubble:     [22, 28, 22],
  building_block:[119, 118, 119],
};

/* ── Image cache ──────────────────────────────────────────── */
const _tileImgCache = new Map();
const _craftpixTileCache = new Map();

function getCraftpixTileImage(url) {
  if (!url) return null;
  if (_craftpixTileCache.has(url)) return _craftpixTileCache.get(url);
  const img = new Image();
  const entry = { img, ok: false, promise: null };
  entry.promise = new Promise((resolve) => {
    img.onload  = () => { entry.ok = true;  resolve(entry); };
    img.onerror = () => { entry.ok = false; resolve(entry); };
  });
  img.src = url;
  _craftpixTileCache.set(url, entry);
  return entry;
}

/**
 * Preload all high-res terrain tiles + the shore sprite.
 * Await this in the boot sequence so the first render is fully textured.
 */
export async function preloadTerrainTiles() {
  const urls = new Set([
    SHORE_SPRITE_URL,
    /* Procedural river channel (flowConnector water, horizontal mask frames) */
    "assets/tiles/urban/Tile_Urban_WaterStrip_64d87f88.png",
  ]);
  for (const arr of Object.values(HIRES_TILE_MAP)) {
    for (const url of arr) urls.add(url);
  }
  const promises = [];
  for (const url of urls) {
    const e = getCraftpixTileImage(url);
    if (e?.promise) promises.push(e.promise);
  }
  await Promise.all(promises);
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
  /* Ocean / river — three animated wave rows travelling right */
  water(ctx, x, y, cs, timeMs) {
    /* Base phase advances slowly; each wave row is offset by 2.1 rad so they
       never align in a distracting synchronised pulse. */
    const phase = (timeMs / 1100) % (Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const rowPhase = phase + i * 2.1;
      const alpha = 0.38 + 0.07 * Math.sin(rowPhase);
      ctx.strokeStyle = `rgba(130,200,255,${alpha.toFixed(2)})`;
      ctx.lineWidth = 1;
      const wy = y + cs * (0.28 + i * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + 4, wy);
      for (let wx = x + 4; wx < x + cs - 4; wx += 6) {
        /* Travelling-wave: phase advances left-to-right across the tile */
        const posPhase = rowPhase + ((wx - x) / cs) * Math.PI * 2.4;
        const amp = 2.2 + 0.8 * Math.sin(rowPhase * 0.7);
        ctx.quadraticCurveTo(wx + 3, wy - amp * Math.sin(posPhase), wx + 6, wy);
      }
      ctx.stroke();
    }
  },
  /* Oasis / desert creek — teal-green with slow lazy ripples */
  water_desert(ctx, x, y, cs, timeMs) {
    const phase = (timeMs / 1500) % (Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const rowPhase = phase + i * 1.9;
      const alpha = 0.42 + 0.08 * Math.sin(rowPhase);
      ctx.strokeStyle = `rgba(100,200,185,${alpha.toFixed(2)})`;
      ctx.lineWidth = 1;
      const wy = y + cs * (0.28 + i * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + 4, wy);
      for (let wx = x + 4; wx < x + cs - 4; wx += 6) {
        const posPhase = rowPhase + ((wx - x) / cs) * Math.PI * 1.8;
        const amp = 1.8 + 0.6 * Math.sin(rowPhase * 0.5);
        ctx.quadraticCurveTo(wx + 3, wy - amp * Math.sin(posPhase), wx + 6, wy);
      }
      ctx.stroke();
    }
    /* Subtle sandy-crack detail at the shore fringe — deterministic positions */
    ctx.strokeStyle = "rgba(200,170,80,0.25)";
    ctx.lineWidth = 0.6;
    const offsets = [[0.08, 0.12], [0.55, 0.08], [0.25, 0.78], [0.72, 0.72]];
    for (const [ox, oy] of offsets) {
      ctx.beginPath();
      ctx.moveTo(x + cs * ox,          y + cs * oy);
      ctx.lineTo(x + cs * (ox + 0.08), y + cs * (oy + 0.05));
      ctx.stroke();
    }
  },
  /* Urban canal / drainage — dark blue-grey with tighter ripples */
  water_urban(ctx, x, y, cs, timeMs) {
    const phase = (timeMs / 900) % (Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const rowPhase = phase + i * 2.4;
      const alpha = 0.36 + 0.09 * Math.sin(rowPhase);
      ctx.strokeStyle = `rgba(100,150,190,${alpha.toFixed(2)})`;
      ctx.lineWidth = 1;
      const wy = y + cs * (0.28 + i * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + 4, wy);
      for (let wx = x + 4; wx < x + cs - 4; wx += 6) {
        const posPhase = rowPhase + ((wx - x) / cs) * Math.PI * 3.0;
        const amp = 1.5 + 0.5 * Math.sin(rowPhase * 0.8);
        ctx.quadraticCurveTo(wx + 3, wy - amp * Math.sin(posPhase), wx + 6, wy);
      }
      ctx.stroke();
    }
    /* Concrete kerb edge — static, no animation needed */
    ctx.strokeStyle = "rgba(160,170,180,0.30)";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x + 1, y + 1, cs - 2, cs - 2);
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

function drawTerrainFallback(ctx, terrainType, x, y, cs, timeMs = 0) {
  const fn = TERRAIN_DRAW_FALLBACK[terrainType];
  if (!fn) return;
  ctx.save();
  fn(ctx, x, y, cs, timeMs);
  ctx.restore();
}

/* ── Main grid draw function ─────────────────────────────── */
export function drawGrid(ctx, game, tileTypes, options) {
  const g  = game.grid;
  const cs = g.cellSize;
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;
  const planeStack = options.stackMode === "plane";
  const bridgeKeys = dividerBridgeKeySet(game);
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
        /* ── High-res tile override (checked before pixel-art fallback) ── */
        const hiresArr = HIRES_TILE_MAP[t];
        if (hiresArr && hiresArr.length) {
          ctx.fillStyle = terrainColor(tileTypes, t);
          ctx.fillRect(px, py, pw, ph);
          const hiresUrl = hiresArr[hiresVariantIndex(x, y, hiresArr.length)];
          const hent = getCraftpixTileImage(hiresUrl);
          if (hent?.ok && hent.img.complete && hent.img.naturalWidth) {
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(hent.img, px, py, pw, ph);
            ctx.restore();
            drewImage = true;
          }
        }
      }
      if (!planeStack) {
        const craftUrl = tileTypes[t]?.tileImage;
        if (!drewImage && craftUrl) {
          /* Always fill the base colour first — image may be partially
             transparent (or a sprite sheet), so never expose raw black canvas. */
          ctx.fillStyle = terrainColor(tileTypes, t);
          ctx.fillRect(px, py, pw, ph);
          const cent = getCraftpixTileImage(craftUrl);
          if (cent?.ok && cent.img.complete && cent.img.naturalWidth) {
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(cent.img, px, py, pw, ph);
            ctx.restore();
          } else {
            drawTerrainFallback(ctx, t, px, py, cs, options.timeMs ?? 0);
          }
          drewImage = true;
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
          drawTerrainFallback(ctx, t, px, py, cs, options.timeMs ?? 0);
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

  const flowByCell = flowConnectorIndex(game);

  /* ── Pass 1a: water flow art + shore (manifest flowConnectors when present; else coast sheet) ── */
  if (!planeStack) {
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const t = g.cells[y][x];
        if (!WATER_TERRAIN_SET.has(t)) continue;
        const px = Math.floor(x * cs);
        const py = Math.floor(y * cs);
        const pw = Math.floor((x + 1) * cs) - px;
        const ph = Math.floor((y + 1) * cs) - py;
        const e = flowByCell.get(`${x},${y}`);
        let drewChannel =
          !!(
            e &&
            WATER_TERRAIN_SET.has(e.terrainId) &&
            drawFlowConnectorRaster(ctx, e, px, py, pw, ph)
          );
        if (!drewChannel) {
          drawWaterShoreSprite(ctx, g.cells, x, y, px, py, pw, ph, options.timeMs ?? 0);
        }
      }
    }
  }

  /* ── Pass 1b: bridge / ford — manifest flow tile when available, else procedural deck ── */
  if (bridgeKeys.size) {
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        if (!bridgeKeys.has(`${x},${y}`)) continue;
        const px = Math.floor(x * cs);
        const py = Math.floor(y * cs);
        const pw = Math.floor((x + 1) * cs) - px;
        const ph = Math.floor((y + 1) * cs) - py;
        const e = flowByCell.get(`${x},${y}`);
        const t = g.cells[y][x];
        if (
          e &&
          ROAD_TERRAIN_SET.has(t) &&
          ROAD_TERRAIN_SET.has(e.terrainId) &&
          drawFlowConnectorRaster(ctx, e, px, py, pw, ph)
        ) {
          continue;
        }
        drawDividerBridgeDeck(ctx, g.cells, x, y, px, py, pw, ph, cs);
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

  /* ── Pass 3: shore + road-grass edge overlays ─────────────
     Runs only on the main tactical map (not plane-stack view).
     For each water cell: gradient strip on every land-adjacent edge using
     the neighbour's terrain colour, giving a natural shoreline blend.
     For each road cell: dark shoulder strip on every grass-adjacent edge.
  ─────────────────────────────────────────────────────────── */
  if (!planeStack) {
    const ROAD_SET  = new Set(["road", "cp_road"]);
    const GRASS_SET = new Set(["plains", "cp_grass", "forest"]);
    const stripW = Math.max(4, Math.round(cs * 0.18));

        /* Coast sprite is a bitmask tileset (used by flow connector layer),
         not a rotateable single frame — gradient-only for Pass 3 shore blending. */

    for (let gy = 0; gy < g.height; gy++) {
      for (let gx = 0; gx < g.width; gx++) {
        const t       = g.cells[gy][gx];
        const isWater = WATER_TERRAIN_SET.has(t);
        const isRoad  = ROAD_SET.has(t);
        if (!isWater && !isRoad) continue;

        const px = Math.floor(gx * cs);
        const py = Math.floor(gy * cs);
        const pw = Math.floor((gx + 1) * cs) - px;
        const ph = Math.floor((gy + 1) * cs) - py;

        /* Four edge directions: [neighbour delta, gradient line, strip rect] */
        const edges = [
          /* North — land above, strip at top, gradient solid→transparent downward */
          { dx:  0, dy: -1,
            lx0: px,      ly0: py,      lx1: px,      ly1: py + stripW,
            rx:  px,      ry:  py,      rw:  pw,      rh:  stripW },
          /* South — land below, strip at bottom, gradient upward */
          { dx:  0, dy:  1,
            lx0: px,      ly0: py + ph, lx1: px,      ly1: py + ph - stripW,
            rx:  px,      ry:  py + ph - stripW, rw: pw, rh: stripW },
          /* West — land left, strip at left, gradient rightward */
          { dx: -1, dy:  0,
            lx0: px,      ly0: py,      lx1: px + stripW, ly1: py,
            rx:  px,      ry:  py,      rw:  stripW,  rh:  ph },
          /* East — land right, strip at right, gradient leftward */
          { dx:  1, dy:  0,
            lx0: px + pw, ly0: py,      lx1: px + pw - stripW, ly1: py,
            rx:  px + pw - stripW, ry: py, rw: stripW, rh: ph },
        ];

        for (const e of edges) {
          const nx = gx + e.dx;
          const ny = gy + e.dy;
          if (nx < 0 || ny < 0 || nx >= g.width || ny >= g.height) continue;
          const nt = g.cells[ny][nx];

          let overlayColor = null;
          let overlayAlpha = 0;

          if (isWater && !WATER_TERRAIN_SET.has(nt)) {
            overlayColor = terrainColor(tileTypes, nt);
            overlayAlpha = 0.52;
          } else if (isRoad && GRASS_SET.has(nt)) {
            overlayColor = "#2a3a1a";
            overlayAlpha = 0.30;
          }

          if (!overlayColor) continue;

          /* Gradient fill — land colour fades into the water/road tile */
          ctx.save();
          const grd = ctx.createLinearGradient(e.lx0, e.ly0, e.lx1, e.ly1);
          grd.addColorStop(0, hexToRgba(overlayColor, overlayAlpha));
          grd.addColorStop(1, hexToRgba(overlayColor, 0));
          ctx.fillStyle = grd;
          ctx.fillRect(e.rx, e.ry, e.rw, e.rh);
          ctx.restore();
        }
      }
    }
  }

  ctx.restore();
}
