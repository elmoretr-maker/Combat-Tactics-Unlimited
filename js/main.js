import { loadJson } from "./loadConfig.js";
import { GameState } from "./engine/gameState.js";
import { drawGrid, preloadTerrainTiles } from "./render/canvasGrid.js";
import { getArenaRenderMode } from "./render/renderMode.js";
import {
  UnitRenderer,
  attackVisualDurationMs,
  compositeUsesIndependentTurret,
} from "./render/unitRenderer.js";
import {
  computeFacing,
  syncFacingAndFaceRad,
  facingToFaceRad,
  normalizeAngleRad,
  syncFacingTowardNearestEnemy,
} from "./engine/facing.js";
import { BattleVfx } from "./render/battleVfx.js";
import { FxLayer } from "./render/fxLayer.js";
import { chebyshev } from "./engine/grid.js";
import { canAttack, canHealSupport } from "./engine/combat.js";
import {
  hasLineOfSight,
  isIndirectDeadzoneBlock,
} from "./engine/los.js";
import { computeAttackRangeOverlay } from "./engine/tacticalOverlays.js";
import {
  obstacleCoverNameAt,
  OBSTACLE_COVER_DAMAGE_FACTOR,
} from "./battle-plane/cover.js";
import { AudioManager } from "./audio/AudioManager.js";
import { loadProgress, saveProgress, isUnlocked } from "./progression/store.js";
import { loadSettings, saveSettings } from "./progression/settings.js";
import { initFirebase } from "./firebase/auth.js";
import { wireCloudProgress } from "./firebase/progressSync.js";
import { createBattlePlaneController } from "./battle-plane/runtime.js";
import { drawMapObjects } from "./render/mapObjectLayer.js";
import { makeMapObject } from "./battle-plane/mapObjects.js";
import { generateProceduralScenario } from "./mapgen/pipeline.js";
import {
  getBiomeForCatalogEntry,
  biomeDisplayName,
  biomeToMapgenTheme,
  resolveProceduralThemeArg,
} from "./mapgen/biome.js";
import { downloadMapLayout } from "./mapgen/persist.js";
import { PER_TILE_MOVE_MS, lerp as lerpScalar } from "./render/tween.js";
import { sharedBattleAmbient } from "./render/effects.js";
import {
  initBattleNotifications,
  showBattleToast,
  flashInvalidTile,
  drawInvalidTileFlashes,
} from "./ui/notifications.js";
import { mergeUnitTemplates } from "./config/unitOverridesStorage.js";

/** Shipped units.json + localStorage `ctu_unit_overrides` (master stats for all modes). */
async function loadMergedUnitsFromConfig() {
  const raw = await loadJson("js/config/units.json");
  return mergeUnitTemplates(raw);
}

window.__CTU_MODULE_LOADED = true;

const PLANE_LAYER_SCENARIO_PATH = "js/config/scenarios/plane_layer_demo.json";

/* ── State ──────────────────────────────────────────── */
const QUICK_PLAYER_UNITS = [
  { templateId: "infantry", owner: 0, x: 2, y: 5 },
  { templateId: "light_tank", owner: 0, x: 3, y: 7 },
];

let game;
let tileTypes;
let spriteAnimations;
let attackEffects;
let unitRenderer;
let battleVfx;
let battleFx;
let canvas;
let ctx;
let gridOffsetX = 0;
let gridOffsetY = 0;

/** Camera pan (px) for battle scaler translate — viewport is arena. */
let battlePanX = 0;
let battlePanY = 0;
/** @type {{ kind: "pending"; x0: number; y0: number; pid: number } | { kind: "pan"; startClientX: number; startClientY: number; panStartX: number; panStartY: number; pid: number } | null} */
let battlePointerDrag = null;
let battleSuppressNextCanvasClick = false;
const BATTLE_PAN_THRESHOLD = 10;
const BATTLE_KEY_PAN_STEP = 16;
const BATTLE_ZOOM_MIN = 0.45;
const BATTLE_ZOOM_MAX = 4;
/**
 * Move animation: either multi-cell `cells` path or legacy 2-point `{ x0,y0,x1,y1 }`.
 * @type {{
 *   unitId: string;
 *   cells?: [number, number][];
 *   seg?: number;
 *   x0?: number;
 *   y0?: number;
 *   x1?: number;
 *   y1?: number;
 *   t0: number;
 *   dur: number;
 * } | null}
 */
let lerp = null;

const TREAD_MARK_LIFETIME_MS = 4800;
const TREAD_MARK_CAP = 96;
/** @type {{ x: number; y: number; rad: number; t0: number }[]} */
let treadMarks = [];
/** Grid cell under pointer for selected-unit facing (valid only in-bounds on the map). */
let battleHoverCellValid = false;
let battleHoverGx = 0;
let battleHoverGy = 0;
let progress = loadProgress();
let settings = loadSettings();

function battleVisualStyle() {
  return settings?.visualStyle === "classic" ? "classic" : "hDef";
}
let unitRegistry = [];
let academyConfig;
let hubConfig;
let onboardingConfig;
let lastBootOptions = {
  mode: "skirmish",
  loadout: null,
  scenarioPath: null,
  matLabTheater: null,
  scenarioInline: null,
  skirmishDifficulty: null,
};
/** Last scenario from generateProceduralScenario (for JSON export). */
let lastProceduralScenario = null;
/** When set (from Map Theater), used as default for vs-CPU skirmish and hotseat base layout. */
let pendingUserMapPath = null;
/** Hub / landing: procedural skirmish chosen — squad picked on Vs CPU prep, map generated at Start. */
let pendingProceduralSkirmishSpec = null;
/** Display name from last loaded scenario JSON (non-catalog paths). */
let pendingVsCpuScenarioName = null;
let mapCatalog = { maps: [] };
let mapTheaterTileTypes = null;

function attachCatalogBiomeFromPath(scenario, scenarioPath) {
  if (!scenarioPath || !scenario) return;
  const maps = mapCatalog.maps || [];
  const entry = maps.find((x) => x.path === scenarioPath);
  if (!entry) return;
  const biome = getBiomeForCatalogEntry(entry);
  if (scenario.biome == null) scenario.biome = biome;
  const prevGen =
    scenario.generator && typeof scenario.generator === "object"
      ? scenario.generator
      : {};
  const generator = { ...prevGen };
  if (generator.biome == null) generator.biome = biome;
  if (generator.theme == null) generator.theme = biomeToMapgenTheme(biome);
  scenario.generator = generator;
}

function drawMapTheaterPreviewCanvas(canvas, terrain, tileTypeMap, maxW, maxH) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !terrain?.length || !terrain[0]?.length) return;
  const th = terrain.length;
  const tw = terrain[0].length;
  const cw = Math.max(1, Math.floor(maxW / tw));
  const ch = Math.max(1, Math.floor(maxH / th));
  const cell = Math.min(cw, ch);
  const drawW = tw * cell;
  const drawH = th * cell;
  canvas.width = drawW;
  canvas.height = drawH;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const id = terrain[y][x];
      const col =
        typeof id === "string" && tileTypeMap?.[id]?.color
          ? tileTypeMap[id].color
          : "#2a3140";
      ctx.fillStyle = col;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

/** Caption under world map; terrain preview is on dots (blowup modal) and thumbnails. */
async function redrawMapTheaterMainPreview(_tileTypeMap) {
  const caption = document.getElementById("map-theater-selected");
  if (!caption) return;
  if (!pendingUserMapPath) {
    caption.textContent =
      "Hover dots to sync thumbnails — click a dot for a large preview. Pick a map in the strip or use preview ✓.";
    return;
  }
  try {
    await loadJson(pendingUserMapPath);
    const maps = mapCatalog?.maps || [];
    const cur = maps.find((x) => x.path === pendingUserMapPath);
    caption.textContent = cur
      ? `Selected: ${cur.name} — ${biomeDisplayName(getBiomeForCatalogEntry(cur))} · ${cur.width}×${cur.height}`
      : "Map loaded.";
  } catch (e) {
    console.warn("[CTU] Map theater caption update failed", e);
    caption.textContent = "Could not load that map metadata.";
  }
}
let battleEndHandled = false;
let aiRunning = false;
/** Pinned "attack view" (range / LOS / deadzone); also shows while hovering an enemy. */
let battleAttackRangePinned = false;
let battleHoverShowsAttackOverlay = false;
let battleHoverShowsHealOverlay = false;
let battleOverlayCacheKey = "";
let battleOverlayCache = null;
let academyPickSet = new Set();
/** Map theater → vs CPU: player-picked squad (insertion order = deploy slots). */
let mapSkirmishPickSet = new Set();
let mapSkirmishPickCount = 2;
/** Deploy slots for the current vs-CPU target map (or default skirmish layout if no map yet). */
let pendingMapSkirmishSlotCount = 4;
/** Squad locked in on Vs CPU prep (`null` until player confirms squad picker). */
let pendingSkirmishOrderedLoadout = null;
/** After squad picker: return to this screen instead of starting battle (`null` = map-theater flow). */
let mapSkirmishPrepReturnId = null;
/** Selected battle-mat theater before plane-layer battle (`grass` | `desert` | `urban`). */
let pendingMatLabTheater = "grass";
/** Player squad for mat lab (1–8 template ids, deploy order). */
let pendingMatLabLoadout = null;
/** If set, picking a map in theater returns to this screen (e.g. vs-cpu-prep). Cleared when opening maps from hub/nav. */
let mapsReturnTarget = null;
/** When set, battle uses mat + plane grid stack (`js/battle-plane/`). Null = legacy renderer. */
let battlePlaneCtl = null;
let battleHints = { movedOnce: false, attackedOnce: false };
let battleStats = { p0Kills: 0, p1Kills: 0, rounds: 0 };

