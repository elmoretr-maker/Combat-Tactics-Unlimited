/**
 * Step 4 — Serialize generated layout to JSON compatible with GameState / scenario files.
 */

/**
 * @param {object} scenario — width, height, cellSize, terrain, units, presetEnemies, mapObjects, buildings, …
 * @param {number} [space]
 * @returns {string}
 */
export function saveMapLayout(scenario, space = 2) {
  return JSON.stringify(scenario, null, space);
}

/**
 * Trigger browser download of a scenario JSON file.
 * @param {object} scenario
 * @param {string} [filename] default ctu-generated-map.json
 */
export function downloadMapLayout(scenario, filename = "ctu-generated-map.json") {
  const blob = new Blob([saveMapLayout(scenario)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
