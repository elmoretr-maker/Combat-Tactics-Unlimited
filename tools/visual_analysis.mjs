/**
 * Visual asset assessment for the Librarian (sharp + sampled pixels + alpha stats).
 * Naming: Category_Theme_Subtype_UUID.ext (PascalCase segments).
 */

import sharp from "sharp";
import { randomUUID } from "node:crypto";
import path from "path";

/** True when the basename is too vague for reliable text classification. */
export function isGenericFileName(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  if (base.length <= 2) return true;
  if (/^(\d+|[a-z])$/i.test(base)) return true;
  if (
    /^(image|img|asset|unnamed|screen|photo|pic|export|file|new|copy|untitled)[\s_-]*\d*$/i.test(
      base,
    )
  ) {
    return true;
  }
  if (/^sprite[\s_-]*\d+$/i.test(base)) return true;
  return false;
}

function rgbToHex(r, g, b) {
  const h = (n) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function inferThemeFromRgb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;
  if (r > 165 && g > 125 && b < 125 && sat > 22) return "desert";
  if (g > r + 22 && g > b + 28 && sat > 28) return "grass";
  if (sat < 48 && max < 230 && min > 35 && Math.abs(r - g) < 38 && Math.abs(g - b) < 38) {
    return "urban";
  }
  if (b > r + 15 && b > g + 10) return "urban";
  return "urban";
}

export function inferAssetTypeFromDimensions(width, height) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const aspect = w / h;
  const area = w * h;

  if (aspect >= 2.2 && h <= 280) {
    return "tile";
  }

  const squareish = aspect >= 0.78 && aspect <= 1.28;
  if (squareish && Math.max(w, h) <= 420 && area < 220_000) {
    return "tile";
  }
  if (aspect >= 2.4 || aspect <= 0.42) {
    return "gun";
  }
  if (area > 320_000 || (Math.min(w, h) > 320 && Math.max(w, h) > 380)) {
    return "building";
  }
  if (squareish && Math.max(w, h) <= 96) {
    return "ui";
  }
  return "obstacle";
}

export function inferGunClassFromDimensions(width, height) {
  const aspect = width / Math.max(1, height);
  if (aspect >= 4.2) return "machine_gun";
  if (aspect >= 2) return "rifle";
  if (aspect <= 0.55) return "handgun";
  return "rifle";
}

export function inferBuildingFootprintFromDimensions(width, height) {
  const area = width * height;
  if (area > 800_000) return "large";
  if (area > 400_000) return "medium";
  if (area < 120_000) return "small";
  return "medium";
}

/**
 * PascalCase each word segment (supports snake_case input).
 * @param {string} s
 */
export function toPascalParts(s) {
  const spaced = String(s).replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
}

/**
 * @param {string} fullPath
 */
export async function analyzeImageVisual(fullPath) {
  const img = sharp(fullPath);
  const meta = await img.metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;

  const { data, info } = await img
    .clone()
    .resize(48, 48, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels || 3;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += ch) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (n) {
    r /= n;
    g /= n;
    b /= n;
  }

  const alphaStats = await sampleTransparency(fullPath);

  const theme = inferThemeFromRgb(r, g, b);
  const assetType = inferAssetTypeFromDimensions(w, h);
  const aspect = w / Math.max(1, h);
  const dominantHex = rgbToHex(r, g, b);

  let gunClass = null;
  let footprint = null;
  if (assetType === "gun") gunClass = inferGunClassFromDimensions(w, h);
  if (assetType === "building") footprint = inferBuildingFootprintFromDimensions(w, h);

  return {
    width: w,
    height: h,
    aspect: Math.round(aspect * 1000) / 1000,
    avgRgb: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
    dominantHex,
    theme,
    assetType,
    gunClass,
    footprint,
    transparencyHigh: alphaStats.transparencyHigh,
    meanAlpha: alphaStats.meanAlpha,
  };
}

