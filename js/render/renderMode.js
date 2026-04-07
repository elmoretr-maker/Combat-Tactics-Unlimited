/**
 * Arena render mode — derived only from scenario JSON (no globals).
 * @param {object|null|undefined} scenario
 * @returns {"mat"|"tiled"}
 */
export function getArenaRenderMode(scenario) {
  return scenario?.battlePlaneLayer?.enabled ? "mat" : "tiled";
}
