#!/usr/bin/env node
/**
 * Staged migration helper — no bulk ref rewrites from this tool.
 *
 *   node tools/safe_attached_migration/cli.mjs mapping   ? tools/reports/attached_migration_mapping.json
 *   node tools/safe_attached_migration/cli.mjs dry-run   ? tools/reports/attached_migration_dry_run.json
 *   node tools/safe_attached_migration/cli.mjs copy      ? copy files that exist at old path to new path (preserve attached_assets)
 *
 * Ref updates (spriteAnimations, maps, etc.) are a separate manual or scripted pass
 * only for paths listed as ok:true in dry-run.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mapAttachedPath } from "./pathMapper.mjs";
import { collectAuthoritativeAttachedPaths } from "./collectRefs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const REPORT_DIR = path.join(ROOT, "tools", "reports");

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel.replace(/\\/g, "/")));
}

function cmdMapping() {
  const refs = collectAuthoritativeAttachedPaths();
  const rows = refs.map((oldPath) => {
    const m = mapAttachedPath(oldPath);
    return {
      oldPath,
      newPath: m.newPath,
      type: m.type,
      subtype: m.subtype ?? null,
    };
  });
  ensureDir(REPORT_DIR);
  const out = path.join(REPORT_DIR, "attached_migration_mapping.json");
  fs.writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, mappings: rows }, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, out)} (${rows.length} paths)`);
}

function cmdDryRun() {
  const refs = collectAuthoritativeAttachedPaths();
  const missingSource = [];
  const ambiguous = [];
  const conflicts = [];
  const ok = [];

  for (const oldPath of refs) {
    if (!exists(oldPath)) {
      missingSource.push(oldPath);
      continue;
    }
    const m = mapAttachedPath(oldPath);
    if (m.type === "unknown") ambiguous.push({ oldPath, newPath: m.newPath });
    const newPath = m.newPath;
    const destAbs = path.join(ROOT, newPath);
    if (fs.existsSync(destAbs)) {
      try {
        const so = fs.statSync(path.join(ROOT, oldPath));
        const sd = fs.statSync(destAbs);
        if (so.size !== sd.size) {
          conflicts.push({ oldPath, newPath, reason: "dest_exists_different_size" });
        } else {
          ok.push({ oldPath, newPath, note: "dest_exists_same_size_skip_copy" });
        }
      } catch {
        conflicts.push({ oldPath, newPath, reason: "stat_error" });
      }
    } else {
      ok.push({ oldPath, newPath, note: "ready_to_copy" });
    }
  }

  ensureDir(REPORT_DIR);
  const payload = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRefs: refs.length,
      missingSource: missingSource.length,
      ambiguous: ambiguous.length,
      conflicts: conflicts.length,
      ok: ok.length,
    },
    missingSource,
    ambiguous,
    conflicts,
    ok,
  };
  const out = path.join(REPORT_DIR, "attached_migration_dry_run.json");
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, out)}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

function cmdCopy() {
  const refs = collectAuthoritativeAttachedPaths();
  let copied = 0;
  let skipped = 0;
  const errors = [];
  for (const oldPath of refs) {
    const src = path.join(ROOT, oldPath);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const m = mapAttachedPath(oldPath);
    const newPath = m.newPath;
    const dest = path.join(ROOT, newPath);
    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied++;
    } catch (e) {
      errors.push({ oldPath, newPath, error: String(e?.message || e) });
    }
  }
  ensureDir(REPORT_DIR);
  const rep = path.join(REPORT_DIR, "attached_migration_copy_log.json");
  fs.writeFileSync(
    rep,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), copied, skipped, errors }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ copied, skipped, errors: errors.length, log: path.relative(ROOT, rep) }, null, 2));
}

const cmd = process.argv[2] || "help";
if (cmd === "mapping") cmdMapping();
else if (cmd === "dry-run") cmdDryRun();
else if (cmd === "copy") cmdCopy();
else {
  console.log("Usage: mapping | dry-run | copy");
}
