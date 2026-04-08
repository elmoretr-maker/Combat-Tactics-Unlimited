import { buildTerrainGrid, moveCostAt, moveCostAtForClass } from "./terrain.js";
import {
  hardMapObjectBlocksAllUnits,
  mapObjectTreeAt,
} from "../battle-plane/mapObjects.js";
import { BLOCKED_MOVE_COST } from "../battle-plane/pathfindingCost.js";
import { reachableTiles, findPath } from "./astar.js";
import { canAttack, resolveAttack, resolveCounter } from "./combat.js";
import { inBounds } from "./grid.js";
import { computeFacing, initializeSpawnFacing, syncFacingAndFaceRad } from "./facing.js";

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
    /** @type {"up"|"down"|"left"|"right"} */
    facing: "down",
    /** @type {"idle"|"move"|"attack"|"hit"} */
    state: "idle",
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
    initializeSpawnFacing(this.units);
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
    if (tx !== sx || ty !== sy) {
      unit.facing = computeFacing({ x: sx, y: sy }, { x: tx, y: ty });
      syncFacingAndFaceRad(unit);
    }
    unit.movedThisTurn = true;
    return true;
  }

  /**
   * Preemptive defender strike only (Medic, etc.). Does not mark attacker attackedThisTurn.
   * @returns {{ preemptDmg: number, preemptProtectedBy: string|null, structurePreempt: object|null, attackerAlive: boolean }}
   */
  attackExecutePreemptiveOnly(attacker, target) {
    const ctx = this.losCtx();
    let preemptDmg = 0;
    let preemptProtectedBy = null;
    let structurePreempt = null;
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
    return {
      preemptDmg,
      preemptProtectedBy,
      structurePreempt,
      attackerAlive: attacker.hp > 0,
    };
  }

  /**
   * Main hit + counter after wind-up. Caller must have already validated range/LOS and set attacker.attackedThisTurn.
   */
  attackExecuteMainAndCounter(attacker, target) {
    const ctx = this.losCtx();
    const atkRes = resolveAttack(attacker, target, ctx);
    const dmg = atkRes.dmg;
    const targetProtectedBy = atkRes.protectedBy;
    const structureHit = this.applyCombatStressToStructure(target.x, target.y, dmg);

    if (dmg > 0 && target.hp > 0) {
      target.state = "hit";
      if (target._hitStateTimer) clearTimeout(target._hitStateTimer);
      target._hitStateTimer = setTimeout(() => {
        target._hitStateTimer = null;
        if (target.hp > 0) target.state = "idle";
      }, 200);
    }

    const counterRes = resolveCounter(attacker, target, ctx);
    const counterDmg = counterRes.dmg;
    const attackerProtectedBy = counterRes.protectedBy;
    const counterStruct =
      counterDmg > 0 && attacker.hp > 0
        ? this.applyCombatStressToStructure(attacker.x, attacker.y, counterDmg)
        : null;

    if (counterDmg > 0 && attacker.hp > 0) {
      attacker.state = "hit";
      if (attacker._hitStateTimer) clearTimeout(attacker._hitStateTimer);
      attacker._hitStateTimer = setTimeout(() => {
        attacker._hitStateTimer = null;
        if (attacker.hp > 0) attacker.state = "idle";
      }, 200);
    }

    let structureCollapsed = null;
    if (structureHit?.collapsed) structureCollapsed = { x: structureHit.x, y: structureHit.y };
    else if (counterStruct?.collapsed)
      structureCollapsed = { x: counterStruct.x, y: counterStruct.y };

    return {
      dmg,
      counterDmg,
      structureCollapsed,
      targetProtectedBy,
      attackerProtectedBy,
    };
  }

  /**
   * Returns damage breakdown including optional preemptive strike from the defender.
   */
  attack(attacker, target) {
    if (!attacker || !target || attacker.owner !== this.currentPlayer) return false;
    if (attacker.attackedThisTurn) return false;
    const ctx = this.losCtx();
    if (!canAttack(attacker, target, this.units, ctx)) return false;

    const pre = this.attackExecutePreemptiveOnly(attacker, target);

    if (!pre.attackerAlive) {
      attacker.attackedThisTurn = true;
      let structureCollapsed = null;
      if (pre.structurePreempt?.collapsed) {
        structureCollapsed = {
          x: pre.structurePreempt.x,
          y: pre.structurePreempt.y,
        };
      }
      return {
        dmg: 0,
        preemptDmg: pre.preemptDmg,
        preemptProtectedBy: pre.preemptProtectedBy,
        counterDmg: 0,
        structureCollapsed,
        targetProtectedBy: null,
        attackerProtectedBy: null,
      };
    }

    attacker.facing = computeFacing(
      { x: attacker.x, y: attacker.y },
      { x: target.x, y: target.y },
    );
    syncFacingAndFaceRad(attacker);

    const main = this.attackExecuteMainAndCounter(attacker, target);
    attacker.attackedThisTurn = true;

    let structureCollapsed = main.structureCollapsed;
    if (!structureCollapsed && pre.structurePreempt?.collapsed) {
      structureCollapsed = { x: pre.structurePreempt.x, y: pre.structurePreempt.y };
    }

    return {
      dmg: main.dmg,
      preemptDmg: pre.preemptDmg,
      preemptProtectedBy: pre.preemptProtectedBy,
      counterDmg: main.counterDmg,
      structureCollapsed,
      targetProtectedBy: main.targetProtectedBy,
      attackerProtectedBy: main.attackerProtectedBy,
    };
  }

  endTurn() {
    for (const u of this.units) {
      if (u._hitStateTimer) {
        clearTimeout(u._hitStateTimer);
        u._hitStateTimer = null;
      }
      if (u._attackWindupTimer) {
        clearTimeout(u._attackWindupTimer);
        u._attackWindupTimer = null;
      }
      u.movedThisTurn = false;
      u.attackedThisTurn = false;
      u.isMoving = false;
      u.state = "idle";
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
