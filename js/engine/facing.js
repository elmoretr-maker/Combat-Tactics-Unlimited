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

/** Wrap to (-π, π] for turret offset vs hull. */
export function normalizeAngleRad(a) {
  if (!Number.isFinite(a)) return 0;
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  if (x > Math.PI) x -= Math.PI * 2;
  return x;
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
 * Battle spawn only: owner 0 → faces right, owner 1 → faces left (not sprite defaults).
 * Idle / cursor / combat continue to use other helpers afterward.
 */
export function defaultFacingForOwner(owner) {
  return owner === 1 ? "left" : "right";
}

export function syncSpawnFacingFromTeam(unit) {
  if (!unit || unit.hp <= 0) return;
  unit.facing = defaultFacingForOwner(unit.owner);
  syncFacingAndFaceRad(unit);
}

/**
 * Face the nearest living opponent (Manhattan; tie-break on unit id).
 * If none, keeps existing facing or `"down"`.
 * @param {object} unit
 * @param {object[]} allUnits
 */
export function syncFacingTowardNearestEnemy(unit, allUnits) {
  if (!unit || unit.hp <= 0) return;
  let best = null;
  let bestD = Infinity;
  for (const o of allUnits) {
    if (!o || o.owner === unit.owner || o.hp <= 0) continue;
    const d = Math.abs(o.x - unit.x) + Math.abs(o.y - unit.y);
    if (d < bestD || (d === bestD && (!best || o.id < best.id))) {
      bestD = d;
      best = o;
    }
  }
  unit.facing = best
    ? computeFacing({ x: unit.x, y: unit.y }, { x: best.x, y: best.y })
    : unit.facing || defaultFacingForOwner(unit.owner);
  syncFacingAndFaceRad(unit);
  if (typeof unit.turretOffsetRad === "number") {
    unit.turretOffsetRad = 0;
  }
}

/**
 * On battle start: team-based facing only (spawn). Tactical facing during play
 * uses syncFacingTowardNearestEnemy, cursor aim, move steps, and attack targets.
 * @param {object[]} units
 */
export function initializeSpawnFacing(units) {
  for (const u of units) {
    if (!u || u.hp <= 0) continue;
    syncSpawnFacingFromTeam(u);
  }
}
