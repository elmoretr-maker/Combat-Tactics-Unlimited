/**
 * Obstacle cover for damage (tree / rock / wall-like props and forest terrain).
 */
const COVER_VISUAL_KINDS = new Set([
  "tree",
  "rock",
  "wall",
  "ruins",
  "house",
]);

function capitalizeKind(k) {
  if (!k) return "Cover";
  const s = String(k);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function obstacleCoverNameAt(grid, tileTypes, mapObjects, x, y) {
  if (!grid?.cells?.[y]) return null;
  const terrainType = grid.cells[y][x];
  if (terrainType === "forest") return "Forest";

  if (mapObjects?.length) {
    for (const o of mapObjects) {
      if (o.x !== x || o.y !== y) continue;
      const k = (o.visualKind || "").toLowerCase();
      if (COVER_VISUAL_KINDS.has(k)) return capitalizeKind(o.visualKind || k);
    }
  }

  const tt = tileTypes?.[terrainType];
  if (terrainType === "building_block" || terrainType === "cp_building") {
    return tt?.displayName || "Building";
  }

  return null;
}

export const OBSTACLE_COVER_DAMAGE_FACTOR = 0.7;
