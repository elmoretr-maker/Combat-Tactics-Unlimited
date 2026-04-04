/**
 * Battlefield feedback: toast messages + invalid-move tile flash (canvas).
 */

const invalidFlashes = [];
const DEFAULT_TILE_FLASH_MS = 520;

let toastEl = null;
let toastHideTimer = null;

/**
 * Mount the toast host inside the battle canvas arena (position: relative in HTML).
 */
export function initBattleNotifications() {
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena) return;
  let el = document.getElementById("ctu-battle-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ctu-battle-toast";
    el.className = "ctu-battle-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    arena.appendChild(el);
  }
  toastEl = el;
}

/**
 * @param {string} message
 * @param {{ ttlMs?: number }} [opts]
 */
export function showBattleToast(message, opts = {}) {
  const ttl = opts.ttlMs ?? 3200;
  if (!toastEl) initBattleNotifications();
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("ctu-battle-toast--visible");
  if (toastHideTimer) clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    toastEl?.classList.remove("ctu-battle-toast--visible");
    toastHideTimer = null;
  }, ttl);
}

/**
 * Brief red overlay on a grid cell (invalid move / attack).
 * @param {number} gx
 * @param {number} gy
 * @param {number} [durationMs]
 */
export function flashInvalidTile(gx, gy, durationMs = DEFAULT_TILE_FLASH_MS) {
  invalidFlashes.push({
    gx,
    gy,
    born: performance.now(),
    duration: durationMs,
  });
}

/**
 * Draw active invalid-tile flashes (call from battle render loop after grid, before or after units).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} ox grid pixel offset X
 * @param {number} oy grid pixel offset Y
 * @param {number} cellSize
 * @param {number} now performance.now()
 */
export function drawInvalidTileFlashes(ctx, ox, oy, cellSize, now) {
  if (!ctx) return;
  for (let i = invalidFlashes.length - 1; i >= 0; i--) {
    const f = invalidFlashes[i];
    const age = now - f.born;
    if (age > f.duration) {
      invalidFlashes.splice(i, 1);
      continue;
    }
    const t = age / f.duration;
    const alpha = (1 - t) * 0.5;
    const px = ox + f.gx * cellSize;
    const py = oy + f.gy * cellSize;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#e02020";
    ctx.fillRect(px, py, cellSize, cellSize);
    ctx.globalAlpha = Math.min(1, alpha * 1.35);
    ctx.strokeStyle = "rgba(255, 220, 220, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
    ctx.restore();
  }
}
