/**
 * CraftPix TDS Modern mega-set — load paths and helpers.
 * Base: attached_assets/craftpix_pack/
 *
 * Folder layout (PNG/runtime assets; PSD stays out of this tree):
 *   city/, city_buildings/, boats/, shadows/, smoke/, hud/, effects/
 *   units/sniper/, units/gunner/, units/helicopter/
 *   bomber/, vehicles/acs_tank_damage/
 *   units/, heavy_weapons/, environment/, fx/ — shared buckets (see craftpix_pack/README.md)
 */
export const CRAFTPIX_BASE = "attached_assets/craftpix_pack";

export const CRAFTPIX = {
  city: `${CRAFTPIX_BASE}/city`,
  cityBuildings: `${CRAFTPIX_BASE}/city_buildings`,
  boats: `${CRAFTPIX_BASE}/boats`,
  shadows: `${CRAFTPIX_BASE}/shadows`,
  smoke: `${CRAFTPIX_BASE}/smoke`,
  hud: `${CRAFTPIX_BASE}/hud`,
  effects: `${CRAFTPIX_BASE}/effects`,
  sniper: `${CRAFTPIX_BASE}/units/sniper`,
  gunner: `${CRAFTPIX_BASE}/units/gunner`,
  helicopter: `${CRAFTPIX_BASE}/units/helicopter`,
  bomber: `${CRAFTPIX_BASE}/bomber`,
  acsTankDamage: `${CRAFTPIX_BASE}/vehicles/acs_tank_damage`,
  units: `${CRAFTPIX_BASE}/units`,
  heavyWeapons: `${CRAFTPIX_BASE}/heavy_weapons`,
  environment: `${CRAFTPIX_BASE}/environment`,
  fx: `${CRAFTPIX_BASE}/fx`,
};
