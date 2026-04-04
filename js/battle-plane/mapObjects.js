/**
 * Placed battlefield props (crates, barrels, ruins). Blocks movement and LOS
 * independent of base terrain when `game.mapObjects` is populated.
 */

/** @param {{ x: number, y: number, blocksMove?: boolean, blocksLos?: boolean }[]} objects */
export function mapObjectBlocksMoveAt(objects, x, y) {
  if (!objects?.length) return false;
  return objects.some(
    (o) => o.x === x && o.y === y && o.blocksMove !== false,
  );
}

/** @param {{ x: number, y: number, blocksLos?: boolean }[]} objects */
export function mapObjectBlocksLosAt(objects, x, y) {
  if (!objects?.length) return false;
  return objects.some(
    (o) => o.x === x && o.y === y && o.blocksLos !== false,
  );
}

/**
 * @param {string | null} sprite Asset path (optional if visualKind drives fallback art)
 * @param {"crate"|"barrel"|"ruins"|"tree"|"house"} [visualKind]
 */
export function makeMapObject(x, y, sprite, id, visualKind = "crate") {
  return {
    id: id || `obj_${x}_${y}_${Math.random().toString(36).slice(2, 7)}`,
    x,
    y,
    sprite: sprite || null,
    visualKind,
    blocksMove: true,
    blocksLos: true,
  };
}
