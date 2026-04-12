/**
 * Post-classification folder grouping: roles, relationship proposals, review payload.
 * Does not modify CLIP or thresholds — consumes existing decision + referenceAssetExtension only.
 *
 * Grouping gates: ≥1 strong signal OR ≥2 weak signals (folder context alone never sufficient).
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { primaryDestRelForContent } from "./primary_dest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const NEW_ARRIVALS_PREFIX = "assets/New_Arrivals";

export const ROLES = {
  BASE: "BASE",
  COMPOSITE: "COMPOSITE",
  ATTACHED_EFFECT: "ATTACHED_EFFECT",
  SHARED_EFFECT: "SHARED_EFFECT",
  PART: "PART",
  STANDALONE: "STANDALONE",
  SOURCE: "SOURCE",
};

/** @typedef {{ strong: string[], weak: string[], summary: string }} GroupSignals */

const SEQUENCE_RE = /_\d{2,}(?=\.[^.]+$)|_\d+(?=\.[^.]+$)/i;
const SEQUENCE_STRONG_RE =
  /(?:_\d{2,}|-\d+|-[12](?:st|nd|rd|th)|_[abc](?=\.[^.]+$)|frame_\d+|_\d{1,3}(?=\.[^.]+$))/i;
const PART_HINT = /tread|turret|barrel|wheel|track|antenna|cannon|hatch|grip|sight/i;
const EFFECT_IDS = new Set(["vfx", "projectile", "puddle"]);
const UI_FRAGMENT_IDS = new Set(["hud", "ui", "menu", "button", "sprite_sheet"]);
const ACTION_SUFFIX_RE = /_(idle|run|walk|attack|hurt|dead|shoot|reload|jump)$/i;
const VERSION_SUFFIX_RE = /_v\d+$/i;
/** Naming hints that suggest a variant / alt asset (not the canonical base). */
const VARIANT_NAME_RE = /_(alt|backup|old|copy|beta|new)(?=\.|$)|_idle(?=\.|$)/i;
/** When the cluster’s dominant class is unit-like, penalize UI fragments as BASE. */
const UNITISH_DOMINANT = new Set(["tank", "helicopter", "unit", "boat", "canon_turret", "gun"]);

function isSourceExt(ext) {
  if (ext?.usage === "redundant_source" || ext?.state === "REDUNDANT_SOURCE") return false;
  return ext?.usage === "needs_extraction" || ext?.state === "SOURCE";
}

function visualId(d) {
  return d?.chosen?.id ?? d?.top3?.[0]?.id ?? null;
}

function confidence(d) {
  return d?.confidence ?? 0;
}

function refBestCosine(d) {
  const v = d?.classifyMeta?.referenceVisual?.bestCosine;
  return v != null ? Number(v) : null;
}

function refTopVisualId(d) {
  const t = d?.classifyMeta?.referenceVisual?.softmaxTop3?.[0]?.id;
  return t ?? null;
}

/** Normalize folder / asset slug for destinations. */
export function normalizeAssetSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "asset";
}

function stemClusterKey(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  return base
    .replace(/_\d{2,}$/i, "")
    .replace(/_\d+$/i, "")
    .replace(/-\d+$/i, "");
}

/** Broader name root: strips sequence + action + version hints for variant grouping. */
export function extendedStemKey(fileName) {
  let s = stemClusterKey(fileName);
  s = s.replace(ACTION_SUFFIX_RE, "").replace(VERSION_SUFFIX_RE, "");
  return s.toLowerCase();
}

function looksLikeSequence(fileName) {
  return SEQUENCE_RE.test(path.basename(fileName, path.extname(fileName)));
}

function looksLikeSequenceStrong(fileName) {
  return SEQUENCE_STRONG_RE.test(path.basename(fileName, path.extname(fileName)));
}

function hashUnresolvedId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function makeUnresolvedItemId(relPath, reasonKey) {
  return `u_${hashUnresolvedId(`${relPath}::${reasonKey}`)}`;
}

function effectiveStandaloneLabel(s) {
  const c = String(s.correct_label || s.content || s.predicted_label || "")
    .trim()
    .toLowerCase();
  if (!c || c === "unspecified") return null;
  return c;
}

function effectiveGroupLabel(g) {
  const c = String(g.correct_base_label || g.predicted_base_label || "")
    .trim()
    .toLowerCase();
  if (!c || c === "unspecified") return null;
  return c;
}

/**
 * Aggregates folder-level unresolved rows + BASE_UNRESOLVED files + routing gaps + attach gaps.
 * Does not change grouping; only lists and enriches for review / execute blocking.
 */
