import { loadJson } from "./loadConfig.js";
import { GameState } from "./engine/gameState.js";
import { drawGrid } from "./render/canvasGrid.js";
import { UnitRenderer } from "./render/unitRenderer.js";
import { BattleVfx } from "./render/battleVfx.js";
import { FxLayer } from "./render/fxLayer.js";
import { manhattan, chebyshev } from "./engine/grid.js";
import { canAttack } from "./engine/combat.js";
import { hasLineOfSight } from "./engine/los.js";
import { AudioManager } from "./audio/AudioManager.js";
import { loadProgress, saveProgress, isUnlocked } from "./progression/store.js";
import { loadSettings, saveSettings } from "./progression/settings.js";
import { initFirebase } from "./firebase/auth.js";
import { wireCloudProgress } from "./firebase/progressSync.js";
import { createBattlePlaneController } from "./battle-plane/runtime.js";
import { drawMapObjects } from "./render/mapObjectLayer.js";
import { generateProceduralScenario } from "./mapgen/pipeline.js";
import { downloadMapLayout } from "./mapgen/persist.js";
import { moveTweenDurationMs, lerpCellPair } from "./render/tween.js";
import { sharedBattleAmbient } from "./render/effects.js";

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
let lerp = null;
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
};
/** Last scenario from generateProceduralScenario (for JSON export). */
let lastProceduralScenario = null;
/** When set (from Map Theater), used as default for vs-CPU skirmish and hotseat base layout. */
let pendingUserMapPath = null;
let mapCatalog = { maps: [] };
let battleEndHandled = false;
let aiRunning = false;
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
/** Allow 1..mapSkirmishPickCount instead of requiring an exact fill (prep + mat lab). */
let mapSkirmishFlexiblePick = false;
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
  if (game.scenario?.battlePlaneLayer?.enabled) return null;
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

function mergeScenarioForBattle(baseScenario, mode, loadout, acad) {
  const s = JSON.parse(JSON.stringify(baseScenario));
  if (s.usePresetUnits) return s;
  if (mode === "trial" || mode === "hotseat") return s;
  const enemies = scenarioPresetEnemies(s);
  if (mode === "academy" && loadout?.length && acad?.deploymentSlots) {
    s.units = [];
    loadout.forEach((tid, i) => {
      const slot = acad.deploymentSlots[i];
      if (slot) s.units.push({ templateId: tid, owner: 0, x: slot.x, y: slot.y });
    });
    s.units.push(...enemies);
    return s;
  }
  if (mode === "skirmish" && Array.isArray(loadout) && loadout.length > 0 && s.skirmishDeploy?.length) {
    s.units = [];
    for (let i = 0; i < s.skirmishDeploy.length; i++) {
      const tid = loadout[i];
      const slot = s.skirmishDeploy[i];
      if (tid && slot) s.units.push({ templateId: tid, owner: 0, x: slot.x, y: slot.y });
    }
    s.units.push(...enemies);
    return s;
  }
  const p0 = QUICK_PLAYER_UNITS.map((u, i) => {
    const slot = s.skirmishDeploy?.[i];
    if (!slot) return { ...u };
    return { ...u, x: slot.x, y: slot.y };
  });
  s.units = [...p0, ...enemies];
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
  const land = document.getElementById("screen-landing");
  if (land?.classList.contains("screen--active")) {
    syncV2OpsLayer(!classic);
  }
}

/** Modern Ops concierge panel over the cinematic landing (video stays visible behind). */
function syncV2OpsLayer(show) {
  const layer = document.getElementById("v2-ops-layer");
  if (!layer) return;
  layer.hidden = !show;
}

async function bootUrbanSiege() {
  await bootBattle({
    mode: "urban",
    scenarioPath: "js/config/scenarios/urban_siege.json",
  });
}

/* ── Screen routing ───────────────────────────────────── */
function showScreen(name, sectionId) {
  /* Close the codex dossier before leaving — avoids it being position:fixed over other screens */
  if (name !== "codex") closeCodexDossier();

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
    applyBattleZoom();
  }
  if (screenName === "codex")    renderCodex();
  if (screenName === "hotseat")  openHotseat();
  if (screenName === "settings") applySettingsToUi();
  if (screenName === "maps")     renderMapTheater();
  if (screenName === "vs-cpu-prep") void openVsCpuPrep();
  if (screenName === "mat-lab-prep") void openMatLabPrep();
  if (screenName === "hub") {
    renderHubRoster(); renderHubModes(); renderHubShortcuts(); updateGateBanner();
    /* Carousel lives in hidden hub until now — remeasure so ▲/▼ aren't stuck disabled */
    requestAnimationFrame(() => {
      requestAnimationFrame(updateHubCarouselNav);
    });
  }
  if (screenName === "landing") {
    collapseAllLandingDockPanels();
    const vid = document.getElementById("lp-bg-video");
    if (vid && vid.paused) vid.play().catch(() => {});
    syncV2OpsLayer(
      v2Alias || (settings?.visualStyle !== "classic")
    );
  } else {
    syncV2OpsLayer(false);
  }
  /* Always reset page scroll first so content from a previous screen doesn't linger */
  window.scrollTo(0, 0);

  /* Scroll to a specific section — double-rAF ensures layout is fully painted before measuring */
  if (sectionId) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = document.getElementById(sectionId);
        if (!target) return;
        const top = target.getBoundingClientRect().top + window.pageYOffset;
        window.scrollTo({ top, behavior: "smooth" });
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

function updateGateBanner() {
  const el = document.getElementById("hub-gate-banner");
  if (!el) return;
  el.hidden = !!progress.academyComplete;
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
        void bootProceduralSkirmish(m.procTheme || "urban");
        return;
      }
      if (m.action === "academy") openAcademy();
      else if (m.action === "skirmish") {
        if (m.scenarioPath) {
          bootBattle({ mode: "skirmish", scenarioPath: m.scenarioPath });
        } else {
          void openVsCpuPrep();
        }
      }
      else if (m.action === "trial")
        bootBattle({
          mode: "trial",
          scenarioPath: m.scenarioPath || "js/config/scenarios/trial_survive.json",
        });
      else if (m.action === "scenario")
        bootBattle({ mode: "skirmish", scenarioPath: m.scenarioPath });
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

