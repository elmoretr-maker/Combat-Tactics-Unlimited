import { hasLineOfSight } from "./los.js";

/**
 * Chebyshev distance: max(|dx|, |dy|).
 * Allows diagonal attacks — a unit with rangeMax:1 can hit all 8 surrounding tiles.
 */
function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * @param {object} attacker
 * @param {object} target
 * @param {object[]} allUnits
 * @param {{ grid?, tileTypes?, sightBudget? } | null} losCtx
 */
export function canAttack(attacker, target, allUnits, losCtx) {
  if (target.owner === attacker.owner) return false;
  if (target.hp <= 0) return false;

  const d  = chebyshev(attacker.x, attacker.y, target.x, target.y);
  const lo = attacker.rangeMin  ?? 1;
  const hi = attacker.rangeMax  ?? 1;
  const ds = attacker.deadspace ?? 0;
  if (d <= ds)         return false;
  if (d < lo || d > hi) return false;

  /* Per-unit sight range check (if defined) */
  const sightRange = attacker.sightRange;
  if (sightRange != null && Number.isFinite(sightRange)) {
    if (d > sightRange) return false;
  }

  const atkType = attacker.attackType || "direct";
  if (atkType === "direct" && losCtx?.grid && losCtx?.tileTypes) {
    const sightBudget =
      losCtx.sightBudget != null && Number.isFinite(losCtx.sightBudget)
        ? losCtx.sightBudget
        : Infinity;
    if (
      !hasLineOfSight(
        losCtx.grid,
        losCtx.tileTypes,
        attacker.x, attacker.y,
        target.x,   target.y,
        { sightBudget, mapObjects: losCtx.mapObjects }
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve one attack hit.
 * Returns actual damage dealt.
 * defenseBonus (0–1) from terrain reduces damage multiplicatively.
 */
export function resolveAttack(attacker, target, losCtx) {
  let dmg = attacker.damage ?? 20;
  const arm = target.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));

  /* Terrain defense bonus */
  const defBonus = getDefenseBonus(target, losCtx);
  if (defBonus > 0) {
    dmg = Math.max(1, Math.round(dmg * (1 - defBonus)));
  }

  target.hp -= dmg;
  return dmg;
}

/**
 * Counter-attack: the struck unit fires back at 60% power if ALL conditions hold:
 *  1. unit.canCounter === true  (explicit per-unit flag; indirect units, medics, etc. set false)
 *  2. defender is still alive after being hit
 *  3. defender has NOT already attacked this turn
 *  4. attacker is within defender's weapon range (range min/max, sight range, LOS all apply)
 *  5. defender uses direct fire (indirect units physically cannot snap-return fire)
 *
 * Units with canCounter = false (mortar, artillery, medic) never return fire.
 * Returns actual HP removed from attacker (0 if no counter fired).
 */
export function resolveCounter(attacker, defender, losCtx) {
  if (defender.hp <= 0) return 0;
  /* Explicit opt-out — medic, mortar, artillery, etc. */
  if (defender.canCounter === false) return 0;
  if (defender.attackedThisTurn) return 0;

  const defType = defender.attackType || "direct";
  if (defType !== "direct") return 0;

  /* Attacker must be within defender's own weapon range */
  if (!canAttack(defender, attacker, [], losCtx)) return 0;

  let dmg = Math.round((defender.damage ?? 20) * 0.6);
  const arm = attacker.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));

  const defBonus = getDefenseBonus(attacker, losCtx);
  if (defBonus > 0) {
    dmg = Math.max(1, Math.round(dmg * (1 - defBonus)));
  }

  attacker.hp -= dmg;
  return dmg;
}

/** Pull defenseBonus from the terrain the unit is standing on. */
function getDefenseBonus(unit, losCtx) {
  if (!losCtx?.grid || !losCtx?.tileTypes) return 0;
  const grid = losCtx.grid;
  const tileTypes = losCtx.tileTypes;
  if (unit.x < 0 || unit.y < 0 || unit.x >= grid.width || unit.y >= grid.height) return 0;
  const terrainType = grid.cells[unit.y][unit.x];
  const info = tileTypes[terrainType];
  return Number(info?.defenseBonus) || 0;
}