export function buildMasterUnresolvedItems(foldersOut) {
  /** @type {Map<string, object>} */
  const byPath = new Map();

  function mergeInto(pathKey, entry) {
    const prev = byPath.get(pathKey);
    if (!prev) {
      byPath.set(pathKey, {
        ...entry,
        reason_codes: [entry.reason_code],
      });
      return;
    }
    if (prev.reason_codes.includes(entry.reason_code)) return;
    prev.reason_codes.push(entry.reason_code);
    prev.reason = `${prev.reason} | ${entry.reason}`;
    prev.required_action = `${prev.required_action} · ${entry.required_action}`;
    if (entry.role_if_known && !prev.role_if_known) prev.role_if_known = entry.role_if_known;
    if (entry.group_id && !prev.group_id) prev.group_id = entry.group_id;
    prev.id = makeUnresolvedItemId(pathKey, [...prev.reason_codes].sort().join("+"));
  }

  for (const folder of foldersOut) {
    const fr = folder.folderRel ?? "";

    for (const u of folder.unresolved ?? []) {
      mergeInto(u.path, {
        id: makeUnresolvedItemId(u.path, "usage_review"),
        path: u.path,
        folderRel: fr,
        reason_code: "usage_review",
        reason: `usage_review — ${u.hint || "usage is review; confirm before move"}`,
        required_action:
          "Set approved + correct_label on standalone, or mark_source / mark STANDALONE in unresolved_items",
        role_if_known: null,
        group_id: null,
        suggested: {
          role: ROLES.STANDALONE,
          confidence_hint: "medium",
          note: "Fix labels then approve standalone row",
        },
        alternatives: [
          { role: ROLES.SOURCE, confidence_hint: "low", note: "Archive / needs_extraction" },
        ],
        resolved: false,
        accept_suggestion: false,
        assign_base: "",
        assign_base_path: "",
        mark_standalone: false,
        mark_source: false,
        force_role: null,
      });
    }

    for (const g of folder.groups ?? []) {
      if (g.base_status !== "BASE_UNRESOLVED") continue;
      const br = g.base_unresolved_reason || "base could not be validated";
      const candNote =
        g.base_candidates?.length &&
        `Candidates: ${g.base_candidates
          .slice(0, 4)
          .map((c) => path.basename(c.path || c))
          .join(", ")}`;

      for (const f of g.files ?? []) {
        const fn = path.basename(f.path);
        const seqHint = looksLikeSequenceStrong(fn) ? "high" : "medium";
        mergeInto(f.path, {
          id: makeUnresolvedItemId(f.path, `base:${g.id}`),
          path: f.path,
          folderRel: fr,
          reason_code: "BASE_UNRESOLVED",
          reason: `BASE_UNRESOLVED (${br}) — role ${f.role}`,
          required_action:
            "Set correct_base_label + base_override_confirmed on the group, or use assign_base / force_role",
          role_if_known: f.role,
          group_id: g.id,
          suggested: {
            role: f.role === ROLES.BASE ? ROLES.COMPOSITE : f.role,
            confidence_hint: seqHint,
            note: candNote || undefined,
          },
          alternatives: [{ role: ROLES.PART, confidence_hint: "medium", note: "If this file is a part layer" }],
          resolved: false,
          accept_suggestion: false,
          assign_base: "",
          assign_base_path: "",
          mark_standalone: false,
          mark_source: false,
          force_role: null,
        });
      }
    }

    for (const g of folder.groups ?? []) {
      const label = effectiveGroupLabel(g);
      if (label && !primaryDestRelForContent(label)) {
        for (const f of g.files ?? []) {
          mergeInto(f.path, {
            id: makeUnresolvedItemId(f.path, "group_route"),
            path: f.path,
            folderRel: fr,
            reason_code: "group_routing_unknown",
            reason: `No PRIMARY route for group base label "${label}"`,
            required_action: "Set correct_base_label to a known semantic id (see primary_dest routes) or mark SOURCE",
            role_if_known: f.role,
            group_id: g.id,
            suggested: {
              role: ROLES.STANDALONE,
              confidence_hint: "low",
              note: "Pick a mapped label or adjust primary_dest.mjs (separate change)",
            },
            alternatives: [{ role: ROLES.SOURCE, confidence_hint: "low", note: "Do not move" }],
            resolved: false,
            accept_suggestion: false,
            assign_base: "",
            assign_base_path: "",
            mark_standalone: false,
            mark_source: false,
            force_role: null,
          });
        }
      }
    }

    for (const s of folder.standalone ?? []) {
      const label = effectiveStandaloneLabel(s);
      if (label && !primaryDestRelForContent(label)) {
        mergeInto(s.path, {
          id: makeUnresolvedItemId(s.path, "routing"),
          path: s.path,
          folderRel: fr,
          reason_code: "routing_unknown_category",
          reason: `No PRIMARY route for content label "${label}"`,
          required_action:
            "Set correct_label to a mapped semantic id, or mark_source / mark_standalone / SHARED_EFFECT path",
          role_if_known: s.role,
          group_id: null,
          suggested: {
            role: ROLES.STANDALONE,
            confidence_hint: "medium",
            note: "Choose a valid category label that exists in primary_dest routes",
          },
          alternatives: [
            {
              role: ROLES.SHARED_EFFECT,
              confidence_hint: s.role === ROLES.SHARED_EFFECT ? "high" : "low",
              note: "Effects often go to PRIMARY/effects when role is SHARED_EFFECT",
            },
          ],
          resolved: false,
          accept_suggestion: false,
          assign_base: "",
          assign_base_path: "",
          mark_standalone: false,
          mark_source: false,
          force_role: null,
        });
      } else if (!label) {
        mergeInto(s.path, {
          id: makeUnresolvedItemId(s.path, "missing_label"),
          path: s.path,
          folderRel: fr,
          reason_code: "missing_content_label",
          reason: "Missing usable content label (empty / unspecified)",
          required_action: "Set correct_label or predicted content, or mark_source",
          role_if_known: s.role,
          group_id: null,
          suggested: {
            role: ROLES.STANDALONE,
            confidence_hint: "low",
            note: "Assign a semantic label from classification",
          },
          alternatives: [{ role: ROLES.SOURCE, confidence_hint: "low", note: "needs_extraction" }],
          resolved: false,
          accept_suggestion: false,
          assign_base: "",
          assign_base_path: "",
          mark_standalone: false,
          mark_source: false,
          force_role: null,
        });
      }

      if (s.role === ROLES.ATTACHED_EFFECT && s.suggested_attach && !s.attach_to_group_id) {
        mergeInto(s.path, {
          id: makeUnresolvedItemId(s.path, "attach"),
          path: s.path,
          folderRel: fr,
          reason_code: "ambiguous_attach",
          reason: "ATTACHED_EFFECT without attach_to_group_id (no linked base group)",
          required_action: "Set assign_base to a BASE filename in the folder, or mark_standalone / SHARED_EFFECT",
          role_if_known: s.role,
          group_id: null,
          suggested: {
            role: ROLES.SHARED_EFFECT,
            confidence_hint: "high",
            note: "When no base is chosen, shared effect is safer",
          },
          alternatives: [
            { role: ROLES.ATTACHED_EFFECT, confidence_hint: "low", note: "Requires assign_base to a base file" },
          ],
          resolved: false,
          accept_suggestion: false,
          assign_base: "",
          assign_base_path: "",
          mark_standalone: false,
          mark_source: false,
          force_role: null,
        });
      }
    }
  }

  return [...byPath.values()];
}

/**
 * Clear unresolved flags when the plan already satisfies them (e.g. base_override saved on group).
 */
