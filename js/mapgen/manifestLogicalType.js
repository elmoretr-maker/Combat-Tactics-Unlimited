/**
 * Logical game category for a manifest asset — prefers ctu.classification over folder-derived type.
 */

/**
 * @param {object} a manifest asset entry
 * @returns {string}
 */
export function manifestAssetLogicalType(a) {
  const t = a?.ctu?.classification?.type;
  const st = a?.ctu?.classification?.subtype;
  if (!t || t === "unknown") return a.type;
  if (t === "environment") return st === "tile" ? "tile" : "obstacle";
  if (t === "effect") return "vfx";
  if (t === "weapon") return "gun";
  return t;
}
