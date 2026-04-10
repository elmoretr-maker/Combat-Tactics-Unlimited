#!/usr/bin/env node
/**
 * Execute approved moves from review_groups.json (group pipeline).
 * Does not run CLIP. Use --dry-run to preview.
 *
 *   node tools/execute_group_moves.mjs
 *   node tools/execute_group_moves.mjs --dry-run
 *   node tools/execute_group_moves.mjs --allow-unresolved
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { primaryDestRelForContent, compositeDestRelForContent } from "./lib/primary_dest.mjs";
import {
  normalizeAssetSlug,
  ROLES,
  applyAcceptedBaseSuggestions,
  applyReviewResolutions,
  pruneStaleUnresolvedFromPlan,
  pruneResolvedFromGroupRouting,
  pruneResolvedFromStandaloneApprovals,
  listBlockingUnresolved,
} from "./lib/folder_asset_pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PLAN_PATH = path.join(ROOT, "review_groups.json");

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry-run");
const ALLOW_UNRESOLVED = ARGS.has("--allow-unresolved");

async function uniqueDestPathPrimaryFile(destFilePath) {
  if (!(await fs.pathExists(destFilePath))) return destFilePath;
  const dir = path.dirname(destFilePath);
  const ext = path.extname(destFilePath);
  const base = path.basename(destFilePath, ext);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(dir, `${base}_primary${i}${ext}`);
    i += 1;
  } while (await fs.pathExists(candidate));
  return candidate;
}

async function uniqueDestDirPath(destDir) {
  if (!(await fs.pathExists(destDir))) return destDir;
  const parent = path.dirname(destDir);
  const base = path.basename(destDir);
  let i = 1;
  let candidate;
  do {
    candidate = path.join(parent, `${base}_group${i}`);
    i += 1;
  } while (await fs.pathExists(candidate));
  return candidate;
}

function isPathUnderRoot(absPath, rootAbs) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(rootAbs);
  const rel = path.relative(root, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function contentLabelForMove(predicted, correct) {
  const c = String(correct || predicted || "").trim().toLowerCase();
  return c || null;
}

async function run() {
  if (!(await fs.pathExists(PLAN_PATH))) {
    console.error(`execute_group_moves: missing ${path.relative(ROOT, PLAN_PATH)}`);
    process.exitCode = 1;
    return;
  }

  const plan = await fs.readJson(PLAN_PATH);
  const SOURCE_DIR = path.join(ROOT, "assets", "New_Arrivals");

  const acceptBaseApplied = applyAcceptedBaseSuggestions(plan);

  pruneStaleUnresolvedFromPlan(plan);
  const prunedStandalone = pruneResolvedFromStandaloneApprovals(plan);
  const resolutionCounts = applyReviewResolutions(plan);

  const blockingUnresolved = listBlockingUnresolved(plan);
  const unresolvedTotal = blockingUnresolved.length;

  if (unresolvedTotal > 0 && !ALLOW_UNRESOLVED) {
    console.error("Execution blocked: unresolved assets must be resolved before moving");
    console.error("");
    for (const u of blockingUnresolved) {
      const p = u.path ?? u.file;
      const r = u.reason ?? u.required_action ?? "";
      console.error(`   — ${p}: ${r}`);
    }
    process.exitCode = 1;
    return;
  }
  if (unresolvedTotal > 0 && ALLOW_UNRESOLVED) {
    console.warn(
      "\n⚠️  execute_group_moves: --allow-unresolved — execution proceeds while unresolved items remain. Review list below.\n",
    );
    for (const u of blockingUnresolved) {
      const p = u.path ?? u.file;
      const r = u.reason ?? "";
      const a = u.required_action ?? "";
      console.warn(`   — ${p}`);
      console.warn(`     reason: ${r}`);
      if (a) console.warn(`     action: ${a}`);
    }
    console.warn("");
  }

  const markSourcePaths = new Set();
  for (const u of plan.unresolved_items ?? []) {
    if (u.mark_source === true) markSourcePaths.add(u.path.replace(/\\/g, "/"));
  }

  const moved = [];
  const skipped = [];
  const errors = [];
  const blocked = [];
  const routingBlocked = [];

  for (const folder of plan.folders ?? []) {
    const groupById = new Map((folder.groups ?? []).map((g) => [g.id, g]));

    for (const g of folder.groups ?? []) {
      if (g.approved !== true) {
        for (const file of g.files ?? []) {
          skipped.push({ path: file.path, reason: "group_not_approved" });
        }
        continue;
      }

      if (g.base_status === "BASE_UNRESOLVED" && g.base_override_confirmed !== true) {
        blocked.push({
          group_id: g.id,
          reason: "BASE_UNRESOLVED — set correct_base_label and base_override_confirmed: true",
        });
        for (const file of g.files ?? []) {
          skipped.push({ path: file.path, reason: "base_unresolved_not_overridden" });
        }
        continue;
      }

      const label = contentLabelForMove(g.predicted_base_label, g.correct_base_label);
      const destPrimaryRoot = primaryDestRelForContent(label);
      const destCompositeRoot = compositeDestRelForContent(label);
      if (!destPrimaryRoot || !destCompositeRoot) {
        for (const file of g.files ?? []) {
          routingBlocked.push({ path: file.path, reason: `no route for label "${label}"` });
          skipped.push({ path: file.path, reason: "routing_unknown" });
        }
        continue;
      }

      const remove = new Set((g.remove_paths ?? []).map((p) => p.replace(/\\/g, "/")));
      const assetName = normalizeAssetSlug(g.slug || g.predicted_base_label || "asset");

      const baseDirPrimary = path.join(ROOT, destPrimaryRoot, assetName);
      const baseDirComposite = path.join(ROOT, destCompositeRoot, assetName);

      for (const file of g.files ?? []) {
        if (markSourcePaths.has(file.path.replace(/\\/g, "/"))) {
          skipped.push({ path: file.path, reason: "mark_source" });
          continue;
        }
        if (remove.has(file.path)) {
          skipped.push({ path: file.path, reason: "removed_by_user" });
          continue;
        }
        const absFrom = path.join(SOURCE_DIR, ...file.path.split("/"));
        if (!(await fs.pathExists(absFrom))) {
          errors.push(`${file.path}: source missing`);
          continue;
        }
        if (!isPathUnderRoot(absFrom, SOURCE_DIR)) {
          errors.push(`${file.path}: not under New_Arrivals`);
          continue;
        }

        const fn = path.basename(file.path);
        let destAbs;
        if (file.role === ROLES.BASE || file.role === ROLES.PART) {
          if (file.role === ROLES.PART) {
            destAbs = path.join(baseDirPrimary, "parts", fn);
          } else {
            destAbs = path.join(baseDirPrimary, fn);
          }
        } else if (file.role === ROLES.COMPOSITE) {
          destAbs = path.join(baseDirComposite, fn);
        } else if (file.role === ROLES.ATTACHED_EFFECT) {
          destAbs = path.join(baseDirComposite, "effects", fn);
        } else {
          destAbs = path.join(baseDirPrimary, fn);
        }

        try {
          if (!isPathUnderRoot(path.dirname(destAbs), ROOT)) throw new Error("dest outside ROOT");
          if (DRY) {
            moved.push({ from: absFrom, to: destAbs, dry: true });
          } else {
            await fs.ensureDir(path.dirname(destAbs));
            const finalTo = await uniqueDestPathPrimaryFile(destAbs);
            await fs.move(absFrom, finalTo, { overwrite: false });
            moved.push({ from: absFrom, to: finalTo, dry: false });
          }
        } catch (e) {
          errors.push(`${file.path}: ${e?.message || e}`);
        }
      }
    }

    for (const s of folder.standalone ?? []) {
      if (markSourcePaths.has(s.path.replace(/\\/g, "/"))) {
        skipped.push({ path: s.path, reason: "mark_source" });
        continue;
      }
      if (s.approved !== true) {
        skipped.push({ path: s.path, reason: "standalone_not_approved" });
        continue;
      }
      const absFrom = path.join(SOURCE_DIR, ...s.path.split("/"));
      if (!(await fs.pathExists(absFrom))) {
        errors.push(`${s.path}: source missing`);
        continue;
      }

      let destAbs;
      if (s.role === ROLES.ATTACHED_EFFECT && s.attach_to_group_id) {
        const g = groupById.get(s.attach_to_group_id);
        if (g?.approved !== true) {
          skipped.push({ path: s.path, reason: "parent_group_not_approved" });
          continue;
        }
        if (g.base_status === "BASE_UNRESOLVED" && g.base_override_confirmed !== true) {
          skipped.push({ path: s.path, reason: "parent_base_unresolved" });
          continue;
        }
        const label = contentLabelForMove(g.predicted_base_label, g.correct_base_label);
        const destCompositeRoot = compositeDestRelForContent(label);
        if (!destCompositeRoot) {
          routingBlocked.push({ path: s.path, reason: "no composite route" });
          skipped.push({ path: s.path, reason: "routing_unknown" });
          continue;
        }
        const assetName = normalizeAssetSlug(g.slug || g.predicted_base_label || "asset");
        destAbs = path.join(ROOT, destCompositeRoot, assetName, "effects", path.basename(s.path));
      } else {
        const label = contentLabelForMove(s.content, s.correct_label) || s.predicted_label;
        const destRoot = primaryDestRelForContent(label);
        if (!destRoot) {
          routingBlocked.push({ path: s.path, reason: `no PRIMARY route for label "${label}"` });
          skipped.push({ path: s.path, reason: "routing_unknown" });
          continue;
        }
        if (s.role === ROLES.SHARED_EFFECT) {
          destAbs = path.join(ROOT, "assets", "PRIMARY", "effects", path.basename(s.path));
        } else {
          destAbs = path.join(ROOT, destRoot, path.basename(s.path));
        }
      }

      try {
        if (DRY) {
          moved.push({ from: absFrom, to: destAbs, dry: true });
        } else {
          await fs.ensureDir(path.dirname(destAbs));
          const finalTo = await uniqueDestPathPrimaryFile(destAbs);
          await fs.move(absFrom, finalTo, { overwrite: false });
          moved.push({ from: absFrom, to: finalTo, dry: false });
        }
      } catch (e) {
        errors.push(`${s.path}: ${e?.message || e}`);
      }
    }
  }

  let nToComposite = 0;
  let nToPrimaryFlat = 0;
  let nToEffects = 0;
  let nToParts = 0;
  for (const m of moved) {
    const rel = path.relative(ROOT, m.to).replace(/\\/g, "/");
    if (rel.includes("/parts/")) nToParts += 1;
    else if (rel.includes("assets/COMPOSITE")) nToComposite += 1;
    else if (rel.includes("assets/PRIMARY/effects/")) nToEffects += 1;
    else if (rel.startsWith("assets/PRIMARY/")) nToPrimaryFlat += 1;
  }

  const skippedNotApproved = skipped.filter((s) =>
    ["group_not_approved", "standalone_not_approved"].includes(s.reason),
  ).length;
  const skippedBase = skipped.filter((s) => s.reason === "base_unresolved_not_overridden").length;
  const skippedRouting = skipped.filter((s) => s.reason === "routing_unknown").length;
  const skippedMarkSource = skipped.filter((s) => s.reason === "mark_source").length;

  const reasonHistogram = {};
  for (const u of plan.unresolved_items ?? []) {
    for (const c of u.reason_codes ?? []) {
      reasonHistogram[c] = (reasonHistogram[c] || 0) + 1;
    }
  }
  console.log(DRY ? "\n=== execute_group_moves (dry-run) ===\n" : "\n=== execute_group_moves ===\n");
  console.log(`   moves: ${moved.length}${DRY ? " (simulated)" : ""}`);
  console.log(`   skipped: ${skipped.length} (not approved: ${skippedNotApproved}, base_unresolved: ${skippedBase}, routing: ${skippedRouting}, mark_source: ${skippedMarkSource})`);
  console.log(`   errors: ${errors.length}`);
  if (blocked.length) {
    console.log(`   blocked groups (BASE_UNRESOLVED): ${blocked.length}`);
    for (const b of blocked) console.log(`      — ${b.group_id}: ${b.reason}`);
  }
  if (routingBlocked.length) {
    console.log(`   routing blocked (no move): ${routingBlocked.length}`);
  }
  if (errors.length) {
    for (const e of errors) console.log(`   ! ${e}`);
  }
  console.log("");
  console.log("--- reporting ---");
  console.log(`   → COMPOSITE tree (files): ${nToComposite}`);
  console.log(`   → PRIMARY (flat / base / parts): ${nToPrimaryFlat + nToParts} (parts: ${nToParts})`);
  console.log(`   → PRIMARY/effects (shared): ${nToEffects}`);
  console.log(`   files moved (total): ${moved.length}`);
  console.log(`   unresolved items (blocking count before override): ${unresolvedTotal}`);
  console.log(`   unresolved total rows in plan: ${(plan.unresolved_items ?? []).length}`);
  if (Object.keys(reasonHistogram).length) {
    console.log(`   unresolved reason codes: ${JSON.stringify(reasonHistogram)}`);
  }
  console.log(
    `   accept_base_suggestion applied: ${acceptBaseApplied}; auto-cleared: group routing ${prunedGroupRoute}, standalone approvals ${prunedStandalone}; one-click applied: ${resolutionCounts.applied} (mark_source: ${resolutionCounts.mark_source})`,
  );
  if (unresolvedTotal && ALLOW_UNRESOLVED) {
    console.log(`   execution allowed with --allow-unresolved (see warning above)`);
  }
  console.log("");
}

run().catch((e) => {
  console.error("execute_group_moves:", e?.message || e);
  process.exitCode = 1;
});
