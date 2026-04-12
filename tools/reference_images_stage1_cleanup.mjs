/**
 * Stage 1: reference_images cleanup — moves only (no deletes).
 * Archives duplicates under reference_images/_duplicates_archive/
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const REPO = process.cwd();
const REF = path.join(REPO, "reference_images");
const ARCHIVE = path.join(REF, "_duplicates_archive");
const IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".bmp"]);

const report = {
  withinFolderArchived: [],
  crossFolderArchived: [],
  terrainToDebris: [],
  uiNormalized: [],
  emptyDirsRemoved: [],
  errors: [],
};

function walkImages(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory() && ent.name === "_duplicates_archive") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkImages(p, out);
    else if (IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

function relRef(abs) {
  return path.relative(REF, abs).split(path.sep).join("/");
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function uniqueDest(dst) {
  if (!fs.existsSync(dst)) return dst;
  const dir = path.dirname(dst);
  const ext = path.extname(dst);
  const base = path.basename(dst, ext);
  let i = 1;
  let alt;
  do {
    alt = path.join(dir, `${base}_moved${i}${ext}`);
    i++;
  } while (fs.existsSync(alt));
  return alt;
}

function moveFile(src, dst) {
  ensureDir(path.dirname(dst));
  dst = uniqueDest(dst);
  fs.renameSync(src, dst);
  return dst;
}

function sha256File(fp) {
  return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function dedupeWithinEachDirectory() {
  const files = walkImages(REF);
  const byDir = new Map();
  for (const fp of files) {
    const d = path.dirname(fp);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(fp);
  }
  for (const [, group] of byDir) {
    const byHash = new Map();
    for (const fp of group) {
      const h = sha256File(fp);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(fp);
    }
    for (const [, paths] of byHash) {
      if (paths.length < 2) continue;
      paths.sort((a, b) => relRef(a).localeCompare(relRef(b)));
      const [keep, ...dupes] = paths;
      for (const dup of dupes) {
        const r = relRef(dup);
        const dest = path.join(ARCHIVE, "within_folder", r.split("/").join(path.sep));
        const finalDst = moveFile(dup, dest);
        report.withinFolderArchived.push({ from: r, to: relRef(finalDst), kept: relRef(keep) });
      }
    }
  }
}

function archiveCrossFolderDupes() {
  const refFiles = walkImages(REF).filter((fp) => !fp.startsWith(ARCHIVE + path.sep));
  const byHash = new Map();
  for (const fp of refFiles) {
    const h = sha256File(fp);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(fp);
  }

  const archiveGroup = (paths, keeperRel) => {
    const keeper = paths.find((p) => relRef(p) === keeperRel);
    if (!keeper) return;
    for (const fp of paths) {
      if (fp === keeper) continue;
      const r = relRef(fp);
      const dest = path.join(ARCHIVE, "cross_folder", r.split("/").join(path.sep));
      const finalDst = moveFile(fp, dest);
      report.crossFolderArchived.push({ from: r, to: relRef(finalDst), kept: keeperRel });
    }
  };

  for (const [, paths] of byHash) {
    if (paths.length < 2) continue;
    const rels = paths.map(relRef);
    const names = new Set(paths.map((p) => path.basename(p).toLowerCase()));
    if (names.has("_ref.png") && rels.every((r) => r.endsWith("_ref.png"))) {
      archiveGroup(paths, "tile/_ref.png");
      continue;
    }
    if (names.has("btn retry.png") && rels.some((r) => r.toLowerCase().includes("btn retry"))) {
      const norm = rels.filter((r) => r.toLowerCase().endsWith("btn retry.png"));
      if (norm.length >= 2) {
        const keeperPath = paths.find((p) => relRef(p) === "ui_button/BTN Retry.png");
        if (keeperPath) {
          for (const fp of paths) {
            if (fp === keeperPath) continue;
            if (relRef(fp).toLowerCase() !== "ui_panel/btn retry.png") continue;
            const r = relRef(fp);
            const dest = path.join(ARCHIVE, "cross_folder", r.split("/").join(path.sep));
            const finalDst = moveFile(fp, dest);
            report.crossFolderArchived.push({ from: r, to: relRef(finalDst), kept: "ui_button/BTN Retry.png" });
          }
        }
      }
    }
  }
}

function moveTerrainGroundTexturesToDebris() {
  const srcDir = path.join(REF, "terrain", "ground textures");
  if (!fs.existsSync(srcDir)) return;
  const destDir = path.join(REF, "debris", "terrain_ground_textures");
  ensureDir(destDir);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    const from = path.join(srcDir, ent.name);
    const to = path.join(destDir, ent.name);
    const finalDst = moveFile(from, to);
    report.terrainToDebris.push({ from: `terrain/ground textures/${ent.name}`, to: relRef(finalDst) });
  }
  try {
    const left = fs.readdirSync(srcDir);
    if (left.length === 0) {
      fs.rmdirSync(srcDir);
      report.emptyDirsRemoved.push(relRef(srcDir));
    }
  } catch (e) {
    report.errors.push(String(e));
  }
}

function normalizeUiPlacement() {
  const moves = [
    { from: path.join(REF, "ui_panel", "PAUSE PRESET.png"), to: path.join(REF, "ui_hud", "PAUSE PRESET.png"), reason: "pause overlay → HUD" },
    { from: path.join(REF, "ui_panel", "Test Logo.png"), to: path.join(REF, "ui", "Test Logo.png"), reason: "branding → general ui" },
  ];
  for (const { from, to, reason } of moves) {
    if (!fs.existsSync(from)) continue;
    const fromRel = relRef(from);
    const finalDst = moveFile(from, to);
    report.uiNormalized.push({ from: fromRel, to: relRef(finalDst), reason });
  }
}

function main() {
  if (!fs.existsSync(REF)) {
    console.error("Missing", REF);
    process.exit(1);
  }
  ensureDir(ARCHIVE);
  dedupeWithinEachDirectory();
  archiveCrossFolderDupes();
  moveTerrainGroundTexturesToDebris();
  normalizeUiPlacement();
  fs.writeFileSync(
    path.join(REPO, "tools", "_reference_images_stage1_report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  console.log("Done. Report: tools/_reference_images_stage1_report.json");
}

main();
