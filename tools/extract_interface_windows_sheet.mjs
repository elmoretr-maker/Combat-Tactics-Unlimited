/**
 * Extract full UI window frames from the Craftpix "Interface windows" sprite sheet.
 * Source: assets/New_Arrivals/cyberpunk GUI plus more/1 Frames/Interface windows.png
 * Output: assets/ui_master/_autoslice_staging_do_not_use/*.png — NOT ui_master/cyberpunk_blue (manual only).
 *
 * Layout (1800×1200): row h=400; row0/2 cell w=360 (5 cols); row1 cell w=450 (4 cols).
 * Run: node tools/extract_interface_windows_sheet.mjs
 */
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = path.join(
  root,
  "assets/New_Arrivals/cyberpunk GUI plus more/1 Frames/Interface windows.png"
);
const outDir = path.join(root, "assets/ui_master/_autoslice_staging_do_not_use");

/** left, top, width, height — from sheet pixel grid */
const crops = [
  { id: "cp_win_empty", left: 0, top: 0, width: 360, height: 400 },
  { id: "cp_win_inventory", left: 360, top: 0, width: 360, height: 400 },
  { id: "cp_win_panel_small", left: 720, top: 0, width: 360, height: 400 },
  { id: "cp_win_large", left: 1080, top: 0, width: 360, height: 400 },
  { id: "cp_win_character", left: 1440, top: 0, width: 360, height: 400 },
  { id: "cp_win_panel_medium", left: 0, top: 400, width: 450, height: 400 },
  { id: "cp_win_dialog", left: 450, top: 400, width: 450, height: 400 },
  { id: "cp_win_grid", left: 900, top: 400, width: 450, height: 400 },
  { id: "cp_win_menu_wide", left: 1350, top: 400, width: 450, height: 400 },
  { id: "cp_win_list", left: 0, top: 800, width: 360, height: 400 },
  { id: "cp_win_wired_small_top", left: 360, top: 800, width: 360, height: 400 },
  { id: "cp_win_wired_small_bottom", left: 720, top: 800, width: 360, height: 400 },
  { id: "cp_win_panel_tall", left: 1080, top: 800, width: 360, height: 400 },
  { id: "cp_win_modal", left: 1440, top: 800, width: 360, height: 400 },
];

async function main() {
  const meta = await sharp(src).metadata();
  if (meta.width !== 1800 || meta.height !== 1200) {
    console.warn(`Expected 1800×1200, got ${meta.width}×${meta.height} — verify crops.`);
  }
  await fs.mkdir(outDir, { recursive: true });

  const report = [];
  for (const c of crops) {
    const dest = path.join(outDir, `${c.id}.png`);
    await sharp(src)
      .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
      .png()
      .toFile(dest);
    report.push({
      file: `${c.id}.png`,
      width: c.width,
      height: c.height,
      sourceRect: { left: c.left, top: c.top, width: c.width, height: c.height },
    });
    console.log("wrote", path.relative(root, dest));
  }

  console.log("\n--- Extraction report ---");
  for (const r of report) {
    console.log(
      `${r.file}\t${r.width}×${r.height}\tsheet: left=${r.sourceRect.left} top=${r.sourceRect.top}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
