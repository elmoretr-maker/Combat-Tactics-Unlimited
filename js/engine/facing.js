/**
 * Cardinal facing for units (map grid: +y is down).
 * @typedef {"up"|"down"|"left"|"right"} UnitFacing
 */

/**
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @returns {UnitFacing}
 */
export function computeFacing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "down" : "up";
}

/**
 * Matches `Math.atan2(to.y - from.y, to.x - from.x)` for pure cardinals.
 * @param {UnitFacing} facing
 * @returns {number}
 */
export function facingToFaceRad(facing) {
  switch (facing) {
    case "right":
      return 0;
    case "down":
      return Math.PI / 2;
    case "left":
      return Math.PI;
    case "up":
    default:
      return -Math.PI / 2;
  }
}

/**
 * Top-down sprites rotate with `faceRad`; keep it aligned with `unit.facing`.
 * @param {{ mapRenderMode?: string, facing?: string, faceRad?: number }} unit
 */
export function syncFacingAndFaceRad(unit) {
  if (unit.mapRenderMode === "topdown" && unit.facing) {
    unit.faceRad = facingToFaceRad(unit.facing);
  }
}

/**
 * On battle start: face the nearest living enemy (Manhattan), else `"down"`.
 * @param {object[]} units
 */
export function initializeSpawnFacing(units) {
  for (const u of units) {
    if (!u || u.hp <= 0) continue;
    let best = null;
    let bestD = Infinity;
    for (const o of units) {
      if (!o || o.owner === u.owner || o.hp <= 0) continue;
      const d = Math.abs(o.x - u.x) + Math.abs(o.y - u.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    u.facing = best ? computeFacing({ x: u.x, y: u.y }, { x: best.x, y: best.y }) : "down";
    syncFacingAndFaceRad(u);
  }
}
