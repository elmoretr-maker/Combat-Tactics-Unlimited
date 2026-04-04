#!/usr/bin/env node
/**
 * Asset Librarian — scans assets/New_Arrivals/, sorts files into permanent dirs,
 * regenerates js/config/assetManifest.json.
 *
 * Run: node tools/catalog_assets.mjs
 *      npm run catalog-assets
 *
 * Flags: --visual-report (write tools/visual_assessment_report.json)
 *        --filename-only   (skip sharp; keep source filenames — legacy)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  analyzeImageVisual,
  isGenericFileName,
  planLibrarianRename,
} from "./visual_analysis.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const NEW_ARRIVALS = path.join(ROOT, "assets", "New_Arrivals");
const MANIFEST_PATH = path.join(ROOT, "js", "config", "assetManifest.json");
const VISUAL_REPORT_PATH = path.join(ROOT, "tools", "visual_assessment_report.json");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const ARGS = new Set(process.argv.slice(2));
const FLAG_VISUAL_REPORT = ARGS.has("--visual-report");
/** Skip sharp; keep original filenames (legacy ingest). */
const FLAG_FILENAME_ONLY = ARGS.has("--filename-only");

function obstacleThemeForPalette(theme) {
  if (theme === "desert" || theme === "grass") return theme;
  return "urban";
}

/* ── Gun classification (filename + relative path, case-insensitive) ─────────
 * Order matters: evaluate machine gun before rifle (e.g. "machine" contains no "rifle"
 * but SMG/LMG patterns are specific).
 *
 * 1) machine_gun — machine gun, SMG, LMG, HMG, minigun, SAW, common MG model tokens
 * 2) handgun     — pistol, revolver, handgun, sidearm, well-known pistol families
 * 3) rifle       — rifle, sniper, carbine, DMR, AR/AK patterns
 * 4) Subfolder hints: .../rifle/..., .../handgun/..., .../machine_gun/...
 * 5) Default     — rifle (long-gun assumption for ambiguous weapon art)
 */