export function pruneStaleUnresolvedFromPlan(plan) {
  let n = 0;
  for (const u of plan.unresolved_items ?? []) {
    if (u.resolved === true) continue;
    if (!u.group_id || !u.reason_codes?.includes("BASE_UNRESOLVED")) continue;
    for (const f of plan.folders ?? []) {
      const g = f.groups?.find((x) => x.id === u.group_id);
      if (
        g?.base_status === "BASE_UNRESOLVED" &&
        g.base_override_confirmed === true &&
        String(g.correct_base_label || "").trim()
      ) {
        u.resolved = true;
        n += 1;
      }
    }
  }
  return n;
}

/** When group base label maps to a PRIMARY route, clear group_routing_unknown rows. */
export function pruneResolvedFromGroupRouting(plan) {
  let n = 0;
  for (const u of plan.unresolved_items ?? []) {
    if (u.resolved === true) continue;
    if (!u.group_id || !(u.reason_codes ?? []).includes("group_routing_unknown")) continue;
    for (const f of plan.folders ?? []) {
      const g = f.groups?.find((x) => x.id === u.group_id);
      if (!g) continue;
      const label = effectiveGroupLabel(g);
      if (label && primaryDestRelForContent(label)) {
        u.resolved = true;
        n += 1;
      }
    }
  }
  return n;
}

function findStandaloneInPlan(plan, relPath) {
  const p = relPath.replace(/\\/g, "/");
  for (const f of plan.folders ?? []) {
    for (const s of f.standalone ?? []) {
      if (s.path.replace(/\\/g, "/") === p) return s;
    }
  }
  return null;
}

/**
 * When standalone rows are already approved with a routable label, clear matching unresolved_items.
 */
export function pruneResolvedFromStandaloneApprovals(plan) {
  let n = 0;
  for (const u of plan.unresolved_items ?? []) {
    if (u.resolved === true) continue;
    const codes = u.reason_codes ?? [];
    const s = findStandaloneInPlan(plan, u.path);
    if (codes.includes("ambiguous_attach")) {
      if (s?.attach_to_group_id && s.approved === true) {
        u.resolved = true;
        n += 1;
      }
      continue;
    }
    const needsStandaloneApprove = codes.some((c) =>
      ["usage_review", "routing_unknown_category", "missing_content_label"].includes(c),
    );
    if (!needsStandaloneApprove) continue;
    if (!s || s.approved !== true) continue;
    const raw = String(s.correct_label || s.content || s.predicted_label || "")
      .trim()
      .toLowerCase();
    if (!raw || raw === "unspecified") continue;
    if (!primaryDestRelForContent(raw)) continue;
    if (s.role === ROLES.ATTACHED_EFFECT && !s.attach_to_group_id) continue;
    u.resolved = true;
    n += 1;
  }
  return n;
}

/**
 * Apply one-click fields on unresolved_items into standalone / flags (in-memory; does not re-run grouping).
 */
/**
 * Safe one-click: if user sets `accept_base_suggestion: true` and the top ranked candidate is HIGH tier,
 * apply `base_override_confirmed` and `correct_base_label` from that candidate (does not re-run grouping).
 */
export function applyAcceptedBaseSuggestions(plan) {
  let n = 0;
  for (const f of plan.folders ?? []) {
    for (const g of f.groups ?? []) {
      if (g.base_status !== "BASE_UNRESOLVED") continue;
      if (g.accept_base_suggestion !== true) continue;
      const top = g.base_suggestion_ranking?.[0];
      if (!top || String(top.tier || "").toUpperCase() !== "HIGH") continue;
      const label = top.label || g.predicted_base_label;
      if (!String(label || "").trim()) continue;
      g.base_override_confirmed = true;
      if (!String(g.correct_base_label || "").trim()) g.correct_base_label = label;
      n += 1;
    }
  }
  return n;
}

export function applyReviewResolutions(plan) {
  const folders = plan.folders ?? [];
  const pathToStandalone = new Map();
  for (const f of folders) {
    for (const s of f.standalone ?? []) {
      pathToStandalone.set(s.path.replace(/\\/g, "/"), s);
    }
  }

  function findGroupWithBaseFile(baseName) {
    const bn = path.basename(baseName.trim()).toLowerCase();
    for (const fo of folders) {
      for (const g of fo.groups ?? []) {
        const hit = (g.files ?? []).find((file) => {
          const b = path.basename(file.path).toLowerCase();
          return (
            b === bn &&
            (file.role === ROLES.BASE || file.role === ROLES.COMPOSITE || file.role === ROLES.PART)
          );
        });
        if (hit) return { group: g };
      }
    }
    return null;
  }

  const counts = { applied: 0, mark_source: 0 };

  for (const u of plan.unresolved_items ?? []) {
    if (u.resolved === true) continue;

    if (u.mark_source === true) {
      u.resolved = true;
      counts.mark_source += 1;
      counts.applied += 1;
      continue;
    }

    if (u.mark_standalone === true) {
      const s = pathToStandalone.get(u.path.replace(/\\/g, "/"));
      if (s) {
        s.role = ROLES.STANDALONE;
        s.approved = true;
        s.attach_to_group_id = null;
        u.resolved = true;
        counts.applied += 1;
      }
      continue;
    }

    if (u.accept_suggestion === true && u.suggested?.role) {
      const s = pathToStandalone.get(u.path.replace(/\\/g, "/"));
      if (s) {
        s.role = u.suggested.role;
        s.approved = true;
        if (u.suggested.role === ROLES.ATTACHED_EFFECT) {
          s.suggested_attach = true;
        }
        u.resolved = true;
        counts.applied += 1;
      }
      continue;
    }

    const ab = String(u.assign_base ?? u.assign_base_path ?? "").trim();
    if (ab) {
      const found = findGroupWithBaseFile(ab);
      const s = pathToStandalone.get(u.path.replace(/\\/g, "/"));
      if (found && s) {
        s.attach_to_group_id = found.group.id;
        s.role = ROLES.ATTACHED_EFFECT;
        s.approved = true;
        u.resolved = true;
        counts.applied += 1;
      }
      continue;
    }

    const fr = String(u.force_role ?? "").trim();
    if (fr) {
      const s = pathToStandalone.get(u.path.replace(/\\/g, "/"));
      if (s) {
        s.role = fr;
        s.approved = true;
        u.resolved = true;
        counts.applied += 1;
      }
    }
  }

  return counts;
}

