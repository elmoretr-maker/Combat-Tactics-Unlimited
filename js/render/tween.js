/**
 * Battlefield motion helpers — used by main.js for unit slide between tiles.
 */

/** Default minimum duration for a move tween (ms). */
export const DEFAULT_MOVE_DURATION_MS = 500;

/** Per orthogonal tile — steady march (linear lerp between cell centers). */
export const PER_TILE_MOVE_MS = 420;

/**
 * Linear interpolation.
 * @param {number} a
 * @param {number} b
 * @param {number} t 0..1
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

/** Smoothstep easing (same as legacy main.js lerp curve). */
export function easeSmoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Optional ease-out quad. */
export function easeOutQuad(t) {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}

/**
 * Interpolate grid cell center positions (float).
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} t 0..1
 * @param {(n: number) => number} [ease] default smoothstep
 */
export function lerpCellPair(x0, y0, x1, y1, t, ease = easeSmoothstep) {
  const e = ease(t);
  return { x: lerp(x0, x1, e), y: lerp(y0, y1, e) };
}

/**
 * Duration for a Manhattan move: at least DEFAULT_MOVE_DURATION_MS, scales slightly with distance.
 * @param {number} dist Manhattan distance in tiles
 * @param {boolean} reduceMotion
 */
export function moveTweenDurationMs(dist, reduceMotion) {
  if (reduceMotion) return 0;
  return Math.min(950, Math.max(DEFAULT_MOVE_DURATION_MS, 180 + dist * 120));
}