function renderHubShortcuts() {
  const host = document.getElementById("hub-shortcuts");
  if (!host || !hubConfig?.shortcuts) return;
  host.innerHTML = "";
  for (const sc of hubConfig.shortcuts) {
    const gated = sc.requiresAcademy && !progress.academyComplete;
    const on    = !gated;
    const btn   = document.createElement("button");
    btn.type    = "button";
    btn.className = "hub-toggle-btn" + (gated ? " hub-toggle-btn--locked" : "");
    btn.disabled  = gated;
    const ic = sc.icon ? `<span class="hub-toggle-icon" aria-hidden="true">${sc.icon}</span>` : "";
    btn.innerHTML = `${ic}<span class="hub-toggle-label">${sc.label}</span>`;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      if (sc.screen === "maps") mapsReturnTarget = null;
      showScreen(sc.screen);
    });
    host.appendChild(btn);
  }
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
  if (!host || !unitRegistry.length) return;
  host.innerHTML = "";

  for (const u of unitRegistry) {
    if (u.tags?.includes("ai")) continue;
    const unlocked = isUnlocked(progress, u.id);

    /* status dot color: core=green, addonB=blue, else=amber */
    const tags = (u.tags || []).filter((t) => t !== "ai");
    const dotCls = tags.includes("coreA") ? "hub-dossier__status--green"
                 : tags.includes("addonB") ? "hub-dossier__status--blue"
                 : "hub-dossier__status--amber";

    const card = document.createElement("div");
    card.className = "hub-dossier" + (unlocked ? "" : " hub-dossier--locked");

    const portraitHtml = u.portrait
      ? `<img src="attached_assets/units/${u.portrait}" alt="" class="hub-dossier__portrait" />`
      : `<div class="hub-dossier__ph">${unitInitials(u)}</div>`;

    const tagLabel = tags.length
      ? `<span class="hub-dossier__tag-star">★</span> ${tags.filter(t => t !== "ai").map(t => t.replace("coreA","AcademyPick").replace("addonB","AddonB")).join(" ")}`
      : "";

    card.innerHTML = `
      ${portraitHtml}
      <div class="hub-dossier__meta">
        <span class="hub-dossier__name">${u.displayName}</span>
        <span class="hub-dossier__tags">${tagLabel}</span>
      </div>
      <span class="hub-dossier__status ${dotCls}"></span>`;

    card.addEventListener("click", () => { showScreen("codex"); selectCodexUnit(u.id); });
    host.appendChild(card);
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
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="muted small">${u.hp} HP · mv ${u.move} · ${u.attackType}</span></span>`;
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
  const path = pendingUserMapPath || "js/config/scenarios/academy_skirmish.json";
  try {
    const sb = await loadJson(path);
    pendingMapSkirmishSlotCount = Math.min(8, Math.max(1, sb.skirmishDeploy?.length ?? 8));
  } catch (e) {
    console.warn("[CTU] skirmish slot count", e);
    pendingMapSkirmishSlotCount = 8;
  }
}

async function openVsCpuPrep() {
  await refreshPendingMapSkirmishSlotCount();
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
    mapEl.textContent = cur
      ? `✓ ${cur.name} (${cur.width}×${cur.height})`
      : "Not chosen — open Map theater and click a map.";
  }
  const need = pendingMapSkirmishSlotCount || 8;
  const n = pendingSkirmishOrderedLoadout?.length ?? 0;
  if (squadEl) {
    squadEl.textContent =
      n >= 1 && n <= need
        ? `✓ ${n} unit(s) ready (uses first ${n} deploy slots; max ${need})`
        : `Pick 1–${need} units — ${n} selected.`;
  }
  const ready = !!pendingUserMapPath && n >= 1 && n <= need;
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
  if (mapSkirmishFlexiblePick) {
    cta.disabled = n < 1 || n > mapSkirmishPickCount;
  } else {
    cta.disabled = n !== mapSkirmishPickCount;
  }
}

/* ── Map theater → vs CPU loadout (full roster, no unlock gate) ─ */
async function openMapSkirmishLoadout(opts = {}) {
  const returnToPrep = opts.returnToPrep === true;
  const matLab = opts.matLab === true;
  mapSkirmishFlexiblePick = returnToPrep || matLab;
  mapSkirmishPrepReturnId = matLab ? "mat-lab-prep" : returnToPrep ? "vs-cpu-prep" : null;

  if (!matLab && !returnToPrep && !pendingUserMapPath) {
    const sel = document.getElementById("map-theater-selected");
    if (sel) sel.textContent = "Select a map first — click a map card below.";
    mapSkirmishPrepReturnId = null;
    mapSkirmishFlexiblePick = false;
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
    mapSkirmishFlexiblePick = false;
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
      unitRegistry = await loadJson("js/config/units.json");
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
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="muted small">${u.hp} HP · mv ${u.move} · ${u.attackType}</span></span>`;
    btn.addEventListener("click", () => toggleMapSkirmishPick(u.id, btn));
    host.appendChild(btn);
  }
  const st = document.getElementById("map-skirmish-status");
  if (st) {
    if (matLab) {
      st.textContent = `Pick 1–8 units (full roster). Click order = deploy order on the mat.`;
    } else if (returnToPrep) {
      st.textContent = mapSkirmishFlexiblePick
        ? `Pick 1–${mapSkirmishPickCount} units — you can choose the map on the setup screen if needed. Order = deploy slots.`
        : `Choose ${mapSkirmishPickCount} units — full roster unlocked for this route. Order = deploy slots.`;
    } else {
      st.textContent = `Choose exactly ${mapSkirmishPickCount} units — full roster unlocked for this route. Order = deploy slots.`;
    }
  }
  syncMapSkirmishCta();
  const ctaLab = document.getElementById("btn-map-skirmish-confirm");
  if (ctaLab) ctaLab.textContent = mapSkirmishFlexiblePick ? "Save squad" : "Start battle";
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
    if (mapSkirmishFlexiblePick) {
      st.textContent = `Selected ${mapSkirmishPickSet.size}/${mapSkirmishPickCount} — need at least 1, at most ${mapSkirmishPickCount}.`;
    } else {
      st.textContent = `Selected ${mapSkirmishPickSet.size}/${mapSkirmishPickCount}.`;
    }
  }
  syncMapSkirmishCta();
}

