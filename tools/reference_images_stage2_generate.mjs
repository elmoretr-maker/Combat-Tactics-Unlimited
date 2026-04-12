/**
 * Stage 2: add procedural reference PNGs to reference_images/ (new files only).
 * Run from repo root: node tools/reference_images_stage2_generate.mjs
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const REPO = process.cwd();
const REF = path.join(REPO, "reference_images");

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function noise01(x, y, s) {
  const t = Math.sin(x * 12.9898 + y * 78.233 + s * 0.001) * 43758.5453;
  return t - Math.floor(t);
}

async function writeRawPng(outPath, w, h, rgbaFn) {
  const buf = Buffer.alloc(w * h * 4);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { r, g, b, a } = rgbaFn(x, y);
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
      buf[i++] = a;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(outPath);
}

async function writeSvgPng(outPath, svg, w, h) {
  const buf = Buffer.from(svg);
  await sharp(buf).resize(w, h, { fit: "fill", kernel: sharp.kernel.nearest }).png({ compressionLevel: 9 }).toFile(outPath);
}

async function genUiMap() {
  const dir = path.join(REF, "ui_map");
  ensureDir(dir);
  const items = [
    [
      "ref_stage2_ui_map_minimap_round.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
 <rect width="320" height="320" fill="#1a2332"/>
        <circle cx="160" cy="160" r="118" fill="#2a3d2a" stroke="#c8d4e0" stroke-width="4"/>
        <rect x="120" y="100" width="80" height="60" fill="#4a5a4a" opacity="0.9"/>
        <path d="M160 60 L175 95 L145 95 Z" fill="#e74c3c"/>
        <circle cx="200" cy="190" r="10" fill="#f1c40f"/>
        <text x="160" y="280" text-anchor="middle" fill="#ecf0f1" font-size="14" font-family="sans-serif">MINIMAP</text>
      </svg>`,
    ],
    [
      "ref_stage2_ui_map_tactical_grid.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
        <rect width="320" height="320" fill="#0f1419"/>
        <g stroke="#3d5a73" stroke-width="1">
          ${Array.from({ length: 17 }, (_, i) => `<line x1="${i * 20}" y1="0" x2="${i * 20}" y2="320"/>`).join("")}
          ${Array.from({ length: 17 }, (_, i) => `<line x1="0" y1="${i * 20}" x2="320" y2="${i * 20}"/>`).join("")}
        </g>
        <rect x="140" y="140" width="40" height="40" fill="#c0392b" opacity="0.85"/>
        <rect x="60" y="80" width="24" height="24" fill="#2980b9"/>
        <text x="160" y="305" text-anchor="middle" fill="#bdc3c7" font-size="13" font-family="sans-serif">TACTICAL GRID</text>
      </svg>`,
    ],
    [
      "ref_stage2_ui_map_fog_wedge.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
        <rect width="320" height="320" fill="#2c3e50"/>
        <path d="M0 0 L320 0 L320 320 L0 320 Z" fill="#1b2631"/>
        <path d="M40 40 L280 40 L160 220 Z" fill="#5d6d7e" opacity="0.95"/>
        <circle cx="160" cy="120" r="8" fill="#e67e22"/>
        <text x="160" y="300" text-anchor="middle" fill="#ecf0f1" font-size="13" font-family="sans-serif">FOG OF WAR</text>
      </svg>`,
    ],
    [
      "ref_stage2_ui_map_overlay_frame.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
        <rect width="320" height="320" fill="#111820"/>
        <rect x="24" y="24" width="272" height="240" fill="#243342" stroke="#7f8c8d" stroke-width="3"/>
        <line x1="24" y1="84" x2="296" y2="84" stroke="#95a5a6" stroke-dasharray="6 4"/>
        <line x1="24" y1="144" x2="296" y2="144" stroke="#95a5a6" stroke-dasharray="6 4"/>
        <rect x="120" y="110" width="80" height="48" fill="#16a085" opacity="0.8"/>
        <text x="160" y="295" text-anchor="middle" fill="#ecf0f1" font-size="13" font-family="sans-serif">MAP OVERLAY</text>
      </svg>`,
    ],
    [
      "ref_stage2_ui_map_corner_inset.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
        <rect width="320" height="320" fill="#1e272e"/>
        <rect x="0" y="200" width="200" height="120" fill="#34495e" stroke="#ecf0f1" stroke-width="2"/>
        <path d="M200 200 L320 200 L320 320 L200 320 Z" fill="#2c2c2c" opacity="0.92"/>
        <circle cx="100" cy="260" r="6" fill="#2ecc71"/>
        <text x="100" y="215" text-anchor="middle" fill="#ecf0f1" font-size="11" font-family="sans-serif">INSET MAP</text>
      </svg>`,
    ],
    [
      "ref_stage2_ui_map_route_lines.png",
      320,
      320,
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
        <rect width="320" height="320" fill="#15202b"/>
        <path d="M40 260 L120 200 L200 220 L280 80" fill="none" stroke="#f39c12" stroke-width="4"/>
        <circle cx="40" cy="260" r="7" fill="#3498db"/>
        <circle cx="280" cy="80" r="7" fill="#e74c3c"/>
        <rect x="170" y="150" width="36" height="36" fill="#7f8c8d" opacity="0.7"/>
        <text x="160" y="305" text-anchor="middle" fill="#ecf0f1" font-size="12" font-family="sans-serif">ROUTE / ORDERS</text>
      </svg>`,
    ],
  ];
  for (const [name, w, h, svg] of items) {
    await writeSvgPng(path.join(dir, name), svg, w, h);
  }
  return items.length;
}

async function genBattleMap() {
  const dir = path.join(REF, "battle_map");
  ensureDir(dir);
  const w = 768;
  const h = 768;
  const specs = [
    ["ref_stage2_battle_urban.png", { r: 90, g: 95, b: 105 }, 18, 1, (x, y) => (x % 64 < 2 || y % 64 < 2 ? 40 : 0)],
    ["ref_stage2_battle_snow.png", { r: 230, g: 240, b: 250 }, 22, 2, () => 0],
    ["ref_stage2_battle_desert.png", { r: 210, g: 180, b: 120 }, 28, 3, (x, y) => (Math.sin(x * 0.02) + Math.sin(y * 0.015)) * 8],
    ["ref_stage2_battle_forest.png", { r: 35, g: 85, b: 45 }, 35, 4, (x, y) => (noise01(x, y, 4) > 0.92 ? 55 : 0)],
    ["ref_stage2_battle_coast.png", { r: 60, g: 120, b: 140 }, 30, 5, (x, y) => (y > h * 0.55 ? -25 : 15)],
    ["ref_stage2_battle_badlands.png", { r: 120, g: 85, b: 60 }, 32, 6, (x, y) => (noise01(x, y, 6) > 0.97 ? -40 : 0)],
  ];
  let n = 0;
  for (const [fname, base, varAmt, seed, extra] of specs) {
    await writeRawPng(path.join(dir, fname), w, h, (x, y) => {
      const n0 = noise01(x, y, seed) * varAmt + extra(x, y);
      const r = clamp(base.r + n0, 0, 255);
      const g = clamp(base.g + n0 * 0.9, 0, 255);
      const b = clamp(base.b + n0 * 0.85, 0, 255);
      return { r: r | 0, g: g | 0, b: b | 0, a: 255 };
    });
    n++;
  }
  const wide = await (async () => {
    const ww = 1024;
    const hh = 640;
    const out = path.join(dir, "ref_stage2_battle_mixed_biome_wide.png");
    await writeRawPng(out, ww, hh, (x, y) => {
      const left = x < ww * 0.35;
      const base = left ? { r: 40, g: 110, b: 60 } : x < ww * 0.7 ? { r: 200, g: 175, b: 110 } : { r: 55, g: 100, b: 130 };
      const v = noise01(x, y, 7) * 20;
      return {
        r: clamp(base.r + v, 0, 255) | 0,
        g: clamp(base.g + v * 0.95, 0, 255) | 0,
        b: clamp(base.b + v * 0.9, 0, 255) | 0,
        a: 255,
      };
    });
    return 1;
  })();
  return specs.length + wide;
}

async function genTerrain() {
  const dir = path.join(REF, "terrain");
  ensureDir(dir);
  const w = 256;
  const h = 256;
  const list = [
    ["ref_stage2_terrain_grass.png", { r: 55, g: 130, b: 65 }, 30, 11],
    ["ref_stage2_terrain_sand.png", { r: 210, g: 185, b: 130 }, 26, 12],
    ["ref_stage2_terrain_snow.png", { r: 235, g: 240, b: 245 }, 18, 13],
    ["ref_stage2_terrain_mud.png", { r: 85, g: 60, b: 40 }, 28, 14],
    ["ref_stage2_terrain_cracked_earth.png", { r: 165, g: 120, b: 75 }, 24, 15, true],
    ["ref_stage2_terrain_moss_rock.png", { r: 70, g: 95, b: 75 }, 22, 16, false, true],
  ];
  let n = 0;
  for (const row of list) {
    const [fname, base, varAmt, seed, cracks, moss] = row;
    await writeRawPng(path.join(dir, fname), w, h, (x, y) => {
      let v = noise01(x, y, seed) * varAmt;
      if (cracks && (noise01(x * 2, y * 2, seed + 1) > 0.965 || noise01(x, y, seed + 2) > 0.992)) {
        v -= 55;
      }
      if (moss && noise01(x, y, seed + 3) > 0.88) {
        v += 15;
      }
      return {
        r: clamp(base.r + v, 0, 255) | 0,
        g: clamp(base.g + v * 0.95, 0, 255) | 0,
        b: clamp(base.b + v * 0.9, 0, 255) | 0,
        a: 255,
      };
    });
    n++;
  }
  return n;
}

async function genTile() {
  const dir = path.join(REF, "tile");
  ensureDir(dir);
  const grass = { r: 70, g: 150, b: 80 };
  const dirt = { r: 140, g: 100, b: 65 };

  const corner32 = (x, y) => {
    const cx = x >= 16 && y >= 16;
    const t = noise01(x, y, 50) * 10;
    const b = cx ? grass : dirt;
    return { r: clamp(b.r + t, 0, 255) | 0, g: clamp(b.g + t, 0, 255) | 0, b: clamp(b.b + t, 0, 255) | 0, a: 255 };
  };
  const edge32 = (x, y) => {
    const topGrass = y < 16;
    const b = topGrass ? grass : dirt;
    const t = noise01(x, y, 51) * 8;
    return { r: clamp(b.r + t, 0, 255) | 0, g: clamp(b.g + t, 0, 255) | 0, b: clamp(b.b + t, 0, 255) | 0, a: 255 };
  };
  const fill32 = (x, y) => {
    const t = noise01(x, y, 52) * 14;
    return { r: clamp(grass.r + t, 0, 255) | 0, g: clamp(grass.g + t, 0, 255) | 0, b: clamp(grass.b + t, 0, 255) | 0, a: 255 };
  };
  const trans32 = (x, y) => {
    const a = x / 32;
    const b = {
      r: dirt.r * (1 - a) + grass.r * a,
      g: dirt.g * (1 - a) + grass.g * a,
      bl: dirt.b * (1 - a) + grass.b * a,
    };
    const t = noise01(x, y, 53) * 10;
    return { r: clamp(b.r + t, 0, 255) | 0, g: clamp(b.g + t, 0, 255) | 0, b: clamp(b.bl + t, 0, 255) | 0, a: 255 };
  };

  await writeRawPng(path.join(dir, "ref_stage2_tile_32_corner_grass_dirt.png"), 32, 32, corner32);
  await writeRawPng(path.join(dir, "ref_stage2_tile_32_edge_transition.png"), 32, 32, edge32);
  await writeRawPng(path.join(dir, "ref_stage2_tile_32_fill_grass.png"), 32, 32, fill32);
  await writeRawPng(path.join(dir, "ref_stage2_tile_32_gradient_transition.png"), 32, 32, trans32);

  const water = { r: 50, g: 110, b: 160 };
  const sand = { r: 210, g: 190, b: 130 };
  const c16 = (x, y) => {
    const cx = x >= 8 && y >= 8;
    const b = cx ? water : sand;
    const t = noise01(x, y, 60) * 6;
    return { r: clamp(b.r + t, 0, 255) | 0, g: clamp(b.g + t, 0, 255) | 0, b: clamp(b.b + t, 0, 255) | 0, a: 255 };
  };
  const f16 = (x, y) => {
    const t = noise01(x, y, 61) * 8;
    return { r: clamp(sand.r + t, 0, 255) | 0, g: clamp(sand.g + t, 0, 255) | 0, b: clamp(sand.b + t, 0, 255) | 0, a: 255 };
  };
  await writeRawPng(path.join(dir, "ref_stage2_tile_16_corner_water_sand.png"), 16, 16, c16);
  await writeRawPng(path.join(dir, "ref_stage2_tile_16_fill_sand.png"), 16, 16, f16);
  return 6;
}

async function genWater() {
  const dir = path.join(REF, "water");
  ensureDir(dir);
  await writeRawPng(path.join(dir, "ref_stage2_water_river_horizontal.png"), 384, 128, (x, y) => {
    const bank = y < 18 || y > 110;
    if (bank) {
      const b = { r: 120, g: 100, b: 70 };
      const t = noise01(x, y, 70) * 15;
      return { r: clamp(b.r + t, 0, 255) | 0, g: clamp(b.g + t, 0, 255) | 0, b: clamp(b.b + t, 0, 255) | 0, a: 255 };
    }
    const deep = x / 384;
    const base = { r: 30 + deep * 30, g: 90 + deep * 20, b: 150 + deep * 30 };
    const t = noise01(x, y, 71) * 12;
    return { r: clamp(base.r + t, 0, 255) | 0, g: clamp(base.g + t, 0, 255) | 0, b: clamp(base.b + t, 0, 255) | 0, a: 255 };
  });

  await writeRawPng(path.join(dir, "ref_stage2_water_ocean_deep.png"), 256, 256, (x, y) => {
    const base = { r: 15, g: 60, b: 120 };
    const t = noise01(x, y, 72) * 18;
    return { r: clamp(base.r + t, 0, 255) | 0, g: clamp(base.g + t, 0, 255) | 0, b: clamp(base.b + t * 1.1, 0, 255) | 0, a: 255 };
  });

  await writeRawPng(path.join(dir, "ref_stage2_water_shoreline_diagonal.png"), 256, 256, (x, y) => {
    const t = (x + y) / 512;
    const sand = { r: 210, g: 185, b: 130 };
    const sea = { r: 40, g: 110, b: 155 };
    const mix = t > 0.48 ? sea : sand;
    const n = noise01(x, y, 73) * 14;
    const k = t > 0.45 && t < 0.52 ? 20 : 0;
    return {
      r: clamp(mix.r + n - k, 0, 255) | 0,
      g: clamp(mix.g + n - k, 0, 255) | 0,
      b: clamp(mix.b + n, 0, 255) | 0,
      a: 255,
    };
  });

  await writeRawPng(path.join(dir, "ref_stage2_water_shallow.png"), 256, 256, (x, y) => {
    const base = { r: 90, g: 170, b: 195 };
    const t = noise01(x, y, 74) * 16;
    return { r: clamp(base.r + t, 0, 255) | 0, g: clamp(base.g + t, 0, 255) | 0, b: clamp(base.b + t, 0, 255) | 0, a: 255 };
  });

  await writeRawPng(path.join(dir, "ref_stage2_water_ripples.png"), 256, 256, (x, y) => {
    const w = Math.sin(x * 0.12) * Math.cos(y * 0.1) * 18;
    const base = { r: 45, g: 115, b: 165 };
    const t = noise01(x, y, 75) * 10 + w;
    return { r: clamp(base.r + t, 0, 255) | 0, g: clamp(base.g + t, 0, 255) | 0, b: clamp(base.b + t, 0, 255) | 0, a: 255 };
  });

  await writeRawPng(path.join(dir, "ref_stage2_water_foam_caps.png"), 256, 256, (x, y) => {
    const base = { r: 50, g: 120, b: 170 };
    const foam = noise01(x * 3, y * 3, 76) > 0.88;
    if (foam) return { r: 230, g: 240, b: 250, a: 255 };
    const t = noise01(x, y, 77) * 12;
    return { r: clamp(base.r + t, 0, 255) | 0, g: clamp(base.g + t, 0, 255) | 0, b: clamp(base.b + t, 0, 255) | 0, a: 255 };
  });

  return 6;
}

async function genUiHud() {
  const dir = path.join(REF, "ui_hud");
  ensureDir(dir);
  const items = [
    [
      "ref_stage2_hud_health_bars.png",
      420,
      120,
      `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120">
        <rect width="420" height="120" fill="#1a1a1a"/>
        <text x="20" y="28" fill="#ecf0f1" font-size="14" font-family="sans-serif">HP</text>
        <rect x="60" y="14" width="320" height="22" fill="#2c2c2c" stroke="#7f8c8d"/>
        <rect x="62" y="16" width="220" height="18" fill="#27ae60"/>
        <text x="20" y="58" fill="#ecf0f1" font-size="14" font-family="sans-serif">ARMOR</text>
        <rect x="60" y="44" width="320" height="18" fill="#2c2c2c" stroke="#7f8c8d"/>
        <rect x="62" y="46" width="140" height="14" fill="#3498db"/>
        <text x="20" y="88" fill="#ecf0f1" font-size="14" font-family="sans-serif">STAMINA</text>
        <rect x="60" y="74" width="320" height="16" fill="#2c2c2c" stroke="#7f8c8d"/>
        <rect x="62" y="76" width="260" height="12" fill="#f1c40f"/>
      </svg>`,
    ],
    [
      "ref_stage2_hud_ammo_cluster.png",
      380,
      100,
      `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="100">
        <rect width="380" height="100" fill="#0d1117"/>
        <text x="20" y="40" fill="#ecf0f1" font-size="22" font-family="monospace">30 / 120</text>
        <text x="20" y="72" fill="#95a5a6" font-size="14" font-family="sans-serif">AMMO</text>
        <rect x="200" y="20" width="140" height="56" fill="#1f2933" stroke="#5c6773"/>
        <text x="220" y="55" fill="#e74c3c" font-size="20" font-family="monospace">RPG</text>
      </svg>`,
    ],
    [
      "ref_stage2_hud_minimal_strip.png",
      480,
      36,
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="36">
        <rect width="480" height="36" fill="#111"/>
        <rect x="8" y="10" width="200" height="14" fill="#222" stroke="#444"/>
        <rect x="10" y="12" width="120" height="10" fill="#0f0"/>
        <text x="230" y="22" fill="#ccc" font-size="12" font-family="sans-serif">OBJ — SECURE</text>
      </svg>`,
    ],
    [
      "ref_stage2_hud_complex_frame.png",
      520,
      200,
      `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="200">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d4f5f"/><stop offset="1" stop-color="#1c2430"/></linearGradient></defs>
        <rect width="520" height="200" fill="#0b0f14"/>
        <rect x="12" y="12" width="496" height="176" fill="url(#g)" stroke="#7f8c8d" stroke-width="2"/>
        <rect x="28" y="28" width="200" height="64" fill="#1a222b" stroke="#566573"/>
        <rect x="28" y="104" width="464" height="68" fill="#141c24" stroke="#566573"/>
        <circle cx="420" cy="60" r="22" fill="#2ecc71" opacity="0.3" stroke="#2ecc71"/>
        <text x="40" y="58" fill="#ecf0f1" font-size="13" font-family="sans-serif">UNIT PANEL</text>
      </svg>`,
    ],
    [
      "ref_stage2_hud_orders_queue.png",
      440,
      140,
      `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="140">
        <rect width="440" height="140" fill="#151b22"/>
        <text x="16" y="28" fill="#bdc3c7" font-size="13" font-family="sans-serif">ORDERS</text>
        <rect x="16" y="40" width="400" height="28" fill="#1f2a36" stroke="#5d6d7e"/>
        <rect x="16" y="76" width="400" height="28" fill="#1f2a36" stroke="#5d6d7e"/>
        <rect x="16" y="112" width="400" height="22" fill="#1f2a36" stroke="#5d6d7e"/>
        <circle cx="36" cy="54" r="6" fill="#3498db"/>
        <circle cx="36" cy="90" r="6" fill="#e67e22"/>
      </svg>`,
    ],
    [
      "ref_stage2_hud_target_reticle.png",
      300,
      300,
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
        <rect width="300" height="300" fill="#0e1114"/>
        <circle cx="150" cy="150" r="90" fill="none" stroke="#e74c3c" stroke-width="3" stroke-dasharray="10 6"/>
        <line x1="150" y1="40" x2="150" y2="90" stroke="#ecf0f1" stroke-width="2"/>
        <line x1="150" y1="210" x2="150" y2="260" stroke="#ecf0f1" stroke-width="2"/>
        <line x1="40" y1="150" x2="90" y2="150" stroke="#ecf0f1" stroke-width="2"/>
        <line x1="210" y1="150" x2="260" y2="150" stroke="#ecf0f1" stroke-width="2"/>
        <rect x="130" y="130" width="40" height="40" fill="#c0392b" opacity="0.85"/>
      </svg>`,
    ],
  ];
  for (const [name, w, h, svg] of items) {
    await writeSvgPng(path.join(dir, name), svg, w, h);
  }
  return items.length;
}

async function genUnit() {
  const dir = path.join(REF, "unit");
  ensureDir(dir);
  const items = [
    [
      "ref_stage2_unit_soldier_blue.png",
      128,
      128,
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
        <rect width="128" height="128" fill="#2a2f35"/>
        <ellipse cx="64" cy="72" rx="22" ry="14" fill="#2980b9"/>
        <circle cx="64" cy="48" r="14" fill="#3498db"/>
        <rect x="58" y="62" width="12" height="22" fill="#1f618d"/>
      </svg>`,
    ],
    [
      "ref_stage2_unit_enemy_red.png",
      128,
      128,
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
        <rect width="128" height="128" fill="#241a1a"/>
        <ellipse cx="64" cy="76" rx="26" ry="16" fill="#922b21"/>
        <circle cx="64" cy="46" r="16" fill="#c0392b"/>
        <path d="M64 62 L78 88 L50 88 Z" fill="#7b241c"/>
      </svg>`,
    ],
    [
      "ref_stage2_unit_heavy_wide.png",
      160,
      128,
      `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="128">
        <rect width="160" height="128" fill="#1e272e"/>
        <rect x="30" y="52" width="100" height="44" rx="6" fill="#566573"/>
        <rect x="50" y="36" width="60" height="24" fill="#7f8c8d"/>
        <rect x="20" y="70" width="22" height="18" fill="#34495e"/>
        <rect x="118" y="70" width="22" height="18" fill="#34495e"/>
      </svg>`,
    ],
    [
      "ref_stage2_unit_scout_small.png",
      96,
      96,
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
        <rect width="96" height="96" fill="#222831"/>
        <circle cx="48" cy="52" r="10" fill="#1abc9c"/>
        <path d="M48 42 L58 52 L48 62 L38 52 Z" fill="#16a085"/>
      </svg>`,
    ],
    [
      "ref_stage2_unit_medic_cross.png",
      128,
      128,
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
        <rect width="128" height="128" fill="#2c2c2c"/>
        <ellipse cx="64" cy="74" rx="20" ry="13" fill="#ecf0f1"/>
        <circle cx="64" cy="48" r="13" fill="#bdc3c7"/>
        <rect x="58" y="40" width="12" height="40" fill="#e74c3c"/>
        <rect x="48" y="52" width="32" height="12" fill="#e74c3c"/>
      </svg>`,
    ],
    [
      "ref_stage2_unit_sniper_elongated.png",
      96,
      160,
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="160">
        <rect width="96" height="160" fill="#1b2026"/>
        <rect x="40" y="24" width="10" height="110" fill="#5d6d7e"/>
        <circle cx="45" cy="20" r="9" fill="#95a5a6"/>
        <rect x="18" y="80" width="34" height="8" fill="#34495e"/>
      </svg>`,
    ],
  ];
  for (const [name, w, h, svg] of items) {
    await writeSvgPng(path.join(dir, name), svg, w, h);
  }
  return items.length;
}

async function main() {
  if (!fs.existsSync(REF)) {
    console.error("Missing", REF);
    process.exit(1);
  }
  const summary = {};
  summary.ui_map = await genUiMap();
  summary.battle_map = await genBattleMap();
  summary.terrain = await genTerrain();
  summary.tile = await genTile();
  summary.water = await genWater();
  summary.ui_hud = await genUiHud();
  summary.unit = await genUnit();
  console.log(JSON.stringify({ generated: summary, total: Object.values(summary).reduce((a, b) => a + b, 0) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
