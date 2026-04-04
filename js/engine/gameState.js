import { buildTerrainGrid, moveCostAt } from "./terrain.js";
import { reachableTiles, findPath } from "./astar.js";
import { canAttack, resolveAttack, resolveCounter } from "./combat.js";
import { inBounds } from "./grid.js";

function uid() {
  return "u" + Math.random().toString(36).slice(2, 10);
}

export function createUnitFromTemplate(tpl, owner, x, y, visualStyle = "classic") {
  const mapSpriteSet =
    visualStyle === "hDef" && tpl.mapSpriteSetHDef
      ? tpl.mapSpriteSetHDef
      : tpl.mapSpriteSet || null;
  return {
    id: uid(),
    templateId: tpl.id,
    displayName: tpl.displayName,
    owner,
    x,
    y,
    hp: tpl.hp,
    maxHp: tpl.hp,
    move: tpl.move,
    attackType: tpl.attackType,
    rangeMin: tpl.rangeMin,
    rangeMax: tpl.rangeMax,
    damage: tpl.damage,
    armor: tpl.armor,
    mapSpriteSet,
    mapRenderMode: tpl.mapRenderMode || "side",
    portrait: tpl.portrait || null,
    attackEffectProfile: tpl.attackEffectProfile || null,
    deadspace: tpl.deadspace ?? 0,
    sightRange: tpl.sightRange ?? null,
    canCounter: tpl.canCounter !== false,
    faceRad: Math.PI / 2,
    movedThisTurn: false,
    attackedThisTurn: false,
    prone: false,
  };
}

export class GameState {
  constructor(scenario, unitTemplates, tileTypes, opts = {}) {
    this.scenario = scenario;
    this.tileTypes = tileTypes;
    this.visualStyle = opts.visualStyle ?? "classic";
    this.grid = buildTerrainGrid(scenario, { defaultType: "plains" });
    this.templates = Object.fromEntries(unitTemplates.map((u) => [u.id, u]));
    this.units = [];
    for (const p of scenario.units || []) {
      const tpl = this.templates[p.templateId];
      if (!tpl) continue;
      this.units.push(
        createUnitFromTemplate(tpl, p.owner, p.x, p.y, this.visualStyle)
      );
    }
    /** @type {Map<string, { hp: number, brokenTerrain: string, destroyed: boolean }>} */
    this.destructibles = new Map();
    for (const d of scenario.destructibles || []) {
      const k = `${d.x},${d.y}`;
      this.destructibles.set(k, {
        hp: d.hp ?? 60,
        brokenTerrain: d.brokenTerrain || "cp_rubble",
        destroyed: false,
      });
    }
    this.currentPlayer = 0;
    this.selectedId = null;
    this.winner = null;
    /** Full rounds completed (each time play returns to player 0 after opfor). */
    this.fullRoundsCompleted = 0;
    this.costAt = (x, y) => moveCostAt(this.grid, this.tileTypes, x, y);
    this.losCtx = () => ({
      grid: this.grid,
      tileTypes: this.tileTypes,
      sightBudget:
        this.scenario?.losSightBudget != null &&
        Number.isFinite(this.scenario.losSightBudget)
          ? this.scenario.losSightBudget
          : Infinity,
    });
  }

  unitAt(x, y) {
    return this.units.find((u) => u.hp > 0 && u.x === x && u.y === y) || null;
  }

  select(unitId) {
    this.selectedId = unitId;
  }

  clearSelection() {
    this.selectedId = null;
  }

  getSelected() {
    return this.units.find((u) => u.id === this.selectedId) || null;
  }

  reachableFor(unit) {
    if (!unit || unit.movedThisTurn) return new Map();
    const occ = new Set(
      this.units.filter((u) => u.hp > 0 && u.id !== unit.id).map((u) => u.x + "," + u.y)
    );
    const vis = reachableTiles(this.grid, unit.x, unit.y, unit.move, (x, y) => {
      if (occ.has(x + "," + y)) return 99;
      return this.costAt(x, y);
    });
    const out = new Map();
    for (const [k, cost] of vis) {
      if (k === unit.x + "," + unit.y) continue;
      if (occ.has(k)) continue;
      out.set(k, cost);
    }
    return out;
  }