export function countBlockingUnresolved(plan) {
  const items = plan.unresolved_items ?? [];
  if (!items.length) {
    let legacy = 0;
    for (const f of plan.folders ?? []) legacy += f.unresolved?.length ?? 0;
    return legacy;
  }
  return items.filter((u) => u.resolved !== true).length;
}

export function listBlockingUnresolved(plan) {
  const items = plan.unresolved_items ?? [];
  if (items.length) return items.filter((u) => u.resolved !== true);
  const out = [];
  for (const f of plan.folders ?? []) {
    for (const u of f.unresolved ?? []) {
      out.push({ path: u.path, reason: u.reason, required_action: u.hint || "resolve usage_review" });
    }
  }
  return out;
}

function isEffectLike(row) {
  const vid = visualId(row.d);
  const fn = path.basename(row.d.file.absPath);
  if (EFFECT_IDS.has(vid)) return true;
  if (UI_FRAGMENT_IDS.has(vid) && confidence(row.d) < 0.35) return true;
  if (/explosion|muzzle|flash|spark|smoke|fire|burst/i.test(fn)) return true;
  return false;
}

function isUiFragmentLike(row) {
  return UI_FRAGMENT_IDS.has(visualId(row.d));
}

function dominantVisualId(cluster) {
  const counts = new Map();
  for (const r of cluster) {
    const v = visualId(r.d);
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      n = c;
      best = v;
    }
  }
  return best;
}

function isUnitishDominant(cluster) {
  const d = dominantVisualId(cluster);
  return d != null && UNITISH_DOMINANT.has(d);
}

function relationshipCount(row, cluster) {
  let n = 0;
  const v = visualId(row.d);
  const ek = extendedStemKey(row.d.file.relPosix);
  for (const o of cluster) {
    if (o.d.file.relPosix === row.d.file.relPosix) continue;
    if (visualId(o.d) === v) n += 1;
    else if (extendedStemKey(o.d.file.relPosix) === ek) n += 1;
  }
  return n;
}

function maxRelationshipInCluster(cluster) {
  let m = 0;
  for (const r of cluster) m = Math.max(m, relationshipCount(r, cluster));
  return m;
}

function hasVariantNaming(fn) {
  const b = path.basename(fn, path.extname(fn));
  return (
    VARIANT_NAME_RE.test(b) ||
    VERSION_SUFFIX_RE.test(b) ||
    ACTION_SUFFIX_RE.test(b)
  );
}

/**
 * Multi-signal BASE ranking (does not use CLIP thresholds — uses existing confidence + filenames).
 * @returns {{ score: number, breakdown: string[] }}
 */
function scoreBaseCandidate(row, cluster) {
  const fn = path.basename(row.d.file.relPosix);
  const lens = cluster.map((r) => path.basename(r.d.file.relPosix).length);
  const minLen = Math.min(...lens);
  const maxConf = Math.max(...cluster.map((r) => confidence(r.d)));
  const mr = maxRelationshipInCluster(cluster);
  const rc = relationshipCount(row, cluster);

  let score = 0;
  const breakdown = [];

  if (!looksLikeSequenceStrong(fn)) {
    score += 3;
    breakdown.push("+3 non_sequence");
  } else {
    score -= 3;
    breakdown.push("-3 sequence_pattern");
  }

  if (Math.abs(confidence(row.d) - maxConf) < 1e-9) {
    score += 3;
    breakdown.push("+3 highest_classification_confidence");
  }

  if (fn.length === minLen) {
    score += 2;
    breakdown.push("+2 shortest_filename");
  }

  const dom = dominantVisualId(cluster);
  if (dom && visualId(row.d) === dom) {
    score += 2;
    breakdown.push("+2 matches_dominant_label");
  }

  if (!hasVariantNaming(fn)) {
    score += 1;
    breakdown.push("+1 no_variant_suffix");
  } else {
    score -= 1;
    breakdown.push("-1 variant_naming");
  }

  if (mr > 0 && rc === mr) {
    score += 1;
    breakdown.push("+1 central_in_cluster");
  }

  if (isEffectLike(row)) {
    score -= 2;
    breakdown.push("-2 effect_like");
  }

  if (isUnitishDominant(cluster) && isUiFragmentLike(row)) {
    score -= 2;
    breakdown.push("-2 ui_like_in_unitish_group");
  }

  return { score, breakdown };
}

function ordinalTierForRank(sortedRanked, index) {
  const cur = sortedRanked[index];
  const next = sortedRanked[index + 1];
  if (!next) return index === 0 ? "HIGH" : "LOW";
  const gap = cur.score - next.score;
  if (gap >= 3) return "HIGH";
  if (gap >= 1) return "MEDIUM";
  /* Tied score — close competition between top ranks */
  return index <= 1 ? "MEDIUM" : "LOW";
}

function buildBaseSuggestionRanking(ranked) {
  return ranked.map((x, i) => ({
    path: x.row.d.file.relPosix,
    basename: x.fn,
    score: x.score,
    label: visualId(x.row.d),
    tier: ordinalTierForRank(ranked, i),
    breakdown: x.breakdown,
  }));
}

/**
 * Score grouping evidence for a cluster (same-folder batch).
 * Strong: multi-file stem, sequence patterns, extended-name alignment.
 * Weak: same visual id, ref embedding hint, ref visual top match, size sync, folder context.
 */
