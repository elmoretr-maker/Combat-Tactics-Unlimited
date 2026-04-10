/**
 * Authoritative UI asset layout under assets/ui_master/.
 *
 * - metal_original: copy of attached_assets/ui (no pixel changes)
 * - cyberpunk_blue: YOU must place only manually extracted PNGs here (see REQUIRED_CYBERPUNK_FRAMES.txt)
 * - military_green: generated from cyberpunk_blue (see tools/lib/military_green_pipeline.mjs)
 *
 * Also removes deprecated: assets/ui/frames/cyberpunk_clean/ and assets/ui/frames/combat_frame_cyber.png
 *
 * Re-run: node tools/build_ui_master.mjs
 */
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { militaryGradePipeline } from "./lib/military_green_pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const master = path.join(root, "assets", "ui_master");
const cyberBlue = path.join(master, "cyberpunk_blue");
const militaryGreen = path.join(master, "military_green");
const metalOriginal = path.join(master, "metal_original");
const metalSrc = path.join(root, "attached_assets", "ui");
const legacyFrames = path.join(root, "assets", "ui", "frames");
const legacyClean = path.join(legacyFrames, "cyberpunk_clean");

const REQUIRED_FRAMES = [
  "cp_frame_main.png",
  "cp_frame_inventory.png",
  "cp_frame_compact.png",
  "cp_frame_wired.png",
  "cp_frame_list.png",
  "cp_frame_map.png",
  "cp_frame_grid.png",
  "cp_frame_plain.png",
  "cp_frame_unit_select.png",
];

const REQUIRED_TXT = `Place ONLY manually extracted cyberpunk window PNGs in this folder.

Required filenames (exact):
${REQUIRED_FRAMES.map((f) => `- ${f}`).join("\n")}

Optional extra frames: add any cp_frame_*.png (e.g. cp_frame_stats.png) — they are picked up automatically.

Do not use auto-sliced sheet outputs here.
Then run: node tools/build_ui_master.mjs
`;

async function copyMetalOriginal() {
  await fs.mkdir(metalOriginal, { recursive: true });
  let n = 0;
  try {
    const entries = await fs.readdir(metalSrc);
    for (const name of entries.sort()) {
      const ext = path.extname(name).toLowerCase();
      if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") continue;
      const src = path.join(metalSrc, name);
      const st = await fs.stat(src).catch(() => null);
      if (!st?.isFile()) continue;
      await fs.copyFile(src, path.join(metalOriginal, name));
      n++;
    }
  } catch (e) {
    console.warn("metal copy:", e.message);
  }
  return n;
}

async function buildMilitaryFromBlue() {
  await fs.rm(militaryGreen, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(militaryGreen, { recursive: true });
  let names;
  try {
    names = await fs.readdir(cyberBlue);
  } catch {
    return 0;
  }
  const pngs = names.filter((f) => /\.png$/i.test(f) && !f.startsWith("."));
  let n = 0;
  for (const file of pngs.sort()) {
    const srcPath = path.join(cyberBlue, file);
    const st = await fs.stat(srcPath).catch(() => null);
    if (!st?.isFile()) continue;

    const destPath = path.join(militaryGreen, file);
    const before = await sharp(srcPath).metadata();

    await militaryGradePipeline(srcPath).png({ compressionLevel: 9 }).toFile(destPath);

    const after = await sharp(destPath).metadata();
    if (before.width !== after.width || before.height !== after.height) {
      console.warn("size mismatch:", file);
    }
    n++;
  }
  return n;
}

async function writeCyberpunkReadme() {
  await fs.mkdir(cyberBlue, { recursive: true });
  await fs.writeFile(path.join(cyberBlue, "REQUIRED_CYBERPUNK_FRAMES.txt"), REQUIRED_TXT, "utf8");
}

async function removeLegacyConfusion() {
  try {
    await fs.rm(legacyClean, { recursive: true, force: true });
    console.log("removed", path.relative(root, legacyClean));
  } catch (_) {}
  const cyberOrphan = path.join(legacyFrames, "combat_frame_cyber.png");
  try {
    await fs.unlink(cyberOrphan);
    console.log("removed", path.relative(root, cyberOrphan));
  } catch (_) {}
}

async function main() {
  await fs.mkdir(master, { recursive: true });
  await writeCyberpunkReadme();

  const nMetal = await copyMetalOriginal();
  console.log(`metal_original: ${nMetal} file(s) from attached_assets/ui`);

  const nMil = await buildMilitaryFromBlue();
  console.log(`military_green: ${nMil} file(s) from cyberpunk_blue`);

  await removeLegacyConfusion();

  const missing = [];
  for (const f of REQUIRED_FRAMES) {
    try {
      await fs.access(path.join(cyberBlue, f));
    } catch {
      missing.push(f);
    }
  }
  if (missing.length) {
    console.log(
      "\ncyberpunk_blue: missing manual frame(s) — add files then re-run:",
      missing.join(", ")
    );
  } else {
    console.log("\ncyberpunk_blue: all 9 required frames present.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
