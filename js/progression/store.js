const STORAGE_KEY = "ctu_progress_v1";

export function defaultProgress() {
  return {
    academyComplete: false,
    unlocks: {
      infantry: true,
      sniper: true,
      light_tank: true,
      mortar: true,
      medic: false,
      artillery: false,
      commander_unit: false,
      vanguard: false,
      guard: false,
      assault: false,
      recon_jeep: false,
      jet_bomber: false,
      grunt_red: true,
      opfor_tank: true,
    },
    wins: 0,
    losses: 0,
    displayName: "Commander",
    updatedAt: 0,
    hideBattleCoach: false,
  };
}

/** @type {((p: object) => void) | null} */
let cloudAdapter = null;

export function setCloudAdapter(fn) {
  cloudAdapter = fn;
}

function mergeUnlocks(baseUnlocks, a, b) {
  const out = { ...baseUnlocks, ...a, ...b };
  const keys = new Set([
    ...Object.keys(a || {}),
    ...Object.keys(b || {}),
  ]);
  for (const k of keys) {
    if (a?.[k] === true || b?.[k] === true) out[k] = true;
  }
  return out;
}

/**
 * Merge local and remote progress (Firestore). Unlocks OR (either side unlocked stays unlocked); W/L from newer `updatedAt`.
 */
export function mergeProgress(local, remote) {
  const la = Number(local?.updatedAt) || 0;
  const ra = Number(remote?.updatedAt) || 0;
  const newer = ra > la ? remote : local;
  const older = ra > la ? local : remote;
  const base = defaultProgress();
  return {
    ...base,
    ...older,
    ...newer,
    unlocks: mergeUnlocks(base.unlocks, older?.unlocks, newer?.unlocks),
    wins: newer?.wins ?? older?.wins ?? 0,
    losses: newer?.losses ?? older?.losses ?? 0,
    academyComplete: Boolean(newer?.academyComplete || older?.academyComplete),
    displayName: newer?.displayName || older?.displayName || base.displayName,
    hideBattleCoach: Boolean(newer?.hideBattleCoach || older?.hideBattleCoach),
    updatedAt: Math.max(la, ra),
  };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw);
    return {
      ...defaultProgress(),
      ...parsed,
      unlocks: { ...defaultProgress().unlocks, ...parsed.unlocks },
    };
  } catch {
    return defaultProgress();
  }
}

/**
 * @param {object} p
 * @param {{ skipCloud?: boolean }} [opts]
 */
export function saveProgress(p, opts = {}) {
  const out = { ...p, updatedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  if (!opts.skipCloud) cloudAdapter?.(out);
}

export function isUnlocked(progress, unitId) {
  return progress.unlocks[unitId] !== false;
}