async function scoreGroupSignals(clusterRows) {
  const strong = [];
  const weak = [];
  const paths = clusterRows.map((r) => r.d.file.absPath);
  const sizes = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      sizes.push(st.size);
    } catch {
      sizes.push(0);
    }
  }

  if (clusterRows.length >= 2) {
    const stems = new Set(clusterRows.map((r) => stemClusterKey(path.basename(r.d.file.relPosix))));
    if (stems.size === 1) {
      strong.push("shared_filename_stem");
    }
  }

  let seqCount = 0;
  for (const r of clusterRows) {
    if (looksLikeSequenceStrong(path.basename(r.d.file.relPosix))) seqCount += 1;
  }
  if (seqCount >= 2) strong.push("sequence_pattern");

  const extStems = clusterRows.map((r) => extendedStemKey(r.d.file.relPosix));
  if (extStems.length >= 2 && new Set(extStems).size === 1) {
    strong.push("name_variant_root");
  }

  const visuals = clusterRows.map((r) => visualId(r.d)).filter(Boolean);
  if (visuals.length >= 2 && new Set(visuals).size === 1) {
    weak.push("same_clip_top_label");
  }

  const refTops = clusterRows.map((r) => refTopVisualId(r.d)).filter(Boolean);
  if (refTops.length >= 2 && new Set(refTops).size === 1) {
    weak.push("same_reference_visual_top");
  }

  const cosines = clusterRows.map((r) => refBestCosine(r.d)).filter((c) => c != null && !Number.isNaN(c));
  if (cosines.length >= 2) {
    const minC = Math.min(...cosines);
    const maxC = Math.max(...cosines);
    if (minC >= 0.22 && maxC - minC < 0.12) {
      weak.push("reference_embedding_band");
    }
  }

  if (sizes.length >= 2 && sizes.every((s) => s > 0)) {
    const mx = Math.max(...sizes);
    const mn = Math.min(...sizes);
    if (mn / mx >= 0.85) weak.push("similar_file_size");
  }

  weak.push("same_folder_context");

  const strongCount = strong.length;
  const weakOnly = weak.filter((w) => w !== "same_folder_context");
  const weakCount = weakOnly.length + (weak.includes("same_folder_context") ? 1 : 0);

  const passes = strongCount >= 1 || weakOnly.length >= 2;

  const summary = [...strong.map((s) => `strong:${s}`), ...weak.map((w) => `weak:${w}`)].join(
    "; ",
  );

  return { strong, weak, weakOnly, passes, summary, strongCount, weakCount: weakOnly.length + 1 };
}

/**
 * Pick BASE using multi-signal ranking. Returns BASE_UNRESOLVED when ambiguous or unsafe.
 * Does not change grouping membership — only which file is BASE within the cluster.
 */
function pickValidatedBase(cluster) {
  const ranked = cluster.map((row) => {
    const fn = path.basename(row.d.file.relPosix);
    const { score, breakdown } = scoreBaseCandidate(row, cluster);
    return { row, score, breakdown, fn };
  });
  ranked.sort((a, b) => {
    const d =
      b.score - a.score ||
      confidence(b.row.d) - confidence(a.row.d) ||
      a.fn.length - b.fn.length ||
      a.row.d.file.relPosix.localeCompare(b.row.d.file.relPosix);
    return d;
  });

  const validRanked = ranked.filter(
    (x) => !looksLikeSequenceStrong(x.fn) && !isEffectLike(x.row),
  );

  if (validRanked.length === 0) {
    return {
      status: "BASE_UNRESOLVED",
      reason: "no_valid_base_non_sequence_non_effect",
      pick: null,
      candidates: [],
      base_suggestion_ranking: buildBaseSuggestionRanking(ranked),
      suggestion_top_tier: "LOW",
      auto_resolved_base: false,
    };
  }

  const fullRanking = buildBaseSuggestionRanking(validRanked);

  const v0 = validRanked[0];
  const v1 = validRanked[1];
  const gap = v1 ? v0.score - v1.score : 999;
  const suggestionTopTier =
    !v1 || gap >= 3 ? "HIGH" : gap >= 1 ? "MEDIUM" : "LOW";

  if (v1 && v0.score === v1.score && visualId(v0.row.d) !== visualId(v1.row.d)) {
    return {
      status: "BASE_UNRESOLVED",
      reason: "score_tie_distinct_labels",
      pick: v0.row,
      candidates: validRanked.slice(0, 6).map((x) => ({
        path: x.row.d.file.relPosix,
        label: visualId(x.row.d),
        confidence: confidence(x.row.d),
        score: x.score,
      })),
      base_suggestion_ranking: fullRanking,
      suggestion_top_tier: "LOW",
      auto_resolved_base: false,
    };
  }

  if (validRanked.length === 1) {
    return {
      status: "OK",
      reason: null,
      pick: v0.row,
      candidates: [],
      base_suggestion_ranking: fullRanking,
      suggestion_top_tier: "HIGH",
      auto_resolved_base: true,
    };
  }

  if (v1 && gap >= 3 && suggestionTopTier === "HIGH") {
    if (visualId(v0.row.d) === visualId(v1.row.d)) {
      return {
        status: "OK",
        reason: null,
        pick: v0.row,
        candidates: [],
        base_suggestion_ranking: fullRanking,
        suggestion_top_tier: "HIGH",
        auto_resolved_base: true,
      };
    }
    return {
      status: "BASE_UNRESOLVED",
      reason: "top_gap_distinct_labels",
      pick: v0.row,
      candidates: validRanked.slice(0, 6).map((x) => ({
        path: x.row.d.file.relPosix,
        label: visualId(x.row.d),
        confidence: confidence(x.row.d),
        score: x.score,
      })),
      base_suggestion_ranking: fullRanking,
      suggestion_top_tier: "HIGH",
      auto_resolved_base: false,
    };
  }

  return {
    status: "BASE_UNRESOLVED",
    reason: "base_ambiguous_ranking",
    pick: v0.row,
    candidates: validRanked.slice(0, 6).map((x) => ({
      path: x.row.d.file.relPosix,
      label: visualId(x.row.d),
      confidence: confidence(x.row.d),
      score: x.score,
    })),
    base_suggestion_ranking: fullRanking,
    suggestion_top_tier: suggestionTopTier,
    auto_resolved_base: false,
  };
}