function confirmMapSkirmish() {
  const n = mapSkirmishPickSet.size;
  if (mapSkirmishFlexiblePick) {
    if (n < 1 || n > mapSkirmishPickCount) return;
  } else if (n !== mapSkirmishPickCount) {
    return;
  }

  const ret = mapSkirmishPrepReturnId;
  if (ret === "mat-lab-prep") {
    pendingMatLabLoadout = [...mapSkirmishPickSet];
    mapSkirmishPrepReturnId = null;
    mapSkirmishFlexiblePick = false;
    syncMatLabPrepUi();
    showScreen("mat-lab-prep");
    return;
  }
  if (ret === "vs-cpu-prep") {
    pendingSkirmishOrderedLoadout = [...mapSkirmishPickSet];
    mapSkirmishPrepReturnId = null;
    mapSkirmishFlexiblePick = false;
    void openVsCpuPrep();
    showScreen("vs-cpu-prep");
    return;
  }

  mapSkirmishFlexiblePick = false;
  mapSkirmishPrepReturnId = null;
  if (!pendingUserMapPath) return;
  void bootBattle({
    mode: "skirmish",
    loadout: [...mapSkirmishPickSet],
    scenarioPath: pendingUserMapPath,
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
    btn.innerHTML = `${ph}<span class="academy-offer__body"><span class="academy-offer__name">${u.displayName}</span><span class="muted small">${u.hp} HP · mv ${u.move}</span></span>`;
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
  const [units, tiles, sprites, scenarioBase, fx] = await Promise.all([
    loadJson("js/config/units.json"),
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/spriteAnimations.json"),
    loadJson(hotseatScenarioPath),
    loadJson("js/config/attackEffects.json"),
  ]);
  unitRegistry = units;
  tileTypes = tiles.types;
  spriteAnimations = sprites;
  attackEffects = fx;
  const scenario = mergeHotseatScenario(scenarioBase, [...hotseatP1Set], [...hotseatP2Set]);
  battlePlaneCtl = null;
  game = new GameState(scenario, units, tileTypes, {
    visualStyle: battleVisualStyle(),
  });
  battlePlaneCtl = await createBattlePlaneController(game, tileTypes);
  resizeBattleCanvas();
  syncBattleAmbientFromScenario();
  game.hotseat = true;
  game.playerNames = ["Player 1", "Player 2"];
  unitRenderer = new UnitRenderer(spriteAnimations);
  battleVfx = new BattleVfx();
  battleFx = new FxLayer();
  combatLog.length = 0;
  lastBootOptions = {
    mode: "hotseat",
    loadout: null,
    scenarioPath: hotseatScenarioPath,
    scenarioInline: null,
    matLabTheater: null,
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
      selEl.textContent = `${u.displayName}  ·  ${moveStatus}  ·  ${atkStatus}  ·  ${rangeStr}${proneStr}`;
    }
  }
  syncCoachPanel();
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
function cellFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const sx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const sy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const cs = game.grid.cellSize;
  return {
    x: Math.floor((sx - gridOffsetX) / cs),
    y: Math.floor((sy - gridOffsetY) / cs),
  };
}

function resizeBattleCanvas() {
  if (!canvas || !game?.grid) return;
  const cs = game.grid.cellSize;
  const m = 24;
  canvas.width = game.grid.width * cs + m * 2;
  canvas.height = game.grid.height * cs + m * 2;
  applyBattleZoom();
}

function syncBattleAmbientFromScenario() {
  if (!game?.grid) {
    sharedBattleAmbient.clear();
    return;
  }
  sharedBattleAmbient.setFromDefs(game.scenario?.ambientEffects ?? [], game.grid.cellSize);
}

function syncBattleZoomLabel() {
  const el = document.getElementById("battle-zoom-label");
  if (!el) return;
  const z = settings.reduceMotion ? 1 : (settings.battleZoom ?? 1.25);
  el.textContent = `${Math.round(z * 100)}%`;
}

function applyBattleZoom() {
  const sc = document.getElementById("battle-canvas-scaler");
  const zp = document.getElementById("battle-canvas-zoomport");
  if (!sc) return;
  const z = settings.reduceMotion ? 1 : (settings.battleZoom ?? 1.25);
  sc.style.transform = `scale(${z})`;
  if (zp && canvas) {
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);
    zp.style.width = `${Math.ceil(w * z)}px`;
    zp.style.height = `${Math.ceil(h * z)}px`;
  }
  syncBattleZoomLabel();
}

function nudgeBattleZoom(delta) {
  const steps = [0.85, 1, 1.15, 1.25, 1.4, 1.6, 1.85, 2];
  let i = steps.findIndex((s) => Math.abs(s - (settings.battleZoom ?? 1.25)) < 0.04);
  if (i < 0) i = 3;
  i = Math.max(0, Math.min(steps.length - 1, i + delta));
  settings.battleZoom = steps[i];
  saveSettings(settings);
  applyBattleZoom();
}

function toggleBattleFullscreen() {
  const el = document.getElementById("screen-battle");
  if (!el) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen?.().catch(() => {});
}