function classifyGunClass(fileName, relDirFromNewArrivals) {
  const s = `${relDirFromNewArrivals}/${fileName}`.replace(/\\/g, "/").toLowerCase();

  if (
    /\b(machine[\s_-]*gun|machinegun|minigun|gatling|submachine|sub[\s_-]*machine|\bsmg\b|\blmg\b|\bhmg\b|m249|m240|m60|pkm|saw\b|sten|uzi|mp5|mp7|p90|vector|thompson)\b/i.test(
      s,
    )
  ) {
    return "machine_gun";
  }
  if (
    /\b(handgun|pistol|revolver|sidearm|glock|beretta|m1911|1911|desert[\s_-]*eagle|\bdeagle\b|walther|makarov)\b/i.test(
      s,
    )
  ) {
    return "handgun";
  }
  if (
    /\b(rifle|sniper|carbine|dmr|\bar[\s_-]*15\b|\bak[\s_-]*47\b|bolt[\s_-]*action|lever[\s_-]*action|shotgun)\b/i.test(
      s,
    )
  ) {
    return "rifle";
  }

  if (/(^|\/)rifles?(\/|$)/i.test(s) || /\/rifle\//i.test(s)) return "rifle";
  if (/(^|\/)handguns?(\/|$)|\/pistol\//i.test(s)) return "handgun";
  if (/(^|\/)machine[\s_-]*guns?(\/|$)|\/smg\/|\/lmg\//i.test(s)) return "machine_gun";

  return "rifle";
}

function classifyBuildingFootprint(fileName, relDir) {
  const s = `${relDir}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (/\b(bunker|fort\b|fortress|citadel|bastion|redoubt|keep\b|castle|curtain[\s_-]*wall|defensive)\b/.test(s)) {
    return "fortified";
  }
  if (/\b(warehouse|mansion|tower|complex|hangar|factory|arena|skyscraper|apartment)\b/.test(s)) {
    return "large";
  }
  if (/\b(small|shack|hut|shed|booth|kiosk|tiny)\b/.test(s)) {
    return "small";
  }
  if (/\b(medium|house|cabin|office|shop|store|garage|building)\b/.test(s)) {
    return "medium";
  }
  if (/\/small\//i.test(s)) return "small";
  if (/\/large\//i.test(s)) return "large";
  if (/\/fortified\//i.test(s)) return "fortified";
  return "medium";
}

function classifyTileTheme(fileName, relDir) {
  const s = `${relDir}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (/\b(desert|sand|dune|arid|sahara|badlands|mesa|dust)\b/.test(s)) return "desert";
  if (/\b(urban|city|street|concrete|brick|asphalt|pavement|downtown|metro)\b/.test(s)) {
    return "urban";
  }
  if (/\/desert\//i.test(s)) return "desert";
  if (/\/urban\//i.test(s)) return "urban";
  return "urban";
}

function classifyObstacleKind(fileName) {
  const s = fileName.toLowerCase();
  if (/_strip_|obstacle_[^_]+_strip_/i.test(fileName)) return "strip";
  if (/\btree|bush|palm|pine\b/.test(s)) return "tree";
  if (/\bcrate|box\b/.test(s)) return "crate";
  if (/\bbarrel\b/.test(s)) return "barrel";
  if (/\bruin|ruins|rubble|wreck\b/.test(s)) return "ruins";
  if (/\brock|boulder|stone\b/.test(s)) return "ruins";
  return "crate";
}

/**
 * Decide high-level category for a file dropped in New_Arrivals.
 */
function classifyCategory(fileName, relDir) {
  const s = `${relDir}/${fileName}`.replace(/\\/g, "/").toLowerCase();

  if (/(^|\/)combat[\s_-]*buttons(\/|$)/i.test(s)) return "ui";
  if (/\bpicsart\b/i.test(s)) return "ui";
  if (
    /(^|\/)dungeon[\s_-]*tiles(\/|$)|(^|\/)tiled_files(\/|$)|(^|\/)png_n_tiled(\/|$)/i.test(
      s,
    )
  ) {
    return "tile";
  }
  if (
    /\b(walls_floor|water_animation|water_coasts|decorative_cracks|doors_lever|trap_animation|bridges\.png)\b/i.test(
      s,
    )
  ) {
    return "tile";
  }

  if (/(^|\/)guns?(\/|$)|\bweapon\b|\bfirearm\b/.test(s)) return "gun";
  if (/(^|\/)buildings?(\/|$)|\bhouse\b|\broof\b|\bstructure\b|\barchitecture\b/.test(s)) {
    return "building";
  }
  if (/(^|\/)tiles?(\/|$)|\bterrain\b|\bground\b|\bfloor\b|\bgrass\s*tile\b/.test(s)) {
    return "tile";
  }
  if (/\btree\b|\bbush\b|\bcrate\b|\bbarrel\b|\bprop\b|\bobstacle\b|\bruins?\b/.test(s)) {
    return "obstacle";
  }
  if (/\b(pistol|rifle|smg|lmg|gun|firearm|m4|ak47)\b/.test(s)) return "gun";
  if (/\b(bunker|warehouse|house|hut|shack|fort)\b/.test(s)) return "building";
  if (/\b(desert|urban|sand|street)[\s_-]*tile\b|\btileset\b/.test(s)) return "tile";

  return "obstacle";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function uniqueDest(destBase) {
  if (!fs.existsSync(destBase)) return destBase;
  const dir = path.dirname(destBase);
  const ext = path.extname(destBase);
  const base = path.basename(destBase, ext);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_${i}${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

function* walkFiles(dir, baseRel = "") {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "README.md") continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(baseRel.replace(/\\/g, "/"), e.name);
    if (e.isDirectory()) {
      yield* walkFiles(full, rel);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) yield { full, rel, name: e.name };
    }
  }
}

function posixRel(fromRootAbs) {
  return path.relative(ROOT, fromRootAbs).split(path.sep).join("/");
}

/** relRoot as passed to collectAssetsUnder, e.g. "assets/obstacles" (no trailing slash). */
function assetBucket(relRoot) {
  const n = relRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (n === "assets/guns" || n.startsWith("assets/guns/")) return "guns";
  if (n === "assets/buildings" || n.startsWith("assets/buildings/")) return "buildings";
  if (n === "assets/tiles" || n.startsWith("assets/tiles/")) return "tiles";
  if (n === "assets/obstacles" || n.startsWith("assets/obstacles/")) return "obstacles";
  if (n === "assets/ui" || n.startsWith("assets/ui/")) return "ui";
  return null;
}

/**
 * One-time fix: earlier runs misclassified tile sheets / UI as obstacles.
 * Moves matching files from assets/obstacles/{theme}/ → tiles or ui/buttons.
 */
function promoteMisfiledFromObstacles() {
  const promoted = [];
  const uiName = (name) => /picsart|preview\.png$/i.test(name) || /\bbutton\b/i.test(name);

  const isTileSheetName = (name) =>
    /walls_floor|decorative_cracks|doors_lever|trap_|fire_animation|water_|Water_coasts|water_detil|water_details|Objects\.png|Bridges\.png|^Objects_/i.test(
      name,
    );

  for (const theme of ["urban", "desert", "grass"]) {
    const dir = path.join(ROOT, "assets", "obstacles", theme);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;

      if (uiName(name)) {
        const destDir = path.join(ROOT, "assets", "ui", "buttons");
        ensureDir(destDir);
        const dest = uniqueDest(path.join(destDir, name));
        fs.renameSync(full, dest);
        promoted.push({ from: `assets/obstacles/${theme}/${name}`, to: posixRel(dest) });
        continue;
      }
      if (isTileSheetName(name)) {
        const destDir = path.join(ROOT, "assets", "tiles", theme);
        ensureDir(destDir);
        const dest = uniqueDest(path.join(destDir, name));
        fs.renameSync(full, dest);
        promoted.push({ from: `assets/obstacles/${theme}/${name}`, to: posixRel(dest) });
      }
    }
  }
  return promoted;
}

/**
 * @param {{ visualAll?: boolean }} opts
 */
async function ingestNewArrivals() {
  ensureDir(NEW_ARRIVALS);
  const moves = [];
  for (const { full, rel, name } of walkFiles(NEW_ARRIVALS, "")) {
    const ext = path.extname(name).toLowerCase();
    let cat = classifyCategory(name, rel);
    let destDir;
    let meta = {};
    let outName = name;
    let plan = null;
    let visual = null;

    const useVisual = !FLAG_FILENAME_ONLY && IMAGE_EXT.has(ext);
    if (useVisual) {
      try {
        visual = await analyzeImageVisual(full);
        plan = planLibrarianRename(visual, name, ext);
        cat = plan.category;
        outName = plan.newFileName;
        meta.visualAnalysis = {
          width: visual.width,
          height: visual.height,
          aspect: visual.aspect,
          dominantHex: visual.dominantHex,
          inferredTheme: visual.theme,
          inferredType: visual.assetType,
          meanAlpha: visual.meanAlpha,
          transparencyHigh: visual.transparencyHigh,
        };
        meta.librarianSubtype = plan.librarianSubtype;
      } catch (e) {
        console.warn("Visual analysis failed:", rel, e?.message || e);
      }
    }

    if (cat === "gun") {
      const gunClass = plan?.gunClass ?? classifyGunClass(name, rel);
      destDir = path.join(ROOT, "assets", "guns", gunClass);
      meta = {
        ...meta,
        type: "gun",
        gunClass,
        tags: [gunClass],
      };
    } else if (cat === "building") {
      const footprint = plan?.footprint ?? classifyBuildingFootprint(name, rel);
      destDir = path.join(ROOT, "assets", "buildings", footprint);
      meta = {
        ...meta,
        type: "building",
        footprint,
        tags: [footprint, "building"],
      };
    } else if (cat === "tile") {
      const theme = visual?.theme ?? classifyTileTheme(name, rel);
      destDir = path.join(ROOT, "assets", "tiles", theme);
      meta = {
        ...meta,
        type: "tile",
        theme,
        tags: [theme, "tile"],
      };
    } else if (cat === "ui") {
      destDir = path.join(ROOT, "assets", "ui", "buttons");
      meta = {
        ...meta,
        type: "ui",
        uiKind: "buttons",
        tags: ["ui", "button"],
      };
    } else {
      const theme = visual?.theme ?? classifyTileTheme(name, rel);
      const obstacleTheme = obstacleThemeForPalette(theme);
      const okind = plan?.obstacleKind ?? classifyObstacleKind(outName);
      destDir = path.join(ROOT, "assets", "obstacles", obstacleTheme);
      meta = {
        ...meta,
        type: "obstacle",
        theme: obstacleTheme,
        obstacleKind: okind,
        tags: [obstacleTheme, "obstacle", okind],
      };
    }

    ensureDir(destDir);
    let destPath = path.join(destDir, outName);
    destPath = uniqueDest(destPath);
    fs.renameSync(full, destPath);
    moves.push({ from: `New_Arrivals/${rel}`, to: posixRel(destPath), meta });
  }
  return moves;
}

function collectAssetsUnder(relRoot) {
  const abs = path.join(ROOT, relRoot);
  const out = [];
  if (!fs.existsSync(abs)) return out;
  for (const { full, name } of walkFiles(abs, "")) {
    const rel = posixRel(full);
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    let record = {
      id: rel.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
      path: rel,
      fileName: name,
      ext: ext.slice(1),
    };

    const bucket = assetBucket(relRoot);
    if (bucket === "guns") {
      const gunClass = rel.split("/")[2];
      record.type = "gun";
      record.gunClass = gunClass;
      record.theme = null;
      record.footprint = null;
      record.tags = ["gun", gunClass];
    } else if (bucket === "buildings") {
      const footprint = rel.split("/")[2];
      record.type = "building";
      record.footprint = footprint;
      record.theme = inferBuildingTheme(name);
      record.tags = ["building", footprint, record.theme].filter(Boolean);
    } else if (bucket === "tiles") {
      const theme = rel.split("/")[2];
      record.type = "tile";
      record.theme = theme;
      record.footprint = null;
      record.tags = ["tile", theme];
    } else if (bucket === "obstacles") {
      const theme = rel.split("/")[2];
      record.type = "obstacle";
      record.theme = theme;
      record.obstacleKind = classifyObstacleKind(name);
      record.footprint = null;
      record.tags = ["obstacle", theme, record.obstacleKind];
    } else if (bucket === "ui") {
      const uiKind = rel.split("/")[2] || "misc";
      record.type = "ui";
      record.uiKind = uiKind;
      record.theme = null;
      record.footprint = null;
      record.tags = ["ui", uiKind];
    } else {
      continue;
    }
    out.push(record);
  }
  return out;
}

function inferBuildingTheme(fileName) {
  const s = fileName.toLowerCase();
  if (/\b(desert|sand|adobe)\b/.test(s)) return "desert";
  if (/\b(urban|city|street|brick)\b/.test(s)) return "urban";
  return "urban";
}

const DEFAULT_FOUNDATION_HINTS = {
  urban: {
    baseTerrain: "cp_grass",
    roadTerrain: "cp_road",
    dividerTerrain: "water",
  },
  desert: {
    baseTerrain: "desert",
    roadTerrain: "road",
    dividerTerrain: "water",
  },
  grass: {
    baseTerrain: "plains",
    roadTerrain: "road",
    dividerTerrain: "water",
  },
};

const LEGACY_CRAFTPIX_OBSTACLES = [
  {
    kind: "tree",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Trees Bushes/TDS04_0022_Tree1.png",
    tags: ["urban", "obstacle", "tree"],
  },
  {
    kind: "ruins",
    sprite:
      "attached_assets/craftpix_pack/city/PNG City 2/broken_small_houses/Elements/small_house1_carcass1.png",
    tags: ["urban", "obstacle", "ruins"],
  },
  {
    kind: "crate",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Crates Barrels/TDS04_0018_Box1.png",
    tags: ["urban", "obstacle", "crate"],
  },
  {
    kind: "barrel",
    sprite: "attached_assets/craftpix_pack/city/PNG City/Crates Barrels/TDS04_0016_Barrel.png",
    tags: ["urban", "obstacle", "barrel"],
  },
];

function buildIndex(assets) {
  const index = {
    guns: { handgun: [], rifle: [], machine_gun: [] },
    buildings: { small: [], medium: [], large: [], fortified: [] },
    tiles: { desert: [], urban: [], grass: [] },
    obstaclesByTheme: { urban: [], desert: [], grass: [] },
    buildingsByThemeFootprint: {
      urban: { small: [], medium: [], large: [], fortified: [] },
      desert: { small: [], medium: [], large: [], fortified: [] },
      grass: { small: [], medium: [], large: [], fortified: [] },
    },
  };

  for (const a of assets) {
    if (a.type === "gun" && index.guns[a.gunClass]) {
      index.guns[a.gunClass].push(a.path);
    }
    if (a.type === "building" && index.buildings[a.footprint]) {
      index.buildings[a.footprint].push(a.path);
      const th = a.theme || "urban";
      if (index.buildingsByThemeFootprint[th]?.[a.footprint]) {
        index.buildingsByThemeFootprint[th][a.footprint].push(a.path);
      }
    }
    if (a.type === "tile") {
      const th = a.theme && index.tiles[a.theme] ? a.theme : "urban";
      index.tiles[th].push(a.path);
    }
    if (a.type === "obstacle" && index.obstaclesByTheme[a.theme]) {
      index.obstaclesByTheme[a.theme].push({
        kind: a.obstacleKind,
        sprite: a.path,
        tags: a.tags,
      });
    }
  }

  for (const th of ["urban", "desert", "grass"]) {
    if (!index.obstaclesByTheme[th].length) {
      index.obstaclesByTheme[th] = LEGACY_CRAFTPIX_OBSTACLES.map((o) => ({ ...o }));
    }
  }

  return index;
}

function scanUnmappedRoots() {
  const attached = path.join(ROOT, "attached_assets");
  const notes = [];
  if (!fs.existsSync(attached)) return notes;
  for (const name of fs.readdirSync(attached, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    if (name.name.startsWith(".")) continue;
    const rel = `attached_assets/${name.name}`;
    notes.push({
      path: rel,
      note: "Pack not managed by assets/ librarian; reference manually or symlink into assets/New_Arrivals for ingestion.",
    });
  }
  return notes;
}

function rebuildManifest(priorFoundationHints) {
  const buckets = [
    collectAssetsUnder("assets/guns"),
    collectAssetsUnder("assets/buildings"),
    collectAssetsUnder("assets/tiles"),
    collectAssetsUnder("assets/obstacles"),
    collectAssetsUnder("assets/ui"),
  ];
  const assets = buckets.flat();
  const index = buildIndex(assets);
  const foundationHints = {
    ...DEFAULT_FOUNDATION_HINTS,
    ...(priorFoundationHints && typeof priorFoundationHints === "object"
      ? priorFoundationHints
      : {}),
  };

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    description:
      "Master catalog for procedural mapgen and tooling. Paths are repo-relative (forward slashes).",
    foundationHints,
    assets,
    index,
    externalRootsScan: scanUnmappedRoots(),
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function runVisualAssessmentReport() {
  const candidates = [];
  const seen = new Set();

  function addCandidate(full, relNote) {
    const base = path.basename(full);
    const ext = path.extname(base).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return;
    if (!isGenericFileName(base)) return;
    const key = path.resolve(full);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ full, relNote });
  }

  if (fs.existsSync(NEW_ARRIVALS)) {
    for (const { full, rel } of walkFiles(NEW_ARRIVALS, "")) {
      addCandidate(full, `New_Arrivals/${rel}`);
    }
  }

  for (const sub of ["tiles", "obstacles"]) {
    const root = path.join(ROOT, "assets", sub);
    if (!fs.existsSync(root)) continue;
    for (const { full } of walkFiles(root, "")) {
      addCandidate(full, posixRel(full));
    }
  }

  const items = [];
  for (const { full, relNote } of candidates) {
    const ext = path.extname(full).toLowerCase();
    try {
      const analysis = await analyzeImageVisual(full);
      const plan = planLibrarianRename(analysis, path.basename(full), ext);
      items.push({
        path: relNote,
        fileName: path.basename(full),
        dimensions: { width: analysis.width, height: analysis.height },
        aspect: analysis.aspect,
        dominantHex: analysis.dominantHex,
        avgRgb: analysis.avgRgb,
        inferredTheme: analysis.theme,
        inferredAssetType: analysis.assetType,
        categoryByVisual: plan.category,
        proposedRename: plan.newFileName,
        librarianSubtype: plan.librarianSubtype,
      });
    } catch (e) {
      items.push({
        path: relNote,
        fileName: path.basename(full),
        error: String(e?.message || e),
      });
    }
  }

  items.sort((a, b) => (a.path || "").localeCompare(b.path || ""));

  /** When nothing in New_Arrivals is generically named, still emit a short demo slice so the pipeline is verifiable. */
  let demoSamples = [];
  if (!items.length) {
    const urban = path.join(ROOT, "assets", "tiles", "urban");
    if (fs.existsSync(urban)) {
      const names = fs
        .readdirSync(urban)
        .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
        .sort()
        .slice(0, 8);
      for (const name of names) {
        const full = path.join(urban, name);
        if (!fs.statSync(full).isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        try {
          const analysis = await analyzeImageVisual(full);
          const plan = planLibrarianRename(analysis, name, ext);
          demoSamples.push({
            path: posixRel(full),
            fileName: name,
            filenameWasGeneric: false,
            dimensions: { width: analysis.width, height: analysis.height },
            aspect: analysis.aspect,
            dominantHex: analysis.dominantHex,
            avgRgb: analysis.avgRgb,
            inferredTheme: analysis.theme,
            inferredAssetType: analysis.assetType,
            categoryByVisual: plan.category,
            proposedRenameIfGeneric: plan.newFileName,
            librarianSubtype: plan.librarianSubtype,
          });
        } catch (e) {
          demoSamples.push({
            path: posixRel(full),
            fileName: name,
            filenameWasGeneric: false,
            error: String(e?.message || e),
          });
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    note: "Primary list: generic basenames only. If that list is empty, `demoSamples` shows the same heuristics on a few `assets/tiles/urban` files (filenames not renamed by the librarian).",
    scannedForGenericUnder: ["assets/New_Arrivals", "assets/tiles", "assets/obstacles"],
    genericNameCount: items.length,
    items,
    demoSamples,
  };

  ensureDir(path.dirname(VISUAL_REPORT_PATH));
  fs.writeFileSync(VISUAL_REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log("CTU Visual assessment report →", VISUAL_REPORT_PATH);
  console.log("  Generic-name rasters analyzed:", items.length);
  if (demoSamples.length) {
    console.log("  Demo samples (urban tiles, non-generic names):", demoSamples.length);
  }
}

/* ── main ─────────────────────────────────────────────────── */
let priorHints = null;
if (fs.existsSync(MANIFEST_PATH)) {
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    priorHints = prev.foundationHints;
  } catch {
    /* ignore */
  }
}

async function main() {
  if (FLAG_VISUAL_REPORT) {
    await runVisualAssessmentReport();
    return;
  }

  const moves = await ingestNewArrivals();
  const promoted = promoteMisfiledFromObstacles();
  const manifest = rebuildManifest(priorHints);

  console.log("CTU Asset Librarian");
  console.log("  New_Arrivals moves:", moves.length ? moves.length : "(none)");
  for (const m of moves) {
    console.log("   ", m.from, "→", m.to, JSON.stringify(m.meta));
  }
  console.log(
    "  Promoted (obstacles → tiles/ui):",
    promoted.length ? promoted.length : "(none)",
  );
  for (const p of promoted) {
    console.log("   ", p.from, "→", p.to);
  }
  console.log("  Manifest:", MANIFEST_PATH);
  console.log("  Total catalogued assets:", manifest.assets.length);
  console.log("  External roots (informational):", manifest.externalRootsScan.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
