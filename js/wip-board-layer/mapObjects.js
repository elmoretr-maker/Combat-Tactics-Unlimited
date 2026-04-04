/**
 * Placed battlefield props (crates, barrels, ruins). Authoritative for scatter obstacles:
 * blocks movement and line-of-sight independent of base terrain type under the cell.
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

export function makeMapObject(x, y, sprite, id) {
  return {
    id: id || `obj_${x}_${y}_${Math.random().toString(36).slice(2, 7)}`,
    x,
    y,
    sprite,
    blocksMove: true,
    blocksLos: true,
  };
}
