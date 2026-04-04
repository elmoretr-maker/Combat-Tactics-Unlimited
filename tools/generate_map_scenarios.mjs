/**
 * One-shot generator: writes js/config/scenarios/maps/*.json and mapCatalog.json entries.
 * Run: node tools/generate_map_scenarios.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "js", "config", "scenarios", "maps");
fs.mkdirSync(outDir, { recursive: true });

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function empty(w, h, t) {
  return Array.from({ length: h }, () => Array(w).fill(t));
}

function borderRoads(g, w, h) {
  for (let x = 0; x < w; x++) {
    g[0][x] = "cp_road";
    g[h - 1][x] = "cp_road";
  }
  for (let y = 0; y < h; y++) {
    g[y][0] = "cp_road";
    g[y][w - 1] = "cp_road";
  }
}

function genUrban(w, h, seed) {
  const rnd = mulberry32(seed);
  const g = empty(w, h, "cp_grass");
  borderRoads(g, w, h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (rnd() < 0.12 && x > 2 && x < w - 3 && y > 1 && y < h - 2) g[y][x] = "cp_building";
      else if (rnd() < 0.06) g[y][x] = "cp_road";
    }
  }
  const destructibles = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (g[y][x] === "cp_building" && rnd() < 0.35) {
        destructibles.push({ x, y, hp: 60 + Math.floor(rnd() * 40), brokenTerrain: "cp_rubble" });
      }
    }
  }
  return { terrain: g, destructibles };
}

function genWild(w, h, seed) {
  const rnd = mulberry32(seed);
  const g = empty(w, h, "plains");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rnd();
      if (n < 0.22) g[y][x] = "forest";
      else if (n < 0.32) g[y][x] = "hill";
      else if (n < 0.38) g[y][x] = "road";
    }
  }
  return { terrain: g, destructibles: [] };
}

function genDesert(w, h, seed) {
  const rnd = mulberry32(seed);
  const g = empty(w, h, "desert");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rnd();
      if (n < 0.08) g[y][x] = "road";
      else if (n < 0.18) g[y][x] = "hill";
      else if (n < 0.28) g[y][x] = "plains";
    }
  }
  return { terrain: g, destructibles: [] };
}

function genArctic(w, h, seed) {
  const rnd = mulberry32(seed);
  const g = empty(w, h, "snow");
  const mid = Math.floor(w / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === mid) {
        g[y][x] = y % 3 === 0 || y === 0 || y === h - 1 ? "road" : "water";
      } else if (Math.abs(x - mid) === 1 && rnd() < 0.18) {
        g[y][x] = "forest";
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] === "snow" && rnd() < 0.12) g[y][x] = "hill";
    }
  }
  return { terrain: g, destructibles: [] };
}

function genMixed(w, h, seed) {
  const rnd = mulberry32(seed);
  const g = empty(w, h, "plains");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rnd();
      if (x < w * 0.45) {
        if (n < 0.2) g[y][x] = "urban";
        else if (n < 0.35) g[y][x] = "road";
        else if (n < 0.5) g[y][x] = "forest";
      } else if (x > w * 0.55) {
        if (n < 0.25) g[y][x] = "desert";
        else if (n < 0.4) g[y][x] = "hill";
        else if (n < 0.52) g[y][x] = "snow";
      } else {
        if (n < 0.3) g[y][x] = "hill";
        else if (n < 0.45) g[y][x] = "forest";
      }
    }
  }
  return { terrain: g, destructibles: [] };
}

const specs = [
  { id: "map_compact_urban", name: "Compact Grid", size: "small", env: "urban", w: 10, h: 8, gen: genUrban, seed: 101 },
  { id: "map_compact_wild", name: "Border Woods", size: "small", env: "wild", w: 10, h: 8, gen: genWild, seed: 102 },
  { id: "map_compact_desert", name: "Dune Alley", size: "small", env: "desert", w: 10, h: 8, gen: genDesert, seed: 103 },
  { id: "map_compact_arctic", name: "Frozen Pass", size: "small", env: "arctic", w: 10, h: 8, gen: genArctic, seed: 104 },
  { id: "map_compact_mixed", name: "Training Mix", size: "small", env: "mixed", w: 10, h: 8, gen: genMixed, seed: 105 },
  { id: "map_warden_urban", name: "Warden Block", size: "medium", env: "urban", w: 12, h: 10, gen: genUrban, seed: 201 },
  { id: "map_warden_wild", name: "Green Belt", size: "medium", env: "wild", w: 12, h: 10, gen: genWild, seed: 202 },
  { id: "map_warden_desert", name: "Sunstroke", size: "medium", env: "desert", w: 12, h: 10, gen: genDesert, seed: 203 },
  { id: "map_warden_arctic", name: "Ice Split", size: "medium", env: "arctic", w: 12, h: 10, gen: genArctic, seed: 204 },
  { id: "map_warden_mixed", name: "Frontline Splice", size: "medium", env: "mixed", w: 12, h: 10, gen: genMixed, seed: 205 },
  { id: "map_sector_urban", name: "Sector Ruins", size: "large", env: "urban", w: 14, h: 12, gen: genUrban, seed: 301 },
  { id: "map_sector_wild", name: "Deep Timber", size: "large", env: "wild", w: 14, h: 12, gen: genWild, seed: 302 },
  { id: "map_sector_desert", name: "Salt Flats", size: "large", env: "desert", w: 14, h: 12, gen: genDesert, seed: 303 },
  { id: "map_sector_arctic", name: "Glacier Run", size: "large", env: "arctic", w: 14, h: 12, gen: genArctic, seed: 304 },
  { id: "map_sector_mixed", name: "Theater Fusion", size: "large", env: "mixed", w: 14, h: 12, gen: genMixed, seed: 305 },
  { id: "map_theater_urban", name: "Theater City", size: "grand", env: "urban", w: 16, h: 14, gen: genUrban, seed: 401 },
  { id: "map_theater_wild", name: "Theater Wilds", size: "grand", env: "wild", w: 16, h: 14, gen: genWild, seed: 402 },
  { id: "map_theater_desert", name: "Theater Dunes", size: "grand", env: "desert", w: 16, h: 14, gen: genDesert, seed: 403 },
  { id: "map_theater_arctic", name: "Theater Tundra", size: "grand", env: "arctic", w: 16, h: 14, gen: genArctic, seed: 404 },
  { id: "map_theater_mixed", name: "Theater Total War", size: "grand", env: "mixed", w: 16, h: 14, gen: genMixed, seed: 405 },
];

function enemyLayout(w, h, area) {
  const rx0 = Math.max(Math.floor(w * 0.62), w - 4);
  const enemies = [
    { templateId: "grunt_red", owner: 1, x: Math.min(w - 2, rx0), y: Math.floor(h / 2) },
    { templateId: "grunt_red", owner: 1, x: Math.min(w - 2, rx0 + 1), y: Math.max(1, Math.floor(h / 2) - 2) },
  ];
  if (area >= 120) {
    enemies.push({ templateId: "grunt_red", owner: 1, x: Math.min(w - 2, rx0), y: Math.min(h - 2, Math.floor(h / 2) + 2) });
  }
  if (area >= 168) {
    enemies.push({ templateId: "opfor_tank", owner: 1, x: w - 2, y: Math.floor(h / 2) });
  }
  return enemies;
}

const catalog = { maps: [] };

for (const s of specs) {
  const { terrain, destructibles } = s.gen(s.w, s.h, s.seed);
  const skirmishDeploy = [
    { x: Math.max(1, Math.floor(s.w * 0.08)), y: Math.max(1, Math.floor(s.h * 0.35)) },
    { x: Math.max(2, Math.floor(s.w * 0.15)), y: Math.min(s.h - 2, Math.floor(s.h * 0.55)) },
  ];
  const p1DeploymentSlots = [
    { x: Math.max(1, Math.floor(s.w * 0.06)), y: Math.floor(s.h * 0.35) },
    { x: Math.max(1, Math.floor(s.w * 0.06)), y: Math.floor(s.h * 0.55) },
  ];
  const p2DeploymentSlots = [
    { x: Math.min(s.w - 2, Math.floor(s.w * 0.94)), y: Math.floor(s.h * 0.35) },
    { x: Math.min(s.w - 2, Math.floor(s.w * 0.94)), y: Math.floor(s.h * 0.55) },
  ];
  const scenario = {
    id: s.id,
    name: s.name,
    width: s.w,
    height: s.h,
    cellSize: 48,
    winCondition: { type: "eliminate" },
    terrain,
    destructibles: destructibles.length ? destructibles : undefined,
    skirmishDeploy,
    p1DeploymentSlots,
    p2DeploymentSlots,
    units: [],
    presetEnemies: enemyLayout(s.w, s.h, s.w * s.h),
  };
  const rel = `js/config/scenarios/maps/${s.id}.json`;
  fs.writeFileSync(path.join(outDir, `${s.id}.json`), JSON.stringify(scenario, null, 2));
  catalog.maps.push({
    id: s.id,
    name: s.name,
    path: rel,
    sizeCategory: s.size,
    environment: s.env,
    width: s.w,
    height: s.h,
  });
}

fs.writeFileSync(path.join(root, "js", "config", "mapCatalog.json"), JSON.stringify(catalog, null, 2));
console.log("Wrote", catalog.maps.length, "maps to", outDir);