/** Grid cell lerp: visual draw uses lerpPos() from (x0,y0) to (x1,y1) while logic x/y stay at destination. */
function startLerp(unit, x0, y0, x1, y1) {
  const dist = Math.abs(x1 - x0) + Math.abs(y1 - y0);
  const dur = moveTweenDurationMs(dist, !!settings.reduceMotion);
  lerp = { unitId: unit.id, x0, y0, x1, y1, t0: performance.now(), dur };
}
function updateLerp() {
  if (!lerp || !game) return;
  const u = game.units.find((q) => q.id === lerp.unitId);
  if (!u) {
    lerp = null;
    return;
  }
  const t = Math.min(1, (performance.now() - lerp.t0) / Math.max(1, lerp.dur));
  if (t >= 1) {
    u.isMoving = false;
    lerp = null;
  }
}
function lerpPos(u) {
  if (!lerp || lerp.unitId !== u.id) return { x: u.x, y: u.y };
  const t = Math.min(1, (performance.now() - lerp.t0) / Math.max(1, lerp.dur));
  return lerpCellPair(lerp.x0, lerp.y0, lerp.x1, lerp.y1, t);
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

/** All cells within the selected unit's weapon range (orange ring, no enemy check). */
function attackRangeCells(sel) {
  const keys = new Set();
  if (!game || !sel) return keys;
  const lo = sel.rangeMin ?? 1;
  const hi = sel.rangeMax ?? 1;
  const { width, height } = game.grid;
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const d = Math.max(Math.abs(tx - sel.x), Math.abs(ty - sel.y));
      if (d >= lo && d <= hi) keys.add(tx + "," + ty);
    }
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
function doAttack(attacker, target) {
  const result = game.attack(attacker, target);
  if (!result) return false;
  const { dmg, counterDmg, structureCollapsed } = result;
  attacker._fireVisualUntil = performance.now() + 420;
  attacker._attackTargetPos = { x: target.x, y: target.y };
  if (attacker.mapRenderMode === "topdown") {
    attacker.faceRad = Math.atan2(target.y - attacker.y, target.x - attacker.x);
  }
  const targetDied    = target.hp <= 0;
  const attackerDied  = attacker.hp <= 0;
  pushLog(`⚔ ${attacker.displayName} → ${target.displayName}: -${dmg} HP${targetDied ? " 💀" : ""}`, "battle-log__item--atk");
  if (counterDmg > 0) {
    pushLog(`↩ ${target.displayName} counter: -${counterDmg} HP${attackerDied ? " 💀" : ""}`, "battle-log__item--move");
  }

  /* kill tracking */
  if (targetDied)   { if (target.owner   === 0) battleStats.p1Kills++; else battleStats.p0Kills++; }
  if (attackerDied) { if (attacker.owner === 0) battleStats.p1Kills++; else battleStats.p0Kills++; }

  /* death animations + world FX */
  const csFx = game.scenario?.cellSize ?? 48;
  const { ox: oxf, oy: oyf } = gridPixelOrigin();
  const spawnWorldFx = (gx, gy) => {
    if (!battleFx) return;
    battleFx.explosionAndSmoke(oxf + gx * csFx + csFx / 2, oyf + gy * csFx + csFx / 2, csFx);
  };
  if (structureCollapsed) spawnWorldFx(structureCollapsed.x, structureCollapsed.y);
  if (targetDied) {
    spawnDying(target);
    spawnWorldFx(target.x, target.y);
  }
  if (attackerDied) {
    spawnDying(attacker);
    spawnWorldFx(attacker.x, attacker.y);
  }

  /* floating damage numbers */
  const cellSz = game.scenario?.cellSize ?? 48;
  const tpx = gridOffsetX + target.x * cellSz + cellSz / 2;
  const tpy = gridOffsetY + target.y * cellSz + cellSz * 0.3;
  spawnFloater(`-${dmg}`, tpx, tpy, "#ff6060");
  if (counterDmg > 0) {
    const apx = gridOffsetX + attacker.x * cellSz + cellSz / 2;
    const apy = gridOffsetY + attacker.y * cellSz + cellSz * 0.3;
    spawnFloater(`↩-${counterDmg}`, apx, apy, "#ffcc44");
  }

  /* canvas VFX flash (always visible even without image assets) */
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
  return true;
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
    game.select(clicked.id);
    AudioManager.play("UnitSelected");
    syncHud();
    return;
  }
  if (sel && sel.owner === currentOwner && sel.hp > 0) {
    if (clicked && clicked.owner !== currentOwner && canAttackNow(sel, clicked)) {
      if (doAttack(sel, clicked)) {
        battleHints.attackedOnce = true;
        game.checkWinner();
      }
      syncHud();
      return;
    }
    const reach = game.reachableFor(sel);
    const k = x + "," + y;
    if (reach.has(k)) {
      const ox = sel.x; const oy2 = sel.y;
      if (game.moveUnit(sel, x, y)) {
        startLerp(sel, ox, oy2, sel.x, sel.y);
        battleHints.movedOnce = true;
        pushLog(`🚶 ${sel.displayName} moved`, "battle-log__item--move");
        AudioManager.play("MoveStart");
      }
      syncHud();
    }
  }
}

/* ── Hover tooltip ────────────────────────────────────── */
function onCanvasMouseMove(ev) {
  if (!game) return;
  const { x, y } = cellFromEvent(ev);
  const tooltip = document.getElementById("unit-tooltip");
  if (!tooltip) return;
  const u = (x >= 0 && y >= 0 && x < game.grid.width && y < game.grid.height) ? game.unitAt(x, y) : null;
  if (!u) { tooltip.hidden = true; return; }
  tooltip.hidden = false;
  const wrap = canvas.closest(".battle-canvas-arena");
  const rect = wrap ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect();
  const tx = Math.min(ev.clientX - rect.left + 14, Math.max(120, rect.width - 180));
  const ty = Math.max(ev.clientY - rect.top - 14, 0);
  tooltip.style.left = tx + "px";
  tooltip.style.top = ty + "px";
  const hpColor = u.hp / u.maxHp > 0.6 ? "tip-hp" : u.hp / u.maxHp > 0.3 ? "" : "tip-dmg";
  const terrainType = (game.grid && u.x >= 0 && u.y >= 0) ? game.grid.cells[u.y]?.[u.x] : "plains";
  const tileInfo = tileTypes?.[terrainType];
  const defBonus = tileInfo?.defenseBonus ? `· ${Math.round(tileInfo.defenseBonus * 100)}% def` : "";

  /* damage preview when hovering an attackable enemy */
  const sel = game.getSelected();
  let previewHtml = "";
  if (sel && sel.owner === game.currentPlayer && u.owner !== game.currentPlayer) {
    const preview = previewDamage(sel, u);
    if (preview) {
      const counterStr = preview.counterDmg > 0 ? ` · ↩ -${preview.counterDmg}` : "";
      previewHtml = `<br><span class="tip-preview">⚔ forecast: -${preview.dmg} HP${counterStr}</span>`;
    }
  }

  tooltip.innerHTML = `<strong>${u.displayName}</strong><span class="${hpColor}">HP ${u.hp}/${u.maxHp}</span><br><span class="tip-dmg">DMG ${u.damage}</span>  ARM ${u.armor}<br>Range ${u.rangeMin}–${u.rangeMax}${u.deadspace ? ` · DS ${u.deadspace}` : ""}  Sight ${u.sightRange ?? "∞"}<br><span class="tip-type">${u.attackType}</span> · mv ${u.move} · <em>${terrainType}${defBonus}</em>${previewHtml}`;
}