function assignRolesInCluster(cluster, basePick) {
  const basePath = basePick?.d?.file?.relPosix;
  if (!basePath) {
    return cluster.map((row) => ({
      path: row.d.file.relPosix,
      absPath: row.d.file.absPath,
      role: ROLES.STANDALONE,
      predicted_label: visualId(row.d),
      confidence: confidence(row.d),
      content: row.ext?.content ?? null,
    }));
  }
  const out = [];
  for (const row of cluster) {
    const fn = path.basename(row.d.file.relPosix);
    let role = ROLES.COMPOSITE;
    if (row.d.file.relPosix === basePath) role = ROLES.BASE;
    else if (PART_HINT.test(fn)) role = ROLES.PART;
    else if (looksLikeSequence(fn)) role = ROLES.COMPOSITE;
    out.push({
      path: row.d.file.relPosix,
      absPath: row.d.file.absPath,
      role,
      predicted_label: visualId(row.d),
      confidence: confidence(row.d),
      content: row.ext?.content ?? null,
    });
  }
  return out;
}

function roleForEffectSingleton({ d, hasStrongBase, multipleGroupsInFolder }) {
  const vid = visualId(d);
  const fn = path.basename(d.file.absPath);
  const effectLike =
    EFFECT_IDS.has(vid) || /explosion|muzzle|flash|spark|smoke|fire/i.test(fn) || UI_FRAGMENT_IDS.has(vid);

  if (effectLike) {
    if (hasStrongBase && !multipleGroupsInFolder) {
      return {
        role: ROLES.ATTACHED_EFFECT,
        attach_hint: true,
        effect_confidence: "low",
      };
    }
    return { role: ROLES.SHARED_EFFECT, attach_hint: false, effect_confidence: "n/a" };
  }
  if (PART_HINT.test(fn)) return { role: ROLES.STANDALONE, attach_hint: false, effect_confidence: "n/a" };
  return { role: ROLES.STANDALONE, attach_hint: false, effect_confidence: "n/a" };
}

/**
 * Build clusters: primary by stemClusterKey, then add extendedStem merges for remaining files.
 */
function buildStemClusters(movable) {
  const stemMap = new Map();
  for (const row of movable) {
    const fn = path.basename(row.d.file.relPosix);
    const stem = stemClusterKey(fn);
    if (!stemMap.has(stem)) stemMap.set(stem, []);
    stemMap.get(stem).push(row);
  }
  return stemMap;
}

function buildExtendedStemClusters(movable, assigned) {
  const extMap = new Map();
  for (const row of movable) {
    if (assigned.has(row.d.file.relPosix)) continue;
    const ek = extendedStemKey(row.d.file.relPosix);
    if (!extMap.has(ek)) extMap.set(ek, []);
    extMap.get(ek).push(row);
  }
  return extMap;
}

/**
 * Build review_groups payload from classified decisions (reference mode).
 */
