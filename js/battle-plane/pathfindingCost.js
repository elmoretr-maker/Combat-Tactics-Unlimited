/** Impassable cost for A* / reachability (not entered into distance sums). */
export const BLOCKED_MOVE_COST = Number.POSITIVE_INFINITY;

export function isBlockedMoveCost(c) {
  return c === BLOCKED_MOVE_COST || !Number.isFinite(c) || c > 1e100;
}