/**
 * Estimate damage without actually applying it.
 * Mirrors the logic in resolveAttack / resolveCounter.
 */
function previewDamage(attacker, target) {
  const losCtx = game.losCtx();
  if (!canAttack(attacker, target, game.units, losCtx)) return null;
  /* attacker → target */
  let dmg = attacker.damage ?? 20;
  const arm = target.armor ?? 0;
  dmg = Math.max(1, Math.round(dmg - arm * 0.25));
  const tTerrain = game.grid.cells[target.y]?.[target.x] ?? "plains";
  const tDef = tileTypes?.[tTerrain]?.defenseBonus ?? 0;
  if (tDef > 0) dmg = Math.max(1, Math.round(dmg * (1 - tDef)));
  /* counter */
  let counterDmg = 0;
  if (target.canCounter !== false && !target.attackedThisTurn && target.hp > 0
      && (target.attackType ?? "direct") === "direct"
      && canAttack(target, attacker, game.units, losCtx)) {
    counterDmg = Math.round((target.damage ?? 20) * 0.6);
    const arm2 = attacker.armor ?? 0;
    counterDmg = Math.max(1, Math.round(counterDmg - arm2 * 0.25));
    const aTerrain = game.grid.cells[attacker.y]?.[attacker.x] ?? "plains";
    const aDef = tileTypes?.[aTerrain]?.defenseBonus ?? 0;
    if (aDef > 0) counterDmg = Math.max(1, Math.round(counterDmg * (1 - aDef)));
  }
  return { dmg, counterDmg };
}

/* ── Draw ─────────────────────────────────────────────── */
function facingRadForDraw(u, moving) {
  if (u.mapRenderMode !== "topdown" || u.hp <= 0) return u.faceRad;
  if (moving) return u.faceRad;
  if (u._attackTargetPos && u._fireVisualUntil && performance.now() < u._fireVisualUntil) {
    return Math.atan2(u._attackTargetPos.y - u.y, u._attackTargetPos.x - u.x);
  }
  const pos = lerpPos(u);
  let best = null; let bestD = Infinity;
  for (const o of game.units) {
    if (o.owner === u.owner || o.hp <= 0) continue;
    const d = manhattan(pos.x, pos.y, o.x, o.y);
    if (d < bestD) { bestD = d; best = o; }
  }
  if (!best) return u.faceRad;
  return Math.atan2(best.y - pos.y, best.x - pos.x);
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
  const atkCells = attackableCellKeys(sel);
  /* Orange range ring: only show when the unit still has attacks available */
  const atkRange = (sel && sel.owner === currentOwner && !sel.attackedThisTurn)
    ? attackRangeCells(sel) : new Set();
  const fogCells = computeVisibleCells();

  drawGrid(ctx, game, tileTypes, {
    offsetX: gridOffsetX, offsetY: gridOffsetY,
    stackMode: battlePlaneCtl ? "plane" : "legacy",
    reachable: reach,
    selected: sel && sel.owner === currentOwner ? sel : null,
    attackRange: atkRange,
    attackableCells: atkCells,
    highlightCells: coachHighlightKeys(),
    fogCells,
    timeMs: ts,
  });

  sharedBattleAmbient.draw(ctx, gridOffsetX, gridOffsetY, ts);

  if (battlePlaneCtl) {
    battlePlaneCtl.drawProps(ctx, gridOffsetX, gridOffsetY);
  } else if (game.mapObjects?.length) {
    drawMapObjects(ctx, game, gridOffsetX, gridOffsetY);
  }

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
    let facingLeft = false;
    if (moving && lerp.x1 < lerp.x0) {
      facingLeft = true;
    } else if (!moving) {
      if (u._attackTargetPos && u._fireVisualUntil && performance.now() < u._fireVisualUntil) {
        facingLeft = u._attackTargetPos.x < u.x;
      } else {
        let nearest = null; let nearD = Infinity;
        for (const o of game.units) {
          if (o.owner === u.owner || o.hp <= 0) continue;
          const d = Math.abs(o.x - u.x) + Math.abs(o.y - u.y);
          if (d < nearD) { nearD = d; nearest = o; }
        }
        if (nearest) facingLeft = nearest.x < u.x;
      }
    }

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

    unitRenderer.drawUnit(ctx, u, px, py, cs, ts, moving, facingLeft, facingRadForDraw(u, moving));

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

function aiTurn() {
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
        if (doAttack(u, t)) game.checkWinner();
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
        if (game.moveUnit(u, tx, ty)) startLerp(u, ox, oy, u.x, u.y);
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
        if (game.moveUnit(u, tx, ty)) startLerp(u, ox, oy, u.x, u.y);
      }
    }

    /* ── 3. Attack again after moving if not yet attacked ─ */
    /* Easy AI doesn't attack-after-move; Hard always tries */
    if (!u.attackedThisTurn && diff !== "easy") {
      const shootable2 = hum.filter((h) => canAttack(u, h, game.units, losCtx));
      if (shootable2.length) {
        const t = shootable2.sort((a, b) => aiScoreTarget(u, b) - aiScoreTarget(u, a))[0];
        if (doAttack(u, t)) game.checkWinner();
        if (game.winner != null) break;
      }
    }
  }
  if (game.winner == null) game.endTurn();
  syncHud();
}