/* ── Death animations ────────────────────────────────── */
const dyingUnits = [];
function spawnDying(unit) {
  const cellSz = game?.scenario?.cellSize ?? 48;
  dyingUnits.push({
    cx: gridOffsetX + unit.x * cellSz + cellSz / 2,
    cy: gridOffsetY + unit.y * cellSz + cellSz / 2,
    owner: unit.owner,
    born: performance.now(),
  });
}
function drawDyingUnits(ts) {
  if (!ctx) return;
  const DUR = 600;
  for (let i = dyingUnits.length - 1; i >= 0; i--) {
    const d = dyingUnits[i];
    const age = ts - d.born;
    if (age > DUR) { dyingUnits.splice(i, 1); continue; }
    const t = age / DUR;
    const alpha = (1 - t) * 0.9;
    const sz = cs() * (0.32 - t * 0.12);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = d.owner === 0 ? "#4ab8ff" : "#ff5555";
    ctx.lineWidth = 3 * (1 - t * 0.5);
    ctx.beginPath();
    ctx.moveTo(d.cx - sz, d.cy - sz); ctx.lineTo(d.cx + sz, d.cy + sz);
    ctx.moveTo(d.cx + sz, d.cy - sz); ctx.lineTo(d.cx - sz, d.cy + sz);
    ctx.stroke();
    /* flash ring */
    ctx.strokeStyle = d.owner === 0 ? "rgba(74,184,255,0.5)" : "rgba(255,85,85,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(d.cx, d.cy, cs() * (0.2 + t * 0.4), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* ── Canvas VFX flash (fallback when no image assets) ─── */
const vfxFlashes = [];
function spawnFlash(cx, cy, color) {
  vfxFlashes.push({ cx, cy, color, born: performance.now() });
}
function drawVfxFlashes(ts) {
  if (!ctx) return;
  for (let i = vfxFlashes.length - 1; i >= 0; i--) {
    const f = vfxFlashes[i];
    const age = ts - f.born;
    if (age > 380) { vfxFlashes.splice(i, 1); continue; }
    const t = age / 380;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.75;
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(f.cx, f.cy, cs() * (0.15 + t * 0.65), 0, Math.PI * 2);
    ctx.stroke();
    if (t < 0.35) {
      ctx.globalAlpha = (1 - t / 0.35) * 0.45;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(f.cx, f.cy, cs() * (0.1 + t * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ── Fog of War ─────────────────────────────────────── */
function computeVisibleCells() {
  if (!game) return null;
  if (!settings.fogOfWar) return null;
  /* Plane stack + scattered props: LOS fog hides the mat, grid, and enemies. Disable until tuned. */
  if (getArenaRenderMode(game.scenario) === "mat") return null;
  if (game.scenario?.fogOfWar === false) return null;
  const visible = new Set();
  const losCtx = game.losCtx();
  const budget = losCtx.sightBudget;
  for (const u of game.units) {
    if (u.owner !== 0 || u.hp <= 0) continue;
    const range = u.sightRange ?? 8;
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const tx = u.x + dx, ty = u.y + dy;
        if (tx < 0 || ty < 0 || tx >= game.grid.width || ty >= game.grid.height) continue;
        if (chebyshev(u.x, u.y, tx, ty) > range) continue;
        if (
          hasLineOfSight(game.grid, game.tileTypes, u.x, u.y, tx, ty, {
            sightBudget: budget,
            mapObjects: game.mapObjects?.length ? game.mapObjects : undefined,
          })
        ) {
          visible.add(`${tx},${ty}`);
        }
      }
    }
  }
  return visible;
}

/* floating damage numbers */
const floaters = [];
function spawnFloater(text, worldX, worldY, color = "#ffe066") {
  floaters.push({ text, x: worldX, y: worldY, born: performance.now(), color });
}
function updateFloaters(ts) {
  const LIFE = 900;
  for (let i = floaters.length - 1; i >= 0; i--) {
    if (ts - floaters[i].born > LIFE) floaters.splice(i, 1);
  }
}
function drawFloaters(ts) {
  if (!ctx) return;
  for (const f of floaters) {
    const age = ts - f.born;
    const t = age / 900;
    const alpha = 1 - t;
    const dy = -28 * t;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.round(cs() * 0.38)}px monospace`;
    ctx.fillStyle = f.color;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(f.text, f.x, f.y + dy);
    ctx.fillText(f.text, f.x + dy * 0.05, f.y + dy);
    ctx.restore();
  }
}
function cs() { return game?.scenario?.cellSize ?? 48; }

/* hotseat */
let hotseatP1Set = new Set();
let hotseatP2Set = new Set();

/* combat log */
const combatLog = [];

/* ── Helpers ─────────────────────────────────────────── */
function portraitThumbHtml(u, imgClass) {
  const initials = u.displayName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  if (u.portrait)
    return `<img src="attached_assets/units/${u.portrait}" alt="" class="${imgClass}" />`;
  return `<div class="roster-card__ph ${imgClass}">${initials}</div>`;
}

function unitInitials(u) {
  return u.displayName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/* ── Combat log ───────────────────────────────────────── */
function pushLog(text, cls = "") {
  combatLog.unshift({ text, cls });
  if (combatLog.length > 8) combatLog.length = 8;
  const list = document.getElementById("battle-log-list");
  if (!list) return;
  list.innerHTML = "";
  for (const e of combatLog) {
    const li = document.createElement("li");
    li.className = "battle-log__item" + (e.cls ? " " + e.cls : "");
    li.textContent = e.text;
    list.appendChild(li);
  }
}

/* ── Scenario merge ───────────────────────────────────── */
function scenarioPresetEnemies(s) {
  if (Array.isArray(s.presetEnemies) && s.presetEnemies.length) return s.presetEnemies;
  return (s.units || []).filter((u) => u.owner !== 0);
}

const SOLO_ENEMY_TARGETS = { easy: 3, normal: 6, hard: 10, hell: 20 };

function normalizeSoloDifficulty(d) {
  const k = String(d || "normal").toLowerCase();
  if (k === "easy" || k === "normal" || k === "hard" || k === "hell") return k;
  return "normal";
}

function scenarioLooksGrand(scenario, scenarioPath) {
  const maps = mapCatalog.maps || [];
  const entry = scenarioPath && maps.find((x) => x.path === scenarioPath);
  if (entry?.sizeCategory === "grand") return true;
  return scenario.width >= 18 && scenario.height >= 14;
}

function scalePresetEnemiesForSolo(enemies, targetCount, scenario) {
  const w = scenario.width;
  const h = scenario.height;
  const list = (enemies || []).map((e) => ({ ...e, owner: e.owner ?? 1 }));
  if (list.length > targetCount) {
    return list.slice(0, targetCount);
  }
  const deployCells = new Set(
    (scenario.skirmishDeploy || []).map((s) => `${s.x},${s.y}`),
  );
  const blockedForSpawn = new Set(deployCells);
  for (const o of scenario.mapObjects || []) {
    if (o.blocksMove !== false) blockedForSpawn.add(`${o.x},${o.y}`);
  }
  for (const e of list) {
    blockedForSpawn.add(`${e.x},${e.y}`);
  }
  const isSpawnable = (x, y) => {
    const k = `${x},${y}`;
    if (blockedForSpawn.has(k)) return false;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    return true;
  };
  while (list.length < targetCount) {
    const templateId = list.length % 5 === 4 ? "opfor_tank" : "grunt_red";
    const xMin = Math.floor(w * 0.5);
    let pick = null;
    for (let x = w - 2; x >= xMin; x--) {
      for (let y = 1; y < h - 1; y++) {
        if (isSpawnable(x, y)) {
          pick = { x, y };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) {
      for (let x = w - 2; x >= 1; x--) {
        for (let y = 1; y < h - 1; y++) {
          if (isSpawnable(x, y)) {
            pick = { x, y };
            break;
          }
        }
        if (pick) break;
      }
    }
    if (!pick) break;
    list.push({ templateId, owner: 1, x: pick.x, y: pick.y });
    blockedForSpawn.add(`${pick.x},${pick.y}`);
  }
  return list;
}

const STAGING_SPRITES = [
  "assets/obstacles/urban/Obstacle_Urban_Prop_95096f7f.png",
  "assets/obstacles/urban/Obstacle_Urban_Prop_55924153.png",
  "assets/units/vehicles/Obstacle_Urban_Prop_162f599e.png",
];

/** Cosmetic props around the deploy flank on Grand maps (does not block move/LOS). */
function injectFriendlyStagingProps(scenario, scenarioPath) {
  if (!scenario?.skirmishDeploy?.length) return;
  if (!scenarioLooksGrand(scenario, scenarioPath)) return;
  const w = scenario.width;
  const h = scenario.height;
  const deploy = scenario.skirmishDeploy;
  const minX = Math.min(...deploy.map((s) => s.x));
  const maxX = Math.max(...deploy.map((s) => s.x));
  const minY = Math.min(...deploy.map((s) => s.y));
  const maxY = Math.max(...deploy.map((s) => s.y));
  const occupied = new Set(deploy.map((s) => `${s.x},${s.y}`));
  for (const o of scenario.mapObjects || []) {
    occupied.add(`${o.x},${o.y}`);
  }
  const additions = [];
  let spriteIdx = 0;
  const nextSprite = () => STAGING_SPRITES[spriteIdx++ % STAGING_SPRITES.length];
  const flankDir = minX <= w - 1 - maxX ? 1 : -1;
  const aisleX = minX + flankDir;
  const ringXs = [aisleX + flankDir, aisleX + flankDir * 2].filter(
    (x) => x >= 0 && x < w,
  );
  for (let yi = minY; yi <= maxY; yi++) {
    if ((yi - minY) % 2 !== 0) continue;
    for (const rx of ringXs) {
      const k = `${rx},${yi}`;
      if (occupied.has(k)) continue;
      occupied.add(k);
      additions.push(
        makeMapObject(rx, yi, nextSprite(), `staging_${rx}_${yi}`, "crate", {
          blocksMove: false,
          blocksLos: false,
          propAnchor: "bottom",
        }),
      );
    }
  }
  if (!scenario.mapObjects) scenario.mapObjects = [];
  scenario.mapObjects.push(...additions);
}

function mergeScenarioForBattle(baseScenario, mode, loadout, acad, battleOpts = null) {
  const s = JSON.parse(JSON.stringify(baseScenario));
  if (s.usePresetUnits) return s;
  if (mode === "trial" || mode === "hotseat") return s;
  const skirmishLike = mode === "skirmish" || mode === "urban";
  let enemies = scenarioPresetEnemies(s);
  if (skirmishLike && battleOpts?.skirmishDifficulty) {
    const diff = normalizeSoloDifficulty(battleOpts.skirmishDifficulty);
    const n = SOLO_ENEMY_TARGETS[diff] ?? 6;
    enemies = scalePresetEnemiesForSolo(enemies, n, s);
  }
  if (mode === "academy" && loadout?.length && acad?.deploymentSlots) {
    s.units = [];
    loadout.forEach((tid, i) => {
      const slot = acad.deploymentSlots[i];
      if (slot) s.units.push({ templateId: tid, owner: 0, x: slot.x, y: slot.y });
    });
    s.units.push(...enemies);
    return s;
  }
  if (skirmishLike && Array.isArray(loadout) && loadout.length > 0 && s.skirmishDeploy?.length) {
    s.units = [];
    for (let i = 0; i < s.skirmishDeploy.length; i++) {
      const tid = loadout[i];
      const slot = s.skirmishDeploy[i];
      if (tid && slot) s.units.push({ templateId: tid, owner: 0, x: slot.x, y: slot.y });
    }
    s.units.push(...enemies);
    injectFriendlyStagingProps(s, battleOpts?.scenarioPath ?? null);
    return s;
  }
  const p0 = QUICK_PLAYER_UNITS.map((u, i) => {
    const slot = s.skirmishDeploy?.[i];
    if (!slot) return { ...u };
    return { ...u, x: slot.x, y: slot.y };
  });
  s.units = [...p0, ...enemies];
  if (skirmishLike) {
    injectFriendlyStagingProps(s, battleOpts?.scenarioPath ?? null);
  }
  return s;
}

function mergeHotseatScenario(baseScenario, p1Picks, p2Picks) {
  const s = JSON.parse(JSON.stringify(baseScenario));
  s.units = [];
  p1Picks.forEach((tid, i) => {
    const slot = s.p1DeploymentSlots?.[i];
    if (slot) s.units.push({ templateId: tid, owner: 0, x: slot.x, y: slot.y });
  });
  p2Picks.forEach((tid, i) => {
    const slot = s.p2DeploymentSlots?.[i];
    if (slot) s.units.push({ templateId: tid, owner: 1, x: slot.x, y: slot.y });
  });
  return s;
}

/* ── Landing dock (collapsed name tags + flyout panels) ── */
const LP_DOCK_AUTO_CLOSE_MS = 8200;
let lpDockCloseTimer = null;

function clearLpDockTimer() {
  if (lpDockCloseTimer) {
    clearTimeout(lpDockCloseTimer);
    lpDockCloseTimer = null;
  }
}

function collapseLandingDockItem(item) {
  if (!item) return;
  item.classList.remove("lp-dock-item--open");
  const panel = item.querySelector(".lp-dock-panel");
  const tag = item.querySelector(".lp-dock-tag");
  if (panel) panel.hidden = true;
  if (tag) tag.setAttribute("aria-expanded", "false");
}

function collapseAllLandingDockPanels() {
  clearLpDockTimer();
  document.querySelectorAll("#lp-dock .lp-dock-item--open").forEach((item) => collapseLandingDockItem(item));
}

function scheduleLandingDockAutoClose(item) {
  clearLpDockTimer();
  lpDockCloseTimer = setTimeout(() => {
    collapseLandingDockItem(item);
    lpDockCloseTimer = null;
  }, LP_DOCK_AUTO_CLOSE_MS);
}

function expandLandingDockItem(item) {
  document.querySelectorAll("#lp-dock .lp-dock-item").forEach((other) => {
    if (other !== item && other.classList.contains("lp-dock-item--open")) {
      collapseLandingDockItem(other);
    }
  });
  item.classList.add("lp-dock-item--open");
  const panel = item.querySelector(".lp-dock-panel");
  const tag = item.querySelector(".lp-dock-tag");
  if (panel) panel.hidden = false;
  if (tag) tag.setAttribute("aria-expanded", "true");
  scheduleLandingDockAutoClose(item);
}

function wireLandingDock() {
  const dock = document.getElementById("lp-dock");
  if (!dock) return;
  dock.querySelectorAll(".lp-dock-tag").forEach((tag) => {
    tag.addEventListener("click", () => {
      /* Direct nav (Hub, Quick Skirmish): bubble to #app [data-screen] delegate */
      if (tag.getAttribute("data-screen")) return;
      const item = tag.closest(".lp-dock-item");
      if (!item) return;
      const panel = item.querySelector(".lp-dock-panel");
      if (!panel) return;
      if (item.classList.contains("lp-dock-item--open")) {
        clearLpDockTimer();
        collapseLandingDockItem(item);
        return;
      }
      expandLandingDockItem(item);
    });
  });
}

function applyVisualTheme() {
  const classic = settings?.visualStyle === "classic";
  document.body.classList.toggle("ctu--classic", classic);
  document.body.classList.toggle("ctu--hdef", !classic);
}

/* ── Screen routing ───────────────────────────────────── */
function showScreen(name, sectionId) {
  /* Close the codex dossier before leaving — avoids it being position:fixed over other screens */
  if (name !== "codex") closeCodexDossier();
  if (name !== "maps") closeMapTheaterBlowup();

  const v2Alias = name === "v2-landing";
  const screenName = v2Alias ? "landing" : name;

  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.remove("screen--active");
    el.hidden = true;
  });
  const el = document.getElementById("screen-" + screenName);
  if (el) {
    el.classList.add("screen--active");
    el.hidden = false;
  }
  const hdr = document.querySelector(".top-bar");
  if (hdr) hdr.classList.toggle("top-bar--landing", screenName === "landing");
  /* combat_frame.png — keep hidden so battle stays readable (solid black stage). */
  const hudFrame = document.querySelector(".ctu-hud-overlay");
  if (hudFrame) hudFrame.hidden = true;
  if (screenName === "battle") {
    requestAnimationFrame(loop);
    clampBattlePan();
    applyBattleCamera();
  }
  if (screenName === "codex")    renderCodex();
  if (screenName === "hotseat")  openHotseat();
  if (screenName === "settings") applySettingsToUi();
  if (screenName === "maps")     void renderMapTheater();
  if (screenName === "vs-cpu-prep") void openVsCpuPrep();
  if (screenName === "mat-lab-prep") void openMatLabPrep();
  if (screenName === "hub") {
    renderHubRoster(); renderHubModes(); updateGateBanner();
    /* Carousel lives in hidden hub until now — remeasure so ▲/▼ aren't stuck disabled */
    requestAnimationFrame(() => {
      requestAnimationFrame(updateHubCarouselNav);
    });
  }
  if (screenName === "landing") {
    collapseAllLandingDockPanels();
    const vid = document.getElementById("lp-bg-video");
    if (vid && vid.paused) vid.play().catch(() => {});
  }
  /* Document scroll is locked (html/body overflow:hidden); scroll inside scrollable ancestors only */
  window.scrollTo(0, 0);

  /* Scroll to a specific section inside the hub (or other in-app scroll parent) */
  if (sectionId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = document.getElementById(sectionId);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
}

/* ── Hub ──────────────────────────────────────────────── */

const HUB_ICONS = {
  academy: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="5" fill="currentColor"/>
    <circle cx="8"  cy="10" r="3" fill="currentColor" opacity="0.7"/>
    <circle cx="32" cy="10" r="3" fill="currentColor" opacity="0.7"/>
    <circle cx="8"  cy="30" r="3" fill="currentColor" opacity="0.7"/>
    <circle cx="32" cy="30" r="3" fill="currentColor" opacity="0.7"/>
    <line x1="20" y1="20" x2="8"  y2="10" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
    <line x1="20" y1="20" x2="32" y2="10" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
    <line x1="20" y1="20" x2="8"  y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
    <line x1="20" y1="20" x2="32" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  </svg>`,
  defend: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 4 L34 10 L34 22 C34 30 20 38 20 38 C20 38 6 30 6 22 L6 10 Z" stroke="currentColor" stroke-width="2" fill="rgba(143,179,148,0.1)"/>
    <path d="M14 20 L18 24 L26 16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  skirmish: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="2"/>
    <circle cx="20" cy="20" r="8"  stroke="currentColor" stroke-width="1.5"/>
    <circle cx="20" cy="20" r="3"  fill="currentColor"/>
    <line x1="20" y1="2"  x2="20" y2="10" stroke="currentColor" stroke-width="2"/>
    <line x1="20" y1="30" x2="20" y2="38" stroke="currentColor" stroke-width="2"/>
    <line x1="2"  y1="20" x2="10" y2="20" stroke="currentColor" stroke-width="2"/>
    <line x1="30" y1="20" x2="38" y2="20" stroke="currentColor" stroke-width="2"/>
  </svg>`,
  target: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="2"/>
    <circle cx="20" cy="20" r="7"  stroke="currentColor" stroke-width="1.5"/>
    <line x1="8"  y1="8"  x2="32" y2="32" stroke="currentColor" stroke-width="2"/>
    <line x1="32" y1="8"  x2="8"  y2="32" stroke="currentColor" stroke-width="2"/>
  </svg>`,
  urban: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2"  y="20" width="10" height="18" fill="currentColor" opacity="0.45"/>
    <rect x="14" y="10" width="12" height="28" fill="currentColor" opacity="0.65"/>
    <rect x="28" y="16" width="10" height="22" fill="currentColor" opacity="0.45"/>
    <rect x="16" y="14" width="3" height="3" fill="rgba(0,0,0,0.6)"/>
    <rect x="21" y="14" width="3" height="3" fill="rgba(0,0,0,0.6)"/>
    <rect x="16" y="20" width="3" height="3" fill="rgba(0,0,0,0.6)"/>
    <rect x="21" y="20" width="3" height="3" fill="rgba(0,0,0,0.6)"/>
    <circle cx="33" cy="11" r="5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="33" y1="4"  x2="33" y2="7"  stroke="currentColor" stroke-width="1.5"/>
    <line x1="33" y1="15" x2="33" y2="18" stroke="currentColor" stroke-width="1.5"/>
    <line x1="26" y1="11" x2="29" y2="11" stroke="currentColor" stroke-width="1.5"/>
    <line x1="37" y1="11" x2="40" y2="11" stroke="currentColor" stroke-width="1.5"/>
  </svg>`,
  river: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="6"  y="10" width="26" height="10" rx="2" fill="currentColor" opacity="0.6"/>
    <rect x="12" y="5"  width="14" height="9"  rx="2" fill="currentColor" opacity="0.85"/>
    <rect x="22" y="7"  width="12" height="5"  rx="1" fill="currentColor" opacity="0.7"/>
    <path d="M2 28 C6 25 10 31 14 28 C18 25 22 31 26 28 C30 25 34 31 38 28" stroke="currentColor" stroke-width="2"/>
    <path d="M2 34 C6 31 10 37 14 34 C18 31 22 37 26 34 C30 31 34 37 38 34" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  </svg>`,
  maps: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 8 L18 5 L32 9 L32 33 L18 30 L6 34 Z" stroke="currentColor" stroke-width="1.8" fill="currentColor" fill-opacity="0.12"/>
    <path d="M18 5 L18 30" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>
    <circle cx="14" cy="16" r="2.5" fill="currentColor" opacity="0.55"/>
    <circle cx="24" cy="22" r="2" fill="currentColor" opacity="0.45"/>
    <path d="M10 26 L16 20 L22 24 L28 18" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.6"/>
  </svg>`,
};

const BULLET_SVG = `<svg class="hub-mode-card__bullet" viewBox="0 0 14 34" aria-hidden="true">
  <path d="M7 1 C11 1 13 5 13 9 L13 25 C13 30 10 33 7 33 C4 33 1 30 1 25 L1 9 C1 5 3 1 7 1Z" fill="#b09040" stroke="#806820" stroke-width="1"/>
  <rect x="1.5" y="22" width="11" height="10" rx="1" fill="#705a18"/>
  <ellipse cx="7" cy="8" rx="4" ry="6" fill="#d0a848"/>
</svg>`;

function syncHeaderHubNav() {
  const hotNav = document.getElementById("nav-header-hotseat");
  if (!hotNav) return;
  hotNav.disabled = !progress.academyComplete;
}

function updateGateBanner() {
  const el = document.getElementById("hub-gate-banner");
  if (el) el.hidden = !!progress.academyComplete;
  syncHeaderHubNav();
}

function renderHubModes() {
  const host = document.getElementById("hub-modes");
  if (!host || !hubConfig?.soloModes) return;
  host.innerHTML = "";
  for (const m of hubConfig.soloModes) {
    const gated = m.requiresAcademy !== false && !progress.academyComplete;
    const li = document.createElement("li");
    const b  = document.createElement("button");
    b.type = "button";
    b.className = "hub-mode-card" + (gated ? " hub-mode-card--locked" : "");
    b.disabled = gated;
    const iconSvg = HUB_ICONS[m.iconKey] ?? HUB_ICONS.skirmish;
    const bullet  = m.bullet ? BULLET_SVG : "";
    b.innerHTML = `
      <span class="ctu-metal-frame__rivet ctu-metal-frame__rivet--nw" aria-hidden="true"></span>
      <span class="ctu-metal-frame__rivet ctu-metal-frame__rivet--ne" aria-hidden="true"></span>
      <span class="ctu-metal-frame__rivet ctu-metal-frame__rivet--sw" aria-hidden="true"></span>
      <span class="ctu-metal-frame__rivet ctu-metal-frame__rivet--se" aria-hidden="true"></span>
      <span class="hub-mode-card__icon-box">${iconSvg}</span>
      <span class="hub-mode-card__switch" aria-hidden="true"></span>
      <span class="hub-mode-card__body">
        <span class="hub-mode-card__title">${m.title}</span>
      </span>
      ${bullet}`;
    b.addEventListener("click", () => {
      if (b.disabled) return;
      if (m.action === "maps") {
        mapsReturnTarget = null;
        showScreen("maps");
        return;
      }
      if (m.action === "mat_lab") {
        showScreen("mat-lab-prep");
        return;
      }
      if (m.action === "procedural") {
        pendingProceduralSkirmishSpec = {
          theme: m.procTheme,
          biome: m.procBiome,
        };
        pendingUserMapPath = null;
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
        return;
      }
      if (m.action === "academy") openAcademy();
      else if (m.action === "skirmish") {
        pendingProceduralSkirmishSpec = null;
        pendingUserMapPath = m.scenarioPath || null;
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
      } else if (m.action === "trial") {
        pendingProceduralSkirmishSpec = null;
        pendingUserMapPath =
          m.scenarioPath || "js/config/scenarios/trial_survive.json";
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
      } else if (m.action === "scenario") {
        pendingProceduralSkirmishSpec = null;
        if (m.scenarioPath) pendingUserMapPath = m.scenarioPath;
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
      }
    });
    li.appendChild(b);
    host.appendChild(li);
  }

  /* Season signup card */
  const tour = document.getElementById("hub-tournament");
  if (tour && hubConfig?.tournament) {
    const t = hubConfig.tournament;
    tour.innerHTML = `
      <div class="hub-season-card">
        <p class="hub-season-card__title">${t.title}</p>
        <p class="hub-season-card__blurb">${t.blurb}</p>
        <a class="hub-season-card__btn" href="${t.externalUrl}" target="_blank" rel="noopener">${t.buttonLabel}</a>
      </div>`;
  }

  requestAnimationFrame(() => requestAnimationFrame(updateHubCarouselNav));
}


function renderHubRoster() {
  /* stats bar */
  const wins   = document.getElementById("hub-stats-wins");
  const losses = document.getElementById("hub-stats-losses");
  const led    = document.getElementById("hub-stats-led");
  const label  = document.getElementById("hub-stats-label");
  if (wins)   wins.textContent   = String(progress.wins   ?? 0);
  if (losses) losses.textContent = String(progress.losses ?? 0);
  if (led)    led.className      = `hub-stats-bar__led ${progress.academyComplete ? "hub-stats-bar__led--green" : "hub-stats-bar__led--amber"}`;
  if (label)  label.textContent  = progress.academyComplete ? "Academy complete ✓" : "Academy open";

  const host = document.getElementById("hub-roster");
  if (!host) return;

  const rosterUnits = unitRegistry.filter((u) => !u.tags?.includes("ai"));
  const HUB_ROSTER_SLOTS = 20;
  host.innerHTML = "";

  for (let i = 0; i < HUB_ROSTER_SLOTS; i++) {
    const u = rosterUnits[i];
    if (!u) {
      const empty = document.createElement("div");
      empty.className = "hub-roster-slot hub-roster-slot--empty";
      empty.setAttribute("aria-hidden", "true");
      host.appendChild(empty);
      continue;
    }

    const unlocked = isUnlocked(progress, u.id);
    const tags = (u.tags || []).filter((t) => t !== "ai");
    const dotCls = tags.includes("coreA")
      ? "hub-roster-slot__led--green"
      : tags.includes("addonB")
        ? "hub-roster-slot__led--blue"
        : "hub-roster-slot__led--amber";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "hub-roster-slot" + (unlocked ? "" : " hub-roster-slot--locked");
    btn.setAttribute("aria-label", `${u.displayName} — open in Codex`);
    btn.title = u.displayName;

    const iconHtml = u.portrait
      ? `<span class="hub-roster-slot__well"><img src="attached_assets/units/${u.portrait}" alt="" class="hub-roster-slot__icon" width="64" height="64" decoding="async" /></span>`
      : `<span class="hub-roster-slot__well hub-roster-slot__well--initials"><span class="hub-roster-slot__initials" aria-hidden="true">${unitInitials(u)}</span></span>`;

    btn.innerHTML = `${iconHtml}<span class="hub-roster-slot__led ${dotCls}" aria-hidden="true"></span>`;

    btn.addEventListener("click", () => {
      showScreen("codex");
      selectCodexUnit(u.id);
    });
    host.appendChild(btn);
  }
}

/* ── Academy ──────────────────────────────────────────── */
function openAcademy() {
  academyPickSet.clear();
  const host = document.getElementById("academy-picks");
  if (!host || !academyConfig) return;
  const tag = academyConfig.registryTag || "academyPick";
  const offer = unitRegistry.filter((u) => u.tags?.includes(tag) && isUnlocked(progress, u.id) && !u.tags?.includes("ai"));
  host.innerHTML = "";
  const count = academyConfig.pickCount ?? 3;
  for (const u of offer) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "academy-offer";
    btn.dataset.unitId = u.id;
    const ph = portraitThumbHtml(u, "academy-offer__img");
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="academy-offer__stats muted small">${u.hp} HP · mv ${u.move} · ${u.attackType}</span></span>`;
    btn.addEventListener("click", () => toggleAcademyPick(u.id, count, btn));
    host.appendChild(btn);
  }
  document.getElementById("academy-status").textContent = `Choose ${count} units.`;
  showScreen("academy");
}

function toggleAcademyPick(id, max, btnEl) {
  if (academyPickSet.has(id)) { academyPickSet.delete(id); btnEl.classList.remove("academy-offer--on"); }
  else if (academyPickSet.size < max) { academyPickSet.add(id); btnEl.classList.add("academy-offer--on"); }
  document.getElementById("academy-status").textContent = `Selected ${academyPickSet.size}/${max}.`;
  document.getElementById("btn-academy-confirm").disabled = academyPickSet.size !== max;
}

function confirmAcademy() {
  const count = academyConfig?.pickCount ?? 3;
  if (academyPickSet.size !== count) return;
  bootBattle({ mode: "academy", loadout: [...academyPickSet], scenarioPath: academyConfig?.scenarioPath });
}

async function refreshPendingMapSkirmishSlotCount() {
  if (pendingProceduralSkirmishSpec) {
    pendingMapSkirmishSlotCount = 4;
    pendingVsCpuScenarioName = null;
    return;
  }
  const path = pendingUserMapPath || "js/config/scenarios/academy_skirmish.json";
  try {
    const sb = await loadJson(path);
    pendingMapSkirmishSlotCount = Math.min(8, Math.max(1, sb.skirmishDeploy?.length ?? 8));
    pendingVsCpuScenarioName =
      typeof sb?.name === "string" && sb.name.trim() ? sb.name.trim() : null;
  } catch (e) {
    console.warn("[CTU] skirmish slot count", e);
    pendingMapSkirmishSlotCount = 8;
    pendingVsCpuScenarioName = null;
  }
}

async function openVsCpuPrep() {
  await refreshPendingMapSkirmishSlotCount();
  const diffSel = document.getElementById("vs-cpu-prep-difficulty");
  if (diffSel) {
    diffSel.value = normalizeSoloDifficulty(settings.soloDifficulty);
  }
  const need = pendingMapSkirmishSlotCount || 8;
  const n = pendingSkirmishOrderedLoadout?.length ?? 0;
  if (pendingSkirmishOrderedLoadout && (n < 1 || n > need)) {
    pendingSkirmishOrderedLoadout = null;
  }
  syncVsCpuPrepUi();
}

function syncVsCpuPrepUi() {
  const mapEl = document.getElementById("vs-cpu-prep-map");
  const squadEl = document.getElementById("vs-cpu-prep-squad");
  const startBtn = document.getElementById("btn-vs-cpu-prep-start");
  const maps = mapCatalog.maps || [];
  const cur = maps.find((x) => x.path === pendingUserMapPath);
  if (mapEl) {
    let line;
    if (pendingProceduralSkirmishSpec) {
      const label =
        pendingProceduralSkirmishSpec.theme ||
        pendingProceduralSkirmishSpec.biome ||
        "Urban";
      line = `✓ Procedural ${label} (random layout when you start)`;
      const diff = normalizeSoloDifficulty(settings.soloDifficulty);
      if (diff === "hell") {
        line += " — Hell uses a 20×16 battlefield.";
      }
    } else if (cur) {
      line = `✓ ${cur.name} (${cur.width}×${cur.height})`;
      const diff = normalizeSoloDifficulty(settings.soloDifficulty);
      if (diff === "hell" && cur.sizeCategory !== "grand") {
        line += " — Hell on Earth will use a Grand map when you start.";
      }
    } else if (pendingUserMapPath) {
      const brief =
        pendingVsCpuScenarioName ||
        pendingUserMapPath.split("/").pop()?.replace(/\.json$/i, "") ||
        "Scenario";
      line = `✓ ${brief}`;
    } else {
      line =
        "Not chosen — use Map theater, or pick a mode from the Hub that sets a battlefield.";
    }
    mapEl.textContent = line;
  }
  const need = pendingMapSkirmishSlotCount || 8;
  const n = pendingSkirmishOrderedLoadout?.length ?? 0;
  if (squadEl) {
    squadEl.textContent =
      n >= 1 && n <= need
        ? `✓ ${n} unit(s) ready (uses first ${n} deploy slots; max ${need})`
        : `Pick 1–${need} units — ${n} selected.`;
  }
  const mapReady = !!pendingUserMapPath || !!pendingProceduralSkirmishSpec;
  const ready = mapReady && n >= 1 && n <= need;
  if (startBtn) startBtn.disabled = !ready;
}

async function openMatLabPrep() {
  if (!pendingMatLabTheater) pendingMatLabTheater = "grass";
  syncMatLabPrepUi();
}

const MAT_LAB_THEATER_LABEL = {
  grass: "Grass mat",
  desert: "Desert mat",
  urban: "Urban mat",
};

function syncMatLabPrepUi() {
  const matEl = document.getElementById("mat-lab-prep-mat");
  const squadEl = document.getElementById("mat-lab-prep-squad");
  const startBtn = document.getElementById("btn-mat-lab-start");
  const th = pendingMatLabTheater || "grass";
  if (matEl) {
    matEl.textContent = `✓ ${MAT_LAB_THEATER_LABEL[th] ?? th}`;
  }
  const n = pendingMatLabLoadout?.length ?? 0;
  if (squadEl) {
    squadEl.textContent =
      n >= 1
        ? `✓ ${n} unit(s) — deploy order saved (max 8)`
        : "Not chosen — pick 1–8 units.";
  }
  if (startBtn) startBtn.disabled = n < 1 || n > 8;
  document.querySelectorAll("#screen-mat-lab-prep [data-mat-theater]").forEach((btn) => {
    const k = btn.getAttribute("data-mat-theater");
    btn.classList.toggle("academy-offer--on", k === th);
  });
}

function syncMapSkirmishCta() {
  const cta = document.getElementById("btn-map-skirmish-confirm");
  if (!cta) return;
  const n = mapSkirmishPickSet.size;
  cta.disabled = n < 1 || n > mapSkirmishPickCount;
}

/* ── Map theater → vs CPU loadout (full roster, no unlock gate) ─ */
async function openMapSkirmishLoadout(opts = {}) {
  const returnToPrep = opts.returnToPrep === true;
  const matLab = opts.matLab === true;
  mapSkirmishPrepReturnId = matLab ? "mat-lab-prep" : returnToPrep ? "vs-cpu-prep" : null;

  if (!matLab && !returnToPrep && !pendingUserMapPath) {
    const sel = document.getElementById("map-theater-selected");
    if (sel) sel.textContent = "Select a map first — click a map card below.";
    mapSkirmishPrepReturnId = null;
    return;
  }

  if (matLab) {
    pendingMapSkirmishSlotCount = 8;
    mapSkirmishPickCount = 8;
  } else {
    await refreshPendingMapSkirmishSlotCount();
    mapSkirmishPickCount = pendingMapSkirmishSlotCount;
  }

  mapSkirmishPickSet.clear();
  const restoreOrder = matLab
    ? pendingMatLabLoadout
    : returnToPrep
      ? pendingSkirmishOrderedLoadout
      : null;
  if (restoreOrder?.length) {
    for (const id of restoreOrder) {
      if (mapSkirmishPickSet.size < mapSkirmishPickCount) mapSkirmishPickSet.add(id);
    }
  }

  let scenarioBase;
  try {
    if (matLab) {
      scenarioBase = await loadJson(PLANE_LAYER_SCENARIO_PATH);
    } else {
      scenarioBase = pendingUserMapPath
        ? await loadJson(pendingUserMapPath)
        : await loadJson("js/config/scenarios/academy_skirmish.json");
    }
  } catch (e) {
    console.warn("[CTU] map loadout: failed to load scenario", e);
    const sel = document.getElementById("map-theater-selected");
    if (sel) sel.textContent = "Could not load that map. Pick another.";
    mapSkirmishPrepReturnId = null;
    return;
  }

  const nameEl = document.getElementById("map-skirmish-map-name");
  if (nameEl) {
    if (matLab) {
      nameEl.textContent = "Battle mat lab";
    } else {
      nameEl.textContent = pendingUserMapPath
        ? scenarioBase.name || "Battlefield"
        : "Choose squad (map next)";
    }
  }

  const host = document.getElementById("map-skirmish-picks");
  if (!host) return;
  if (!unitRegistry.length) {
    try {
      unitRegistry = await loadMergedUnitsFromConfig();
    } catch (e) {
      console.warn("[CTU] map loadout: units.json", e);
      return;
    }
  }
  host.innerHTML = "";
  const offer = unitRegistry.filter((u) => !u.tags?.includes("ai"));
  for (const u of offer) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "academy-offer";
    if (mapSkirmishPickSet.has(u.id)) btn.classList.add("academy-offer--on");
    btn.dataset.unitId = u.id;
    const ph = portraitThumbHtml(u, "academy-offer__img");
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="academy-offer__stats muted small">${u.hp} HP · mv ${u.move} · ${u.attackType}</span></span>`;
    btn.addEventListener("click", () => toggleMapSkirmishPick(u.id, btn));
    host.appendChild(btn);
  }
  const st = document.getElementById("map-skirmish-status");
  if (st) {
    if (matLab) {
      st.textContent = `Pick 1–8 units (full roster). Click order = deploy order on the mat.`;
    } else if (returnToPrep) {
      st.textContent = `Pick 1–${mapSkirmishPickCount} units — you can choose the map on the setup screen if needed. Order = deploy slots.`;
    } else {
      st.textContent = `Pick 1–${mapSkirmishPickCount} units — full roster unlocked for this route. Order = deploy slots.`;
    }
  }
  syncMapSkirmishCta();
  const ctaLab = document.getElementById("btn-map-skirmish-confirm");
  if (ctaLab) {
    ctaLab.textContent =
      mapSkirmishPrepReturnId === "mat-lab-prep" || mapSkirmishPrepReturnId === "vs-cpu-prep"
        ? "Save squad"
        : "Start battle";
  }
  const backLab = document.getElementById("btn-map-skirmish-back");
  if (backLab) {
    if (mapSkirmishPrepReturnId === "mat-lab-prep") backLab.textContent = "← Mat lab setup";
    else if (mapSkirmishPrepReturnId === "vs-cpu-prep") backLab.textContent = "← Vs CPU setup";
    else backLab.textContent = "← Map theater";
  }
  showScreen("map-skirmish");
}

function toggleMapSkirmishPick(id, btnEl) {
  if (mapSkirmishPickSet.has(id)) {
    mapSkirmishPickSet.delete(id);
    btnEl.classList.remove("academy-offer--on");
  } else if (mapSkirmishPickSet.size < mapSkirmishPickCount) {
    mapSkirmishPickSet.add(id);
    btnEl.classList.add("academy-offer--on");
  }
  const st = document.getElementById("map-skirmish-status");
  if (st) {
    st.textContent = `Selected ${mapSkirmishPickSet.size}/${mapSkirmishPickCount} — need at least 1, at most ${mapSkirmishPickCount}.`;
  }
  syncMapSkirmishCta();
}

function confirmMapSkirmish() {
  const n = mapSkirmishPickSet.size;
  if (n < 1 || n > mapSkirmishPickCount) return;

  const ret = mapSkirmishPrepReturnId;
  if (ret === "mat-lab-prep") {
    pendingMatLabLoadout = [...mapSkirmishPickSet];
    mapSkirmishPrepReturnId = null;
    syncMatLabPrepUi();
    showScreen("mat-lab-prep");
    return;
  }
  if (ret === "vs-cpu-prep") {
    pendingSkirmishOrderedLoadout = [...mapSkirmishPickSet];
    mapSkirmishPrepReturnId = null;
    void openVsCpuPrep();
    showScreen("vs-cpu-prep");
    return;
  }

  mapSkirmishPrepReturnId = null;
  if (!pendingUserMapPath) return;
  void bootBattle({
    mode: "skirmish",
    loadout: [...mapSkirmishPickSet],
    scenarioPath: pendingUserMapPath,
    skirmishDifficulty: normalizeSoloDifficulty(settings.soloDifficulty),
  });
}

/* ── Hotseat ──────────────────────────────────────────── */
const HOTSEAT_PICK_COUNT = 2;

function openHotseat() {
  hotseatP1Set.clear();
  hotseatP2Set.clear();
  buildHotseatPicker("hotseat-p1-picks", hotseatP1Set, "hotseat-p1-status", 1);
  buildHotseatPicker("hotseat-p2-picks", hotseatP2Set, "hotseat-p2-status", 2);
  syncHotseatStart();
}

function buildHotseatPicker(hostId, pickSet, statusId, playerNum) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = "";
  const offer = unitRegistry.filter((u) => !u.tags?.includes("ai") && isUnlocked(progress, u.id));
  for (const u of offer) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "academy-offer";
    btn.dataset.unitId = u.id;
    const ph = portraitThumbHtml(u, "academy-offer__img");
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="academy-offer__stats muted small">${u.hp} HP · mv ${u.move}</span></span>`;
    btn.addEventListener("click", () => {
      if (pickSet.has(u.id)) { pickSet.delete(u.id); btn.classList.remove("academy-offer--on"); }
      else if (pickSet.size < HOTSEAT_PICK_COUNT) { pickSet.add(u.id); btn.classList.add("academy-offer--on"); }
      document.getElementById(statusId).textContent = `Selected ${pickSet.size}/${HOTSEAT_PICK_COUNT}.`;
      syncHotseatStart();
    });
    host.appendChild(btn);
  }
}

function syncHotseatStart() {
  const btn = document.getElementById("btn-hotseat-start");
  if (btn) btn.disabled = hotseatP1Set.size < HOTSEAT_PICK_COUNT || hotseatP2Set.size < HOTSEAT_PICK_COUNT;
}

async function bootHotseat() {
  const hotseatScenarioPath =
    pendingUserMapPath || "js/config/scenarios/hotseat.json";
  const [unitsRaw, tiles, sprites, scenarioBase, fx] = await Promise.all([
    loadJson("js/config/units.json"),
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/spriteAnimations.json"),
    loadJson(hotseatScenarioPath),
    loadJson("js/config/attackEffects.json"),
  ]);
  const units = mergeUnitTemplates(unitsRaw);
  unitRegistry = units;
  tileTypes = tiles.types;
  spriteAnimations = sprites;
  attackEffects = fx;
  const scenario = mergeHotseatScenario(scenarioBase, [...hotseatP1Set], [...hotseatP2Set]);
  attachCatalogBiomeFromPath(scenario, hotseatScenarioPath);
  battlePlaneCtl = null;
  game = new GameState(scenario, units, tileTypes, {
    visualStyle: battleVisualStyle(),
  });
  battlePlaneCtl = await createBattlePlaneController(game, tileTypes);
  resizeBattleCanvas();
  syncBattleAmbientFromScenario();
  requestAnimationFrame(() => centerBattleCamera());
  game.hotseat = true;
  game.playerNames = ["Player 1", "Player 2"];
  unitRenderer = new UnitRenderer(spriteAnimations);
  battleVfx = new BattleVfx();
  battleFx = new FxLayer();
  combatLog.length = 0;
  treadMarks.length = 0;
  lerp = null;
  battleHoverCellValid = false;
  lastBootOptions = {
    mode: "hotseat",
    loadout: null,
    scenarioPath: hotseatScenarioPath,
    scenarioInline: null,
    matLabTheater: null,
    skirmishDifficulty: null,
  };
  battleEndHandled = false;
  battleHints = { movedOnce: false, attackedOnce: false };
  syncHud();
  showScreen("battle");
  showInterstitial(0);
}

/* ── Interstitial ─────────────────────────────────────── */
function showInterstitial(playerIdx) {
  const el = document.getElementById("battle-interstitial");
  const nameEl = document.getElementById("interstitial-player-name");
  if (!el || !nameEl) return;
  nameEl.textContent = game?.playerNames?.[playerIdx] ?? `Player ${playerIdx + 1}`;
  el.hidden = false;
}
function hideInterstitial() {
  const el = document.getElementById("battle-interstitial");
  if (el) el.hidden = true;
}

/* ── Result overlay ───────────────────────────────────── */
function showResultOverlay() {
  if (!game || game.winner == null) return;
  const el = document.getElementById("battle-result-overlay");
  if (!el) return;
  const won = game.winner === 0;
  const icon = document.getElementById("battle-result-icon");
  const title = document.getElementById("battle-result-title");
  const stats = document.getElementById("battle-result-stats");
  if (icon) icon.textContent = won ? "🏆" : "💀";
  const titleText = game.hotseat
    ? (won ? `${game.playerNames?.[0] ?? "Player 1"} wins!` : `${game.playerNames?.[1] ?? "Player 2"} wins!`)
    : (won ? "Victory!" : "Defeat");
  if (title) title.textContent = titleText;
  if (stats) {
    const alive     = game.units.filter((u) => u.hp > 0);
    const friendly  = alive.filter((u) => u.owner === 0).length;
    const enemy     = alive.filter((u) => u.owner === 1).length;
    const totalP0   = game.units.filter((u) => u.owner === 0).length;
    const totalP1   = game.units.filter((u) => u.owner === 1).length;
    const rounds    = game.fullRoundsCompleted;
    const p0Lost    = totalP0 - friendly;
    const p1Lost    = totalP1 - enemy;
    const p1Name    = game.hotseat ? (game.playerNames?.[1] ?? "Player 2") : "Enemy";
    stats.innerHTML =
      `<span class="result-stat"><b>${battleStats.p0Kills}</b> kills · <b>${p0Lost}</b> lost</span>` +
      `<span class="result-stat result-stat--sep">vs</span>` +
      `<span class="result-stat"><b>${battleStats.p1Kills}</b> ${p1Name} kills · <b>${p1Lost}</b> lost</span>` +
      `<span class="result-stat result-stat--rounds">Rounds: ${rounds}</span>`;
  }
  el.hidden = false;
}

/* ── HUD sync ─────────────────────────────────────────── */
function syncHud() {
  const phaseEl   = document.getElementById("hud-phase");
  const turnEl    = document.getElementById("hud-turn");
  const selEl     = document.getElementById("hud-selection");
  const mapNameEl = document.getElementById("hud-map-name");
  if (!game) return;
  const who = game.hotseat
    ? (game.playerNames?.[game.currentPlayer] ?? `Player ${game.currentPlayer + 1}`)
    : (game.currentPlayer === 0 ? "You" : "Opfor");
  if (turnEl) turnEl.textContent = `Turn: ${who}`;
  if (mapNameEl) mapNameEl.textContent = game.scenario?.name ?? "";
  const wc = game.scenario?.winCondition;
  let phase = "Tactical — direct fire needs LOS.";
  if (game.winner != null) {
    phase = game.winner === 0
      ? (game.hotseat ? `${game.playerNames?.[0] ?? "P1"} wins!` : "Victory!")
      : (game.hotseat ? `${game.playerNames?.[1] ?? "P2"} wins!` : "Defeat");
  } else if (wc?.type === "survive") {
    const need = wc.rounds ?? 1;
    phase = `Survive ${need} rounds (${game.fullRoundsCompleted}/${need}). Eliminate or outlast.`;
  } else if (lastBootOptions.mode === "academy") {
    phase = "Academy — " + phase;
  } else if (lastBootOptions.mode === "urban") {
    phase = "Urban Siege — cover collapses when struck. " + phase;
  }
  if (phaseEl) phaseEl.textContent = phase;
  const u = game.getSelected();

  /* portrait panel */
  const portraitRow  = document.getElementById("hud-portrait-row");
  const portraitEl   = document.getElementById("hud-portrait");
  const portraitName = document.getElementById("hud-portrait-name");
  const portraitHp   = document.getElementById("hud-portrait-hp");
  if (portraitRow) {
    if (!u) {
      portraitRow.hidden = true;
    } else {
      portraitRow.hidden = false;
      if (portraitEl) {
        const tpl = unitRegistry.find((t) => t.id === u.templateId);
        if (tpl?.portrait) {
          portraitEl.innerHTML = `<img src="attached_assets/units/${tpl.portrait}" alt="" class="hud__portrait-img" />`;
        } else {
          portraitEl.textContent = unitInitials(u);
        }
      }
      if (portraitName) portraitName.textContent = u.displayName;
      if (portraitHp) {
        const pct = u.hp / u.maxHp;
        const col = pct > 0.6 ? "#40c057" : pct > 0.3 ? "#fab005" : "#fa5252";
        portraitHp.innerHTML = `<span style="color:${col}">${u.hp}/${u.maxHp} HP</span>`;
      }
      const kitsEl = document.getElementById("hud-support-kits");
      if (kitsEl) {
        if (u.supportRole && (u.supportChargesMax ?? 0) > 0) {
          kitsEl.hidden = false;
          kitsEl.setAttribute("aria-hidden", "false");
          const icon =
            u.supportRole === "engineer"
              ? "assets/ui/engineer_kit.svg"
              : "assets/ui/med_kit.svg";
          const n = Math.max(0, u.supportChargesRemaining ?? 0);
          const maxK = u.supportChargesMax ?? 3;
          const parts = [];
          for (let i = 0; i < maxK; i++) {
            const on = i < n;
            parts.push(
              `<img src="${icon}" alt="" width="12" height="12" class="hud__kit-icon${on ? "" : " hud__kit-icon--spent"}" />`,
            );
          }
          kitsEl.innerHTML = parts.join("");
        } else {
          kitsEl.hidden = true;
          kitsEl.setAttribute("aria-hidden", "true");
          kitsEl.innerHTML = "";
        }
      }
    }
  }

  if (selEl) {
    if (!u) {
      selEl.textContent = "Select a unit";
    } else {
      const moveStatus = u.movedThisTurn ? "moved ✓" : `move ${u.move} tiles`;
      const atkStatus  = u.attackedThisTurn ? "attacked ✓" : (u.canCounter === false ? "no counter" : "can attack");
      const rangeStr   = u.rangeMin === u.rangeMax ? `range ${u.rangeMin}` : `range ${u.rangeMin}–${u.rangeMax}`;
      const proneStr =
        u.templateId === "sniper" ? (u.prone ? " · PRONE (P)" : " · press P prone") : "";
      const kitStr =
        u.supportRole && (u.supportChargesRemaining ?? 0) >= 0
          ? u.supportRole === "engineer"
            ? ` · ${u.supportChargesRemaining ?? 0} repair kit(s)`
            : ` · ${u.supportChargesRemaining ?? 0} med pack(s)`
          : "";
      selEl.textContent = `${u.displayName}  ·  ${moveStatus}  ·  ${atkStatus}  ·  ${rangeStr}${proneStr}${kitStr}`;
    }
  }
  const atkOvr = document.getElementById("btn-battle-attack-overlay");
  if (atkOvr) {
    atkOvr.setAttribute("aria-pressed", battleAttackRangePinned ? "true" : "false");
    atkOvr.classList.toggle("btn--toggle-on", battleAttackRangePinned);
  }
  syncCoachPanel();
}

function getCachedAttackOverlay(sel) {
  if (!sel || !game) return null;
  const key = `${sel.id}|${sel.x}|${sel.y}|${sel.attackedThisTurn}|${game.currentPlayer}|${sel.supportChargesRemaining ?? ""}`;
  if (key !== battleOverlayCacheKey) {
    battleOverlayCacheKey = key;
    battleOverlayCache = computeAttackRangeOverlay(sel, game);
  }
  return battleOverlayCache;
}

/** Hover label for an empty tile (or under a unit) when a friendly is selected. */
function classifyBattleHoverTile(x, y, sel) {
  if (!game || !sel) return null;
  const k = `${x},${y}`;
  const reach = game.reachableFor(sel);
  if (reach?.has(k)) return "Move";
  const ally = game.unitAt(x, y);
  if (
    ally &&
    ally.owner === game.currentPlayer &&
    ally.id !== sel.id &&
    ally.hp > 0 &&
    sel.supportRole &&
    (sel.supportChargesRemaining ?? 0) > 0 &&
    canHealSupport(sel, ally, game.units, game.losCtx())
  ) {
    return sel.supportRole === "engineer" ? "Repair" : "Heal";
  }
  const ov = getCachedAttackOverlay(sel);
  if (!ov) return null;
  if (!ov.weaponBand.has(k)) return "Out of range";
  if (ov.cannotHit.has(k)) return "Cannot hit";
  if (ov.losBlocked.has(k)) return "Blocked (LOS)";
  return "Attack";
}

/* ── Coach ────────────────────────────────────────────── */
function coachActiveStep() {
  const steps = onboardingConfig?.steps || [];
  if (!steps.length) return null;
  if (!battleHints.movedOnce) return steps[0];
  if (!battleHints.attackedOnce) return steps[1] ?? steps[0];
  return steps[2] ?? steps[steps.length - 1];
}
function coachHighlightKeys() {
  if (lastBootOptions.mode !== "academy") return new Set();
  const step = coachActiveStep();
  if (!step?.highlightTiles?.length) return new Set();
  return new Set(step.highlightTiles.map(([x, y]) => `${x},${y}`));
}
function syncCoachPanel() {
  const wrap = document.getElementById("battle-coach");
  const textEl = document.getElementById("battle-coach-text");
  if (!wrap || !textEl) return;
  if (!game || progress.hideBattleCoach || !onboardingConfig?.steps?.length || game.hotseat) { wrap.hidden = true; return; }
  const step = coachActiveStep();
  if (!step) { wrap.hidden = true; return; }
  wrap.hidden = false;
  textEl.textContent = step.objective;
}

/* ── Canvas helpers ───────────────────────────────────── */
/**
 * Map pointer to grid cell. Uses canvas.getBoundingClientRect() so mapping matches
 * the composed transform (pan/zoom on #battle-canvas-scaler) in the browser.
 */
function cellFromEvent(ev) {
  const cs = game.grid.cellSize;
  if (canvas && game?.grid) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const sx = (ev.clientX - rect.left) * (canvas.width / rect.width);
      const sy = (ev.clientY - rect.top) * (canvas.height / rect.height);
      return {
        x: Math.floor((sx - gridOffsetX) / cs),
        y: Math.floor((sy - gridOffsetY) / cs),
      };
    }
  }
  const rect = canvas.getBoundingClientRect();
  const sx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  return {
    x: Math.floor((sx - gridOffsetX) / cs),
    y: Math.floor((sy - gridOffsetY) / cs),
  };
}

function updateBattlePointerHover(ev) {
  if (!game?.grid || !canvas) {
    battleHoverCellValid = false;
    return;
  }
  if (!document.getElementById("screen-battle")?.classList.contains("screen--active")) {
    battleHoverCellValid = false;
    return;
  }
  const { x, y } = cellFromEvent(ev);
  const w = game.grid.width;
  const h = game.grid.height;
  battleHoverCellValid = x >= 0 && y >= 0 && x < w && y < h;
  battleHoverGx = x;
  battleHoverGy = y;
}

function resizeBattleCanvas() {
  if (!canvas || !game?.grid) return;
  const cs = game.grid.cellSize;
  const m = 24;
  canvas.width = game.grid.width * cs + m * 2;
  canvas.height = game.grid.height * cs + m * 2;
  clampBattlePan();
  applyBattleCamera();
}

function centerBattleCamera() {
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena || !canvas) return;
  const z = getBattleZoomLevel();
  const mapW = canvas.width * z;
  const mapH = canvas.height * z;
  const vw = arena.clientWidth;
  const vh = arena.clientHeight;
  battlePanX = (vw - mapW) / 2;
  battlePanY = (vh - mapH) / 2;
  clampBattlePan();
  applyBattleCamera();
}

