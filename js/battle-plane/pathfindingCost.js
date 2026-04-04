/** Impassable cost for A* / reachability (matches terrain `blocksMove` tiles). */
export const BLOCKED_MOVE_COST = 99;

export function isBlockedMoveCost(c) {
  return !Number.isFinite(c) || c >= BLOCKED_MOVE_COST;
}