export async function buildGroupReviewPayload(decisions, options = {}) {
  const { mergeFromPath = path.join(ROOT, "review_groups.json") } = options;

  /** @type {Map<string, Array<{d, ext}>>} */
  const byFolder = new Map();
  for (const d of decisions) {
    const ext = d.referenceAssetExtension;
    if (!ext) continue;
    const dir = path.posix.dirname(d.file.relPosix.replace(/\\/g, "/"));
    const key = dir === "." ? "" : dir;
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push({ d, ext });
  }

  const foldersOut = [];
  let groupSeq = 0;

  for (const [folderRel, rows] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sources = [];
    const movable = [];
    for (const row of rows) {
      if (isSourceExt(row.ext)) {
        sources.push({
          path: row.d.file.relPosix,
          role: ROLES.SOURCE,
          predicted_label: visualId(row.d),
          content: row.ext?.content ?? null,
        });
      } else {
        movable.push(row);
      }
    }

    const proposedGroups = [];
    const standalone = [];
    const unresolved = [];

    if (movable.length === 0) {
      foldersOut.push({
        folderRel,
        groups: [],
        standalone: [],
        sourceOnly: sources,
        unresolved: [],
        grouping_meta: { folder_context: "weak_only" },
      });
      continue;
    }

    const stemMap = buildStemClusters(movable);
    const assignedToGroup = new Set();
    const multiStems = [...stemMap.entries()].filter(([, c]) => c.length > 1);
    const hasStrongBaseFolder = multiStems.length >= 1;
    const multipleGroupsInFolder = multiStems.length > 1;

    for (const [stem, cluster] of stemMap.entries()) {
      if (cluster.length < 2) continue;

      const signals = await scoreGroupSignals(cluster);
      if (!signals.passes) {
        for (const row of cluster) {
          assignedToGroup.add(row.d.file.relPosix);
          standalone.push({
            path: row.d.file.relPosix,
            absPath: row.d.file.absPath,
            role: ROLES.STANDALONE,
            predicted_label: visualId(row.d),
            content: row.ext?.content ?? null,
            approved: false,
            correct_label: "",
            ungrouped_reason: "insufficient_grouping_signals",
            signals_summary: signals.summary,
          });
        }
        continue;
      }

      const baseResult = pickValidatedBase(cluster);
      const basePick = baseResult.pick;
      const provisional =
        basePick ??
        [...cluster].sort((a, b) => confidence(b.d) - confidence(a.d))[0];
      const predictedBaseLabel =
        basePick?.ext?.content && basePick.ext.content !== "unspecified"
          ? basePick.ext.content
          : visualId(provisional?.d) ?? "unspecified";

      const slug = normalizeAssetSlug(stem);
      const files = assignRolesInCluster(cluster, basePick ?? provisional);

      for (const r of cluster) {
        assignedToGroup.add(r.d.file.relPosix);
      }

      proposedGroups.push({
        id: `g${groupSeq++}`,
        slug,
        stemKey: stem,
        predicted_base_label: predictedBaseLabel,
        base_confidence: basePick != null ? confidence(basePick.d) : confidence(provisional?.d),
        roles_provisional: baseResult.status === "BASE_UNRESOLVED",
        base_status: baseResult.status,
        base_unresolved_reason:
          baseResult.status === "BASE_UNRESOLVED" ? baseResult.reason : null,
        base_candidates: baseResult.candidates?.length ? baseResult.candidates : undefined,
        base_suggestion_ranking: baseResult.base_suggestion_ranking ?? [],
        suggestion_top_tier: baseResult.suggestion_top_tier ?? null,
        auto_resolved_base: baseResult.auto_resolved_base === true,
        accept_base_suggestion: false,
        base_override_confirmed: false,
        grouping_signals: signals.summary,
        grouping_signals_detail: {
          strong: signals.strong,
          weak: signals.weak,
        },
        files,
        approved: false,
        correct_base_label: "",
        remove_paths: [],
        notes:
          baseResult.status === "BASE_UNRESOLVED"
            ? "BASE_UNRESOLVED — set correct_base_label + base_override_confirmed, accept_base_suggestion (if top tier HIGH), or fix remove_paths"
            : multipleGroupsInFolder
              ? "(Multiple groups in folder — confirm each.)"
              : "",
      });
    }

    const extMap = buildExtendedStemClusters(movable, assignedToGroup);
    for (const [, extCluster] of extMap.entries()) {
      if (extCluster.length < 2) continue;
      const signals = await scoreGroupSignals(extCluster);
      if (!signals.passes || signals.strong.includes("shared_filename_stem")) continue;

      const baseResult = pickValidatedBase(extCluster);
      const basePick = baseResult.pick;
      const provisional =
        basePick ??
        [...extCluster].sort((a, b) => confidence(b.d) - confidence(a.d))[0];

      const stem = extendedStemKey(provisional.d.file.relPosix);
      const predictedBaseLabel =
        basePick?.ext?.content && basePick.ext.content !== "unspecified"
          ? basePick.ext.content
          : visualId(provisional.d) ?? "unspecified";
      const slug = normalizeAssetSlug(stem);
      const files = assignRolesInCluster(extCluster, basePick ?? provisional);

      for (const r of extCluster) {
        assignedToGroup.add(r.d.file.relPosix);
      }

      proposedGroups.push({
        id: `g${groupSeq++}`,
        slug,
        stemKey: stem + "_variant",
        predicted_base_label: predictedBaseLabel,
        base_confidence: basePick != null ? confidence(basePick.d) : confidence(provisional.d),
        base_status: baseResult.status,
        base_unresolved_reason:
          baseResult.status === "BASE_UNRESOLVED" ? baseResult.reason : null,
        base_candidates: baseResult.candidates?.length ? baseResult.candidates : undefined,
        base_suggestion_ranking: baseResult.base_suggestion_ranking ?? [],
        suggestion_top_tier: baseResult.suggestion_top_tier ?? null,
        auto_resolved_base: baseResult.auto_resolved_base === true,
        accept_base_suggestion: false,
        base_override_confirmed: false,
        roles_provisional: baseResult.status === "BASE_UNRESOLVED",
        grouping_signals: signals.summary,
        grouping_signals_detail: {
          strong: signals.strong,
          weak: signals.weak,
        },
        files,
        approved: false,
        correct_base_label: "",
        remove_paths: [],
        notes: "Extended name-variant cluster — verify BASE in review.",
      });
    }

    for (const row of movable) {
      if (assignedToGroup.has(row.d.file.relPosix)) continue;
      const er = roleForEffectSingleton({
        d: row.d,
        hasStrongBase: hasStrongBaseFolder,
        multipleGroupsInFolder,
      });
      standalone.push({
        path: row.d.file.relPosix,
        absPath: row.d.file.absPath,
        role: er.role,
        predicted_label: visualId(row.d),
        content: row.ext?.content ?? null,
        approved: false,
        correct_label: "",
        suggested_attach: er.attach_hint,
        effect_classification: er.role === ROLES.ATTACHED_EFFECT ? "attached_low_confidence" : "shared",
        attach_to_group_id: null,
      });
    }

    const seenU = new Set();
    for (const row of movable) {
      if (row.ext?.usage === "review" && !seenU.has(row.d.file.relPosix)) {
        seenU.add(row.d.file.relPosix);
        unresolved.push({
          path: row.d.file.relPosix,
          reason: "usage_review",
          hint: "Approve standalone or correct labels in review_groups.json before execute",
        });
      }
    }

    foldersOut.push({
      folderRel,
      groups: proposedGroups,
      standalone,
      sourceOnly: sources,
      unresolved,
      grouping_meta: {
        folder_context: "weak_signal_only",
        multi_group_folder: multipleGroupsInFolder,
      },
    });
  }

  let previous = null;
  if (await fs.pathExists(mergeFromPath)) {
    try {
      previous = await fs.readJson(mergeFromPath);
    } catch {
      previous = null;
    }
  }

  const unresolvedMaster = buildMasterUnresolvedItems(foldersOut);

  const merged = mergeApprovalsIntoPayload(
    {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      referenceRoot: NEW_ARRIVALS_PREFIX + "/",
      folders: foldersOut,
      unresolved_items: unresolvedMaster,
    },
    previous,
  );

  return merged;
}

function mergeApprovalsIntoPayload(fresh, old) {
  if (old?.unresolved_items?.length && fresh.unresolved_items?.length) {
    const byId = new Map(old.unresolved_items.map((u) => [u.id, u]));
    const byPath = new Map(old.unresolved_items.map((u) => [u.path, u]));
    for (const u of fresh.unresolved_items) {
      const pu = byId.get(u.id) ?? byPath.get(u.path);
      if (!pu) continue;
      if (pu.resolved === true) u.resolved = true;
      if (pu.accept_suggestion === true) u.accept_suggestion = true;
      if (pu.mark_standalone === true) u.mark_standalone = true;
      if (pu.mark_source === true) u.mark_source = true;
      if (String(pu.assign_base ?? pu.assign_base_path ?? "").trim()) {
        u.assign_base = pu.assign_base ?? u.assign_base;
        u.assign_base_path = pu.assign_base_path ?? u.assign_base_path;
      }
      if (String(pu.force_role ?? "").trim()) u.force_role = pu.force_role;
    }
  }

  if (!old?.folders?.length) return fresh;
  const oldByFolder = new Map(old.folders.map((f) => [f.folderRel, f]));
  for (const f of fresh.folders) {
    const prev = oldByFolder.get(f.folderRel);
    if (!prev) continue;
    const prevGroups = new Map(prev.groups?.map((g) => [g.stemKey + g.slug, g]) ?? []);
    for (const g of f.groups) {
      const key = g.stemKey + g.slug;
      const pg = prevGroups.get(key);
      if (pg) {
        if (pg.approved === true) g.approved = true;
        if (pg.correct_base_label) g.correct_base_label = pg.correct_base_label;
        if (pg.remove_paths?.length) g.remove_paths = pg.remove_paths;
        if (pg.notes && !g.notes) g.notes = pg.notes;
        if (pg.base_override_confirmed === true) g.base_override_confirmed = true;
        if (pg.accept_base_suggestion === true) g.accept_base_suggestion = true;
      }
    }
    const prevStandalone = new Map((prev.standalone ?? []).map((s) => [s.path, s]));
    for (const s of f.standalone) {
      const ps = prevStandalone.get(s.path);
      if (ps) {
        if (ps.approved === true) s.approved = true;
        if (ps.correct_label) s.correct_label = ps.correct_label;
      }
    }
  }
  return fresh;
}