/* ── Procedural mapgen boot ───────────────────────────── */
async function bootProceduralSkirmish(theme = "urban") {
  const [tiles, assetManifest] = await Promise.all([
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/assetManifest.json").catch(() => null),
  ]);
  const scenario = generateProceduralScenario({
    theme,
    width: 16,
    height: 12,
    seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
    tileTypes: tiles.types,
    assetManifest: assetManifest && typeof assetManifest === "object" ? assetManifest : null,
  });
  if (!scenario) {
    console.warn("[CTU] Procedural generation failed; using default skirmish.");
    void bootBattle({ mode: "skirmish" });
    return;
  }
  lastProceduralScenario = scenario;
  void bootBattle({ mode: "skirmish", scenarioInline: scenario });
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
  };
  await bootBattle({ mode: "skirmish", scenarioInline: scenario });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const u = game?.units.find((q) => q.owner === 0 && q.hp > 0);
      if (!u || !game) return;
      game.select(u.id);
      const ox = u.x;
      const oy = u.y;
      const tx = ox + 3;
      if (tx < game.grid.width && game.moveUnit(u, tx, oy)) {
        startLerp(u, ox, oy, u.x, u.y);
        pushLog("Debug: animation test (3 cells east)", "battle-log__item--move");
      }
    });
  });
}

