import { hasLineOfSight, isIndirectDeadzoneBlock } from "./los.js";
import {
  obstacleCoverNameAt,
  OBSTACLE_COVER_DAMAGE_FACTOR,
} from "../battle-plane/cover.js";

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
  const useLos =
    atkType === "direct" && attacker.usesLos !== false;
  if (useLos && losCtx?.grid && losCtx?.tileTypes) {
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

  if (atkType === "indirect" && losCtx?.grid && losCtx?.tileTypes) {
    if (
      isIndirectDeadzoneBlock(
        losCtx.grid,
        losCtx.tileTypes,
        attacker.x,
        attacker.y,
        target.x,
        target.y,
        { mapObjects: losCtx.mapObjects },
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

  let protectedBy = null;
  if (losCtx?.grid && losCtx?.tileTypes) {
    const coverName = obstacleCoverNameAt(
      losCtx.grid,
      losCtx.tileTypes,
      losCtx.mapObjects,
      target.x,
      target.y,
    );
    if (coverName) {
      protectedBy = coverName;
      dmg = Math.max(1, Math.round(dmg * OBSTACLE_COVER_DAMAGE_FACTOR));
    }
  }

  target.hp -= dmg;
  return { dmg, protectedBy };
}

/**
 * Counter-attack: defender fires back at 60% power only if specialAbility is Counter-Attack
 * (after being struck; same range / LOS / sight rules as canAttack).
 */
export function resolveCounter(attacker, defender, losCtx) {
  if (defender.hp <= 0) return { dmg: 0, protectedBy: null };
  if (defender.specialAbility !== "Counter-Attack")
    return { dmg: 0, protectedBy: null };
  if (defender.attackedThisTurn) return { dmg: 0, protectedBy: null };

  const defType = defender.attackType || "direct";
  if (defType !== "direct") return { dmg: 0, protectedBy: null };

  /* Attacker must be within defender's own weapon range */
  if (!canAttack(defender, attacker, [], losCtx))
    return { dmg: 0, protectedBy: null };

  let dmg = Math.round((defender.damage ?? 20) * 0.6);
  const arm = attacker.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));

  const defBonus = getDefenseBonus(attacker, losCtx);
  if (defBonus > 0) {
    dmg = Math.max(1, Math.round(dmg * (1 - defBonus)));
  }

  let protectedBy = null;
  if (losCtx?.grid && losCtx?.tileTypes) {
    const coverName = obstacleCoverNameAt(
      losCtx.grid,
      losCtx.tileTypes,
      losCtx.mapObjects,
      attacker.x,
      attacker.y,
    );
    if (coverName) {
      protectedBy = coverName;
      dmg = Math.max(1, Math.round(dmg * OBSTACLE_COVER_DAMAGE_FACTOR));
    }
  }

  attacker.hp -= dmg;
  return { dmg, protectedBy };
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
