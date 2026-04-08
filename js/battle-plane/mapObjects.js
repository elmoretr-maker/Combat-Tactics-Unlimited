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

/** Small clutter does not block direct-fire LOS (barrels, crates). */
const LOS_SOFT_KINDS = new Set(["barrel", "crate"]);

/**
 * True if a map object on this cell blocks direct line of sight (buildings, trees, rocks, etc.).
 */
export function mapObjectInterruptsDirectLos(objects, x, y) {
  if (!objects?.length) return false;
  for (const o of objects) {
    if (o.x !== x || o.y !== y) continue;
    if (o.blocksLos === false) return false;
    const k = (o.visualKind || "").toLowerCase();
    if (LOS_SOFT_KINDS.has(k)) return false;
    return true;
  }
  return false;
}

/**
 * Movement block for rocks, ruins, buildings — not passable by any unit.
 * Trees are excluded (infantry may enter; vehicles are blocked in GameState.costAtForUnit).
 */
export function hardMapObjectBlocksAllUnits(objects, x, y) {
  if (!objects?.length) return false;
  for (const o of objects) {
    if (o.x !== x || o.y !== y) continue;
    if ((o.visualKind || "").toLowerCase() === "tree") continue;
    if (o.blocksMove !== false) return true;
  }
  return false;
}

export function mapObjectTreeAt(objects, x, y) {
  if (!objects?.length) return false;
  return objects.some(
    (o) =>
      o.x === x &&
      o.y === y &&
      (o.visualKind || "").toLowerCase() === "tree",
  );
}

/**
 * @param {string | null} sprite Asset path (optional if visualKind drives fallback art)
 * @param {"crate"|"barrel"|"ruins"|"tree"|"house"} [visualKind]
 * @param {{ sourceRect?: { x: number, y: number, w: number, h: number }, propAnchor?: "bottom"|"center", pyOffset?: number, blocksMove?: boolean, blocksLos?: boolean }} [extra]
 */
export function makeMapObject(x, y, sprite, id, visualKind = "crate", extra = null) {
  const o = {
    id: id || `obj_${x}_${y}_${Math.random().toString(36).slice(2, 7)}`,
    x,
    y,
    sprite: sprite || null,
    visualKind,
    blocksMove: extra?.blocksMove !== undefined ? !!extra.blocksMove : true,
    blocksLos: extra?.blocksLos !== undefined ? !!extra.blocksLos : true,
  };
  if (extra?.sourceRect) o.sourceRect = { ...extra.sourceRect };
  if (extra?.propAnchor === "bottom" || extra?.propAnchor === "center") {
    o.propAnchor = extra.propAnchor;
  }
  if (typeof extra?.pyOffset === "number" && Number.isFinite(extra.pyOffset)) {
    o.pyOffset = extra.pyOffset;
  }
  return o;
}
