/**
 * Structured layout templates — produce initial terrain[y][x] before divider / tactical steps.
 * Placeholder land/water tokens ("plains", "water") are normalized to theme terrain in pipeline.js.
 */

import { mulberry32 } from "./rng.js";

export const MAP_TEMPLATES = {
  island_cluster: (width, height, seed) => {
    const terrain = [];

    for (let y = 0; y < height; y++) {
      terrain[y] = [];
      for (let x = 0; x < width; x++) {
        terrain[y][x] = "water";
      }
    }

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

  /** Small — tight cross of land in water */
  arena_cross: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("water"));

    for (let y = 2; y < h - 2; y++) {
      for (let x = Math.floor(w / 2) - 1; x <= Math.floor(w / 2) + 1; x++) {
        t[y][x] = "plains";
      }
    }

    for (let x = 2; x < w - 2; x++) {
      for (let y = Math.floor(h / 2) - 1; y <= Math.floor(h / 2) + 1; y++) {
        t[y][x] = "plains";
      }
    }

    return t;
  },

  /** Small — two land squares */
  small_dual_islands: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("water"));

    for (let i = 0; i < 2; i++) {
      const cx = i === 0 ? Math.floor(w * 0.3) : Math.floor(w * 0.7);
      const cy = Math.floor(h / 2);

      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x > 1 && x < w - 1 && y > 1 && y < h - 1) {
            t[y][x] = "plains";
          }
        }
      }
    }

    return t;
  },

  /** Medium — water moat in center */
  central_stronghold: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("plains"));

    for (let y = Math.floor(h / 2) - 2; y <= Math.floor(h / 2) + 2; y++) {
      for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) {
        t[y][x] = "water";
      }
    }

    return t;
  },

  /** Medium — three horizontal lanes; off-lane cells get sporadic water */
  three_lane_battle: (w, h, seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("plains"));
    const rnd = mulberry32(seed >>> 0);

    const lanes = [
      Math.floor(h * 0.25),
      Math.floor(h * 0.5),
      Math.floor(h * 0.75),
    ];

    for (let y = 0; y < h; y++) {
      if (!lanes.includes(y)) {
        for (let x = 0; x < w; x++) {
          if (rnd() < 0.3) t[y][x] = "water";
        }
      }
    }

    return t;
  },

  /** Large — several islands with seeded vertical jitter */
  island_cluster_large: (w, h, seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("water"));

    const islands = 5;

    for (let i = 0; i < islands; i++) {
      const cx = Math.floor(((i + 1) * w) / (islands + 1));
      const cyRnd = mulberry32((seed + i * 0x9e3779b1) >>> 0);
      const cy = Math.floor(h * (0.3 + 0.4 * cyRnd()));

      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let x = cx - 3; x <= cx + 3; x++) {
          if (x > 1 && x < w - 1 && y > 1 && y < h - 1) {
            t[y][x] = "plains";
          }
        }
      }
    }

    return t;
  },

  /** Large — hollow rectangle ring of land */
  ring_map: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("water"));

    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (y === 2 || y === h - 3 || x === 2 || x === w - 3) {
          t[y][x] = "plains";
        }
      }
    }

    return t;
  },

  /** Large — horizontal choke: water band except middle row */
  choke_valley: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("plains"));

    for (let y = 0; y < h; y++) {
      if (y !== Math.floor(h / 2)) {
        for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) {
          t[y][x] = "water";
        }
      }
    }

    return t;
  },

  /** Large — grid of water trenches */
  broken_grid: (w, h, _seed) => {
    const t = Array.from({ length: h }, () => Array(w).fill("plains"));

    for (let y = 2; y < h; y += 4) {
      for (let x = 0; x < w; x++) {
        t[y][x] = "water";
      }
    }

    for (let x = 2; x < w; x += 4) {
      for (let y = 0; y < h; y++) {
        t[y][x] = "water";
      }
    }

    return t;
  },
};
