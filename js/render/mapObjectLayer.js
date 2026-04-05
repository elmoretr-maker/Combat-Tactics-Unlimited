/**
 * Draw scattered map props (CraftPix sprites + fallbacks) for legacy grid mode
 * and battle-plane mode. Shared cache so sprites load once.
 *
 * Map object draw fields (optional, from scenario / makeMapObject):
 * - sourceRect: { x, y, w, h } — region in the sprite image (9-arg drawImage).
 * - propAnchor: "bottom" | "center" — vertical placement; tall props default to bottom.
 */

const _propEntryCache = new Map();

/** @typedef {{ x: number, y: number, w: number, h: number }} SourceRect */

/**
 * @param {HTMLImageElement} img
 * @param {SourceRect | undefined} rect
 * @returns {SourceRect | null} null if rect invalid or out of bounds
 */
function resolveSourceRect(img, rect) {
  if (!rect) return null;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  let sx = Math.floor(Number(rect.x) || 0);
  let sy = Math.floor(Number(rect.y) || 0);
  let sw = Math.floor(Number(rect.w) || 0);
  let sh = Math.floor(Number(rect.h) || 0);
  if (sw <= 0 || sh <= 0) return null;
  sx = Math.max(0, Math.min(sx, iw - 1));
  sy = Math.max(0, Math.min(sy, ih - 1));
  sw = Math.min(sw, iw - sx);
  sh = Math.min(sh, ih - sy);
  if (sw <= 0 || sh <= 0) return null;
  return { x: sx, y: sy, w: sw, h: sh };
}

/**
 * Default vertical anchor when `propAnchor` is omitted.
 * Tall world props sit on the tile foot; small clutter stays centered.
 * @param {string} visualKind
 * @returns {"bottom"|"center"}
 */
function defaultPropAnchor(visualKind) {
  const k = (visualKind || "").toLowerCase();
  if (k === "tree" || k === "house" || k === "ruins") return "bottom";
  return "center";
}

export function getPropImage(src) {
  if (!src) return { img: null, ok: false };
  if (_propEntryCache.has(src)) return _propEntryCache.get(src);
  const img = new Image();
  const entry = { img, ok: false };
  img.onload = () => {
    entry.ok = true;
  };
  img.onerror = () => {
    entry.ok = false;
  };
  img.src = src;
  _propEntryCache.set(src, entry);
  return entry;
}

export function drawPropFallback(ctx, kind, px0, py0, box) {
  ctx.save();
  const cx = px0 + box / 2;
  switch (kind) {
    case "tree": {
      ctx.fillStyle = "rgba(38,72,42,0.92)";
      ctx.strokeStyle = "rgba(14,28,16,0.95)";
      ctx.lineWidth = Math.max(1, box * 0.04);
      ctx.beginPath();
      ctx.moveTo(cx, py0 + box * 0.1);
      ctx.lineTo(px0 + box * 0.85, py0 + box * 0.86);
      ctx.lineTo(px0 + box * 0.15, py0 + box * 0.86);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(52,36,24,0.92)";
      ctx.fillRect(cx - box * 0.09, py0 + box * 0.68, box * 0.18, box * 0.22);
      break;
    }
    case "house": {
      ctx.fillStyle = "rgba(118,92,70,0.92)";
      ctx.fillRect(px0 + box * 0.14, py0 + box * 0.36, box * 0.72, box * 0.54);
      ctx.fillStyle = "rgba(78,48,38,0.96)";
      ctx.beginPath();
      ctx.moveTo(cx, py0 + box * 0.08);
      ctx.lineTo(px0 + box * 0.9, py0 + box * 0.4);
      ctx.lineTo(px0 + box * 0.1, py0 + box * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(28,18,12,0.9)";
      ctx.lineWidth = Math.max(1, box * 0.035);
      ctx.strokeRect(px0 + box * 0.14, py0 + box * 0.36, box * 0.72, box * 0.54);
      break;
    }
    case "ruins": {
      ctx.fillStyle = "rgba(78,74,68,0.9)";
      for (let i = 0; i < 4; i++) {
        const ox = px0 + (i % 2) * box * 0.46 + box * 0.04;
        const oy = py0 + Math.floor(i / 2) * box * 0.4 + box * 0.18;
        ctx.fillRect(ox, oy, box * 0.4, box * 0.34);
      }
      ctx.strokeStyle = "rgba(32,30,28,0.88)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px0 + box * 0.04, py0 + box * 0.16, box * 0.92, box * 0.72);
      break;
    }
    case "barrel": {
      ctx.fillStyle = "rgba(98,60,34,0.9)";
      ctx.beginPath();
      ctx.ellipse(cx, py0 + box * 0.5, box * 0.34, box * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(42,26,14,0.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
      break;
    }
    default: {
      ctx.fillStyle = "rgba(55,42,28,0.88)";
      ctx.strokeStyle = "rgba(20,15,10,0.9)";
      ctx.lineWidth = Math.max(1, box * 0.04);
      ctx.fillRect(px0, py0 + box * 0.12, box, box * 0.62);
      ctx.strokeRect(px0, py0 + box * 0.12, box, box * 0.62);
      ctx.fillStyle = "rgba(35,28,20,0.9)";
      ctx.fillRect(px0 + box * 0.08, py0, box * 0.84, box * 0.22);
    }
  }
  ctx.restore();
}

/**
 * @param {import("../engine/gameState.js").GameState} game
 */
export function drawMapObjects(ctx, game, offsetX, offsetY) {
  if (!game?.mapObjects?.length) return;
  const cs = game.grid.cellSize;
  const pad = cs * 0.08;
  for (const o of game.mapObjects) {
    const vk = o.visualKind || "crate";
    const entry = getPropImage(o.sprite);
    const cellLeft = offsetX + o.x * cs;
    const cellTop = offsetY + o.y * cs;
    const px0 = cellLeft + pad;
    const py0 = cellTop + pad;
    const box = cs - pad * 2;
    if (entry.ok && entry.img?.naturalWidth) {
      const img = entry.img;
      const slice = resolveSourceRect(img, o.sourceRect);
      const sw = slice ? slice.w : img.naturalWidth;
      const sh = slice ? slice.h : img.naturalHeight;
      const sx = slice ? slice.x : 0;
      const sy = slice ? slice.y : 0;

      const anchor = o.propAnchor || defaultPropAnchor(vk);
      let dw;
      let dh;
      let px;
      let py;

      if (anchor === "bottom") {
        /* Width fits inside cell (with horizontal pad); height scales proportionally.
           Sprite foot sits on the bottom cell edge — may extend upward past the cell. */
        const maxW = box;
        const scale = maxW / sw;
        dw = sw * scale;
        dh = sh * scale;
        px = cellLeft + (cs - dw) / 2;
        py = cellTop + cs - dh;
      } else {
        /* Centered clutter: uniform scale to fit the padded inner box. */
        const scale = Math.min(box / sw, box / sh);
        dw = sw * scale;
        dh = sh * scale;
        px = cellLeft + (cs - dw) / 2;
        py = cellTop + (cs - dh) / 2;
      }

      const pyOff = typeof o.pyOffset === "number" && Number.isFinite(o.pyOffset) ? o.pyOffset : 0;
      py += pyOff;

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      if (slice) {
        ctx.drawImage(img, sx, sy, sw, sh, px, py, dw, dh);
      } else {
        ctx.drawImage(img, px, py, dw, dh);
      }
      ctx.restore();
    } else {
      drawPropFallback(ctx, vk, px0, py0, box);
    }
  }
}
