export function buildTerrainGrid(scenario, tileConfig) {
  const w = scenario.width;
  const h = scenario.height;
  const def = tileConfig.defaultType || "plains";
  const cells = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      let t = def;
      if (scenario.terrain && scenario.terrain[y] && scenario.terrain[y][x]) {
        t = scenario.terrain[y][x];
      }
      row.push(t);
    }
    cells.push(row);
  }
  return { width: w, height: h, cells, cellSize: scenario.cellSize || 48 };
}

export function moveCostAt(grid, tileTypes, x, y) {
  const type = grid.cells[y][x];
  if (!tileTypes[type]) {
    console.warn(`[terrain] Unknown terrain type "${type}" at (${x},${y}) — defaulting to impassable`);
    return 99;
  }
  const info = tileTypes[type];
  if (info.blocksMove) return 99;
  return info.moveCost ?? 1;
}

/**
 * @param {"infantry"|"vehicle"} movementClass
 */
export function moveCostAtForClass(grid, tileTypes, x, y, movementClass) {
  const type = grid.cells[y][x];
  if (!tileTypes[type]) {
    console.warn(`[terrain] Unknown terrain type "${type}" at (${x},${y}) — defaulting to impassable`);
    return 99;
  }
  const info = tileTypes[type];
  if (info.blocksMove) return 99;
  if (movementClass === "vehicle" && type === "forest") return 99;
  return info.moveCost ?? 1;
}

export function terrainColor(tileTypes, type) {
  const info = tileTypes[type];
  if (!info) {
    console.warn(`[terrain] Unknown terrain type "${type}" in terrainColor — using fallback`);
    return "#445544";
  }
  return info.color || "#445544";
}
