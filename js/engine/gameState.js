import { buildTerrainGrid, moveCostAt, moveCostAtForClass } from "./terrain.js";
import {
  hardMapObjectBlocksAllUnits,
  mapObjectTreeAt,
} from "../battle-plane/mapObjects.js";
import { BLOCKED_MOVE_COST } from "../battle-plane/pathfindingCost.js";
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
    specialAbility: tpl.specialAbility || "None",
    usesLos: tpl.usesLos !== false,
    canCounter: tpl.specialAbility === "Counter-Attack",
    faceRad: Math.PI / 2,
    movedThisTurn: false,
    attackedThisTurn: false,
    prone: false,
    isMoving: false,
    movementClass:
      tpl.movementClass ??
      (tpl.mapRenderMode === "topdown" ? "vehicle" : "infantry"),
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
    /** Scatter props / procedural map objects; optional scenario.mapObjects[] */
    this.mapObjects = [];
    if (Array.isArray(scenario.mapObjects)) {
      for (const o of scenario.mapObjects) {
        const mo = {
          id: o.id || `obj_${o.x}_${o.y}_${Math.random().toString(36).slice(2, 7)}`,
          x: o.x,
          y: o.y,
          sprite: o.sprite ?? null,
          visualKind: o.visualKind || "crate",
          blocksMove: o.blocksMove !== false,
          blocksLos: o.blocksLos !== false,
        };
        if (o.sourceRect && typeof o.sourceRect === "object") {
          mo.sourceRect = {
            x: Number(o.sourceRect.x) || 0,
            y: Number(o.sourceRect.y) || 0,
            w: Number(o.sourceRect.w ?? o.sourceRect.width) || 0,
            h: Number(o.sourceRect.h ?? o.sourceRect.height) || 0,
          };
        }
        if (o.propAnchor === "bottom" || o.propAnchor === "center") {
          mo.propAnchor = o.propAnchor;
        }
        if (typeof o.pyOffset === "number" && Number.isFinite(o.pyOffset)) {
          mo.pyOffset = o.pyOffset;
        }
        this.mapObjects.push(mo);
      }
    }
    this.currentPlayer = 0;
    this.selectedId = null;
    this.winner = null;
    /** Full rounds completed (each time play returns to player 0 after opfor). */
    this.fullRoundsCompleted = 0;
    this._terrainMoveCost = (x, y) =>
      moveCostAt(this.grid, this.tileTypes, x, y);
    this.costAtForUnit = (unit, x, y) => {
      const cls = unit?.movementClass ?? "infantry";
      let base = moveCostAtForClass(this.grid, this.tileTypes, x, y, cls);
      if (base >= BLOCKED_MOVE_COST) return base;
      if (hardMapObjectBlocksAllUnits(this.mapObjects, x, y)) {
        return BLOCKED_MOVE_COST;
      }
      if (mapObjectTreeAt(this.mapObjects, x, y)) {
        if (cls === "vehicle") return BLOCKED_MOVE_COST;
        return Math.max(base, 2);
      }
      return base;
    };
    this.losCtx = () => ({
      grid: this.grid,
      tileTypes: this.tileTypes,
      mapObjects: this.mapObjects?.length ? this.mapObjects : undefined,
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
      return this.costAtForUnit(unit, x, y);
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
      return this.costAtForUnit(unit, x, y);
    });
    if (!path) return false;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const [nx, ny] = path[i];
      total += this.costAtForUnit(unit, nx, ny);
    }
    if (total > unit.move + 1e-6) return false;
    const sx = unit.x;
    const sy = unit.y;
    unit.x = tx;
    unit.y = ty;
    unit.isMoving = true;
    if (unit.mapRenderMode === "topdown" && (tx !== sx || ty !== sy)) {
      unit.faceRad = Math.atan2(ty - sy, tx - sx);
    }
    unit.movedThisTurn = true;
    return true;
  }

  /**
   * Returns damage breakdown including optional preemptive strike from the defender.
   */
  attack(attacker, target) {
    if (!attacker || !target || attacker.owner !== this.currentPlayer) return false;
    if (attacker.attackedThisTurn) return false;
    const ctx = this.losCtx();
    if (!canAttack(attacker, target, this.units, ctx)) return false;

    let preemptDmg = 0;
    let preemptProtectedBy = null;
    let structurePreempt = null;

    /* ── Preemptive Strike: defender fires first (e.g. Medic) ── */
    if (
      target.specialAbility === "Preemptive Strike" &&
      !target.attackedThisTurn &&
      target.hp > 0
    ) {
      if (canAttack(target, attacker, this.units, ctx)) {
        const pr = resolveAttack(target, attacker, ctx);
        preemptDmg = pr.dmg;
        preemptProtectedBy = pr.protectedBy;
        structurePreempt = this.applyCombatStressToStructure(
          attacker.x,
          attacker.y,
          preemptDmg,
        );
        target.attackedThisTurn = true;
      }
    }

    if (attacker.hp <= 0) {
      attacker.attackedThisTurn = true;
      let structureCollapsed = null;
      if (structurePreempt?.collapsed) {
        structureCollapsed = {
          x: structurePreempt.x,
          y: structurePreempt.y,
        };
      }
      return {
        dmg: 0,
        preemptDmg,
        preemptProtectedBy,
        counterDmg: 0,
        structureCollapsed,
        targetProtectedBy: null,
        attackerProtectedBy: null,
      };
    }

    const atkRes = resolveAttack(attacker, target, ctx);
    const dmg = atkRes.dmg;
    const targetProtectedBy = atkRes.protectedBy;
    const structureHit = this.applyCombatStressToStructure(target.x, target.y, dmg);
    attacker.attackedThisTurn = true;

    const counterRes = resolveCounter(attacker, target, ctx);
    const counterDmg = counterRes.dmg;
    const attackerProtectedBy = counterRes.protectedBy;
    const counterStruct =
      counterDmg > 0 && attacker.hp > 0
        ? this.applyCombatStressToStructure(attacker.x, attacker.y, counterDmg)
        : null;

    let structureCollapsed = null;
    if (structureHit?.collapsed) structureCollapsed = { x: structureHit.x, y: structureHit.y };
    else if (counterStruct?.collapsed)
      structureCollapsed = { x: counterStruct.x, y: counterStruct.y };
    else if (structurePreempt?.collapsed)
      structureCollapsed = { x: structurePreempt.x, y: structurePreempt.y };

    return {
      dmg,
      preemptDmg,
      preemptProtectedBy,
      counterDmg,
      structureCollapsed,
      targetProtectedBy,
      attackerProtectedBy,
    };
  }

  endTurn() {
    for (const u of this.units) {
      u.movedThisTurn = false;
      u.attackedThisTurn = false;
      u.isMoving = false;
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