  moveUnit(unit, tx, ty) {
    if (!unit || unit.owner !== this.currentPlayer || unit.movedThisTurn) return false;
    const path = findPath(this.grid, [unit.x, unit.y], [tx, ty], (x, y) => {
      const o = this.unitAt(x, y);
      if (o && o.id !== unit.id) return 99;
      return this.costAt(x, y);
    });
    if (!path) return false;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const [px, py] = path[i - 1];
      const [nx, ny] = path[i];
      total += this.costAt(nx, ny);
    }
    if (total > unit.move + 1e-6) return false;
    const sx = unit.x;
    const sy = unit.y;
    unit.x = tx;
    unit.y = ty;
    if (unit.mapRenderMode === "topdown" && (tx !== sx || ty !== sy)) {
      unit.faceRad = Math.atan2(ty - sy, tx - sx);
    }
    unit.movedThisTurn = true;
    return true;
  }

  /**
   * Returns { dmg, counterDmg } — both are the actual HP removed, 0 if no hit.
   */
  attack(attacker, target) {
    if (!attacker || !target || attacker.owner !== this.currentPlayer) return false;
    if (attacker.attackedThisTurn) return false;
    const ctx = this.losCtx();
    if (!canAttack(attacker, target, this.units, ctx)) return false;
    const dmg = resolveAttack(attacker, target, ctx);
    const structureHit = this.applyCombatStressToStructure(target.x, target.y, dmg);
    attacker.attackedThisTurn = true;
    /* Counter-attack: defender fires back immediately if still alive */
    const counterDmg = resolveCounter(attacker, target, ctx);
    const counterStruct =
      counterDmg > 0 && attacker.hp > 0
        ? this.applyCombatStressToStructure(attacker.x, attacker.y, counterDmg)
        : null;
    let structureCollapsed = null;
    if (structureHit?.collapsed) structureCollapsed = { x: structureHit.x, y: structureHit.y };
    else if (counterStruct?.collapsed)
      structureCollapsed = { x: counterStruct.x, y: counterStruct.y };
    return { dmg, counterDmg, structureCollapsed };
  }

  endTurn() {
    for (const u of this.units) {
      u.movedThisTurn = false;
      u.attackedThisTurn = false;
    }
    const was = this.currentPlayer;
    this.currentPlayer = this.currentPlayer === 0 ? 1 : 0;
    if (was === 1 && this.currentPlayer === 0) this.fullRoundsCompleted++;
    this.clearSelection();
    this.checkWinner();
  }

  /**
   * Combat stress on cover: hits on a unit standing on a marked building tile damage the structure.
   * @returns {{ collapsed: boolean, x: number, y: number } | null}
   */
  applyCombatStressToStructure(x, y, dmg) {
    const k = `${x},${y}`;
    const s = this.destructibles.get(k);
    if (!s || s.destroyed) return null;
    const terr = this.grid.cells[y]?.[x];
    if (terr !== "cp_building") return null;
    const chunk = Math.max(1, Math.floor(dmg * 0.45));
    s.hp -= chunk;
    if (s.hp <= 0) {
      s.destroyed = true;
      this.grid.cells[y][x] = s.brokenTerrain;
      return { collapsed: true, x, y };
    }
    return { collapsed: false, x, y };
  }

  checkWinner() {
    const alive = [0, 1].map((o) => this.units.some((u) => u.owner === o && u.hp > 0));
    if (!alive[0]) {
      this.winner = 1;
      return;
    }
    if (!alive[1]) {
      this.winner = 0;
      return;
    }
    const wc = this.scenario?.winCondition;
    if (!wc || wc.type === "eliminate") return;
    if (wc.type === "survive" && alive[0]) {
      const need = wc.rounds ?? 1;
      if (this.fullRoundsCompleted >= need) this.winner = 0;
    }
  }

  enemiesInAttackRange(unit) {
    if (!unit || unit.hp <= 0) return [];
    const ctx = this.losCtx();
    return this.units.filter(
      (t) => t.owner !== unit.owner && t.hp > 0 && canAttack(unit, t, this.units, ctx)
    );
  }
}
