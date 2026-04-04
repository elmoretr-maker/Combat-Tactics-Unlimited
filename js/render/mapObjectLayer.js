/**
 * Draw scattered map props (CraftPix sprites + fallbacks) for legacy grid mode
 * and battle-plane mode. Shared cache so sprites load once.
 */

const _propEntryCache = new Map();

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
    const px0 = offsetX + o.x * cs + pad;
    const py0 = offsetY + o.y * cs + pad;
    const box = cs - pad * 2;
    if (entry.ok && entry.img?.naturalWidth) {
      const maxS = box;
      const iw = entry.img.naturalWidth;
      const ih = entry.img.naturalHeight;
      const scale = Math.min(maxS / iw, maxS / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const px = offsetX + o.x * cs + (cs - dw) / 2;
      const py = offsetY + o.y * cs + (cs - dh) / 2;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(entry.img, px, py, dw, dh);
      ctx.restore();
    } else {
      drawPropFallback(ctx, vk, px0, py0, box);
    }
  }
}
