/**
 * Seeded obstacle mix ("ratio calculator") for procedural placement.
 * Works with manifest tags: `water_only`, `urban_ok`, optional `water_adjacent` (desert riparian 20% branch).
 */


/** @param {{ tags?: string[] } | null | undefined} ob */
function hasTag(ob, tag) {
  const t = (tag || "").toLowerCase();
  return (ob?.tags || []).some((x) => String(x).toLowerCase() === t);
}

/**
 * @param {"urban"|"desert"|"grass"|"arctic"} profileId
 * @param {{ kind: string, sprite: string, tags?: string[] }[]} validKinds
 * @param {boolean} touchesWater — 4-neighbor touches any water_* / water cell
 * @param {() => number} rnd
 * @returns {{ kind: string, sprite: string, tags?: string[] }[]}
 */
export function applyPlacementRatioMix(profileId, validKinds, touchesWater, rnd) {
  if (!validKinds?.length) return validKinds;

  if (profileId === "grass" || profileId === "arctic") {
    const trees = [];
    const nonTrees = [];
    for (const ob of validKinds) {
      const eff = String(
        ob.ctu?.classification?.subtype || ob.kind || "crate",
      ).toLowerCase();
      if (eff === "tree" || eff === "foliage") trees.push(ob);
      else nonTrees.push(ob);
    }
    if (trees.length && nonTrees.length) {
      return rnd() < 0.5 ? trees : nonTrees;
    }
    return validKinds;
  }

  if (profileId === "desert") {
    const riparian = validKinds.filter((o) => hasTag(o, "water_adjacent"));
    const landish = validKinds.filter((o) => !hasTag(o, "water_adjacent"));
    if (touchesWater && riparian.length && rnd() < 0.2) {
      return riparian;
    }
    if (landish.length) return landish;
    return validKinds;
  }

  return validKinds;
}
