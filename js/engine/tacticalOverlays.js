import { chebyshev } from "./grid.js";
import { hasLineOfSight, isIndirectDeadzoneBlock } from "./los.js";

/**
 * Weapon-range tactical overlay for the selected attacker (Chebyshev ring).
 * Does not check for enemy presence — only geometry + LOS / deadzone rules.
 *
 * @returns {{
 *   weaponBand: Set<string>,
 *   losBlocked: Set<string>,
 *   cannotHit: Set<string>,
 * }}
 */
export function computeAttackRangeOverlay(sel, game) {
  const weaponBand = new Set();
  const losBlocked = new Set();
  const cannotHit = new Set();

  if (!sel || !game?.grid || !game.tileTypes) {
    return { weaponBand, losBlocked, cannotHit };
  }

  const ax = sel.x;
  const ay = sel.y;
  const lo = sel.rangeMin ?? 1;
  const hi = sel.rangeMax ?? 1;
  const ds = sel.deadspace ?? 0;
  const atkType = sel.attackType || "direct";
  const grid = game.grid;
  const tileTypes = game.tileTypes;
  const losCtx = game.losCtx();
  const budget =
    losCtx.sightBudget != null && Number.isFinite(losCtx.sightBudget)
      ? losCtx.sightBudget
      : Infinity;
  const mapObjects = losCtx.mapObjects;
  const sr = sel.sightRange;

  const w = grid.width;
  const h = grid.height;

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (tx === ax && ty === ay) continue;
      const d = chebyshev(ax, ay, tx, ty);
      if (d < lo || d > hi) continue;
      const k = `${tx},${ty}`;
      weaponBand.add(k);

      if (d <= ds) {
        cannotHit.add(k);
        continue;
      }
      if (sr != null && Number.isFinite(sr) && d > sr) {
        cannotHit.add(k);
        continue;
      }

      if (atkType === "indirect") {
        if (
          isIndirectDeadzoneBlock(grid, tileTypes, ax, ay, tx, ty, {
            mapObjects,
          })
        ) {
          cannotHit.add(k);
        }
        continue;
      }

      if (sel.usesLos === false) continue;
      if (
        !hasLineOfSight(grid, tileTypes, ax, ay, tx, ty, {
          sightBudget: budget,
          mapObjects,
        })
      ) {
        losBlocked.add(k);
      }
    }
  }

  return { weaponBand, losBlocked, cannotHit };
}
