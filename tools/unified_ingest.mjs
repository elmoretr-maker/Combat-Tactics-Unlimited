/**
 * Unified New_Arrivals ingest: reference_images/<label>/ is the only classification authority.
 * CLIP image embeddings score similarity vs curated references; softmax probabilities drive
 * auto-move vs review (see tools/smart_catalog.mjs --unified-ingest).
 */

import { compactPlacementTagsFromSurfaces } from "./asset_metadata.mjs";
import { primaryDestRelForContent } from "./lib/primary_dest.mjs";

/**
 * Minimum raw cosine similarity (top-1 vs reference pool) required for auto-move.
 * Scale: 0.0–1.0 (L2-normalized dot product). Game-art CLIP cosines cluster ~0.62–0.92.
 * NOT a softmax probability — softmax over 22+ labels never approaches 0.7 with typical
 * game sprite cosine distributions, making softmax-based thresholds unachievable.
 */
export const UNIFIED_HIGH_CONFIDENCE = 0.85;

/**
 * Minimum raw cosine margin (top-1 minus top-2 cosine) required for auto-move.
 * Guards against ambiguous cases where two labels score nearly identically.
 */
export const UNIFIED_MIN_PROB_MARGIN = 0.01;

const LAND_SURFACES = ["grass", "urban", "desert", "interior"];

/**
 * When the embedding-winning reference_images label has no PRIMARY/ui route,
 * remap to a valid semantic key (only if cosine ≥ UNIFIED_HIGH_CONFIDENCE — see resolveUnifiedDestination).
 * Keys use normalizeLabelToContentKey output and/or raw lowercase folder names (e.g. ui_panel).
 */
export const UNIFIED_DEST_LABEL_ALIASES = {
  debris: "obstacle",
  road: "tile",
  foliage: "terrain",
  structure: "building",
  ui_panel: "ui",
  ui_hud: "ui",
};

/** Map reference folder name → primary_dest semantic key (lowercase). */
export function normalizeLabelToContentKey(label) {
  if (label == null || label === "") return "unknown";
  const L = String(label).toLowerCase().trim();
  const synonyms = {
    building: "building",
    buildings: "building",
    house: "building",
    obstacle: "obstacle",
    obstacles: "obstacle",
    prop: "obstacle",
    props: "obstacle",
    tile: "tile",
    tiles: "tile",
    terrain: "tile",
    unit: "unit",
    units: "unit",
    vehicle: "unit",
    soldier: "unit",
    ui: "ui",
    hud: "ui",
    icon: "ui",
    icons: "ui",
  };
  return synonyms[L] ?? L;
}

/**
 * Destination folder under repo root for a winning reference label.
 * UI uses game tree assets/ui/panels; other keys use assets/PRIMARY/* from primary_dest.
 */
export function unifiedDestRelForContentKey(label) {
  const c = normalizeLabelToContentKey(label);
  if (c === "ui") return "assets/ui/panels";
  const pr = primaryDestRelForContent(c);
  return pr || null;
}

/**
 * Resolve move destination for a reference label; apply UNIFIED_DEST_LABEL_ALIASES only when
 * cosine ≥ UNIFIED_HIGH_CONFIDENCE and the direct route is missing.
 * @returns {{ dest: string|null, originalReferenceLabel: string, normalizedReferenceLabel: string, aliasApplied: string|null }}
 */
export function resolveUnifiedDestination(referenceLabel, cosineConfidence) {
  const originalReferenceLabel = String(referenceLabel || "").trim();
  if (!originalReferenceLabel) {
    return {
      dest: null,
      originalReferenceLabel: "",
      normalizedReferenceLabel: "",
      aliasApplied: null,
    };
  }

  let dest = unifiedDestRelForContentKey(originalReferenceLabel);
  if (dest) {
    return {
      dest,
      originalReferenceLabel,
      normalizedReferenceLabel: originalReferenceLabel,
      aliasApplied: null,
    };
  }

  if (Number(cosineConfidence) < UNIFIED_HIGH_CONFIDENCE) {
    return {
      dest: null,
      originalReferenceLabel,
      normalizedReferenceLabel: originalReferenceLabel,
      aliasApplied: null,
    };
  }

  const L = originalReferenceLabel.toLowerCase();
  const norm = normalizeLabelToContentKey(originalReferenceLabel);
  const aliasTarget = UNIFIED_DEST_LABEL_ALIASES[norm] ?? UNIFIED_DEST_LABEL_ALIASES[L];

  if (!aliasTarget) {
    return {
      dest: null,
      originalReferenceLabel,
      normalizedReferenceLabel: originalReferenceLabel,
      aliasApplied: null,
    };
  }

  dest = unifiedDestRelForContentKey(aliasTarget);
  if (!dest) {
    return {
      dest: null,
      originalReferenceLabel,
      normalizedReferenceLabel: originalReferenceLabel,
      aliasApplied: null,
    };
  }

  return {
    dest,
    originalReferenceLabel,
    normalizedReferenceLabel: aliasTarget,
    aliasApplied: aliasTarget,
  };
}

function placementForContentKey(c) {
  if (c === "ui") return compactPlacementTagsFromSurfaces([]);
  if (c === "tile") return compactPlacementTagsFromSurfaces(["urban"]);
  return compactPlacementTagsFromSurfaces(LAND_SURFACES);
}

function behaviorForContentKey(c) {
  const walkable = c === "tile";
  return {
    walkable,
    blocking: c !== "ui" && c !== "unit",
    animated: false,
    interactive: false,
  };
}

/**
 * CTU-shaped metadata: classification comes from reference label only (no filename rules).
 * @param {Array<{ id: string, confidence: number }>} topRanked
 */
export function buildUnifiedMetadata(fileName, routingLabel, topRanked, options = {}) {
  const originalReferenceLabel = options.originalReferenceLabel ?? routingLabel;
  const contentKey = normalizeLabelToContentKey(routingLabel);
  const typeMap = {
    building: { type: "building", subtype: "structure" },
    obstacle: { type: "obstacle", subtype: "prop" },
    tile: { type: "environment", subtype: "tile" },
    unit: { type: "unit", subtype: "vehicle" },
    ui: { type: "ui", subtype: "panel" },
  };
  const { type, subtype } = typeMap[contentKey] || { type: "unknown", subtype: "unknown" };

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceImage: null,
    classification: {
      type,
      subtype,
      decidedBy: "reference_visual",
      /** Embedding-winning reference_images folder label (before dest alias). */
      referenceLabel: originalReferenceLabel,
      /** Same as routingLabel passed to buildUnifiedMetadata (after dest alias when applied). */
      normalizedReferenceLabel: routingLabel,
      destLabelAlias: options.destLabelAlias ?? null,
      reviewPending: Boolean(options.reviewPending),
      ingestError: Boolean(options.ingestError),
    },
    clipSuggestions: {
      note:
        "Unified ingest: scores are softmax probabilities vs reference_images/ embeddings only; not generic CLIP text categories.",
      topCategories: (topRanked || []).slice(0, 5).map((r) => ({
        referenceLabel: r.id,
        confidence: r.confidence,
      })),
    },
    placement: placementForContentKey(contentKey),
    behavior: behaviorForContentKey(contentKey),
    rulesApplied: ["unified_reference_authority"],
    pipeline: {
      folderLayoutHint: null,
      note: "folderLayoutHint set by unified ingest from reference label → primary_dest / ui",
    },
  };
}
