const SETTINGS_KEY = "ctu_settings_v1";

export function defaultSettings() {
  return {
    audioEnabled: true,
    reduceMotion: false,
    difficulty: "normal",
    fogOfWar: true,
    visualStyle: "hDef",
    battleZoom: 1.25,
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