async function bootBattle(options = {}) {
  const mode = options.mode ?? "skirmish";
  const loadout = options.loadout ?? null;
  const useInline = options.scenarioInline && typeof options.scenarioInline === "object";
  let scenarioPath = options.scenarioPath;
  if (!useInline && !scenarioPath) {
    scenarioPath =
      mode === "skirmish"
        ? pendingUserMapPath || "js/config/scenarios/academy_skirmish.json"
        : "js/config/scenarios/academy_skirmish.json";
  }
  lastBootOptions = {
    mode,
    loadout,
    scenarioPath: useInline ? null : scenarioPath,
    matLabTheater: options.matLabTheater ?? null,
    scenarioInline: useInline ? JSON.parse(JSON.stringify(options.scenarioInline)) : null,
  };
  battleEndHandled = false;
  aiRunning = false;
  battleHints = { movedOnce: false, attackedOnce: false };
  battleStats = { p0Kills: 0, p1Kills: 0, rounds: 0 };
  floaters.length = 0;
  dyingUnits.length = 0;
  vfxFlashes.length = 0;
  combatLog.length = 0;
  const list = document.getElementById("battle-log-list");
  if (list) list.innerHTML = "";

  /* show loading overlay while assets fetch */
  const loadingEl = document.getElementById("battle-loading");
  if (loadingEl) loadingEl.hidden = false;

  const scenarioPromise = useInline
    ? Promise.resolve(JSON.parse(JSON.stringify(options.scenarioInline)))
    : loadJson(scenarioPath);
  const [units, tiles, sprites, scenarioBase, fx] = await Promise.all([
    loadJson("js/config/units.json"),
    loadJson("js/config/tileTextures.json"),
    loadJson("js/config/spriteAnimations.json"),
    scenarioPromise,
    loadJson("js/config/attackEffects.json"),
  ]);
  unitRegistry = units;
  tileTypes = tiles.types;
  spriteAnimations = sprites;
  attackEffects = fx;
  const scenario = mergeScenarioForBattle(scenarioBase, mode, loadout, academyConfig);
  if (options.matLabTheater && scenario.battlePlaneLayer?.enabled) {
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
        medic: true, artillery: true, commander_unit: true,
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
  renderHubShortcuts();
  updateGateBanner();
  showResultOverlay();
}

/* ── Codex ────────────────────────────────────────────── */
let activeCodexId = null;

function renderCodex() {
  const list = document.getElementById("codex-list");
  if (!list || !unitRegistry.length) return;
  list.innerHTML = "";

  unitRegistry.forEach((u, idx) => {
    const locked  = !isUnlocked(progress, u.id);
    const isActive = u.id === activeCodexId;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.unitId = u.id;
    btn.className = "unit-tile"
      + (locked   ? " unit-tile--locked" : "")
      + (isActive ? " unit-tile--active" : "");

    /* portrait: real PNG or initials fallback */
    const portraitHtml = u.portrait
      ? `<div class="unit-tile__img-wrap"><img src="attached_assets/units/${u.portrait}" alt="" class="unit-tile__img" /></div>`
      : `<div class="unit-tile__ph">${unitInitials(u)}</div>`;

    /* scan-line on unlocked tiles, staggered by position */
    const scanDelay = ((idx % 6) * 0.65).toFixed(2);
    const scanLine  = locked ? "" : `<div class="scan-line" style="animation-delay:${scanDelay}s" aria-hidden="true"></div>`;

    btn.innerHTML = `
      ${scanLine}
      ${portraitHtml}
      <span class="unit-tile__name">${u.displayName}</span>
      ${locked ? '<span class="unit-tile__lock" aria-hidden="true">🔒</span>' : ""}`;

    if (!locked) btn.addEventListener("click", () => selectCodexUnit(u.id));
    list.appendChild(btn);
  });

  if (activeCodexId) selectCodexUnit(activeCodexId);
}

function closeCodexDossier() {
  const panel = document.getElementById("codex-detail");
  if (panel) { panel.classList.remove("codex-detail--open"); panel.setAttribute("aria-hidden", "true"); }
  activeCodexId = null;
  document.querySelectorAll(".unit-tile").forEach((el) => el.classList.remove("unit-tile--active"));
}

function selectCodexUnit(id) {
  activeCodexId = id;
  /* update active state using data-unit-id — reliable, no text matching */
  document.querySelectorAll(".unit-tile").forEach((el) => {
    el.classList.toggle("unit-tile--active", el.dataset.unitId === id);
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

  /* Slide the dossier overlay into view */
  const panel = document.getElementById("codex-detail");
  if (panel) {
    panel.classList.add("codex-detail--open");
    panel.setAttribute("aria-hidden", "false");
    /* Re-apply drag scroll each time (content was rebuilt) */
    addDragScroll(detail);
    addDragScroll(document.querySelector(".codex-detail-frame__body"));
  }
}

/* ── Settings ─────────────────────────────────────────── */
function applySettingsToUi() {
  const audioEl  = document.getElementById("setting-audio");
  const motionEl = document.getElementById("setting-reduce-motion");
  const fogEl    = document.getElementById("setting-fog");
  const diffEl   = document.getElementById("setting-difficulty");
  const hdefEl   = document.getElementById("setting-visual-hdef");
  if (audioEl)  audioEl.checked  = settings.audioEnabled;
  if (motionEl) motionEl.checked = settings.reduceMotion;
  if (fogEl)    fogEl.checked    = settings.fogOfWar !== false;
  if (diffEl)   diffEl.value     = settings.difficulty ?? "normal";
  if (hdefEl)   hdefEl.checked   = settings.visualStyle !== "classic";
}

let mapTheaterFilterSize = "all";
let mapTheaterFilterEnv = "all";

function renderMapTheater() {
  const fs = document.getElementById("map-filter-size");
  if (fs) fs.value = mapTheaterFilterSize;
  const fe = document.getElementById("map-filter-env");
  if (fe) fe.value = mapTheaterFilterEnv;
  const host = document.getElementById("map-theater-grid");
  if (!host) return;
  host.innerHTML = "";
  const maps = mapCatalog.maps || [];
  for (const m of maps) {
    if (mapTheaterFilterSize !== "all" && m.sizeCategory !== mapTheaterFilterSize) continue;
    if (mapTheaterFilterEnv !== "all" && m.environment !== mapTheaterFilterEnv) continue;
    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "map-theater-card" +
      (pendingUserMapPath === m.path ? " map-theater-card--selected" : "");
    card.dataset.mapPath = m.path;
    card.innerHTML =
      `<span class="map-theater-card__name">${m.name}</span>` +
      `<span class="map-theater-card__meta">${m.width}×${m.height} · ${m.sizeCategory} · ${m.environment}</span>` +
      (m.blurb ? `<span class="map-theater-card__blurb">${m.blurb}</span>` : "");
    card.addEventListener("click", () => {
      void (async () => {
        const prevPath = pendingUserMapPath;
        pendingUserMapPath = m.path;
        let sb;
        try {
          sb = await loadJson(m.path);
        } catch (e) {
          console.warn("[CTU] map theater: load failed", e);
          pendingUserMapPath = prevPath;
          const sel = document.getElementById("map-theater-selected");
          if (sel) sel.textContent = "Could not load that map. Pick another.";
          renderMapTheater();
          return;
        }
        const newSlots = Math.min(8, Math.max(1, sb.skirmishDeploy?.length ?? 8));
        pendingMapSkirmishSlotCount = newSlots;
        if (
          pendingSkirmishOrderedLoadout &&
          pendingSkirmishOrderedLoadout.length !== newSlots
        ) {
          pendingSkirmishOrderedLoadout = null;
        }
        renderMapTheater();
        if (mapsReturnTarget === "vs-cpu-prep") {
          mapsReturnTarget = null;
          void openVsCpuPrep();
          showScreen("vs-cpu-prep");
        } else if (mapsReturnTarget === "mat-lab-prep") {
          mapsReturnTarget = null;
          void openMatLabPrep();
          showScreen("mat-lab-prep");
        }
      })();
    });
    host.appendChild(card);
  }
  const sel = document.getElementById("map-theater-selected");
  if (sel) {
    const cur = maps.find((x) => x.path === pendingUserMapPath);
    sel.textContent = cur
      ? `Selected: ${cur.name} (${cur.width}×${cur.height})`
      : "Select a map below (optional — defaults apply if none).";
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
  unitRegistry = await loadJson("js/config/units.json");
  progress  = loadProgress();
  settings  = loadSettings();
  settings.visualStyle = settings.visualStyle === "classic" ? "classic" : "hDef";
  window.__CTU_AUDIO_DISABLED = !settings.audioEnabled;
  applySettingsToUi();
  applyVisualTheme();
  applyBattleZoom();

  /* Firebase is optional — never blocks the app */
  await initFirebase();
  try {
    await wireCloudProgress(
      () => progress,
      (p) => { progress = p; saveProgress(p, { skipCloud: true }); renderHubRoster(); renderHubShortcuts(); }
    );
  } catch (e) {
    console.warn("[CTU] Cloud sync unavailable", e);
  }

  renderHubRoster();
  renderHubModes();
  renderHubShortcuts();
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
      const urbanBtn = t.closest("#btn-v2-urban");
      if (urbanBtn) {
        ev.preventDefault();
        void bootUrbanSiege();
        return;
      }
      const procV2 = t.closest("#btn-v2-procedural");
      if (procV2) {
        ev.preventDefault();
        void bootProceduralSkirmish(procV2.getAttribute("data-theme") || "urban");
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
  document.getElementById("btn-end-turn")?.addEventListener("click", () => {
    if (!game || game.winner != null || aiRunning) return;
    AudioManager.play("TurnEnd");
    game.endTurn();
    syncHud();
    if (game.winner != null) return;
    if (game.hotseat) { showInterstitial(game.currentPlayer); return; }
    aiRunning = true;
    setTimeout(() => { aiTurn(); aiRunning = false; }, 400);
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
    renderMapTheater();
  });
  document.getElementById("map-filter-env")?.addEventListener("change", (ev) => {
    mapTheaterFilterEnv = ev.target.value || "all";
    renderMapTheater();
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
    mapsReturnTarget = "vs-cpu-prep";
    showScreen("maps");
  });
  document.getElementById("btn-vs-cpu-prep-squad")?.addEventListener("click", () => {
    void openMapSkirmishLoadout({ returnToPrep: true });
  });
  document.getElementById("btn-vs-cpu-prep-start")?.addEventListener("click", () => {
    const need = pendingMapSkirmishSlotCount || 8;
    const n = pendingSkirmishOrderedLoadout?.length ?? 0;
    if (!pendingUserMapPath || n < 1 || n > need) return;
    void bootBattle({
      mode: "skirmish",
      loadout: [...pendingSkirmishOrderedLoadout],
      scenarioPath: pendingUserMapPath,
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
    });
  });
  document.getElementById("btn-proc-urban")?.addEventListener("click", () => {
    void bootProceduralSkirmish("urban");
  });
  document.getElementById("btn-proc-desert")?.addEventListener("click", () => {
    void bootProceduralSkirmish("desert");
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
    mapSkirmishFlexiblePick = false;
    if (ret === "mat-lab-prep") {
      showScreen("mat-lab-prep");
      syncMatLabPrepUi();
    } else if (ret === "vs-cpu-prep") {
      showScreen("vs-cpu-prep");
      syncVsCpuPrepUi();
    } else {
      showScreen("maps");
      renderMapTheater();
    }
  });
  document.getElementById("btn-map-theater-hotseat")?.addEventListener("click", () =>
    showScreen("hotseat")
  );

  document.getElementById("btn-battle-zoom-out")?.addEventListener("click", () => nudgeBattleZoom(-1));
  document.getElementById("btn-battle-zoom-in")?.addEventListener("click", () => nudgeBattleZoom(1));
  document.getElementById("btn-battle-fullscreen")?.addEventListener("click", () => toggleBattleFullscreen());
  document.getElementById("btn-battle-end-float")?.addEventListener("click", () => {
    document.getElementById("btn-end-turn")?.click();
  });

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
    applyBattleZoom();
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
  document.getElementById("btn-settings-back")?.addEventListener("click", () => {
    showScreen(settings.visualStyle === "classic" ? "hub" : "v2-landing");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "p" && ev.key !== "P") return;
    if (!game || game.winner != null) return;
    const battleEl = document.getElementById("screen-battle");
    if (!battleEl?.classList.contains("screen--active")) return;
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
    renderHubRoster(); renderHubModes(); renderHubShortcuts(); updateGateBanner();
    showScreen("hub");
  });

  /* canvas */
  canvas = document.getElementById("battle-canvas");
  ctx = canvas.getContext("2d");
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("mousemove", onCanvasMouseMove);
  canvas.addEventListener("mouseleave", () => { const t = document.getElementById("unit-tooltip"); if (t) t.hidden = true; });
  /* touch controls — map touch to the same click/move handlers */
  canvas.addEventListener("touchstart", (ev) => {
    ev.preventDefault();
    const touch = ev.changedTouches[0];
    onCanvasClick({ clientX: touch.clientX, clientY: touch.clientY, currentTarget: canvas });
  }, { passive: false });
  canvas.addEventListener("touchmove", (ev) => {
    ev.preventDefault();
    const touch = ev.changedTouches[0];
    onCanvasMouseMove({ clientX: touch.clientX, clientY: touch.clientY, currentTarget: canvas });
  }, { passive: false });
}

/* ── Drag-to-scroll gesture helper ──────────────────────
   Adds mouse-drag + touch-drag scrolling to any overflow
   container. Uses a movement threshold so child button
   clicks still fire on a short tap/click.
   ────────────────────────────────────────────────────── */
const DRAG_THRESHOLD = 6; /* px — below this is a tap, above is a drag */

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

function addDragScroll(el) {
  if (!el || el._dragWired) return;
  el._dragWired = true;

  let active = false, dragging = false;
  let startY = 0, startX = 0, top0 = 0, left0 = 0;

  const begin = (y, x) => {
    active   = true;
    dragging = false;
    startY = y; startX = x;
    top0   = el.scrollTop;
    left0  = el.scrollLeft;
  };

  const move = (y, x) => {
    if (!active) return;
    const dy = startY - y;
    const dx = startX - x;
    if (!dragging && Math.abs(dy) + Math.abs(dx) < DRAG_THRESHOLD) return;
    dragging = true;
    el.classList.add("drag-scroll--active");
    el.scrollTop  = top0  + dy;
    el.scrollLeft = left0 + dx;
  };

  const end = () => {
    active = false;
    el.classList.remove("drag-scroll--active");
  };

  /* Mouse */
  el.addEventListener("mousedown",  e => begin(e.clientY, e.clientX));
  el.addEventListener("mousemove",  e => move(e.clientY, e.clientX));
  el.addEventListener("mouseup",    end);
  el.addEventListener("mouseleave", end);

  /* Block click on children if the pointer actually dragged */
  el.addEventListener("click", e => {
    if (dragging) { e.stopPropagation(); e.preventDefault(); dragging = false; }
  }, true /* capture — fires before child handlers */);

  /* Touch */
  el.addEventListener("touchstart", e => {
    begin(e.touches[0].clientY, e.touches[0].clientX);
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    move(e.touches[0].clientY, e.touches[0].clientX);
    if (dragging) e.preventDefault(); /* suppress page scroll only when dragging this element */
  }, { passive: false });
  el.addEventListener("touchend",    end);
  el.addEventListener("touchcancel", end);
}

function wireGestures() {
  /* Static containers — always in DOM */
  addDragScroll(document.getElementById("codex-list"));
  addDragScroll(document.getElementById("codex-detail"));
  addDragScroll(document.getElementById("codex-detail-inner"));
  addDragScroll(document.querySelector(".codex-detail-frame__body"));
  addDragScroll(document.querySelector(".battle-log__list"));
  addDragScroll(document.querySelector("#screen-codex .ctu-metal-frame__content"));
  /* NOTE: hub-modes carousel uses prev/next buttons instead of drag
     so that scroll-snap engagement is not disrupted */

  /* ── Solo-modes carousel nav buttons ── */
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
    syncV2OpsLayer(false);
  });
