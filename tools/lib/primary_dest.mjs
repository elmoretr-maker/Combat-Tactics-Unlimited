/**
 * Semantic content → destination under assets/PRIMARY (shared by promote + group pipeline).
 * Must stay aligned with smart_catalog routing expectations.
 */
export function primaryDestRelForContent(content) {
  const c = String(content || "").trim().toLowerCase();
  if (!c || c === "unspecified") return null;
  const routes = {
    unit: "assets/PRIMARY/units",
    tank: "assets/PRIMARY/units",
    helicopter: "assets/PRIMARY/units",
    tree: "assets/PRIMARY/obstacles/trees",
    rock: "assets/PRIMARY/obstacles/rocks",
    cactus: "assets/PRIMARY/obstacles",
    obstacle: "assets/PRIMARY/obstacles",
    building: "assets/PRIMARY/buildings",
    bridge: "assets/PRIMARY/obstacles",
    gun: "assets/PRIMARY/guns",
    projectile: "assets/PRIMARY/projectiles",
    tile: "assets/PRIMARY/tiles",
    map: "assets/PRIMARY/maps",
    vfx: "assets/PRIMARY/vfx",
    ui: "assets/PRIMARY/ui",
    menu: "assets/PRIMARY/ui",
    hud: "assets/PRIMARY/ui",
    boat: "assets/PRIMARY/units",
    container: "assets/PRIMARY/obstacles",
    canon_turret: "assets/PRIMARY/units",
    puddle: "assets/PRIMARY/obstacles",
    unit_items: "assets/PRIMARY/ui",
  };
  if (Object.prototype.hasOwnProperty.call(routes, c)) {
    return routes[c];
  }
  /** Unknown semantic labels — no automatic misc/ bucket; caller must mark unresolved. */
  return null;
}

/** Parallel tree for composite frames / effects under approved groups. */
export function compositeDestRelForContent(content) {
  const pr = primaryDestRelForContent(content);
  if (!pr) return null;
  return pr.replace(/^assets\/PRIMARY/, "assets/COMPOSITE");
}