function syncBattleAmbientFromScenario() {
  if (!game?.grid) {
    sharedBattleAmbient.clear();
    return;
  }
  sharedBattleAmbient.setFromDefs(game.scenario?.ambientEffects ?? [], game.grid.cellSize);
}

function getBattleZoomLevel() {
  const raw = settings.battleZoom ?? 1.25;
  return Math.max(BATTLE_ZOOM_MIN, Math.min(BATTLE_ZOOM_MAX, raw));
}

/** Keep viewport center stable when zoom changes (slider / programmatic). */
function applyBattleZoomKeepingCenter(newZ) {
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena || !canvas) return;
  const oldZ = getBattleZoomLevel();
  const z = Math.max(BATTLE_ZOOM_MIN, Math.min(BATTLE_ZOOM_MAX, newZ));
  const rect = arena.getBoundingClientRect();
  const ox = rect.width / 2;
  const oy = rect.height / 2;
  const wx = (ox - battlePanX) / oldZ;
  const wy = (oy - battlePanY) / oldZ;
  settings.battleZoom = z;
  saveSettings(settings);
  battlePanX = ox - wx * z;
  battlePanY = oy - wy * z;
  clampBattlePan();
  applyBattleCamera();
}

function syncBattleZoomLabel() {
  const el = document.getElementById("battle-zoom-label");
  const slider = document.getElementById("battle-zoom-slider");
  const z = getBattleZoomLevel();
  const pct = Math.round(z * 100);
  if (el) el.textContent = `${pct}%`;
  if (slider) {
    const lo = Number(slider.min);
    const hi = Number(slider.max);
    const clamped = Math.max(lo, Math.min(hi, pct));
    if (Number(slider.value) !== clamped) slider.value = String(clamped);
    slider.setAttribute("aria-valuetext", `${pct}%`);
  }
}