function formatSuggestionBlock(u) {
  const lines = [];
  if (u.suggested?.role) {
    lines.push(
      `  - **Suggested:** \`${u.suggested.role}\` (${u.suggested.confidence_hint || "—"})${u.suggested.note ? ` — ${u.suggested.note}` : ""}`,
    );
  }
  if (u.alternatives?.length) {
    for (const a of u.alternatives) {
      lines.push(
        `  - **Alternative:** \`${a.role}\` (${a.confidence_hint || "—"})${a.note ? ` — ${a.note}` : ""}`,
      );
    }
  }
  return lines.length ? lines.join("\n") : "  - *(no heuristic suggestion)*";
}

export function renderGroupReviewMarkdown(payload) {
  const lines = [
    "# Group review (relationship-aware pipeline)",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "Edit **`review_groups.json`** to approve (`approved: true`), `correct_base_label`, `base_override_confirmed` if BASE_UNRESOLVED, or `accept_base_suggestion: true` when the top suggested base is tier HIGH.",
    "Then run: `node tools/execute_group_moves.mjs` (`--dry-run` first).",
    "",
    "**Nothing moves without explicit approval.** SOURCE rows are never moved.",
    "",
    "---",
    "",
    "## ❗ UNRESOLVED ITEMS (BLOCKING)",
    "",
  ];

  const master = payload.unresolved_items ?? [];
  if (!master.length) {
    lines.push("*None. All clear.*", "");
  } else {
    let i = 0;
    for (const u of master) {
      i += 1;
      lines.push(`### ${i}. \`${path.basename(u.path)}\``, "");
      lines.push(`- **file:** \`${u.path}\``);
      if (u.folderRel) lines.push(`- **folder:** \`${u.folderRel}\``);
      if (u.role_if_known) lines.push(`- **role (known):** ${u.role_if_known}`);
      if (u.group_id) lines.push(`- **group_id:** \`${u.group_id}\``);
      lines.push(`- **reason:** ${u.reason}`);
      lines.push(`- **required action:** ${u.required_action}`);
      if (u.reason_codes?.length) {
        lines.push(`- **codes:** \`${u.reason_codes.join(", ")}\``);
      }
      lines.push("- **suggestions (do not auto-apply):**");
      lines.push(formatSuggestionBlock(u));
      lines.push(`- **id:** \`${u.id}\` — set \`resolved: true\`, or use \`accept_suggestion\` / \`assign_base\` / \`mark_standalone\` / \`mark_source\` / \`force_role\` in \`review_groups.json\`.`);
      lines.push("");
    }
  }

  lines.push("---", "");

  for (const folder of payload.folders) {
    lines.push(`## Folder: \`${folder.folderRel || "(root)"}\``, "");
    if (folder.sourceOnly?.length) {
      lines.push("### SOURCE (not moved)", "");
      for (const s of folder.sourceOnly) {
        lines.push(`- \`${s.path}\``);
      }
      lines.push("");
    }
    for (const g of folder.groups ?? []) {
      lines.push(`### GROUP: ${g.slug}`, "");
      lines.push(`- **id:** \`${g.id}\`  |  **base_status:** ${g.base_status}`);
      lines.push(`- **Base (predicted):** \`${g.predicted_base_label}\`  (conf: ${g.base_confidence ?? "—"})`);
      lines.push(`- **Signals:** ${g.grouping_signals || "—"}`);
      if (g.base_suggestion_ranking?.length) {
        lines.push(`- **Suggested base (ranked):**`);
        let rnk = 0;
        for (const r of g.base_suggestion_ranking.slice(0, 10)) {
          rnk += 1;
          lines.push(
            `  ${rnk}. \`${r.basename}\` — score: **${r.score}**, **${r.tier}**${r.label ? ` (label: \`${r.label}\`)` : ""}`,
          );
        }
        if (g.suggestion_top_tier) {
          lines.push(`- **Top suggestion tier:** ${g.suggestion_top_tier}${g.auto_resolved_base ? " (auto-resolved in export)" : ""}`);
        }
      }
      if (g.base_status === "BASE_UNRESOLVED") {
        lines.push(`- **Requires:** \`correct_base_label\` + \`base_override_confirmed: true\`, or \`accept_base_suggestion: true\` when top candidate tier is HIGH`);
      }
      lines.push(`- **Files:**`);
      for (const f of g.files) {
        lines.push(`  - \`${f.path}\` (${f.role})`);
      }
      lines.push("");
    }
    for (const s of folder.standalone ?? []) {
      lines.push(`### STANDALONE: \`${path.basename(s.path)}\``, "");
      lines.push(
        `- role: **${s.role}** | effect: ${s.effect_classification ?? "—"} | suggested_attach: ${s.suggested_attach ?? false}`,
      );
      lines.push("");
    }
    if (folder.unresolved?.length) {
      lines.push(
        "*Folder-level usage:review rows — see **UNRESOLVED ITEMS (BLOCKING)** at top for full detail.*",
        "",
      );
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}
