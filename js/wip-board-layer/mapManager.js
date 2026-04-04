/**
 * Layered plane: battle-mat image under the tactical stack.
 * With `randomizeBattleMat`, picks grass / urban / desert per battle (seeded from scenario id).
 */
const THEME_TO_PLANE = {
  craftpixUrban: "urban",
  craftpixGrass: "grass",
  craftpixDesert: "desert",
};

const MAT_THEATERS = ["grass", "urban", "desert"];

function defaultPlaneKind(scenario) {
  const key = scenario?.visualTheme;
  if (key && THEME_TO_PLANE[key]) return THEME_TO_PLANE[key];
  return "grass";
}

export class MapManager {
  /**
   * @param {object} scenario Merged battle scenario (after load + merge).
   */
  constructor(scenario) {
    this.scenario = scenario;
    const mp = scenario.mapPlane || {};
    const randomize = scenario.randomizeBattleMat !== false && !!scenario.layeredPlane;
    if (randomize) {
      this.planeKind =
        MAT_THEATERS[Math.floor(Math.random() * MAT_THEATERS.length)];
      this.imagePath = `assets/maps/${this.planeKind}/base.png`;
    } else {
      this.planeKind = mp.kind || defaultPlaneKind(scenario);
      this.imagePath =
        mp.image || `assets/maps/${this.planeKind}/base.png`;
    }
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
  drawPlaneImage(ctx, x, y, w, h) {
    if (!this.planeReady) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.planeImg, x, y, w, h);
    ctx.restore();
  }
}