function clampBattlePan() {
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena || !canvas) return;
  const z = getBattleZoomLevel();
  const mapW = canvas.width * z;
  const mapH = canvas.height * z;
  const vw = arena.clientWidth;
  const vh = arena.clientHeight;
  if (mapW <= vw) battlePanX = (vw - mapW) / 2;
  else battlePanX = Math.min(0, Math.max(vw - mapW, battlePanX));
  if (mapH <= vh) battlePanY = (vh - mapH) / 2;
  else battlePanY = Math.min(0, Math.max(vh - mapH, battlePanY));
}

function applyBattleCamera() {
  const sc = document.getElementById("battle-canvas-scaler");
  if (!sc || !canvas) return;
  const z = getBattleZoomLevel();
  sc.style.transform = `translate(${battlePanX}px, ${battlePanY}px) scale(${z})`;
  sc.style.transformOrigin = "0 0";
  syncBattleZoomLabel();
}

function onBattleArenaPointerDown(ev) {
  if (!game || game.winner != null) return;
  const battleEl = document.getElementById("screen-battle");
  if (!battleEl?.classList.contains("screen--active")) return;
  if (ev.button !== 0) return;
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena?.contains(ev.target)) return;

  battlePointerDrag = {
    kind: "pending",
    x0: ev.clientX,
    y0: ev.clientY,
    pid: ev.pointerId,
  };
  /* Capture only after pan threshold — capturing here breaks click→canvas on some browsers. */
}

