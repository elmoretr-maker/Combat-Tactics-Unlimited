/**
 * Structured layout templates — produce initial terrain[y][x] before divider / tactical steps.
 * Placeholder land/water tokens ("plains", "water") are normalized to theme terrain in pipeline.js.
 */

export const MAP_TEMPLATES = {
  island_cluster: (width, height, seed) => {
    const terrain = [];

    // fill with water first
    for (let y = 0; y < height; y++) {
      terrain[y] = [];
      for (let x = 0; x < width; x++) {
        terrain[y][x] = "water";
      }
    }

    // simple island blobs
    const islands = 3 + (seed % 3);

    for (let i = 0; i < islands; i++) {
      const cx = Math.floor(((i + 1) * width) / (islands + 1));
      const cy = Math.floor(height / 2);
      const radius = 2 + (seed % 3);

      for (let y = cy - radius; y <= cy + radius; y++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
          if (x > 1 && x < width - 1 && y > 1 && y < height - 1) {
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy <= radius * radius) {
              terrain[y][x] = "plains";
            }
          }
        }
      }
    }

    return terrain;
  },
};
