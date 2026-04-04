/**
 * Dev unit overrides (localStorage). Key: ctu_unit_overrides
 * Schema per template id: displayName, mapSpriteSet, move, rangeMin, rangeMax,
 * sightRange, usesLos, attackType ("direct"|"indirect"), isIndirect, deadspace,
 * deadzoneRange (alias for deadspace), specialAbility
 *
 * Stage 0 spec: merge on top of js/config/units.json; empty storage = defaults only.
 */

export const UNIT_OVERRIDES_STORAGE_KEY = "ctu_unit_overrides";

/** @returns {Record<string, object>} */
export function loadOverridesObject() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(UNIT_OVERRIDES_STORAGE_KEY);
    if (!raw || !raw.trim()) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Default combat ability when not set in JSON or overrides.
 * @param {{ id: string, attackType?: string, canCounter?: boolean }} tpl
 * @returns {"None"|"Counter-Attack"|"Preemptive Strike"}
 */
export function defaultSpecialAbilityForTemplate(tpl) {
  const atk = tpl.attackType || "direct";
  if (atk === "indirect") return "None";
  if (tpl.id === "medic") return "Preemptive Strike";
  if (tpl.canCounter !== false) return "Counter-Attack";
  return "None";
}

/**
 * @param {object} tpl
 * @returns {object}
 */
export function normalizeUnitTemplate(tpl) {
  const out = { ...tpl };
  const atk = out.attackType || "direct";
  if (atk === "indirect") {
    out.usesLos = false;
  } else if (out.usesLos === undefined) {
    out.usesLos = true;
  }
  if (!out.specialAbility) {
    out.specialAbility = defaultSpecialAbilityForTemplate(out);
  }
  out.canCounter = out.specialAbility === "Counter-Attack";
  return out;
}

/**
 * Apply localStorage overrides to the shipped units array (browser) or pass {} in Node.
 * @param {object[]} defaultsArr
 * @returns {object[]}
 */
export function mergeUnitTemplates(defaultsArr) {
  const overrides = loadOverridesObject();
  return defaultsArr.map((base) => {
    const o = overrides[base.id];
    if (!o || typeof o !== "object") return normalizeUnitTemplate({ ...base });

    const merged = { ...base };
    if (o.displayName != null && String(o.displayName).trim() !== "") {
      merged.displayName = String(o.displayName);
    }
    if (o.mapSpriteSet != null && String(o.mapSpriteSet).trim() !== "") {
      merged.mapSpriteSet = String(o.mapSpriteSet);
    }
    if (o.move != null && Number.isFinite(Number(o.move))) {
      merged.move = Number(o.move);
    }
    if (o.rangeMin != null && Number.isFinite(Number(o.rangeMin))) {
      merged.rangeMin = Number(o.rangeMin);
    }
    if (o.rangeMax != null && Number.isFinite(Number(o.rangeMax))) {
      merged.rangeMax = Number(o.rangeMax);
    }
    if (o.sightRange != null && Number.isFinite(Number(o.sightRange))) {
      merged.sightRange = Number(o.sightRange);
    }
    if (o.deadzoneRange != null && Number.isFinite(Number(o.deadzoneRange))) {
      merged.deadspace = Number(o.deadzoneRange);
    } else if (o.deadspace != null && Number.isFinite(Number(o.deadspace))) {
      merged.deadspace = Number(o.deadspace);
    }
    if (typeof o.usesLos === "boolean") {
      merged.usesLos = o.usesLos;
    }
    if (o.attackType === "indirect" || o.attackType === "direct") {
      merged.attackType = o.attackType;
    } else if (o.isIndirect === true) {
      merged.attackType = "indirect";
    } else if (o.isIndirect === false) {
      merged.attackType = "direct";
    }
    if (
      o.specialAbility === "None" ||
      o.specialAbility === "Counter-Attack" ||
      o.specialAbility === "Preemptive Strike"
    ) {
      merged.specialAbility = o.specialAbility;
    }

    return normalizeUnitTemplate(merged);
  });
}

export function clearOverridesInStorage() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(UNIT_OVERRIDES_STORAGE_KEY);
}

/**
 * One editor/storage row (per template id) — full baseline for seeding.
 * @param {object} tpl — shipped unit from units.json
 */
export function baselineRowFromShippedTemplate(tpl) {
  const n = normalizeUnitTemplate({ ...tpl });
  const dz = n.deadspace ?? 0;
  return {
    id: n.id,
    displayName: n.displayName,
    mapSpriteSet: n.mapSpriteSet || "",
    move: n.move,
    rangeMin: n.rangeMin ?? 1,
    rangeMax: n.rangeMax ?? 1,
    sightRange: n.sightRange ?? 0,
    usesLos: n.usesLos !== false,
    isIndirect: (n.attackType || "direct") === "indirect",
    attackType: n.attackType || "direct",
    deadzoneRange: dz,
    deadspace: dz,
    specialAbility: n.specialAbility,
  };
}

/** Full localStorage object: { [templateId]: row } */
export function buildBaselineOverridesRecord(unitsArray) {
  const out = {};
  for (const u of unitsArray) {
    out[u.id] = baselineRowFromShippedTemplate(u);
  }
  return out;
}

export function saveOverridesObject(obj) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(UNIT_OVERRIDES_STORAGE_KEY, JSON.stringify(obj, null, 2));
}

/** If storage is empty, write baseline from shipped units (initial seed). */
export function seedOverridesIfEmpty(unitsArray) {
  if (typeof localStorage === "undefined") return false;
  const raw = localStorage.getItem(UNIT_OVERRIDES_STORAGE_KEY);
  if (raw != null && String(raw).trim() !== "") return false;
  saveOverridesObject(buildBaselineOverridesRecord(unitsArray));
  return true;
}