function onBattleArenaPointerMove(ev) {
  if (!battlePointerDrag || battlePointerDrag.pid !== ev.pointerId) return;
  const arena = document.getElementById("battle-canvas-arena");
  const sc = document.getElementById("battle-canvas-scaler");
  if (battlePointerDrag.kind === "pending") {
    const dx = ev.clientX - battlePointerDrag.x0;
    const dy = ev.clientY - battlePointerDrag.y0;
    if (Math.abs(dx) + Math.abs(dy) < BATTLE_PAN_THRESHOLD) return;
    battlePointerDrag = {
      kind: "pan",
      startClientX: battlePointerDrag.x0,
      startClientY: battlePointerDrag.y0,
      panStartX: battlePanX,
      panStartY: battlePanY,
      pid: ev.pointerId,
    };
    sc?.classList.add("battle-canvas-scaler--dragging");
    try {
      arena?.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  }
  if (battlePointerDrag.kind === "pan") {
    const ddx = ev.clientX - battlePointerDrag.startClientX;
    const ddy = ev.clientY - battlePointerDrag.startClientY;
    battlePanX = battlePointerDrag.panStartX + ddx;
    battlePanY = battlePointerDrag.panStartY + ddy;
    clampBattlePan();
    applyBattleCamera();
  }
}

function onBattleArenaPointerUp(ev) {
  if (!battlePointerDrag || battlePointerDrag.pid !== ev.pointerId) return;
  const arena = document.getElementById("battle-canvas-arena");
  const sc = document.getElementById("battle-canvas-scaler");
  sc?.classList.remove("battle-canvas-scaler--dragging");
  if (battlePointerDrag.kind === "pan") battleSuppressNextCanvasClick = true;
  battlePointerDrag = null;
  try {
    arena?.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}

function onBattleArenaWheel(ev) {
  const battleEl = document.getElementById("screen-battle");
  if (!battleEl?.classList.contains("screen--active")) return;
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena?.contains(ev.target)) return;
  ev.preventDefault();
  const oldZ = getBattleZoomLevel();
  const factor = ev.deltaY > 0 ? 0.92 : 1.09;
  let newZ = oldZ * factor;
  newZ = Math.max(BATTLE_ZOOM_MIN, Math.min(BATTLE_ZOOM_MAX, newZ));
  const rect = arena.getBoundingClientRect();
  const ox = ev.clientX - rect.left;
  const oy = ev.clientY - rect.top;
  const wx = (ox - battlePanX) / oldZ;
  const wy = (oy - battlePanY) / oldZ;
  settings.battleZoom = newZ;
  saveSettings(settings);
  battlePanX = ox - wx * newZ;
  battlePanY = oy - wy * newZ;
  clampBattlePan();
  applyBattleCamera();
}

function onBattleArenaMapClick(ev) {
  if (ev.target.closest?.("#unit-tooltip")) return;
  onCanvasClick(ev);
}

function initBattleCameraControls() {
  const arena = document.getElementById("battle-canvas-arena");
  if (!arena || arena._ctuCameraWired) return;
  arena._ctuCameraWired = true;
  arena.addEventListener("pointerdown", onBattleArenaPointerDown, true);
  arena.addEventListener("pointermove", onBattleArenaPointerMove, true);
  arena.addEventListener("pointerup", onBattleArenaPointerUp, true);
  arena.addEventListener("pointercancel", onBattleArenaPointerUp, true);
  arena.addEventListener("wheel", onBattleArenaWheel, { passive: false });

  /* Consume post-pan ghost click on arena (capture) so it never hits canvas; also clears
   * battleSuppressNextCanvasClick when the click target is zoomport/margin (not canvas). */
  arena.addEventListener(
    "click",
    (ev) => {
      if (!battleSuppressNextCanvasClick) return;
      battleSuppressNextCanvasClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    true,
  );
  arena.addEventListener("click", onBattleArenaMapClick);

  arena.addEventListener("pointermove", (ev) => {
    updateBattlePointerHover(ev);
  });
  arena.addEventListener("pointerleave", () => {
    battleHoverCellValid = false;
  });

  const ro = new ResizeObserver(() => {
    if (document.getElementById("screen-battle")?.classList.contains("screen--active")) {
      clampBattlePan();
      applyBattleCamera();
    }
  });
  ro.observe(arena);

  const zoomSlider = document.getElementById("battle-zoom-slider");
  if (zoomSlider && !zoomSlider._ctuZoomWired) {
    zoomSlider._ctuZoomWired = true;
    zoomSlider.min = String(Math.round(BATTLE_ZOOM_MIN * 100));
    zoomSlider.max = String(Math.round(BATTLE_ZOOM_MAX * 100));
    zoomSlider.addEventListener("input", () => {
      const pct = Number(zoomSlider.value);
      if (!Number.isFinite(pct)) return;
      applyBattleZoomKeepingCenter(pct / 100);
    });
  }

  document.getElementById("btn-battle-toggle-log")?.addEventListener("click", () => {
    const p = document.getElementById("battle-log-panel");
    const b = document.getElementById("btn-battle-toggle-log");
    if (!p || !b) return;
    const open = p.hidden;
    p.hidden = !open;
    b.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.getElementById("btn-battle-log-close")?.addEventListener("click", () => {
    const p = document.getElementById("battle-log-panel");
    const b = document.getElementById("btn-battle-toggle-log");
    if (p) p.hidden = true;
    if (b) b.setAttribute("aria-expanded", "false");
  });
}

function toggleBattleFullscreen() {
  const el = document.getElementById("screen-battle");
  if (!el) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen?.().catch(() => {});
}

function applyMoveFacingForStep(unit, from, to) {
  unit.facing = computeFacing(
    { x: from[0], y: from[1] },
    { x: to[0], y: to[1] },
  );
  syncFacingAndFaceRad(unit);
  unit.turretOffsetRad = 0;
}

function pushTreadMarkForStep(unit, from, to) {
  const cfg = spriteAnimations?.[unit.mapSpriteSet];
  if (!cfg?.treadVehicle) return;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return;
  treadMarks.push({
    x: to[0],
    y: to[1],
    rad: Math.atan2(dy, dx),
    t0: performance.now(),
  });
  while (treadMarks.length > TREAD_MARK_CAP) treadMarks.shift();
}

function pruneTreadMarks(now) {
  treadMarks = treadMarks.filter((m) => now - m.t0 < TREAD_MARK_LIFETIME_MS);
}

function drawTreadMarks(nowMs) {
  if (!game || !treadMarks.length) return;
  const cs = game.grid.cellSize;
  const now = nowMs;
  pruneTreadMarks(now);
  ctx.save();
  ctx.lineCap = "round";
  for (const m of treadMarks) {
    const age = now - m.t0;
    const alpha = 0.42 * (1 - age / TREAD_MARK_LIFETIME_MS);
    if (alpha <= 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(28,26,22,0.95)";
    ctx.lineWidth = Math.max(1.5, cs * 0.045);
    const cx = gridOffsetX + m.x * cs + cs / 2;
    const cy = gridOffsetY + m.y * cs + cs / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(m.rad);
    const half = cs * 0.28;
    const off = cs * 0.11;
    ctx.beginPath();
    ctx.moveTo(-half, -off);
    ctx.lineTo(half, -off);
    ctx.moveTo(-half, off);
    ctx.lineTo(half, off);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Walk each path tile at constant speed; hull/sprite faces each step, tread marks for tracked vehicles. */
function startLerpAlongPath(unit, path) {
  if (!path || path.length < 2) return;
  unit.state = "move";
  if (settings.reduceMotion) {
    unit.isMoving = false;
    if (unit.hp > 0) unit.state = "idle";
    lerp = null;
    syncFacingTowardNearestEnemy(unit, game.units);
    return;
  }
  const steps = path.length - 1;
  lerp = {
    unitId: unit.id,
    cells: path,
    seg: 0,
    t0: performance.now(),
    dur: PER_TILE_MOVE_MS,
  };
  applyMoveFacingForStep(unit, path[0], path[1]);
}

function updateLerp() {
  if (!lerp || !game) return;
  const u = game.units.find((q) => q.id === lerp.unitId);
  if (!u) {
    lerp = null;
    return;
  }
  const now = performance.now();
  const t = Math.min(1, (now - lerp.t0) / Math.max(1, lerp.dur));

  if (lerp.cells && lerp.seg != null) {
    const cells = lerp.cells;
    const lastSeg = cells.length - 2;
    if (t >= 1) {
      const from = cells[lerp.seg];
      const to = cells[lerp.seg + 1];
      pushTreadMarkForStep(u, from, to);
      if (lerp.seg >= lastSeg) {
        u.isMoving = false;
        if (u.hp > 0 && u.state === "move") u.state = "idle";
        syncFacingTowardNearestEnemy(u, game.units);
        lerp = null;
        return;
      }
      lerp.seg += 1;
      lerp.t0 = now;
      applyMoveFacingForStep(u, cells[lerp.seg], cells[lerp.seg + 1]);
    }
    return;
  }

  if (
    lerp.x0 != null &&
    lerp.y0 != null &&
    lerp.x1 != null &&
    lerp.y1 != null &&
    t >= 1
  ) {
    u.isMoving = false;
    if (u.hp > 0 && u.state === "move") u.state = "idle";
    syncFacingTowardNearestEnemy(u, game.units);
    lerp = null;
  }
}

function lerpPos(u) {
  if (!lerp || lerp.unitId !== u.id) return { x: u.x, y: u.y };
  const t = Math.min(1, (performance.now() - lerp.t0) / Math.max(1, lerp.dur));
  if (lerp.cells && lerp.seg != null) {
    const a = lerp.cells[lerp.seg];
    const b = lerp.cells[lerp.seg + 1];
    return {
      x: lerpScalar(a[0], b[0], t),
      y: lerpScalar(a[1], b[1], t),
    };
  }
  if (
    lerp.x0 != null &&
    lerp.y0 != null &&
    lerp.x1 != null &&
    lerp.y1 != null
  ) {
    return {
      x: lerpScalar(lerp.x0, lerp.x1, t),
      y: lerpScalar(lerp.y0, lerp.y1, t),
    };
  }
  return { x: u.x, y: u.y };
}

/* ── Attack ───────────────────────────────────────────── */
function canAttackNow(a, t) {
  if (!game || a.attackedThisTurn) return false;
  return canAttack(a, t, game.units, game.losCtx());
}
function attackableCellKeys(sel) {
  const keys = new Set();
  const owner = game?.currentPlayer ?? 0;
  if (!game || !sel || sel.owner !== owner) return keys;
  const losCtx = game.losCtx();
  for (const u of game.units) {
    if (u.owner === owner || u.hp <= 0) continue;
    if (canAttack(sel, u, game.units, losCtx)) keys.add(u.x + "," + u.y);
  }
  return keys;
}

function healableCellKeys(sel) {
  const keys = new Set();
  const owner = game?.currentPlayer ?? 0;
  if (!game || !sel || sel.owner !== owner) return keys;
  if (!sel.supportRole || (sel.supportChargesRemaining ?? 0) <= 0) return keys;
  const losCtx = game.losCtx();
  for (const u of game.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if (canHealSupport(sel, u, game.units, losCtx)) keys.add(`${u.x},${u.y}`);
  }
  return keys;
}

function effectProfileFor(unit) {
  const key = unit.attackEffectProfile;
  if (!key || !attackEffects) return null;
  return attackEffects[key] || null;
}
function gridPixelOrigin() {
  const cs = game.grid.cellSize;
  const gw = game.grid.width * cs;
  const gh = game.grid.height * cs;
  return { ox: Math.floor((canvas.width - gw) / 2), oy: Math.floor((canvas.height - gh) / 2), cs };
}
function spawnAttackVfx(attacker, target) {
  if (!battleVfx || !game || !canvas) return;
  const prof = effectProfileFor(attacker);
  if (!prof) return;
  const { ox, oy, cs } = gridPixelOrigin();
  battleVfx.spawnFromProfile(prof, { x: ox + attacker.x * cs, y: oy + attacker.y * cs }, { x: ox + target.x * cs, y: oy + target.y * cs }, cs);
}

function applyPreemptAttackUi(attacker, target, pre) {
  if (pre.preemptDmg <= 0) return;
  pushLog(
    `⚡ ${target.displayName} preemptive → ${attacker.displayName}: -${pre.preemptDmg} HP`,
    "battle-log__item--atk",
  );
  if (pre.preemptProtectedBy) {
    showBattleToast(`Target protected by ${pre.preemptProtectedBy}!`);
  }
  const cellSz = game.scenario?.cellSize ?? 48;
  const apx0 = gridOffsetX + attacker.x * cellSz + cellSz / 2;
  const apy0 = gridOffsetY + attacker.y * cellSz + cellSz * 0.3;
  spawnFloater(`⚡-${pre.preemptDmg}`, apx0, apy0, "#ffcc44");
}

function applyMainStrikeUi(attacker, target, pre, main) {
  const {
    dmg,
    counterDmg,
    structureCollapsed,
    targetProtectedBy,
    attackerProtectedBy,
  } = main;
  let structureCollapsedUse = structureCollapsed;
  if (!structureCollapsedUse && pre.structurePreempt?.collapsed) {
    structureCollapsedUse = {
      x: pre.structurePreempt.x,
      y: pre.structurePreempt.y,
    };
  }

  const targetDied = target.hp <= 0;
  const attackerDied = attacker.hp <= 0;

  if (dmg > 0) {
    pushLog(
      `⚔ ${attacker.displayName} → ${target.displayName}: -${dmg} HP${targetDied ? " 💀" : ""}`,
      "battle-log__item--atk",
    );
  }
  if (dmg > 0 && targetProtectedBy) {
    showBattleToast(`Target protected by ${targetProtectedBy}!`);
  }
  if (counterDmg > 0) {
    pushLog(
      `↩ ${target.displayName} counter: -${counterDmg} HP${attackerDied ? " 💀" : ""}`,
      "battle-log__item--move",
    );
  }
  if (counterDmg > 0 && attackerProtectedBy) {
    showBattleToast(`Target protected by ${attackerProtectedBy}!`);
  }

  if (targetDied) {
    if (target.owner === 0) battleStats.p1Kills++;
    else battleStats.p0Kills++;
  }
  if (attackerDied) {
    if (attacker.owner === 0) battleStats.p1Kills++;
    else battleStats.p0Kills++;
  }

  const csFx = game.scenario?.cellSize ?? 48;
  const { ox: oxf, oy: oyf } = gridPixelOrigin();
  const spawnWorldFx = (gx, gy) => {
    if (!battleFx) return;
    battleFx.explosionAndSmoke(
      oxf + gx * csFx + csFx / 2,
      oyf + gy * csFx + csFx / 2,
      csFx,
    );
  };
  if (structureCollapsedUse) spawnWorldFx(structureCollapsedUse.x, structureCollapsedUse.y);
  if (targetDied) {
    spawnDying(target);
    spawnWorldFx(target.x, target.y);
  }
  if (attackerDied) {
    spawnDying(attacker);
    spawnWorldFx(attacker.x, attacker.y);
  }

  const cellSz = game.scenario?.cellSize ?? 48;
  const tpx = gridOffsetX + target.x * cellSz + cellSz / 2;
  const tpy = gridOffsetY + target.y * cellSz + cellSz * 0.3;
  if (dmg > 0) {
    spawnFloater(`-${dmg}`, tpx, tpy, "#ff6060");
  }
  if (counterDmg > 0) {
    const apx = gridOffsetX + attacker.x * cellSz + cellSz / 2;
    const apy = gridOffsetY + attacker.y * cellSz + cellSz * 0.3;
    spawnFloater(`↩-${counterDmg}`, apx, apy, "#ffcc44");
  }

  const tcx = gridOffsetX + target.x * cellSz + cellSz / 2;
  const tcy = gridOffsetY + target.y * cellSz + cellSz / 2;
  spawnFlash(tcx, tcy, attacker.attackType === "indirect" ? "#ffaa44" : "#ff5555");
  const acx = gridOffsetX + attacker.x * cellSz + cellSz / 2;
  const acy = gridOffsetY + attacker.y * cellSz + cellSz / 2;
  spawnFlash(acx, acy, "#ffe066");

  const isIndirect = attacker.attackType === "indirect";
  AudioManager.play(isIndirect ? "AttackIndirect" : "AttackImpact");
  if (counterDmg > 0) setTimeout(() => AudioManager.play("Counter"), 150);
  spawnAttackVfx(attacker, target);
}

/**
 * Validates range/LOS, runs preempt immediately, then wind-up animation before damage + VFX.
 * @returns {Promise<boolean>}
 */
function doAttack(attacker, target) {
  return new Promise((resolve) => {
    if (!game || !attacker || !target) {
      resolve(false);
      return;
    }
    if (attacker.owner !== game.currentPlayer) {
      resolve(false);
      return;
    }
    if (attacker.attackedThisTurn) {
      resolve(false);
      return;
    }
    if (!canAttack(attacker, target, game.units, game.losCtx())) {
      resolve(false);
      return;
    }

    const pre = game.attackExecutePreemptiveOnly(attacker, target);
    applyPreemptAttackUi(attacker, target, pre);

    if (!pre.attackerAlive) {
      attacker.attackedThisTurn = true;
      attacker.state = "idle";
      const structureCollapsed = pre.structurePreempt?.collapsed
        ? { x: pre.structurePreempt.x, y: pre.structurePreempt.y }
        : null;
      const attackerDied = attacker.hp <= 0;
      if (attackerDied) {
        if (attacker.owner === 0) battleStats.p1Kills++;
        else battleStats.p0Kills++;
      }
      const csFx = game.scenario?.cellSize ?? 48;
      const { ox: oxf, oy: oyf } = gridPixelOrigin();
      if (structureCollapsed && battleFx) {
        battleFx.explosionAndSmoke(
          oxf + structureCollapsed.x * csFx + csFx / 2,
          oyf + structureCollapsed.y * csFx + csFx / 2,
          csFx,
        );
      }
      if (attackerDied) {
        spawnDying(attacker);
        if (battleFx) {
          battleFx.explosionAndSmoke(
            oxf + attacker.x * csFx + csFx / 2,
            oyf + attacker.y * csFx + csFx / 2,
            csFx,
          );
        }
      }
      syncHud();
      resolve(true);
      return;
    }

    attacker.facing = computeFacing(
      { x: attacker.x, y: attacker.y },
      { x: target.x, y: target.y },
    );
    syncFacingAndFaceRad(attacker);
    attacker.turretOffsetRad = 0;
    attacker.attackedThisTurn = true;
    attacker.state = "attack";
    attacker._attackTargetPos = { x: target.x, y: target.y };
    let windup = attackVisualDurationMs(spriteAnimations, attacker.mapSpriteSet);
    if (!windup || windup < 1) windup = 420;
    attacker._fireVisualUntil = performance.now() + windup;

    if (attacker._attackWindupTimer) clearTimeout(attacker._attackWindupTimer);
    attacker._attackWindupTimer = setTimeout(() => {
      attacker._attackWindupTimer = null;
      attacker._fireVisualUntil = null;
      attacker._attackTargetPos = null;
      const main = game.attackExecuteMainAndCounter(attacker, target);
      applyMainStrikeUi(attacker, target, pre, main);
      if (attacker.hp > 0) attacker.state = "idle";
      else attacker.state = "idle";
      syncHud();
      resolve(true);
    }, windup);

    syncHud();
  });
}

/* ── Click handler ────────────────────────────────────── */
function onCanvasClick(ev) {
  if (!game || game.winner != null) return;
  const currentOwner = game.currentPlayer;
  const { x, y } = cellFromEvent(ev);
  if (x < 0 || y < 0 || x >= game.grid.width || y >= game.grid.height) return;
  const clicked = game.unitAt(x, y);
  const sel = game.getSelected();

  if (clicked && clicked.owner === currentOwner && clicked.hp > 0) {
    if (
      sel &&
      sel.id !== clicked.id &&
      canHealSupport(sel, clicked, game.units, game.losCtx())
    ) {
      const kitsLeft = Math.max(0, (sel.supportChargesRemaining ?? 0) - 1);
      const title = sel.supportRole === "engineer" ? "Repair unit?" : "Heal Unit";
      const detail =
        sel.supportRole === "engineer"
          ? "Restore 50% of missing HP (uses 1 repair kit)."
          : "Restore 50% of missing HP (uses 1 med pack).";
      if (
        window.confirm(
          `${title}\n\n${detail}\nYou will have ${kitsLeft} kit(s) left after.`,
        )
      ) {
        const res = game.healFriendly(sel, clicked);
        if (res) {
          battleHints.attackedOnce = true;
          pushLog(
            `✚ ${sel.displayName} restored ${res.healed} HP to ${clicked.displayName}.`,
            "battle-log__item--move",
          );
          const cellSz = game.scenario?.cellSize ?? 48;
          const tpx = gridOffsetX + clicked.x * cellSz + cellSz / 2;
          const tpy = gridOffsetY + clicked.y * cellSz + cellSz * 0.3;
          spawnFloater(`+${res.healed}`, tpx, tpy, "#40c057");
          spawnFlash(
            tpx,
            gridOffsetY + clicked.y * cellSz + cellSz / 2,
            "#6ee7b7",
          );
          AudioManager.play("HealSupport");
          game.checkWinner();
        }
      }
      syncHud();
      return;
    }
    game.select(clicked.id);
    AudioManager.play("UnitSelected");
    syncHud();
    return;
  }
  if (sel && sel.owner === currentOwner && sel.hp > 0) {
    /* Enemy: attack */
    if (clicked && clicked.owner !== currentOwner && clicked.hp > 0) {
      if (canAttackNow(sel, clicked)) {
        void doAttack(sel, clicked).then((ok) => {
          if (ok) {
            battleHints.attackedOnce = true;
            game.checkWinner();
          }
          syncHud();
        });
        return;
      }
      flashInvalidTile(x, y);
      if (sel.attackedThisTurn) {
        showBattleToast("Unit has already moved/attacked this turn.");
      } else {
        showBattleToast(explainAttackFailure(sel, clicked));
      }
      syncHud();
      return;
    }

    const reach = game.reachableFor(sel);
    const k = x + "," + y;
    if (reach.has(k)) {
      const ox = sel.x;
      const oy2 = sel.y;
      const movePath = game.moveUnit(sel, x, y);
      if (movePath) {
        startLerpAlongPath(sel, movePath);
        battleHints.movedOnce = true;
        pushLog(`🚶 ${sel.displayName} moved`, "battle-log__item--move");
        AudioManager.play("MoveStart");
      } else {
        flashInvalidTile(x, y);
        showBattleToast("Cannot move to that tile.");
      }
      syncHud();
      return;
    }

    /* Move/click rejected: not in reachable set */
    const onSelf = x === sel.x && y === sel.y;
    if (!onSelf && !clicked) {
      flashInvalidTile(x, y);
      if (sel.movedThisTurn) {
        showBattleToast("Unit has already moved/attacked this turn.");
      } else if (game.costAtForUnit(sel, x, y) >= 99) {
        const name = describeMoveBlockerName(x, y);
        showBattleToast(`That position is blocked by ${name}.`);
      } else {
        showBattleToast("Target is out of movement range.");
      }
      syncHud();
    }
  }
}

/* ── Hover tooltip ────────────────────────────────────── */
function onCanvasMouseMove(ev) {
  if (!game) return;
  updateBattlePointerHover(ev);
  const { x, y } = cellFromEvent(ev);
  const tooltip = document.getElementById("unit-tooltip");
  if (!tooltip) return;

  const sel = game.getSelected();
  const cp = game.currentPlayer;
  battleHoverShowsAttackOverlay = false;
  battleHoverShowsHealOverlay = false;
  if (
    sel &&
    sel.owner === cp &&
    !sel.attackedThisTurn &&
    x >= 0 &&
    y >= 0 &&
    x < game.grid.width &&
    y < game.grid.height
  ) {
    const hu = game.unitAt(x, y);
    if (hu && hu.owner !== cp && hu.hp > 0) {
      battleHoverShowsAttackOverlay = true;
    }
    if (
      hu &&
      hu.owner === cp &&
      hu.hp > 0 &&
      hu.id !== sel.id &&
      sel.supportRole &&
      (sel.supportChargesRemaining ?? 0) > 0 &&
      canHealSupport(sel, hu, game.units, game.losCtx())
    ) {
      battleHoverShowsHealOverlay = true;
    }
  }

  const inGrid =
    x >= 0 && y >= 0 && x < game.grid.width && y < game.grid.height;
  const u = inGrid ? game.unitAt(x, y) : null;

  const wrap = canvas.closest(".battle-canvas-arena");
  const rect = wrap ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect();
  const tipX = Math.min(ev.clientX - rect.left + 14, Math.max(120, rect.width - 180));
  const tipY = Math.max(ev.clientY - rect.top - 14, 0);

  if (!u) {
    let tileHint = null;
    if (inGrid && sel && sel.owner === cp) {
      tileHint = classifyBattleHoverTile(x, y, sel);
    }
    if (tileHint) {
      tooltip.hidden = false;
      tooltip.style.left = tipX + "px";
      tooltip.style.top = tipY + "px";
      tooltip.innerHTML = `<strong>${tileHint}</strong>`;
      return;
    }
    tooltip.hidden = true;
    return;
  }

  tooltip.hidden = false;
  tooltip.style.left = tipX + "px";
  tooltip.style.top = tipY + "px";
  const hpColor = u.hp / u.maxHp > 0.6 ? "tip-hp" : u.hp / u.maxHp > 0.3 ? "" : "tip-dmg";
  const terrainType = (game.grid && u.x >= 0 && u.y >= 0) ? game.grid.cells[u.y]?.[u.x] : "plains";
  const tileInfo = tileTypes?.[terrainType];
  const defBonus = tileInfo?.defenseBonus ? `· ${Math.round(tileInfo.defenseBonus * 100)}% def` : "";

  let previewHtml = "";
  if (sel && sel.owner === cp && u.owner !== cp) {
    const preview = previewDamage(sel, u);
    if (preview) {
      previewHtml = `<br><span class="tip-preview">${preview.summaryHtml}</span>`;
    }
  }

  let tileAct = "";
  if (sel && sel.owner === cp) {
    const h = classifyBattleHoverTile(u.x, u.y, sel);
    if (h) tileAct = `<br><span class="tip-preview">${h}</span>`;
  }

  tooltip.innerHTML = `<strong>${u.displayName}</strong><span class="${hpColor}">HP ${u.hp}/${u.maxHp}</span><br><span class="tip-dmg">DMG ${u.damage}</span>  ARM ${u.armor}<br>Range ${u.rangeMin}–${u.rangeMax}${u.deadspace ? ` · DS ${u.deadspace}` : ""}  Sight ${u.sightRange ?? "∞"}<br><span class="tip-type">${u.attackType}</span> · mv ${u.move} · <em>${terrainType}${defBonus}</em>${tileAct}${previewHtml}`;
}

function estimateStrikeDamagePreview(striker, victim) {
  let dmg = striker.damage ?? 20;
  const arm = victim.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));
  const tTerrain = game.grid.cells[victim.y]?.[victim.x] ?? "plains";
  const tDef = tileTypes?.[tTerrain]?.defenseBonus ?? 0;
  if (tDef > 0) dmg = Math.max(1, Math.round(dmg * (1 - tDef)));
  const tCover = obstacleCoverNameAt(
    game.grid,
    tileTypes,
    game.mapObjects,
    victim.x,
    victim.y,
  );
  if (tCover) dmg = Math.max(1, Math.round(dmg * OBSTACLE_COVER_DAMAGE_FACTOR));
  return dmg;
}

function estimateCounterDamagePreview(defender, attackerUnit) {
  let dmg = Math.round((defender.damage ?? 20) * 0.6);
  const arm = attackerUnit.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));
  const aTerrain = game.grid.cells[attackerUnit.y]?.[attackerUnit.x] ?? "plains";
  const aDef = tileTypes?.[aTerrain]?.defenseBonus ?? 0;
  if (aDef > 0) dmg = Math.max(1, Math.round(dmg * (1 - aDef)));
  const aCover = obstacleCoverNameAt(
    game.grid,
    tileTypes,
    game.mapObjects,
    attackerUnit.x,
    attackerUnit.y,
  );
  if (aCover) dmg = Math.max(1, Math.round(dmg * OBSTACLE_COVER_DAMAGE_FACTOR));
  return dmg;
}

/**
 * Forecast damage order: preemptive (if any), your hit, counter/no counter.
 */
function previewDamage(attacker, target) {
  const losCtx = game.losCtx();
  if (!canAttack(attacker, target, game.units, losCtx)) return null;

  const preemptWouldFire =
    target.specialAbility === "Preemptive Strike" &&
    !target.attackedThisTurn &&
    target.hp > 0 &&
    (target.attackType ?? "direct") === "direct" &&
    canAttack(target, attacker, game.units, losCtx);

  let preemptEst = 0;
  if (preemptWouldFire) {
    preemptEst = estimateStrikeDamagePreview(target, attacker);
  }

  const dmg = estimateStrikeDamagePreview(attacker, target);

  const defenderAlreadyActed = preemptWouldFire;
  let counterDmg = 0;
  if (
    !defenderAlreadyActed &&
    target.specialAbility === "Counter-Attack" &&
    !target.attackedThisTurn &&
    target.hp > 0 &&
    (target.attackType ?? "direct") === "direct" &&
    canAttack(target, attacker, game.units, losCtx)
  ) {
    counterDmg = estimateCounterDamagePreview(target, attacker);
  }

  const lines = [];
  if (preemptWouldFire) {
    lines.push(
      `⚡ ${target.displayName} strikes first (~${preemptEst} HP to you)`,
    );
  }
  lines.push(`⚔ Your hit ~${dmg} HP`);
  if (defenderAlreadyActed) {
    lines.push("↩ No counter (defender already fired preemptively).");
  } else if (counterDmg > 0) {
    lines.push(`↩ Counter ~${counterDmg} HP`);
  } else {
    lines.push("↩ No counter-attack");
  }

  return { dmg, counterDmg, summaryHtml: lines.join("<br>") };
}

/** Human-readable blocker for an impassable tile (terrain + map objects). */
function describeMoveBlockerName(x, y) {
  if (!game) return "an obstacle";
  const mo = game.mapObjects?.find(
    (o) => o.x === x && o.y === y && o.blocksMove !== false,
  );
  if (mo?.visualKind) {
    const k = String(mo.visualKind);
    return k.charAt(0).toUpperCase() + k.slice(1);
  }
  const t = game.grid.cells[y]?.[x];
  const tt = game.tileTypes?.[t];
  if (tt?.displayName) return tt.displayName;
  if (t === "water") return "Water";
  if (t === "building_block" || t === "cp_building") return "Building";
  if (t) {
    return String(t)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "Terrain";
}

function explainAttackFailure(attacker, target) {
  const d = chebyshev(attacker.x, attacker.y, target.x, target.y);
  const lo = attacker.rangeMin ?? 1;
  const hi = attacker.rangeMax ?? 1;
  const ds = attacker.deadspace ?? 0;
  if (d <= ds) return "Target is too close to attack.";
  if (d < lo || d > hi) return "Target is out of attack range.";
  const losCtx = game.losCtx();
  const sightRange = attacker.sightRange;
  if (sightRange != null && Number.isFinite(sightRange) && d > sightRange) {
    return "Target is out of attack range.";
  }
  if ((attacker.attackType || "direct") === "indirect" && losCtx?.grid && losCtx?.tileTypes) {
    if (
      isIndirectDeadzoneBlock(
        losCtx.grid,
        losCtx.tileTypes,
        attacker.x,
        attacker.y,
        target.x,
        target.y,
        { mapObjects: losCtx.mapObjects },
      )
    ) {
      return "Target is in deadzone (obstacle shadow).";
    }
  }
  if (
    (attacker.attackType || "direct") === "direct" &&
    attacker.usesLos !== false &&
    losCtx?.grid &&
    losCtx?.tileTypes
  ) {
    const budget =
      losCtx.sightBudget != null && Number.isFinite(losCtx.sightBudget)
        ? losCtx.sightBudget
        : Infinity;
    if (
      !hasLineOfSight(
        losCtx.grid,
        losCtx.tileTypes,
        attacker.x,
        attacker.y,
        target.x,
        target.y,
        { sightBudget: budget, mapObjects: losCtx.mapObjects },
      )
    ) {
      return "Line of sight is blocked.";
    }
  }
  return "Cannot attack that target.";
}

/* ── Draw ─────────────────────────────────────────────── */
function unitHasIndependentTurret(unit) {
  const c = spriteAnimations?.[unit.mapSpriteSet]?.compositeTopdown;
  return (
    unit.mapRenderMode === "topdown" && compositeUsesIndependentTurret(c)
  );
}

/**
 * Idle orientation: selected current-player unit follows cursor cell on the map;
 * everyone else (and selection when pointer is off-map / on own cell) faces nearest enemy.
 * Attack wind-up keeps doAttack-applied facing until state returns to idle.
 */
function applyBattleIdleFacing() {
  if (!game) return;
  const sel = game.getSelected();
  const cp = game.currentPlayer;
  for (const u of game.units) {
    if (u.hp <= 0) continue;
    const moving = (lerp && lerp.unitId === u.id) || !!u.isMoving;
    if (moving || u.state === "attack") continue;

    const cursorGuides =
      sel &&
      sel.id === u.id &&
      u.owner === cp &&
      battleHoverCellValid;

    if (cursorGuides) {
      if (battleHoverGx === u.x && battleHoverGy === u.y) {
        syncFacingTowardNearestEnemy(u, game.units);
      } else if (unitHasIndependentTurret(u)) {
        const hullRad = facingToFaceRad(u.facing || "down");
        const aimRad = Math.atan2(
          battleHoverGy - u.y,
          battleHoverGx - u.x,
        );
        u.turretOffsetRad = normalizeAngleRad(aimRad - hullRad);
      } else {
        u.facing = computeFacing(
          { x: u.x, y: u.y },
          { x: battleHoverGx, y: battleHoverGy },
        );
        syncFacingAndFaceRad(u);
      }
      continue;
    }
    syncFacingTowardNearestEnemy(u, game.units);
  }
}

function facingRadForDraw(u) {
  if (u.hp <= 0) return u.faceRad;
  if (u.mapRenderMode === "topdown") {
    return facingToFaceRad(u.facing || "down");
  }
  return u.faceRad;
}

/** White medic helmet + red cross (map readout). */
function drawMedicHelmetOverlay(ctx, u, px, py, cs) {
  if (u.templateId !== "medic" || u.hp <= 0) return;
  ctx.save();
  const cx = px + cs / 2;
  const cy = py + cs * 0.36;
  const r = cs * 0.13;
  ctx.fillStyle = "rgba(255,255,255,0.93)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.lineTo(cx + r, cy + r * 0.42);
  ctx.lineTo(cx - r, cy + r * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(30,30,30,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  const arm = Math.max(2, cs * 0.045);
  ctx.fillStyle = "#dc2626";
  ctx.fillRect(cx - arm / 2, cy - arm * 0.35 - 3, arm, 6);
  ctx.fillRect(cx - 3, cy - arm * 0.35 - arm / 2, 6, arm);
  ctx.restore();
}

function drawCoverShieldIcon(ctx, cx, cy, scale) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(160, 220, 255, 0.95)";
  ctx.strokeStyle = "rgba(25, 45, 70, 0.9)";
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  ctx.moveTo(0, -1);
  ctx.bezierCurveTo(1, -0.55, 1, 0.4, 0, 1.05);
  ctx.bezierCurveTo(-1, 0.4, -1, -0.55, 0, -1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawHpBars(ts) {
  const cs = game.grid.cellSize;
  for (const u of game.units) {
    if (u.hp <= 0) continue;
    const pos = lerpPos(u);
    const px = gridOffsetX + pos.x * cs;
    const py = gridOffsetY + pos.y * cs;
    const frac = u.hp / u.maxHp;
    const bw = cs * 0.78;
    const bh = 4;
    const bx = px + (cs - bw) / 2;
    const by = py + cs - bh - 3;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = frac > 0.6 ? "#40c057" : frac > 0.3 ? "#fab005" : "#fa5252";
    ctx.fillRect(bx, by, Math.max(1, bw * frac), bh);
    const cover = obstacleCoverNameAt(
      game.grid,
      tileTypes,
      game.mapObjects,
      u.x,
      u.y,
    );
    if (cover) {
      const sc = cs * 0.22;
      drawCoverShieldIcon(ctx, bx - sc * 0.85, by + bh / 2, sc * 0.42);
    }
  }
}

function drawFrame(ts) {
  if (!game) return;
  if (game.winner != null && !battleEndHandled) {
    battleEndHandled = true;
    handleBattleEnd();
  }
  const cs = game.grid.cellSize;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  gridOffsetX = Math.floor((canvas.width - game.grid.width * cs) / 2);
  gridOffsetY = Math.floor((canvas.height - game.grid.height * cs) / 2);

  if (battlePlaneCtl) {
    battlePlaneCtl.drawBackground(ctx, gridOffsetX, gridOffsetY);
  }

  const sel = game.getSelected();
  const currentOwner = game.currentPlayer;
  const reach = sel && sel.owner === currentOwner ? game.reachableFor(sel) : null;
  const showTacticalRing =
    !!(
      sel &&
      sel.owner === currentOwner &&
      !sel.attackedThisTurn &&
      (battleAttackRangePinned ||
        battleHoverShowsAttackOverlay ||
        battleHoverShowsHealOverlay)
    );
  const overlay = showTacticalRing ? getCachedAttackOverlay(sel) : null;
  const atkTargetKeys =
    showTacticalRing && overlay ? attackableCellKeys(sel) : new Set();
  const healTargetKeys =
    showTacticalRing &&
    overlay &&
    sel.supportRole &&
    (sel.supportChargesRemaining ?? 0) > 0
      ? healableCellKeys(sel)
      : new Set();
  const fogCells = computeVisibleCells();

  drawGrid(ctx, game, tileTypes, {
    offsetX: gridOffsetX, offsetY: gridOffsetY,
    stackMode: battlePlaneCtl ? "plane" : "legacy",
    reachable: reach,
    selected: sel && sel.owner === currentOwner ? sel : null,
    tacticalOverlays:
      showTacticalRing && overlay
        ? {
            enabled: true,
            weaponBand: overlay.weaponBand,
            losBlocked: overlay.losBlocked,
            cannotHit: overlay.cannotHit,
            validTargets: atkTargetKeys,
            healTargets: healTargetKeys,
          }
        : { enabled: false },
    highlightCells: coachHighlightKeys(),
    fogCells,
    timeMs: ts,
  });

  drawInvalidTileFlashes(ctx, gridOffsetX, gridOffsetY, cs, ts);

  sharedBattleAmbient.draw(ctx, gridOffsetX, gridOffsetY, ts);

  if (battlePlaneCtl) {
    battlePlaneCtl.drawProps(ctx, gridOffsetX, gridOffsetY);
  } else if (game.mapObjects?.length) {
    drawMapObjects(ctx, game, gridOffsetX, gridOffsetY);
  }

  drawTreadMarks(ts);

  applyBattleIdleFacing();

  const sorted = [...game.units]
    .filter((u) => {
      if (u.hp <= 0) return false;
      /* hide enemy units in fog */
      if (fogCells && u.owner !== 0 && !fogCells.has(`${u.x},${u.y}`)) return false;
      return true;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const u of sorted) {
    const pos = lerpPos(u);
    const px = gridOffsetX + pos.x * cs;
    const py = gridOffsetY + pos.y * cs;
    const moving = (lerp && lerp.unitId === u.id) || !!u.isMoving;
    const renderMode = u.mapRenderMode || "side";
    const facingLeft = renderMode !== "topdown" && u.facing === "left";

    /* Dim units that have spent BOTH their move and attack this turn */
    const spent = u.owner === currentOwner && u.movedThisTurn && u.attackedThisTurn;
    const partSpent = u.owner === currentOwner && (u.movedThisTurn || u.attackedThisTurn) && !spent;
    if (spent) {
      ctx.save();
      ctx.globalAlpha = 0.45;
    } else if (partSpent) {
      ctx.save();
      ctx.globalAlpha = 0.75;
    }

    unitRenderer.drawUnit(ctx, u, px, py, cs, ts, moving, facingLeft, facingRadForDraw(u));
    drawMedicHelmetOverlay(ctx, u, px, py, cs);

    if (spent || partSpent) ctx.restore();

    /* "SPENT" label on fully exhausted friendly units */
    if (spent) {
      ctx.save();
      ctx.font = `bold ${Math.round(cs * 0.22)}px monospace`;
      ctx.fillStyle = "rgba(255,200,80,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("DONE", px + cs / 2, py + cs - 2);
      ctx.restore();
    }
  }
  drawHpBars(ts);
  battleVfx?.draw(ctx, ts);
  battleFx?.draw(ctx, ts);
  drawVfxFlashes(ts);
  drawDyingUnits(ts);
  updateFloaters(ts);
  drawFloaters(ts);
}

function loop(ts) {
  if (!document.getElementById("screen-battle")?.classList.contains("screen--active")) return;
  updateLerp();
  drawFrame(ts);
  requestAnimationFrame(loop);
}

/* ── AI turn ──────────────────────────────────────────── */
/**
 * Score a potential attack target for priority:
 * higher = better kill opportunity.
 * Prefer wounded enemies, high-damage enemies, and ones already in range.
 */
function aiScoreTarget(attacker, target) {
  const killRatio = (target.maxHp - target.hp) / (target.maxHp || 1);
  const threat    = (target.damage ?? 10) / (attacker.armor ? attacker.armor + 5 : 5);
  return killRatio * 2 + threat;
}

async function aiTurn() {
  if (!game || game.winner != null) return;
  const aiUnits  = game.units.filter((u) => u.owner === 1 && u.hp > 0);
  const hum      = game.units.filter((u) => u.owner === 0 && u.hp > 0);
  if (!aiUnits.length || !hum.length) { game.checkWinner(); syncHud(); return; }

  const losCtx   = game.losCtx();
  const diff     = settings.difficulty ?? "normal";
  const retreatThreshold = diff === "hard" ? 0.40 : 0.30;

  for (const u of aiUnits) {
    const lowHp = u.hp / (u.maxHp || 1) < retreatThreshold;

    /* ── 1. Try to shoot before moving ─────────────────── */
    if (!u.attackedThisTurn) {
      const shootable = hum.filter((h) => canAttack(u, h, game.units, losCtx));
      if (shootable.length) {
        /* Easy: random target; Normal/Hard: scored target */
        const sorted = diff === "easy"
          ? shootable
          : shootable.sort((a, b) => aiScoreTarget(u, b) - aiScoreTarget(u, a));
        const t = diff === "easy"
          ? sorted[Math.floor(Math.random() * sorted.length)]
          : sorted[0];
        if (await doAttack(u, t)) game.checkWinner();
        if (game.winner != null) break;
        /* Don't move after attacking if indirect unit */
        if (u.attackType === "indirect") continue;
      }
    }

    /* ── 2. Move ────────────────────────────────────────── */
    if (u.movedThisTurn) continue;
    const reach = game.reachableFor(u);

    if (lowHp) {
      /* Retreat: find reachable tile furthest from all enemies */
      let bestK = null; let bestD = -Infinity;
      for (const k of reach.keys()) {
        const [tx, ty] = k.split(",").map(Number);
        const minEnemyDist = hum.reduce((m, h) => Math.min(m, chebyshev(tx, ty, h.x, h.y)), Infinity);
        const defBonus = tileTypes[game.grid.cells?.[ty]?.[tx] ?? "plains"]?.defenseBonus ?? 0;
        const score = minEnemyDist * 2 + defBonus * 4;
        if (score > bestD) { bestD = score; bestK = k; }
      }
      if (bestK) {
        const [tx, ty] = bestK.split(",").map(Number);
        const ox = u.x; const oy = u.y;
        const p = game.moveUnit(u, tx, ty);
        if (p) startLerpAlongPath(u, p);
      }
    } else {
      /* Advance: move to best tile that brings enemy into range OR has good defence */
      const primary = hum.reduce((a, b) => aiScoreTarget(u, b) > aiScoreTarget(u, a) ? b : a);
      let bestK = null; let bestScore = -Infinity;
      for (const k of reach.keys()) {
        const [tx, ty] = k.split(",").map(Number);
        const distToPrimary = chebyshev(tx, ty, primary.x, primary.y);
        const willBeInRange  = distToPrimary >= (u.rangeMin ?? 1) && distToPrimary <= (u.rangeMax ?? 1);
        const terrain = game.grid.cells?.[ty]?.[tx] ?? "plains";
        const defBonus = tileTypes[terrain]?.defenseBonus ?? 0;
        const score =
          (willBeInRange ? 10 : 0)          // strongly prefer being in range
          - distToPrimary * 0.5              // closer is generally better
          + defBonus * 3;                    // bonus for good cover
        if (score > bestScore) { bestScore = score; bestK = k; }
      }
      if (bestK) {
        const [tx, ty] = bestK.split(",").map(Number);
        const ox = u.x; const oy = u.y;
        const p = game.moveUnit(u, tx, ty);
        if (p) startLerpAlongPath(u, p);
      }
    }

    /* ── 3. Attack again after moving if not yet attacked ─ */
    /* Easy AI doesn't attack-after-move; Hard always tries */
    if (!u.attackedThisTurn && diff !== "easy") {
      const shootable2 = hum.filter((h) => canAttack(u, h, game.units, losCtx));
      if (shootable2.length) {
        const t = shootable2.sort((a, b) => aiScoreTarget(u, b) - aiScoreTarget(u, a))[0];
        if (await doAttack(u, t)) game.checkWinner();
        if (game.winner != null) break;
      }
    }
  }
  battleAttackRangePinned = false;
  if (game.winner == null) game.endTurn();
  syncHud();
}

/* ── Procedural mapgen boot ───────────────────────────── */
async function startProceduralFromVsCpuPrep(loadoutOrdered) {
  const spec = pendingProceduralSkirmishSpec;
  if (!spec || !loadoutOrdered?.length) return;
  const themeOrBiome = spec.biome || spec.theme || "urban";
  const { theme, biome } = resolveProceduralThemeArg(themeOrBiome);
  const diff = normalizeSoloDifficulty(settings.soloDifficulty);
  const grand = diff === "hell";
  const [tiles, assetManifest] = await Promise.all([
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/assetManifest.json").catch(() => null),
    preloadTerrainTiles(),
  ]);
  const scenario = generateProceduralScenario({
    theme,
    biome,
    template: "island_cluster",
    width: grand ? 20 : 16,
    height: grand ? 16 : 12,
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    tileTypes: tiles.types,
    assetManifest: assetManifest && typeof assetManifest === "object" ? assetManifest : null,
  });
  if (!scenario) {
    showBootFailureBanner("Could not generate a procedural map. Try again or pick a map in the theater.");
    return;
  }
  pendingProceduralSkirmishSpec = null;
  lastProceduralScenario = scenario;
  void bootBattle({
    mode: "skirmish",
    scenarioInline: scenario,
    loadout: [...loadoutOrdered],
    skirmishDifficulty: diff,
  });
}

async function bootProceduralSkirmish(themeOrBiome = "urban") {
  const { theme, biome } = resolveProceduralThemeArg(themeOrBiome);
  const diff = normalizeSoloDifficulty(settings.soloDifficulty);
  const grand = diff === "hell";
  const [tiles, assetManifest] = await Promise.all([
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/assetManifest.json").catch(() => null),
    preloadTerrainTiles(),
  ]);
  const scenario = generateProceduralScenario({
    theme,
    biome,
    width: grand ? 20 : 16,
    height: grand ? 16 : 12,
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    tileTypes: tiles.types,
    assetManifest: assetManifest && typeof assetManifest === "object" ? assetManifest : null,
  });
  if (!scenario) {
    console.warn("[CTU] Procedural generation failed; using default skirmish.");
    void bootBattle({ mode: "skirmish", skirmishDifficulty: diff });
    return;
  }
  lastProceduralScenario = scenario;
  void bootBattle({ mode: "skirmish", scenarioInline: scenario, skirmishDifficulty: diff });
}

/* ── Dev: logo backdoor → dev-editor.html (5 clicks in 2s + password) ── */
const DEV_EDITOR_PASSWORD = "@@@IamBlack123";
const DEV_LOGO_CLICK_WINDOW_MS = 2000;
const DEV_LOGO_CLICKS_REQUIRED = 5;
let devLogoClickTimes = [];

function initDevLogoBackdoor() {
  const logo = document.querySelector("header .logo, h1.logo");
  if (!logo) return;
  logo.addEventListener("click", () => {
    const now = performance.now();
    devLogoClickTimes = devLogoClickTimes.filter(
      (t) => now - t <= DEV_LOGO_CLICK_WINDOW_MS,
    );
    devLogoClickTimes.push(now);
    if (devLogoClickTimes.length < DEV_LOGO_CLICKS_REQUIRED) return;
    devLogoClickTimes.length = 0;
    const key = window.prompt("Access key");
    if (key === DEV_EDITOR_PASSWORD) {
      window.location.href = "dev-editor.html";
    }
  });
}

/* ── Battle boot ──────────────────────────────────────── */
/** Minimal skirmish + automatic 3-tile eastward move (Settings → Dev). */
async function runDevAnimationTest() {
  const scenario = {
    usePresetUnits: true,
    id: "debug_anim_test",
    name: "Animation test",
    width: 12,
    height: 8,
    cellSize: 48,
    terrain: Array.from({ length: 8 }, () => Array(12).fill("plains")),
    units: [{ templateId: "infantry", owner: 0, x: 2, y: 4 }],
    presetEnemies: [],
    skirmishDeploy: [{ x: 2, y: 4 }],
    winCondition: { type: "eliminate" },
    fogOfWar: false,
    ambientEffects: [
      {
        x: 4,
        y: 3,
        spritePath: "assets/tiles/urban/fire_animation.png",
        frameCount: 8,
        fps: 12,
      },
      {
        x: 6,
        y: 4,
        spritePath: "assets/tiles/urban/fire_animation2.png",
        frameCount: 8,
        fps: 10,
      },
    ],
  };
  await bootBattle({ mode: "skirmish", scenarioInline: scenario, soloSkirmishTuning: false });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const u = game?.units.find((q) => q.owner === 0 && q.hp > 0);
      if (!u || !game) return;
      game.select(u.id);
      const ox = u.x;
      const oy = u.y;
      const tx = ox + 3;
      const dbgPath =
        tx < game.grid.width ? game.moveUnit(u, tx, oy) : false;
      if (dbgPath) {
        startLerpAlongPath(u, dbgPath);
        pushLog("Debug: animation test (3 cells east)", "battle-log__item--move");
      }
    });
  });
}

async function bootBattle(options = {}) {
  const mode = options.mode ?? "skirmish";
  const loadout = options.loadout ?? null;
  const useInline = options.scenarioInline && typeof options.scenarioInline === "object";
  const applySoloTuning =
    (mode === "skirmish" || mode === "urban") && options.soloSkirmishTuning !== false;
  const skirmishDifficulty = applySoloTuning
    ? normalizeSoloDifficulty(options.skirmishDifficulty ?? settings.soloDifficulty)
    : null;
  let scenarioPath = options.scenarioPath;
  if (!useInline && !scenarioPath) {
    if (mode === "urban") {
      scenarioPath = "js/config/scenarios/urban_siege.json";
    } else if (mode === "skirmish") {
      scenarioPath =
        pendingUserMapPath || "js/config/scenarios/academy_skirmish.json";
    } else {
      scenarioPath = "js/config/scenarios/academy_skirmish.json";
    }
  }
  if (
    mode === "skirmish" &&
    applySoloTuning &&
    !useInline &&
    skirmishDifficulty === "hell" &&
    scenarioPath
  ) {
    const maps = mapCatalog.maps || [];
    const cur = maps.find((x) => x.path === scenarioPath);
    if (!cur || cur.sizeCategory !== "grand") {
      const g = maps.find((m) => m.sizeCategory === "grand");
      if (g) {
        scenarioPath = g.path;
        pendingUserMapPath = g.path;
        void refreshPendingMapSkirmishSlotCount();
      }
    }
  }
  lastBootOptions = {
    mode,
    loadout,
    scenarioPath: useInline ? null : scenarioPath,
    matLabTheater: options.matLabTheater ?? null,
    scenarioInline: useInline ? JSON.parse(JSON.stringify(options.scenarioInline)) : null,
    skirmishDifficulty: skirmishDifficulty || null,
    soloSkirmishTuning: options.soloSkirmishTuning,
  };
  battleEndHandled = false;
  aiRunning = false;
  battleAttackRangePinned = false;
  battleHoverShowsAttackOverlay = false;
  battleOverlayCacheKey = "";
  battleOverlayCache = null;
  battleHints = { movedOnce: false, attackedOnce: false };
  battleStats = { p0Kills: 0, p1Kills: 0, rounds: 0 };
  floaters.length = 0;
  dyingUnits.length = 0;
  vfxFlashes.length = 0;
  combatLog.length = 0;
  treadMarks.length = 0;
  lerp = null;
  battleHoverCellValid = false;
  const list = document.getElementById("battle-log-list");
  if (list) list.innerHTML = "";

  /* show loading overlay while assets fetch */
  const loadingEl = document.getElementById("battle-loading");
  if (loadingEl) loadingEl.hidden = false;

  const scenarioPromise = useInline
    ? Promise.resolve(JSON.parse(JSON.stringify(options.scenarioInline)))
    : loadJson(scenarioPath);
  const [unitsRaw, tiles, sprites, scenarioBase, fx, assetManifest] = await Promise.all([
    loadJson("js/config/units.json"),
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/spriteAnimations.json"),
    scenarioPromise,
    loadJson("js/config/attackEffects.json"),
    loadJson("js/config/assetManifest.json").catch(() => null),
  ]);
  const units = mergeUnitTemplates(unitsRaw);
  unitRegistry = units;
  tileTypes = tiles.types;
  spriteAnimations = sprites;
  attackEffects = fx;
  const scenario = mergeScenarioForBattle(scenarioBase, mode, loadout, academyConfig, {
    skirmishDifficulty: skirmishDifficulty || null,
    scenarioPath: useInline ? null : scenarioPath,
  });
  if (!useInline && scenarioPath) attachCatalogBiomeFromPath(scenario, scenarioPath);
  scenario.assetManifest =
    assetManifest && typeof assetManifest === "object" ? assetManifest : null;
  if (options.matLabTheater && getArenaRenderMode(scenario) === "mat") {
    scenario.battlePlaneLayer.theater = options.matLabTheater;
    scenario.battlePlaneLayer.randomizeTheater = false;
  }
  battlePlaneCtl = null;
  game = new GameState(scenario, units, tileTypes, {
    visualStyle: battleVisualStyle(),
  });
  battlePlaneCtl = await createBattlePlaneController(game, tileTypes);
  resizeBattleCanvas();
  syncBattleAmbientFromScenario();
  unitRenderer = new UnitRenderer(spriteAnimations);
  battleVfx = new BattleVfx();
  battleFx = new FxLayer();
  document.getElementById("battle-result-overlay").hidden = true;
  document.getElementById("battle-interstitial").hidden = true;
  if (loadingEl) loadingEl.hidden = true;
  syncHud();
  syncCoachPanel();
  showScreen("battle");
  requestAnimationFrame(() => centerBattleCamera());
  pushLog("⚑ Battle started!", "battle-log__item--event");
}

/* ── Battle end ───────────────────────────────────────── */
function handleBattleEnd() {
  if (!game || game.winner == null) return;
  if (game.winner === 0) {
    progress.wins += 1;
    if (lastBootOptions.mode === "academy") {
      progress.academyComplete = true;
      /* unlock Tier 2 roster on first academy win */
      Object.assign(progress.unlocks, {
        medic: true, engineer: true, artillery: true, commander_unit: true,
        vanguard: true, guard: true, assault: true,
        recon_jeep: true, jet_bomber: true,
      });
    }
  } else {
    progress.losses += 1;
  }
  saveProgress(progress);
  pushLog(game.winner === 0 ? "🏆 Victory!" : "💀 Defeat", "battle-log__item--event");
  AudioManager.play(game.winner === 0 ? "Victory" : "Defeat");
  renderHubRoster();
  renderHubModes();
  updateGateBanner();
  showResultOverlay();
}

/* ── Codex ────────────────────────────────────────────── */
let activeCodexId = null;

function codexEmptySlot() {
  const d = document.createElement("div");
  d.className = "hub-roster-slot hub-roster-slot--empty";
  d.setAttribute("aria-hidden", "true");
  return d;
}

/** Hub roster slot chrome + LED; same interaction model as hub roster grid */
function codexSlotButton(u) {
  const locked = !isUnlocked(progress, u.id);
  const isActive = u.id === activeCodexId;
  const tags = (u.tags || []).filter((t) => t !== "ai");
  const dotCls = tags.includes("coreA")
    ? "hub-roster-slot__led--green"
    : tags.includes("addonB")
      ? "hub-roster-slot__led--blue"
      : "hub-roster-slot__led--amber";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.unitId = u.id;
  btn.className =
    "hub-roster-slot codex-select-slot" +
    (locked ? " hub-roster-slot--locked" : "") +
    (isActive ? " codex-select-slot--active" : "");
  btn.setAttribute(
    "aria-label",
    locked ? `${u.displayName} (locked)` : `View dossier: ${u.displayName}`
  );

  const iconHtml = u.portrait
    ? `<span class="hub-roster-slot__well"><img src="attached_assets/units/${u.portrait}" alt="" class="hub-roster-slot__icon" width="64" height="64" decoding="async" /></span>`
    : `<span class="hub-roster-slot__well hub-roster-slot__well--initials"><span class="hub-roster-slot__initials" aria-hidden="true">${unitInitials(u)}</span></span>`;

  btn.innerHTML = `${iconHtml}<span class="hub-roster-slot__led ${dotCls}" aria-hidden="true"></span>`;
  btn.addEventListener("click", () => selectCodexUnit(u.id));
  return btn;
}

function renderCodex() {
  const grid = document.getElementById("codex-select-grid");
  if (!grid || !unitRegistry.length) return;

  const rosterUnits = unitRegistry.filter((u) => !u.tags?.includes("ai"));
  const CODEX_SLOTS = 12;
  grid.innerHTML = "";

  const left = document.createElement("div");
  left.className = "codex-select-col codex-select-col--left";
  for (let i = 0; i < 4; i++) {
    const u = rosterUnits[i];
    left.appendChild(u ? codexSlotButton(u) : codexEmptySlot());
  }

  const center = document.createElement("div");
  center.className = "codex-detail codex-select-stage";
  center.id = "codex-detail";
  center.setAttribute("aria-label", "Unit dossier");
  center.innerHTML = `<div id="codex-detail-inner" class="codex-detail__scroll"></div>`;

  const right = document.createElement("div");
  right.className = "codex-select-col codex-select-col--right";
  for (let i = 4; i < 8; i++) {
    const u = rosterUnits[i];
    right.appendChild(u ? codexSlotButton(u) : codexEmptySlot());
  }

  const bottom = document.createElement("div");
  bottom.className = "codex-select-bottom";
  for (let i = 8; i < CODEX_SLOTS; i++) {
    const u = rosterUnits[i];
    bottom.appendChild(u ? codexSlotButton(u) : codexEmptySlot());
  }

  grid.appendChild(left);
  grid.appendChild(center);
  grid.appendChild(right);
  grid.appendChild(bottom);

  if (activeCodexId) selectCodexUnit(activeCodexId);
  else setCodexDetailPlaceholder();
}

function setCodexDetailPlaceholder() {
  const detail = document.getElementById("codex-detail-inner");
  if (!detail) return;
  detail.innerHTML = `<p class="codex-detail__placeholder">Select a unit from the list.</p>`;
}

function closeCodexDossier() {
  const panel = document.getElementById("codex-detail");
  if (panel) panel.classList.remove("codex-detail--open");
  activeCodexId = null;
  document.querySelectorAll("#screen-codex .codex-select-slot").forEach((el) => {
    el.classList.remove("codex-select-slot--active");
  });
  setCodexDetailPlaceholder();
}

function selectCodexUnit(id) {
  activeCodexId = id;
  document.querySelectorAll("#screen-codex .codex-select-slot").forEach((el) => {
    el.classList.toggle("codex-select-slot--active", el.dataset.unitId === id);
  });
  const u = unitRegistry.find((u) => u.id === id);
  const detail = document.getElementById("codex-detail-inner");
  if (!u || !detail) return;
  const locked = !isUnlocked(progress, u.id);

  const statColor = (val, good, mid) => val >= good ? "codex-stat__value--green" : val >= mid ? "codex-stat__value--yellow" : "codex-stat__value--red";
  const portrait = u.portrait
    ? `<img src="attached_assets/units/${u.portrait}" alt="" class="codex-card__portrait" />`
    : `<div class="codex-card__ph">${unitInitials(u)}</div>`;

  const tags = (u.tags || []).filter((t) => t !== "ai").map((t) => `<span class="tag${u.attackType === "indirect" && t === "coreA" ? "" : ""}">${t}</span>`).join(" ");
  const attackTag = `<span class="tag ${u.attackType === "indirect" ? "tag--indirect" : ""}">${u.attackType}</span>`;

  const lockedNotice = locked
    ? `<div class="codex-locked-notice">🔒 Locked — complete Training Academy to unlock this unit.</div>`
    : "";

  detail.innerHTML = `
    <div class="codex-card">
      <div class="codex-card__header">
        ${portrait}
        <div class="codex-card__title">
          <h2>${u.displayName}</h2>
          <div class="codex-card__tags">${tags} ${attackTag}</div>
        </div>
      </div>
      ${lockedNotice}
      <p class="codex-card__desc">${u.codexDesc || "No description available."}</p>
      <div class="codex-stats-grid">
        <div class="codex-stat"><div class="codex-stat__label">HP</div><div class="codex-stat__value ${statColor(u.hp, 120, 80)}">${u.hp}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Damage</div><div class="codex-stat__value ${statColor(u.damage, 40, 25)}">${u.damage}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Armor</div><div class="codex-stat__value ${statColor(u.armor, 6, 2)}">${u.armor}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Move</div><div class="codex-stat__value ${statColor(u.move, 5, 3)} codex-stat__value--blue">${u.move}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Range</div><div class="codex-stat__value codex-stat__value--blue">${u.rangeMin}–${u.rangeMax}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Sight</div><div class="codex-stat__value codex-stat__value--blue">${u.sightRange ?? "∞"}</div></div>
        <div class="codex-stat"><div class="codex-stat__label">Deadspace</div><div class="codex-stat__value">${u.deadspace ?? 0}</div></div>
      </div>
      <p class="muted small" style="margin-top:0.5rem"><strong>Attack:</strong> ${u.attackType === "indirect" ? "Ignores line-of-sight; cannot target within deadspace radius." : "Requires clear line-of-sight for direct attacks."}</p>
    </div>`;

  const panel = document.getElementById("codex-detail");
  if (panel) {
    panel.classList.add("codex-detail--open");
    addDragScroll(detail);
  }
}

/* ── Settings ─────────────────────────────────────────── */
function applyCyberHudArt() {
  document.getElementById("app")?.classList.toggle(
    "ctu-cyber-art-enabled",
    !!settings.cyberHudArtEnabled
  );
}

function applySettingsToUi() {
  const audioEl  = document.getElementById("setting-audio");
  const motionEl = document.getElementById("setting-reduce-motion");
  const fogEl    = document.getElementById("setting-fog");
  const diffEl   = document.getElementById("setting-difficulty");
  const hdefEl   = document.getElementById("setting-visual-hdef");
  const cyberArtEl = document.getElementById("setting-cyber-hud-art");
  if (audioEl)  audioEl.checked  = settings.audioEnabled;
  if (motionEl) motionEl.checked = settings.reduceMotion;
  if (fogEl)    fogEl.checked    = settings.fogOfWar !== false;
  if (diffEl)   diffEl.value     = settings.difficulty ?? "normal";
  if (hdefEl)   hdefEl.checked   = settings.visualStyle !== "classic";
  if (cyberArtEl) cyberArtEl.checked = !!settings.cyberHudArtEnabled;
  applyCyberHudArt();
}

let mapTheaterFilterSize = "all";
let mapTheaterFilterEnv = "all";
let mapTheaterFilterBiome = "all";
/** Map path for open blowup modal (`null` when closed). */
let mapTheaterBlowupPath = null;
/** Pin button that opened the blowup (for projection lines); cleared on close. */
let mapTheaterBlowupPinEl = null;
/** When max-height scales the map narrower than the wrap, pins must match the <img> box, not the wrap. */
let mapTheaterWorldPinResizeObs = null;

/** Sizes #map-theater-world-pins to the rendered bitmap (same coordinate space as anchor %). */
function syncMapTheaterWorldPinLayerBox() {
  const wrap = document.querySelector("#screen-maps .map-theater-world-wrap");
  const img = document.querySelector("#screen-maps .map-theater-world-img");
  const pins = document.getElementById("map-theater-world-pins");
  if (!wrap || !img || !pins) return;
  if (!img.offsetWidth || !img.offsetHeight) return;
  pins.style.position = "absolute";
  pins.style.left = `${img.offsetLeft}px`;
  pins.style.top = `${img.offsetTop}px`;
  pins.style.width = `${img.offsetWidth}px`;
  pins.style.height = `${img.offsetHeight}px`;
  pins.style.right = "auto";
  pins.style.bottom = "auto";
}

function ensureMapTheaterWorldPinLayerObserver() {
  const img = document.querySelector("#screen-maps .map-theater-world-img");
  const pins = document.getElementById("map-theater-world-pins");
  const wrap = document.querySelector("#screen-maps .map-theater-world-wrap");
  if (!img || !pins || !wrap) return;
  const run = () => {
    syncMapTheaterWorldPinLayerBox();
    if (!document.getElementById("map-theater-blowup")?.hidden) {
      updateMapTheaterProjectionLines();
    }
  };
  if (!mapTheaterWorldPinResizeObs) {
    mapTheaterWorldPinResizeObs = new ResizeObserver(run);
    mapTheaterWorldPinResizeObs.observe(img);
    mapTheaterWorldPinResizeObs.observe(wrap);
    img.addEventListener("load", run);
  }
  run();
}

/** Deterministic ±20px jitter from map path so each preview feels anchored, not template-centered. */
function mapTheaterPathJitterPx(path, salt) {
  let h = 2166136261 ^ (salt | 0);
  const s = String(path || "");
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 41) - 20;
}

function layoutMapTheaterBlowupDialog() {
  const shell = document.getElementById("map-theater-blowup");
  const dialog = shell?.querySelector?.(".map-theater-blowup__dialog");
  if (!shell || shell.hidden || !dialog) return;
  const hdr = document.querySelector("#app > header.top-bar");
  const headH = hdr ? hdr.getBoundingClientRect().height : 0;
  const margin = 10;
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const jx = mapTheaterPathJitterPx(mapTheaterBlowupPath, 0x51d);
  const jy = mapTheaterPathJitterPx(mapTheaterBlowupPath, 0xa7f);
  const pin = mapTheaterBlowupPinEl;
  const dw = dialog.offsetWidth;
  const dh = dialog.offsetHeight;
  if (!dw || !dh) return;

  let left;
  let top;
  if (pin && pin.isConnected) {
    const pr = pin.getBoundingClientRect();
    const pcx = pr.left + pr.width / 2;
    let preferTop = pr.top - gap - dh;
    if (preferTop >= headH + margin) {
      top = preferTop;
    } else {
      top = pr.bottom + gap;
    }
    left = pcx - dw / 2;
  } else {
    left = (vw - dw) / 2;
    top = headH + margin + 8;
  }
  left += jx;
  top += jy;
  left = Math.min(Math.max(margin, left), vw - margin - dw);
  top = Math.min(Math.max(headH + margin, top), vh - margin - dh);
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
}

function resetMapTheaterBlowupDialogPosition() {
  const dialog = document.querySelector("#map-theater-blowup .map-theater-blowup__dialog");
  if (!dialog) return;
  dialog.style.left = "";
  dialog.style.top = "";
}

function updateMapTheaterProjectionLines() {
  const g = document.getElementById("map-theater-projection-lines");
  const shell = document.getElementById("map-theater-blowup");
  const svg = document.getElementById("map-theater-projection-svg");
  if (!g || !svg || !shell || shell.hidden) {
    if (g) g.innerHTML = "";
    return;
  }
  const pin = mapTheaterBlowupPinEl;
  const vp = document.querySelector(".map-theater-blowup__viewport");
  if (!pin || !vp || !pin.isConnected) {
    g.innerHTML = "";
    return;
  }
  const pr = pin.getBoundingClientRect();
  const vr = vp.getBoundingClientRect();
  const px = pr.left + pr.width / 2;
  const py = pr.top + pr.height / 2;
  const w = window.innerWidth;
  const h = window.innerHeight;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const corners = [
    [vr.left, vr.top],
    [vr.right, vr.top],
    [vr.right, vr.bottom],
    [vr.left, vr.bottom],
  ];
  g.innerHTML = corners
    .map(
      ([x2, y2]) =>
        `<line x1="${px}" y1="${py}" x2="${x2}" y2="${y2}" stroke="#5af0ff" stroke-width="1.4" stroke-opacity="0.72" filter="url(#map-theater-proj-glow)" />`,
    )
    .join("");
}

function refreshMapTheaterBlowupPinRef() {
  if (!mapTheaterBlowupPath) return;
  const host = document.getElementById("map-theater-world-pins");
  if (!host) return;
  mapTheaterBlowupPinEl = null;
  for (const b of host.querySelectorAll("button.map-theater-world-pin")) {
    if (b.dataset.mapPath === mapTheaterBlowupPath) {
      mapTheaterBlowupPinEl = b;
      break;
    }
  }
}

function getFilteredMapsForTheater() {
  const maps = mapCatalog?.maps || [];
  const filtered = [];
  for (const m of maps) {
    if (mapTheaterFilterSize !== "all" && m.sizeCategory !== mapTheaterFilterSize) continue;
    if (mapTheaterFilterEnv !== "all" && m.environment !== mapTheaterFilterEnv) continue;
    if (mapTheaterFilterBiome !== "all") {
      const b = getBiomeForCatalogEntry(m);
      if (b !== mapTheaterFilterBiome) continue;
    }
    filtered.push(m);
  }
  return filtered;
}

/** FNV-1a for stable urban → Europe vs Africa split from map id. */
function theaterMapIdStableHash(s) {
  const str = String(s ?? "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function theaterMapUrbanSplitRegion(id) {
  return (theaterMapIdStableHash(id) & 1) === 0
    ? "europe_urban"
    : "africa_urban";
}

/**
 * Map catalog entry → geographic theater bucket (pins + previews align to region).
 * - Desert maps → North Africa + Australia (same asset)
 * - Wild forest → Amazon / Brazil (dense forest)
 * - Arctic / winter → Alaska (2 pin slots) + Russia (1 pin slot) on the world map
 * - Mixed (suburban + sparse cover) → North America
 * - Urban → Europe or Africa (stable split by map id)
 */
function mapCatalogEntryToTheaterWorldRegion(m) {
  const env = String(m.environment || "").toLowerCase();
  if (env === "mixed") return "north_america_mixed";
  if (env === "wild") return "amazon_dense_forest";
  if (env === "desert") return "desert";
  if (env === "arctic") return "arctic";
  if (env === "urban") return theaterMapUrbanSplitRegion(m.id);
  const biome = getBiomeForCatalogEntry(m);
  if (biome === "desert") return "desert";
  if (biome === "winter") return "arctic";
  if (biome === "urban") return theaterMapUrbanSplitRegion(m.id);
  if (biome === "forest") return "amazon_dense_forest";
  return "fallback";
}

function pinMicroJitterFromMapId(_id) {
  /* Anchors are sampled on interior black pixels; jitter would push dots onto glow/ocean */
  return { dx: 0, dy: 0 };
}

function clampWorldPinPct(n) {
  return Math.min(98, Math.max(2, n));
}

/**
 * Pin anchors as % of the rendered `world map.jpg` bitmap (native 1024×721).
 * Regenerated by `tools/generate_world_map_cyber.py` (interior black land, greedy spacing, geo boxes).
 */
const THEATER_WORLD_ANCHORS = {
  desert: [
    { leftPct: 47.75, topPct: 31.76 },
    { leftPct: 49.51, topPct: 31.07 },
    { leftPct: 51.17, topPct: 31.9 },
    { leftPct: 49.02, topPct: 33.56 },
    { leftPct: 52.93, topPct: 31.76 },
    { leftPct: 54.39, topPct: 33.15 },
    { leftPct: 56.05, topPct: 32.18 },
    { leftPct: 57.71, topPct: 33.15 },
    { leftPct: 60.16, topPct: 31.07 },
    { leftPct: 83.4, topPct: 55.48 },
    { leftPct: 85.16, topPct: 57.84 },
    { leftPct: 87.21, topPct: 56.87 },
    { leftPct: 91.31, topPct: 55.48 },
    { leftPct: 89.45, topPct: 57.14 },
    { leftPct: 81.93, topPct: 62.14 },
    { leftPct: 83.89, topPct: 60.33 },
  ],
  amazon_dense_forest: [
    { leftPct: 29.69, topPct: 43.97 },
    { leftPct: 28.81, topPct: 46.46 },
    { leftPct: 30.66, topPct: 47.43 },
    { leftPct: 32.13, topPct: 44.52 },
    { leftPct: 33.59, topPct: 46.46 },
    { leftPct: 35.35, topPct: 47.71 },
    { leftPct: 28.42, topPct: 49.24 },
    { leftPct: 30.27, topPct: 50.21 },
    { leftPct: 27.83, topPct: 52.01 },
  ],
  /* Winter / arctic maps: 2 dots Alaska, 1 dot Russia (Plate Carré % on world map.jpg, on interior land). */
  arctic: [
    { leftPct: 6.2, topPct: 15.5 },
    { leftPct: 10.2, topPct: 18.0 },
    { leftPct: 60.5, topPct: 18.5 },
  ],
  north_america_mixed: [
    { leftPct: 14.65, topPct: 21.08 },
    { leftPct: 16.6, topPct: 21.08 },
    { leftPct: 15.72, topPct: 23.86 },
    { leftPct: 18.55, topPct: 21.08 },
    { leftPct: 20.41, topPct: 22.05 },
    { leftPct: 17.68, topPct: 23.58 },
    { leftPct: 22.27, topPct: 21.08 },
    { leftPct: 23.83, topPct: 22.75 },
    { leftPct: 21.97, topPct: 23.86 },
    { leftPct: 25.39, topPct: 21.08 },
    { leftPct: 27.25, topPct: 22.05 },
    { leftPct: 25.68, topPct: 23.86 },
    { leftPct: 29.1, topPct: 21.08 },
    { leftPct: 30.66, topPct: 22.75 },
  ],
  europe_urban: [
    { leftPct: 48.63, topPct: 18.03 },
    { leftPct: 51.76, topPct: 16.64 },
    { leftPct: 53.91, topPct: 16.64 },
    { leftPct: 58.01, topPct: 17.06 },
    { leftPct: 56.15, topPct: 18.72 },
    { leftPct: 49.8, topPct: 20.67 },
    { leftPct: 51.17, topPct: 23.02 },
    { leftPct: 52.64, topPct: 20.11 },
    { leftPct: 54.59, topPct: 21.5 },
    { leftPct: 53.22, topPct: 23.99 },
  ],
  africa_urban: [
    { leftPct: 46.0, topPct: 38.83 },
    { leftPct: 59.08, topPct: 54.37 },
    { leftPct: 61.23, topPct: 47.3 },
    { leftPct: 56.74, topPct: 40.92 },
    { leftPct: 49.32, topPct: 46.74 },
    { leftPct: 61.82, topPct: 37.86 },
    { leftPct: 58.5, topPct: 61.86 },
    { leftPct: 56.35, topPct: 53.12 },
    { leftPct: 52.54, topPct: 40.64 },
    { leftPct: 54.98, topPct: 43.55 },
    { leftPct: 55.37, topPct: 49.79 },
    { leftPct: 49.22, topPct: 42.02 },
  ],
  fallback: [
    { leftPct: 48.63, topPct: 18.03 },
    { leftPct: 47.75, topPct: 31.76 },
    { leftPct: 29.69, topPct: 43.97 },
  ],
};

/**
 * @param {Array<{ id?: string, path: string }>} maps
 * @returns {Map<string, { leftPct: number, topPct: number }>}
 */
function buildWorldPinLayoutByPath(maps) {
  /** @type {Map<string, { leftPct: number, topPct: number }>} */
  const out = new Map();
  /** @type {Map<string, typeof maps>} */
  const groups = new Map();
  for (const m of maps) {
    const r = mapCatalogEntryToTheaterWorldRegion(m);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  }
  for (const [regionKey, list] of groups) {
    const anchors = THEATER_WORLD_ANCHORS[regionKey] || THEATER_WORLD_ANCHORS.fallback;
    const ordered = [...list].sort((a, b) =>
      String(a.path || "").localeCompare(String(b.path || "")),
    );
    ordered.forEach((m, idx) => {
      const slot = anchors[idx % anchors.length];
      const j = pinMicroJitterFromMapId(m.id);
      out.set(m.path, {
        leftPct: clampWorldPinPct(slot.leftPct + j.dx),
        topPct: clampWorldPinPct(slot.topPct + j.dy),
      });
    });
  }
  return out;
}

function mapTheaterThumbButtonForPath(mapPath) {
  const strip = document.getElementById("map-theater-rail-strip");
  if (!strip) return null;
  const esc = String(mapPath).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return strip.querySelector(`button.map-theater-thumb[data-map-path="${esc}"]`);
}

function scrollMapTheaterThumbIntoView(mapPath) {
  const el = mapTheaterThumbButtonForPath(mapPath);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

function setMapTheaterThumbPeek(mapPath, on) {
  document
    .querySelectorAll("#map-theater-rail-strip .map-theater-thumb--peek")
    .forEach((n) => n.classList.remove("map-theater-thumb--peek"));
  if (!on || !mapPath) return;
  const el = mapTheaterThumbButtonForPath(mapPath);
  if (el) el.classList.add("map-theater-thumb--peek");
}

async function applyMapTheaterSelectionFromPath(mapPath) {
  const prevPath = pendingUserMapPath;
  pendingProceduralSkirmishSpec = null;
  pendingUserMapPath = mapPath;
  let sb;
  try {
    sb = await loadJson(mapPath);
  } catch (e) {
    console.warn("[CTU] map theater: load failed", e);
    pendingUserMapPath = prevPath;
    const sel = document.getElementById("map-theater-selected");
    if (sel) sel.textContent = "Could not load that map. Pick another.";
    await renderMapTheater();
    return false;
  }
  const newSlots = Math.min(8, Math.max(1, sb.skirmishDeploy?.length ?? 8));
  pendingMapSkirmishSlotCount = newSlots;
  if (
    pendingSkirmishOrderedLoadout &&
    pendingSkirmishOrderedLoadout.length !== newSlots
  ) {
    pendingSkirmishOrderedLoadout = null;
  }
  await renderMapTheater();
  if (mapsReturnTarget === "vs-cpu-prep") {
    mapsReturnTarget = null;
    void openVsCpuPrep();
    showScreen("vs-cpu-prep");
  } else if (mapsReturnTarget === "mat-lab-prep") {
    mapsReturnTarget = null;
    void openMatLabPrep();
    showScreen("mat-lab-prep");
  }
  return true;
}

async function redrawMapTheaterBlowupCanvas(tileTypeMap) {
  const canvas = document.getElementById("map-theater-blowup-canvas");
  const panel = document.querySelector("#map-theater-blowup .map-theater-blowup__viewport");
  if (!canvas || !mapTheaterBlowupPath || !panel) return;
  const maxW = Math.max(120, Math.min(560, (panel.clientWidth || 320) - 4));
  const maxH = Math.max(100, Math.min(400, (panel.clientHeight || 200) - 4));
  try {
    const sb = await loadJson(mapTheaterBlowupPath);
    const terrain = sb?.terrain;
    if (terrain?.length) {
      drawMapTheaterPreviewCanvas(canvas, terrain, tileTypeMap, maxW, maxH);
    }
  } catch (e) {
    console.warn("[CTU] Map theater blowup preview failed", e);
  }
}

function openMapTheaterBlowup(mapPath, tileTypeMap, pinEl) {
  mapTheaterBlowupPath = mapPath;
  mapTheaterBlowupPinEl = pinEl && pinEl instanceof Element ? pinEl : null;
  const shell = document.getElementById("map-theater-blowup");
  const nameEl = document.getElementById("map-theater-blowup-name");
  if (!shell) return;
  const maps = mapCatalog?.maps || [];
  const entry = maps.find((x) => x.path === mapPath);
  if (nameEl) nameEl.textContent = entry ? entry.name : mapPath;
  shell.hidden = false;
  shell.setAttribute("aria-hidden", "false");
  void redrawMapTheaterBlowupCanvas(tileTypeMap);
  requestAnimationFrame(() => {
    layoutMapTheaterBlowupDialog();
    void redrawMapTheaterBlowupCanvas(tileTypeMap);
    updateMapTheaterProjectionLines();
  });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      layoutMapTheaterBlowupDialog();
      void redrawMapTheaterBlowupCanvas(tileTypeMap);
      updateMapTheaterProjectionLines();
    });
  });
  scrollMapTheaterThumbIntoView(mapPath);
  setMapTheaterThumbPeek(mapPath, true);
  document.getElementById("map-theater-blowup-close")?.focus?.();
}

function closeMapTheaterBlowup() {
  const shell = document.getElementById("map-theater-blowup");
  if (shell) {
    shell.hidden = true;
    shell.setAttribute("aria-hidden", "true");
  }
  resetMapTheaterBlowupDialogPosition();
  mapTheaterBlowupPath = null;
  mapTheaterBlowupPinEl = null;
  const g = document.getElementById("map-theater-projection-lines");
  if (g) g.innerHTML = "";
  setMapTheaterThumbPeek(null, false);
}

async function renderMapTheater() {
  const fs = document.getElementById("map-filter-size");
  if (fs) fs.value = mapTheaterFilterSize;
  const fe = document.getElementById("map-filter-env");
  if (fe) fe.value = mapTheaterFilterEnv;
  const fb = document.getElementById("map-filter-biome");
  if (fb) fb.value = mapTheaterFilterBiome;

  let tileTypeMap = mapTheaterTileTypes;
  if (!tileTypeMap) {
    try {
      const j = await loadJson("js/config/tileTextures.json");
      tileTypeMap = j.types || {};
      mapTheaterTileTypes = tileTypeMap;
    } catch (e) {
      console.warn("[CTU] Map theater: could not load tileTextures for previews", e);
      tileTypeMap = {};
    }
  }

  const railStrip = document.getElementById("map-theater-rail-strip");
  if (!railStrip) return;
  railStrip.innerHTML = "";

  const thumbMaxW = 52;
  const thumbMaxH = 52;

  const filtered = getFilteredMapsForTheater();
  if (mapTheaterBlowupPath && !filtered.some((x) => x.path === mapTheaterBlowupPath)) {
    closeMapTheaterBlowup();
  }

  filtered.forEach((m) => {
    const card = document.createElement("button");
    card.type = "button";
    const isSel = pendingUserMapPath === m.path;
    card.className =
      "map-theater-thumb" + (isSel ? " map-theater-thumb--selected" : "");
    card.dataset.mapPath = m.path;
    card.setAttribute("aria-label", `Select map: ${m.name}`);
    card.setAttribute("aria-current", isSel ? "true" : "false");
    const previewCanvas = document.createElement("canvas");
    previewCanvas.className = "map-theater-thumb__cv";
    previewCanvas.setAttribute("aria-hidden", "true");
    const previewWrap = document.createElement("span");
    previewWrap.className = "map-theater-thumb__preview-wrap";
    previewWrap.appendChild(previewCanvas);
    card.appendChild(previewWrap);
    const nameEl = document.createElement("span");
    nameEl.className = "map-theater-thumb__name";
    nameEl.textContent = m.name;
    card.appendChild(nameEl);
    void loadJson(m.path)
      .then((sb) => {
        if (sb?.terrain && previewCanvas) {
          drawMapTheaterPreviewCanvas(
            previewCanvas,
            sb.terrain,
            tileTypeMap,
            thumbMaxW,
            thumbMaxH
          );
        }
      })
      .catch((e) => {
        console.warn("[CTU] Map theater thumb preview failed:", m.path, e);
      });
    card.addEventListener("click", () => {
      void applyMapTheaterSelectionFromPath(m.path);
    });
    railStrip.appendChild(card);
  });

  const pinHost = document.getElementById("map-theater-world-pins");
  if (pinHost) {
    pinHost.innerHTML = "";
    const pinLayout = buildWorldPinLayoutByPath(filtered);
    filtered.forEach((m) => {
      const pos = pinLayout.get(m.path);
      const leftPct = pos?.leftPct ?? 50;
      const topPct = pos?.topPct ?? 50;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "map-theater-world-pin";
      pin.style.left = `${leftPct}%`;
      pin.style.top = `${topPct}%`;
      pin.dataset.mapPath = m.path;
      pin.setAttribute("aria-label", `Open terrain preview: ${m.name}`);
      pin.addEventListener("mouseenter", () => {
        scrollMapTheaterThumbIntoView(m.path);
        setMapTheaterThumbPeek(m.path, true);
      });
      pin.addEventListener("mouseleave", () => {
        if (mapTheaterBlowupPath !== m.path) {
          setMapTheaterThumbPeek(null, false);
        }
      });
      pin.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMapTheaterBlowup(m.path, tileTypeMap, pin);
      });
      pinHost.appendChild(pin);
    });
    ensureMapTheaterWorldPinLayerObserver();
    requestAnimationFrame(() => {
      syncMapTheaterWorldPinLayerBox();
      requestAnimationFrame(() => syncMapTheaterWorldPinLayerBox());
    });
  }

  if (
    mapTheaterBlowupPath &&
    !document.getElementById("map-theater-blowup")?.hidden
  ) {
    refreshMapTheaterBlowupPinRef();
    requestAnimationFrame(() => {
      layoutMapTheaterBlowupDialog();
      updateMapTheaterProjectionLines();
    });
  }

  void redrawMapTheaterMainPreview(tileTypeMap);
  if (!document.getElementById("map-theater-blowup")?.hidden && mapTheaterBlowupPath) {
    void redrawMapTheaterBlowupCanvas(tileTypeMap);
  }
  const backPrep = document.getElementById("btn-map-theater-back-prep");
  if (backPrep) {
    backPrep.hidden =
      mapsReturnTarget !== "vs-cpu-prep" && mapsReturnTarget !== "mat-lab-prep";
  }
}

