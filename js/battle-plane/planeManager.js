/**
 * Loads `assets/maps/<theater>/base.png` (or scenario override) and draws
 * mat + darken overlay. Used only when `battlePlaneLayer.enabled`.
 */

const DEFAULT_THEATERS = ["grass", "urban", "desert"];

export function isBattlePlaneEnabled(scenario) {
  return !!(scenario?.battlePlaneLayer?.enabled);
}

export class BattlePlaneManager {
  /**
   * @param {object} scenario Merged battle scenario
   */
  constructor(scenario) {
    this.scenario = scenario;
    const bpl = scenario.battlePlaneLayer || {};
    this.overlayAlpha =
      typeof bpl.overlayAlpha === "number" ? bpl.overlayAlpha : 0.2;

    let kind = bpl.theater;
    if (!kind || typeof kind !== "string") {
      if (bpl.randomizeTheater !== false) {
        kind =
          DEFAULT_THEATERS[
            Math.floor(Math.random() * DEFAULT_THEATERS.length)
          ];
      } else {
        kind = "grass";
      }
    }
    this.planeKind = kind;
    this.imagePath =
      bpl.matImage || `assets/maps/${kind}/base.png`;
    this.planeImg = new Image();
    this.planeReady = false;
  }

  /** @returns {Promise<void>} */
  loadPlane() {
    return new Promise((resolve) => {
      const done = () => resolve();
      this.planeImg.onload = () => {
        this.planeReady =
          !!this.planeImg.naturalWidth && !!this.planeImg.naturalHeight;
        done();
      };
      this.planeImg.onerror = () => {
        this.planeReady = false;
        done();
      };
      this.planeImg.src = this.imagePath;
    });
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  drawMatAndOverlay(ctx, x, y, w, h) {
    if (this.planeReady) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.planeImg, x, y, w, h);
      ctx.restore();
    }
    const a = Math.max(0, Math.min(1, this.overlayAlpha));
    if (a > 0) {
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(x, y, w, h);
    }
  }
}
