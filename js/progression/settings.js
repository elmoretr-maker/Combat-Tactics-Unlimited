const SETTINGS_KEY = "ctu_settings_v1";

export function defaultSettings() {
  return {
    audioEnabled: true,
    reduceMotion: false,
    difficulty: "normal",
    /** Vs-CPU / solo map skirmish: scales preset enemy count (easy→hell). */
    soloDifficulty: "normal",
    fogOfWar: true,
    visualStyle: "hDef",
    battleZoom: 1.25,
    /** Craftpix-style bitmap backdrops + metal hybrid (toggle in Settings). */
    cyberHudArtEnabled: false,
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
