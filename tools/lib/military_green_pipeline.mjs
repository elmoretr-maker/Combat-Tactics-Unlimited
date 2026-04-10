/**
 * cyberpunk_blue → military_green: olive / drab metal look.
 * Hue shift + desat + blue-channel crush + light contrast (no resize, alpha preserved).
 */
import sharp from "sharp";

/** Rotate away from cyan/blue toward yellow–olive (°) */
const HUE_SHIFT = 108;

/** Remove neon, matte finish */
const SATURATION = 0.38;

/** Slightly darker overall */
const BRIGHTNESS = 0.84;

/**
 * RGB recomb: attenuate blue, bleed warm from G→R, olive in shadows.
 * Rows sum ~1 to avoid blowing highlights.
 */
const RECOMB = [
  [0.92, 0.22, 0.06],
  [0.1, 0.88, 0.12],
  [0.04, 0.26, 0.42],
];

/** Slight contrast (multiply, offset in 0–255 space) */
const LINEAR_A = 1.06;
const LINEAR_B = -10;

/**
 * @param {string} srcPath
 * @returns {import("sharp").Sharp}
 */
export function militaryGradePipeline(srcPath) {
  return sharp(srcPath)
    .ensureAlpha()
    .modulate({
      hue: HUE_SHIFT,
      saturation: SATURATION,
      brightness: BRIGHTNESS,
    })
    .recomb(RECOMB)
    .linear(LINEAR_A, LINEAR_B);
}