function showBootFailureBanner(message) {
  let el = document.getElementById("ctu-boot-failure");
  if (!el) {
    el = document.createElement("div");
    el.id = "ctu-boot-failure";
    el.setAttribute("role", "alert");
    el.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:0.75rem 1rem;" +
      "background:#4a1212;color:#fde8e8;font-family:system-ui,sans-serif;font-size:0.88rem;" +
      "text-align:center;border-top:1px solid #8a3030;";
    document.body.appendChild(el);
  }
  el.textContent = message;
}

/* ── Init app ─────────────────────────────────────────── */
async function initApp() {
  /* Local configs first — these MUST succeed for the app to function */
  [academyConfig, hubConfig, onboardingConfig, mapCatalog] = await Promise.all([
    loadJson("js/config/academy.json"),
    loadJson("js/config/hub.json"),
    loadJson("js/config/onboarding.json"),
    loadJson("js/config/mapCatalog.json").catch(() => ({ maps: [] })),
  ]);
  unitRegistry = await loadMergedUnitsFromConfig();
  progress  = loadProgress();
  settings  = loadSettings();
  settings.visualStyle = settings.visualStyle === "classic" ? "classic" : "hDef";
  if (typeof settings.cyberHudArtEnabled !== "boolean") settings.cyberHudArtEnabled = false;
  window.__CTU_AUDIO_DISABLED = !settings.audioEnabled;
  applySettingsToUi();
  applyVisualTheme();
  applyBattleCamera();

  /* Firebase is optional — never blocks the app */
  await initFirebase();
  try {
    await wireCloudProgress(
      () => progress,
      (p) => { progress = p; saveProgress(p, { skipCloud: true }); renderHubRoster(); updateGateBanner(); }
    );
  } catch (e) {
    console.warn("[CTU] Cloud sync unavailable", e);
  }

  renderHubRoster();
  renderHubModes();
  updateGateBanner();
}