async function sampleTransparency(fullPath) {
  try {
    const { data, info } = await sharp(fullPath)
      .resize(64, 64, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels || 4;
    if (ch < 4) {
      return { transparencyHigh: false, meanAlpha: 255 };
    }
    let sumA = 0;
    let low = 0;
    const n = data.length / ch;
    for (let i = 0; i < data.length; i += ch) {
      const a = data[i + 3];
      sumA += a;
      if (a < 38) low++;
    }
    const meanA = sumA / n;
    const transparencyHigh = low / n > 0.22 || meanA < 198;
    return { transparencyHigh, meanAlpha: Math.round(meanA) };
  } catch {
    return { transparencyHigh: false, meanAlpha: 255 };
  }
}

/**
 * Apply filename + transparency rules on top of dimension/color heuristics.
 * @param {Awaited<ReturnType<typeof analyzeImageVisual>>} analysis
 * @param {string} originalBaseName basename without path, with or without ext
 */
export function refineLibrarianClassification(analysis, originalBaseName) {
  const base = path.basename(originalBaseName, path.extname(originalBaseName));
  const w = analysis.width;
  const h = analysis.height;
  const area = w * h;
  const aspect = w / Math.max(1, h);
  const isWideStrip = aspect >= 2.2 && h <= 280;
  const theme = analysis.theme;

  let kind = analysis.assetType;
  let subtype = defaultSubtypeForKind(kind, analysis);
  let obstacleKind = null;

  const delimTok = (re) => re.test(base) || re.test(base.toLowerCase());
  if (
    delimTok(/(^|[_\-.])(vehicle|tank|plane)([_\-.]|$)/i) ||
    /\b(vehicle|tank|plane)\b/.test(base.toLowerCase())
  ) {
    kind = "unit";
    subtype = "Vehicle";
    obstacleKind = null;
    return { kind, subtype, obstacleKind };
  }

  if (
    isWideStrip &&
    /water|coast|liquid|fluid|ocean|sea|animation|lake|pond|river/i.test(base)
  ) {
    kind = "tile";
    subtype = "WaterStrip";
  } else if (isWideStrip && (/object/i.test(base) || analysis.transparencyHigh)) {
    kind = "obstacle";
    subtype = "Strip";
    obstacleKind = "strip";
  } else if (
    theme === "urban" &&
    area >= 280_000 &&
    kind !== "gun" &&
    kind !== "ui" &&
    !isWideStrip
  ) {
    kind = "building";
    if (!analysis.footprint) {
      analysis.footprint = inferBuildingFootprintFromDimensions(w, h);
    }
    subtype = toPascalParts(analysis.footprint);
  } else if (isWideStrip && kind === "tile") {
    subtype = "TileStrip";
  }

  if (kind === "obstacle" && !obstacleKind) {
    obstacleKind = "crate";
  }

  return { kind, subtype, obstacleKind };
}

function defaultSubtypeForKind(kind, analysis) {
  if (kind === "gun") return toPascalParts(analysis.gunClass || "rifle");
  if (kind === "building") return toPascalParts(analysis.footprint || "medium");
  if (kind === "ui") return "Button";
  if (kind === "tile") return "Tile";
  if (kind === "unit") return "Sprite";
  if (kind === "obstacle") return "Prop";
  return "Prop";
}

/**
 * @param {Awaited<ReturnType<typeof analyzeImageVisual>>} analysis
 * @param {string} originalFileName file basename with ext
 * @param {string} ext lower e.g. .png
 */
export function planLibrarianRename(analysis, originalFileName, ext) {
  const { kind, subtype, obstacleKind } = refineLibrarianClassification(
    analysis,
    originalFileName,
  );

  const themeP = toPascalParts(analysis.theme);
  const id = randomUUID().replace(/-/g, "").slice(0, 8);

  let category = "obstacle";
  let catP = "Obstacle";
  let gunClass = analysis.gunClass || "rifle";
  let footprint = analysis.footprint || "medium";

  if (kind === "tile") {
    category = "tile";
    catP = "Tile";
  } else if (kind === "gun") {
    category = "gun";
    catP = "Gun";
    gunClass = analysis.gunClass || "rifle";
  } else if (kind === "building") {
    category = "building";
    catP = "Building";
    footprint = analysis.footprint || inferBuildingFootprintFromDimensions(analysis.width, analysis.height);
  } else if (kind === "ui") {
    category = "ui";
    catP = "Ui";
  } else if (kind === "unit") {
    category = "unit";
    catP = "Unit";
    footprint = null;
  } else {
    category = "obstacle";
    catP = "Obstacle";
  }

  const subP = toPascalParts(subtype);
  const newFileName = `${catP}_${themeP}_${subP}_${id}${ext}`;

  return {
    category,
    newFileName,
    gunClass,
    footprint,
    theme: analysis.theme,
    obstacleKind: obstacleKind || "crate",
    librarianSubtype: subP,
    unitKind: category === "unit" ? (subP === "Vehicle" ? "vehicle" : "soldier") : undefined,
  };
}

/**
 * Filename keyword wins over visual/refine — stable Obstacle_* / Unit_* names.
 * @param {object} override { category: 'obstacle' | 'unit', obstacleKind?: string, unitKind?: 'vehicle'|'soldier' }
 */
export function planRenameForKeywordOverride(analysis, originalFileName, ext, override) {
  const themeP = toPascalParts(analysis.theme);
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  if (override.category === "obstacle") {
    const ok = override.obstacleKind || "crate";
    const subP = toPascalParts(ok);
    return {
      category: "obstacle",
      newFileName: `Obstacle_${themeP}_${subP}_${id}${ext}`,
      gunClass: analysis.gunClass || "rifle",
      footprint: analysis.footprint || "medium",
      theme: analysis.theme,
      obstacleKind: ok,
      librarianSubtype: subP,
    };
  }
  if (override.category === "unit") {
    const isVehicle = override.unitKind === "vehicle";
    const subP = isVehicle ? "Vehicle" : "Sprite";
    return {
      category: "unit",
      unitKind: isVehicle ? "vehicle" : "soldier",
      newFileName: `Unit_${themeP}_${subP}_${id}${ext}`,
      gunClass: analysis.gunClass || "rifle",
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: subP,
    };
  }
  return null;
}

/**
 * New_Arrivals path contains a folder segment `URBAN` + known pixel size → category + stable name.
 * Theme is always urban; building footprint comes from filename/path heuristics when 512².
 */
export function planRenameForUrbanBrain(analysis, originalFileName, ext, spec) {
  const themeP = "Urban";
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  if (spec.category === "tile") {
    return {
      category: "tile",
      newFileName: `Tile_${themeP}_Tile_${id}${ext}`,
      gunClass: analysis.gunClass || "rifle",
      footprint: null,
      theme: "urban",
      obstacleKind: "crate",
      librarianSubtype: "Tile",
    };
  }
  if (spec.category === "building") {
    const fp = spec.footprint || "medium";
    const fpP = toPascalParts(fp);
    return {
      category: "building",
      newFileName: `Building_${themeP}_${fpP}_${id}${ext}`,
      gunClass: analysis.gunClass || "rifle",
      footprint: fp,
      theme: "urban",
      obstacleKind: "crate",
      librarianSubtype: fpP,
    };
  }
  if (spec.category === "obstacle") {
    const ok = spec.obstacleKind || "crate";
    const subP = toPascalParts(ok);
    return {
      category: "obstacle",
      newFileName: `Obstacle_${themeP}_${subP}_${id}${ext}`,
      gunClass: analysis.gunClass || "rifle",
      footprint: null,
      theme: "urban",
      obstacleKind: ok,
      librarianSubtype: subP,
    };
  }
  return null;
}

/**
 * Rename when ingest category is already decided from the filename (not visual inference).
 * Mirrors planLibrarianRename buckets without re-running refineLibrarianClassification.
 */
export function planRenameFixedCategory(analysis, originalFileName, ext, fixed) {
  const themeP = toPascalParts(analysis.theme);
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  const category = fixed.category;
  const gunClass = fixed.gunClass ?? analysis.gunClass ?? "rifle";
  const footprint =
    fixed.footprint ??
    analysis.footprint ??
    inferBuildingFootprintFromDimensions(analysis.width, analysis.height);

  if (category === "tile") {
    return {
      category: "tile",
      newFileName: `Tile_${themeP}_Tile_${id}${ext}`,
      gunClass,
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: "Tile",
    };
  }
  if (category === "building") {
    const fpP = toPascalParts(footprint);
    return {
      category: "building",
      newFileName: `Building_${themeP}_${fpP}_${id}${ext}`,
      gunClass,
      footprint,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: fpP,
    };
  }
  if (category === "gun") {
    const gcP = toPascalParts(gunClass);
    return {
      category: "gun",
      newFileName: `Gun_${themeP}_${gcP}_${id}${ext}`,
      gunClass,
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: gcP,
    };
  }
  if (category === "ui") {
    return {
      category: "ui",
      newFileName: `Ui_${themeP}_Panel_${id}${ext}`,
      gunClass,
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: "Panel",
    };
  }
  if (category === "vfx") {
    return {
      category: "vfx",
      newFileName: `Vfx_${themeP}_Effect_${id}${ext}`,
      gunClass,
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: "Effect",
    };
  }
  if (category === "unit") {
    const isVehicle = fixed.unitKind === "vehicle";
    const subP = isVehicle ? "Vehicle" : "Sprite";
    return {
      category: "unit",
      unitKind: isVehicle ? "vehicle" : "soldier",
      newFileName: `Unit_${themeP}_${subP}_${id}${ext}`,
      gunClass,
      footprint: null,
      theme: analysis.theme,
      obstacleKind: "crate",
      librarianSubtype: subP,
    };
  }
  const ok = fixed.obstacleKind ?? "crate";
  const subP = toPascalParts(ok);
  return {
    category: "obstacle",
    newFileName: `Obstacle_${themeP}_${subP}_${id}${ext}`,
    gunClass,
    footprint: null,
    theme: analysis.theme,
    obstacleKind: ok,
    librarianSubtype: subP,
  };
}

/** @deprecated use planLibrarianRename — kept for scripts that still import the old name */
export function planVisualRename(analysis, ext) {
  const id = randomUUID().slice(0, 8);
  const t = analysis.theme;
  const type = analysis.assetType;
  let base = `${type}_${t}_${id}`;
  let category = "obstacle";

  if (type === "tile") {
    category = "tile";
    base = `tile_${t}_${id}`;
  } else if (type === "gun") {
    category = "gun";
    const gc = analysis.gunClass || "rifle";
    base = `gun_${gc}_${t}_${id}`;
  } else if (type === "building") {
    category = "building";
    const fp = analysis.footprint || "medium";
    base = `building_${fp}_${t}_${id}`;
  } else if (type === "ui") {
    category = "ui";
    base = `ui_button_${t}_${id}`;
  } else {
    base = `obstacle_${t}_${id}`;
  }

  return {
    category,
    newFileName: `${base}${ext}`,
    gunClass: analysis.gunClass || "rifle",
    footprint: analysis.footprint || "medium",
    theme: t,
  };
}
