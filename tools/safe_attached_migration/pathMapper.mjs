/**
 * Semantic OLD -> NEW mapping for attached_assets -> assets (staged migration).
 * @param {string} relPosix must start with attached_assets/
 * @returns {{ type: string, subtype?: string, oldPath: string, newPath: string }}
 */
export function mapAttachedPath(relPosix) {
  const o = relPosix.replace(/\\/g, "/").trim();
  if (!o.startsWith("attached_assets/")) {
    return { type: "skip", oldPath: o, newPath: o };
  }
  const rest = o.slice("attached_assets/".length);

  if (rest.startsWith("units/")) {
    const file = rest.slice("units/".length);
    return {
      type: "unit",
      subtype: "portrait",
      oldPath: o,
      newPath: `assets/units/portraits/${file}`,
    };
  }
  if (rest.startsWith("ui/")) {
    const file = rest.slice("ui/".length);
    return {
      type: "ui",
      subtype: "chrome",
      oldPath: o,
      newPath: `assets/ui/attached/${file}`,
    };
  }
  if (rest.startsWith("tiles/")) {
    const file = rest.slice("tiles/".length);
    return {
      type: "tile",
      subtype: "classic_pixel",
      oldPath: o,
      newPath: `assets/tiles/classic/${file}`,
    };
  }
  if (rest.startsWith("sprites/")) {
    return {
      type: "unit",
      subtype: "sprite_sequence",
      oldPath: o,
      newPath: `assets/sprites/${rest.slice("sprites/".length)}`,
    };
  }
  if (rest.startsWith("vfx/")) {
    const file = rest.slice("vfx/".length);
    return {
      type: "effect",
      subtype: "vfx",
      oldPath: o,
      newPath: `assets/vfx/${file}`,
    };
  }
  if (rest.startsWith("craftpix_pack/effects/")) {
    const tail = rest.slice("craftpix_pack/effects/".length);
    return {
      type: "effect",
      subtype: "craftpix_effects",
      oldPath: o,
      newPath: `assets/effects/craftpix/effects/${tail}`,
    };
  }
  if (rest.startsWith("craftpix_pack/city/")) {
    const tail = rest.slice("craftpix_pack/city/".length);
    return {
      type: "effect",
      subtype: "craftpix_city",
      oldPath: o,
      newPath: `assets/effects/craftpix/city/${tail}`,
    };
  }
  if (rest.startsWith("craftpix_pack/units/")) {
    const tail = rest.slice("craftpix_pack/units/".length);
    return {
      type: "unit",
      subtype: "craftpix_units",
      oldPath: o,
      newPath: `assets/units/craftpix/${tail}`,
    };
  }
  if (rest.startsWith("craftpix_pack/vehicles/")) {
    const tail = rest.slice("craftpix_pack/vehicles/".length);
    return {
      type: "unit",
      subtype: "craftpix_vehicles",
      oldPath: o,
      newPath: `assets/units/craftpix/vehicles/${tail}`,
    };
  }
  if (rest.startsWith("craftpix_pack/bomber/")) {
    const tail = rest.slice("craftpix_pack/bomber/".length);
    return {
      type: "unit",
      subtype: "craftpix_bomber",
      oldPath: o,
      newPath: `assets/units/craftpix/bomber/${tail}`,
    };
  }

  if (rest === "bg_video.mp4" || rest.startsWith("bg_video")) {
    const file = rest;
    return {
      type: "ui",
      subtype: "media",
      oldPath: o,
      newPath: `assets/media/${file}`,
    };
  }

  return {
    type: "unknown",
    subtype: "needs_manual_rule",
    oldPath: o,
    newPath: `assets/_unclassified/${rest}`,
  };
}