/* ── Wire UI ──────────────────────────────────────────── */
function wireUi() {
  /* Nav / screen buttons — capture phase so nothing can swallow bubble; target may be text node inside button */
  const navClickTarget = (ev) => {
    const n = ev.target;
    if (!n) return null;
    if (n.nodeType === Node.TEXT_NODE) return n.parentElement;
    return n instanceof Element ? n : null;
  };

  document.getElementById("app")?.addEventListener(
    "click",
    (ev) => {
      const t = navClickTarget(ev);
      if (!t) return;
      const procV2 = t.closest("[data-proc-biome], [data-proc-theme]");
      if (procV2) {
        ev.preventDefault();
        const biome = procV2.getAttribute("data-proc-biome");
        const theme = procV2.getAttribute("data-proc-theme");
        pendingProceduralSkirmishSpec = {
          biome: biome || undefined,
          theme: theme || undefined,
        };
        pendingUserMapPath = null;
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
        return;
      }
      const btn = t.closest("[data-screen]");
      if (!btn || btn.closest("a")) return;
      if (btn.disabled) return;
      const s = btn.getAttribute("data-screen");
      if (!s) return;
      const section = btn.getAttribute("data-section") || null;
      if (s === "maps") {
        mapsReturnTarget = null;
        showScreen(s, section);
        return;
      }
      if (s === "battle") {
        if (btn.getAttribute("data-requires-academy") === "true" && !progress.academyComplete) {
          showScreen("hub", "hub-section-modes"); updateGateBanner(); return;
        }
        void openVsCpuPrep();
        showScreen("vs-cpu-prep");
        return;
      }
      if (s === "hotseat" && !progress.academyComplete) {
        showScreen("hub", "hub-section-modes"); updateGateBanner(); return;
      }
      showScreen(s, section);
    },
    true
  );

  /* landing shortcut: "vs Computer" shortcut card with data-skirmish */
  document.querySelectorAll("[data-skirmish='true']").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!progress.academyComplete) { showScreen("hub"); updateGateBanner(); return; }
      void openVsCpuPrep();
      showScreen("vs-cpu-prep");
    });
  });

  /* Codex dossier close — delegated to the screen so it always works */
  document.getElementById("screen-codex")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-dossier]")) closeCodexDossier();
  });

  wireLandingDock();

  /* battle buttons */
  document.getElementById("btn-battle-attack-overlay")?.addEventListener("click", () => {
    if (!game || game.winner != null) return;
    battleAttackRangePinned = !battleAttackRangePinned;
    syncHud();
  });
  document.getElementById("btn-end-turn")?.addEventListener("click", () => {
    if (!game || game.winner != null || aiRunning) return;
    if (game.units.some((u) => u.hp > 0 && u.state === "attack")) {
      showBattleToast("Wait for the attack animation to finish.");
      return;
    }
    AudioManager.play("TurnEnd");
    battleAttackRangePinned = false;
    game.endTurn();
    syncHud();
    if (game.winner != null) return;
    if (game.hotseat) { showInterstitial(game.currentPlayer); return; }
    aiRunning = true;
    setTimeout(async () => {
      try {
        await aiTurn();
      } finally {
        aiRunning = false;
      }
    }, 400);
  });
  document.getElementById("btn-restart")?.addEventListener("click", () => {
    document.getElementById("battle-result-overlay").hidden = true;
    if (lastBootOptions.mode === "hotseat") bootHotseat();
    else bootBattle(lastBootOptions);
  });
  document.getElementById("btn-result-restart")?.addEventListener("click", () => {
    document.getElementById("battle-result-overlay").hidden = true;
    if (lastBootOptions.mode === "hotseat") bootHotseat();
    else bootBattle(lastBootOptions);
  });
  document.getElementById("btn-result-hub")?.addEventListener("click", () => {
    document.getElementById("battle-result-overlay").hidden = true;
    showScreen(settings.visualStyle === "classic" ? "hub" : "v2-landing");
  });
  document.getElementById("btn-hub-from-battle")?.addEventListener("click", () =>
    showScreen(settings.visualStyle === "classic" ? "hub" : "v2-landing")
  );
  document.getElementById("btn-interstitial-ready")?.addEventListener("click", hideInterstitial);
  document.getElementById("btn-coach-dismiss")?.addEventListener("click", () => {
    progress.hideBattleCoach = true; saveProgress(progress); syncCoachPanel();
  });

  /* academy */
  document.getElementById("btn-academy-confirm")?.addEventListener("click", confirmAcademy);
  document.getElementById("btn-academy-back")?.addEventListener("click", () => showScreen("hub"));

  /* hotseat */
  document.getElementById("btn-hotseat-start")?.addEventListener("click", bootHotseat);

  document.getElementById("map-filter-size")?.addEventListener("change", (ev) => {
    mapTheaterFilterSize = ev.target.value || "all";
    void renderMapTheater();
  });
  document.getElementById("map-filter-env")?.addEventListener("change", (ev) => {
    mapTheaterFilterEnv = ev.target.value || "all";
    void renderMapTheater();
  });
  document.getElementById("map-filter-biome")?.addEventListener("change", (ev) => {
    mapTheaterFilterBiome = ev.target.value || "all";
    void renderMapTheater();
  });
  let mapTheaterLayoutTimer = null;
  window.addEventListener(
    "resize",
    () => {
      clearTimeout(mapTheaterLayoutTimer);
      mapTheaterLayoutTimer = setTimeout(() => {
        if (document.getElementById("screen-maps")?.classList.contains("screen--active")) {
          void renderMapTheater();
          const blow = document.getElementById("map-theater-blowup");
          if (blow && !blow.hidden && mapTheaterBlowupPath) {
            layoutMapTheaterBlowupDialog();
            void redrawMapTheaterBlowupCanvas(mapTheaterTileTypes || {});
            updateMapTheaterProjectionLines();
          }
        }
      }, 120);
    },
    { passive: true },
  );
  document.getElementById("map-theater-blowup-close")?.addEventListener("click", () => {
    closeMapTheaterBlowup();
  });
  document.getElementById("map-theater-blowup-use")?.addEventListener("click", () => {
    const p = mapTheaterBlowupPath;
    if (!p) return;
    void (async () => {
      await applyMapTheaterSelectionFromPath(p);
      closeMapTheaterBlowup();
    })();
  });
  document.getElementById("btn-map-theater-skirmish")?.addEventListener("click", () => {
    void openMapSkirmishLoadout({ returnToPrep: false });
  });
  document.getElementById("btn-map-theater-back-prep")?.addEventListener("click", () => {
    const t = mapsReturnTarget;
    mapsReturnTarget = null;
    if (t === "mat-lab-prep") {
      void openMatLabPrep();
      showScreen("mat-lab-prep");
    } else {
      void openVsCpuPrep();
      showScreen("vs-cpu-prep");
    }
  });
  document.getElementById("btn-vs-cpu-prep-map")?.addEventListener("click", () => {
    pendingProceduralSkirmishSpec = null;
    mapsReturnTarget = "vs-cpu-prep";
    showScreen("maps");
  });
  document.getElementById("btn-vs-cpu-prep-squad")?.addEventListener("click", () => {
    void openMapSkirmishLoadout({ returnToPrep: true });
  });
  document.getElementById("btn-vs-cpu-prep-difficulty")?.addEventListener("change", (ev) => {
    const v = ev.target?.value;
    settings.soloDifficulty = normalizeSoloDifficulty(v);
    saveSettings(settings);
    syncVsCpuPrepUi();
  });
  document.getElementById("btn-vs-cpu-prep-start")?.addEventListener("click", () => {
    const need = pendingMapSkirmishSlotCount || 8;
    const n = pendingSkirmishOrderedLoadout?.length ?? 0;
    if (n < 1 || n > need) return;
    const loadout = [...pendingSkirmishOrderedLoadout];
    const diff = normalizeSoloDifficulty(settings.soloDifficulty);
    if (pendingProceduralSkirmishSpec) {
      void startProceduralFromVsCpuPrep(loadout);
      return;
    }
    if (!pendingUserMapPath) return;
    const urbanSiege =
      pendingUserMapPath.endsWith("urban_siege.json") ||
      pendingUserMapPath.includes("/urban_siege.json");
    void bootBattle({
      mode: urbanSiege ? "urban" : "skirmish",
      loadout,
      scenarioPath: pendingUserMapPath,
      skirmishDifficulty: diff,
    });
  });
  document.getElementById("screen-mat-lab-prep")?.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-mat-theater]");
    if (!b || b.disabled) return;
    pendingMatLabTheater = b.getAttribute("data-mat-theater") || "grass";
    syncMatLabPrepUi();
  });
  document.getElementById("btn-mat-lab-squad")?.addEventListener("click", () => {
    void openMapSkirmishLoadout({ matLab: true });
  });
  document.getElementById("btn-mat-lab-start")?.addEventListener("click", () => {
    const loadout = pendingMatLabLoadout;
    const n = loadout?.length ?? 0;
    if (n < 1 || n > 8 || !pendingMatLabTheater) return;
    void bootBattle({
      mode: "skirmish",
      scenarioPath: PLANE_LAYER_SCENARIO_PATH,
      loadout: [...loadout],
      matLabTheater: pendingMatLabTheater,
      skirmishDifficulty: normalizeSoloDifficulty(settings.soloDifficulty),
    });
  });
  document.getElementById("btn-proc-urban")?.addEventListener("click", () => {
    pendingProceduralSkirmishSpec = { theme: "urban" };
    pendingUserMapPath = null;
    void openVsCpuPrep();
    showScreen("vs-cpu-prep");
  });
  document.getElementById("btn-proc-desert")?.addEventListener("click", () => {
    pendingProceduralSkirmishSpec = { theme: "desert" };
    pendingUserMapPath = null;
    void openVsCpuPrep();
    showScreen("vs-cpu-prep");
  });
  document.getElementById("btn-export-proc-map")?.addEventListener("click", () => {
    if (!lastProceduralScenario) {
      window.alert("No procedural map yet. Start a procedural battle from Hub, Modern Ops, or Classic menu first.");
      return;
    }
    downloadMapLayout(lastProceduralScenario, `${lastProceduralScenario.id || "ctu-map"}.json`);
  });
  document.getElementById("btn-map-skirmish-confirm")?.addEventListener("click", confirmMapSkirmish);
  document.getElementById("btn-map-skirmish-back")?.addEventListener("click", () => {
    const ret = mapSkirmishPrepReturnId;
    mapSkirmishPrepReturnId = null;
    if (ret === "mat-lab-prep") {
      showScreen("mat-lab-prep");
      syncMatLabPrepUi();
    } else if (ret === "vs-cpu-prep") {
      showScreen("vs-cpu-prep");
      syncVsCpuPrepUi();
    } else {
      showScreen("maps");
      void renderMapTheater();
    }
  });
  document.getElementById("btn-map-theater-hotseat")?.addEventListener("click", () =>
    showScreen("hotseat")
  );

  document.getElementById("btn-battle-fullscreen")?.addEventListener("click", () => toggleBattleFullscreen());

  document.getElementById("btn-dev-animation-test")?.addEventListener("click", () => {
    void runDevAnimationTest();
  });

  /* settings */
  document.getElementById("setting-audio")?.addEventListener("change", (ev) => {
    settings.audioEnabled = ev.target.checked;
    window.__CTU_AUDIO_DISABLED = !settings.audioEnabled;
    saveSettings(settings);
  });
  document.getElementById("setting-reduce-motion")?.addEventListener("change", (ev) => {
    settings.reduceMotion = ev.target.checked;
    saveSettings(settings);
    clampBattlePan();
    applyBattleCamera();
  });
  document.getElementById("setting-fog")?.addEventListener("change", (ev) => {
    settings.fogOfWar = ev.target.checked; saveSettings(settings);
  });
  document.getElementById("setting-difficulty")?.addEventListener("change", (ev) => {
    settings.difficulty = ev.target.value; saveSettings(settings);
  });
  document.getElementById("setting-visual-hdef")?.addEventListener("change", (ev) => {
    settings.visualStyle = ev.target.checked ? "hDef" : "classic";
    saveSettings(settings);
    applyVisualTheme();
  });
  document.getElementById("setting-cyber-hud-art")?.addEventListener("change", (ev) => {
    settings.cyberHudArtEnabled = ev.target.checked;
    saveSettings(settings);
    applyCyberHudArt();
  });
  document.getElementById("btn-settings-back")?.addEventListener("click", () => {
    showScreen(settings.visualStyle === "classic" ? "hub" : "v2-landing");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target?.closest?.("input, textarea, select, [contenteditable=true]")) return;

    if (ev.key === "Escape") {
      const blow = document.getElementById("map-theater-blowup");
      if (blow && !blow.hidden) {
        ev.preventDefault();
        closeMapTheaterBlowup();
        return;
      }
    }

    const battleEl = document.getElementById("screen-battle");
    const battleOn = battleEl?.classList.contains("screen--active");

    if (battleOn && game && game.winner == null) {
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : "";
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        ev.preventDefault();
        if (k === "w") battlePanY += BATTLE_KEY_PAN_STEP;
        if (k === "s") battlePanY -= BATTLE_KEY_PAN_STEP;
        if (k === "a") battlePanX += BATTLE_KEY_PAN_STEP;
        if (k === "d") battlePanX -= BATTLE_KEY_PAN_STEP;
        clampBattlePan();
        applyBattleCamera();
        return;
      }
    }

    if ((ev.key === "r" || ev.key === "R") && battleOn && game && game.winner == null) {
      battleAttackRangePinned = !battleAttackRangePinned;
      syncHud();
      ev.preventDefault();
      return;
    }

    if (ev.key !== "p" && ev.key !== "P") return;
    if (!game || game.winner != null) return;
    if (!battleOn) return;
    const sel = game.getSelected();
    if (!sel || sel.owner !== game.currentPlayer || sel.hp <= 0) return;
    if (sel.templateId !== "sniper") return;
    sel.prone = !sel.prone;
    pushLog(sel.prone ? "Sniper: prone (steady shot)." : "Sniper: standing.", "battle-log__item--move");
    syncHud();
  });
  document.getElementById("btn-reset-progress")?.addEventListener("click", () => {
    if (!confirm("Reset ALL progress? This cannot be undone.")) return;
    localStorage.removeItem("ctu_progress_v1");
    progress = loadProgress();
    renderHubRoster(); renderHubModes(); updateGateBanner();
    showScreen("hub");
  });

  /* canvas */
  canvas = document.getElementById("battle-canvas");
  ctx = canvas.getContext("2d");
  initBattleNotifications();
  canvas.addEventListener("pointermove", onCanvasMouseMove);
  canvas.addEventListener("mouseleave", () => {
    battleHoverShowsAttackOverlay = false;
    const t = document.getElementById("unit-tooltip");
    if (t) t.hidden = true;
  });
  initBattleCameraControls();

  initDevLogoBackdoor();

  ensureMapTheaterWorldPinLayerObserver();
}

/* ── Drag-to-scroll gesture helper ──────────────────────
   Adds mouse-drag + touch-drag scrolling to any overflow
   container. Uses a movement threshold so child button
   clicks still fire on a short tap/click.
   ────────────────────────────────────────────────────── */
const DRAG_THRESHOLD = 8; /* px — below this is a tap, above is a drag */

/* Solo Modes carousel — prev/next beside the list (see index.html .hub-carousel) */
function updateHubCarouselNav() {
  const carousel = document.getElementById("hub-modes");
  const btnPrev  = document.getElementById("hub-modes-prev");
  const btnNext  = document.getElementById("hub-modes-next");
  if (!carousel || !btnPrev || !btnNext) return;
  const st = carousel.scrollTop;
  const ch = carousel.clientHeight;
  const sh = carousel.scrollHeight;
  btnPrev.disabled = st <= 1;
  btnNext.disabled = sh <= ch || st + ch >= sh - 2;
}

function addDragScroll(el, opts) {
  if (!el || el._dragWired) return;
  el._dragWired = true;
  const ignoreFrom = opts?.ignoreFromSelector
    ? (e) => {
        try {
          return e.target?.closest?.(opts.ignoreFromSelector);
        } catch {
          return null;
        }
      }
    : () => null;

  let active = false;
  let dragging = false;
  let suppressClick = false;
  let pid = null;
  let startY = 0;
  let startX = 0;
  let top0 = 0;
  let left0 = 0;

  const finish = () => {
    if (pid != null) {
      try {
        el.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
    }
    pid = null;
    active = false;
    el.classList.remove("drag-scroll--active");
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return; /* native overflow scroll + momentum */
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (ignoreFrom(e)) return;
    active = true;
    dragging = false;
    suppressClick = false;
    pid = e.pointerId;
    startY = e.clientY;
    startX = e.clientX;
    top0 = el.scrollTop;
    left0 = el.scrollLeft;
  });

  el.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pid) return;
    const dy = startY - e.clientY;
    const dx = startX - e.clientX;
    if (!dragging && Math.abs(dy) + Math.abs(dx) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      suppressClick = true;
      try {
        el.setPointerCapture(pid);
      } catch {
        /* ignore */
      }
      el.classList.add("drag-scroll--active");
    }
    el.scrollTop = top0 + dy;
    el.scrollLeft = left0 + dx;
    e.preventDefault();
  });

  el.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pid) return;
    const wasDrag = dragging;
    finish();
    dragging = false;
    if (!wasDrag) suppressClick = false;
  });

  el.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== pid) return;
    finish();
    dragging = false;
    suppressClick = false;
  });

  el.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    },
    true,
  );
}

function wireGestures() {
  /* Static containers — always in DOM */
  addDragScroll(document.getElementById("codex-detail-inner"));
  addDragScroll(document.querySelector(".battle-log__list"));
  addDragScroll(document.querySelector("#screen-codex .codex-command.bg-command-codex"), {
    ignoreFromSelector:
      "#codex-select-grid, .codex-select-stage, .codex-clear-dossier, button, a[href]",
  });
  addDragScroll(document.querySelector("#screen-hub .hub-command.bg-command-hub"), {
    ignoreFromSelector:
      "#hub-modes, button, a[href], .hub-roster-slot, .hub-toggle-btn, .hub-season-card, .hub-gate",
  });
  addDragScroll(document.getElementById("hub-modes"));
  addDragScroll(document.querySelector("#screen-maps .maps-command.bg-command-maps"), {
    ignoreFromSelector:
      ".map-theater-rail, .map-theater-stage, .map-theater-hero, .map-theater-filter-slots, select, button, a[href], canvas",
  });
  document.querySelectorAll("#screen-maps .map-theater-rail").forEach((el) => {
    addDragScroll(el);
  });
  addDragScroll(document.querySelector("#screen-settings .ctu-metal-frame__content"));
  addDragScroll(document.querySelector("#screen-academy .ctu-metal-frame__content"));

  /* ── Solo-modes carousel nav buttons (optional; list also drag-scrolls) ── */
  const carousel = document.getElementById("hub-modes");
  const btnPrev  = document.getElementById("hub-modes-prev");
  const btnNext  = document.getElementById("hub-modes-next");
  const CARD_H   = 76 + 8; /* card height + gap = one snap step */

  btnPrev?.addEventListener("click", () => {
    carousel?.scrollBy({ top: -CARD_H, behavior: "smooth" });
  });
  btnNext?.addEventListener("click", () => {
    carousel?.scrollBy({ top: CARD_H, behavior: "smooth" });
  });
  carousel?.addEventListener("scroll", updateHubCarouselNav, { passive: true });
}

wireUi();
wireGestures();
initApp()
  .then(() => {
    showScreen(settings.visualStyle === "classic" ? "landing" : "v2-landing");
  })
  .catch((err) => {
    console.error("[CTU] initApp failed", err);
    showBootFailureBanner(
      "Could not load game data (configs / units.json). Use a local server (npm start), not file:// — " +
        (err && err.message ? err.message : String(err))
    );
    showScreen("landing");
  });
