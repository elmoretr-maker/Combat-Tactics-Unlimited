#!/usr/bin/env node
/**
 * Copy Craftpix "cyberpunk GUI plus more" rasters into canonical CTU UI layout under assets/ui/.
 * Does not delete or move sources under New_Arrivals (originals stay intact).
 *
 *   node tools/organize_cyberpunk_ui_kit.mjs
 *   node tools/organize_cyberpunk_ui_kit.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PACK = path.join(ROOT, "assets", "New_Arrivals", "cyberpunk GUI plus more");
const DRY = process.argv.includes("--dry-run");

/** @param {number} n 1..81 */
function frameRC(n) {
  const i = n - 1;
  return { row: Math.floor(i / 9), col: i % 9 };
}

function frameCategory(row, col) {
  const onEdge = row === 0 || row === 8 || col === 0 || col === 8;
  if (onEdge) return "windows";
  if (row >= 3 && row <= 5 && col >= 3 && col <= 5) return "panels";
  return "components";
}

function frameDestName(row, col, category) {
  const kind = category === "windows" ? "window" : category === "panels" ? "panel" : "component";
  return `${kind}_cp_mod_r${row}c${col}.png`;
}

/** Meaningful slugs for 16×16 symbolic icons (pack order 1–40). Verified: 10=checkmark, 14=arrow left. */
const ICON_SLUGS = [
  "icon_eye",
  "icon_gear",
  "icon_heart",
  "icon_bolt",
  "icon_shield",
  "icon_crosshair",
  "icon_user",
  "icon_mail",
  "icon_map_pin",
  "icon_checkmark",
  "icon_close",
  "icon_plus",
  "icon_minus",
  "icon_arrow_left",
  "icon_arrow_right",
  "icon_arrow_up",
  "icon_arrow_down",
  "icon_star",
  "icon_lock",
  "icon_unlock",
  "icon_bag",
  "icon_sword",
  "icon_skull",
  "icon_flask",
  "icon_ring",
  "icon_gem",
  "icon_clock",
  "icon_flag",
  "icon_camp",
  "icon_book",
  "icon_wrench",
  "icon_save_disk",
  "icon_search",
  "icon_chat_bubble",
  "icon_bell",
  "icon_music",
  "icon_camera",
  "icon_video",
  "icon_wifi",
  "icon_power",
];

function ensureDir(dir) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  if (DRY) {
    console.log("[dry-run]", path.relative(ROOT, src), "->", path.relative(ROOT, dest));
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function main() {
  if (!fs.existsSync(PACK)) {
    console.error("Missing pack folder:", path.relative(ROOT, PACK));
    process.exit(1);
  }

  const out = {
    icons: path.join(ROOT, "assets", "ui", "icons"),
    windows: path.join(ROOT, "assets", "ui", "windows"),
    panels: path.join(ROOT, "assets", "ui", "panels"),
    components: path.join(ROOT, "assets", "ui", "components"),
  };

  for (const dir of Object.values(out)) ensureDir(dir);

  const framesDir = path.join(PACK, "1 Frames");
  for (let n = 1; n <= 81; n++) {
    const src = path.join(framesDir, `Frame_${String(n).padStart(2, "0")}.png`);
    if (!fs.existsSync(src)) continue;
    const { row, col } = frameRC(n);
    const cat = frameCategory(row, col);
    const name = frameDestName(row, col, cat);
    const destDir = out[cat];
    copyFile(src, path.join(destDir, name));
  }

  const refMap = path.join(framesDir, "FrameMap.png");
  if (fs.existsSync(refMap)) {
    copyFile(refMap, path.join(out.panels, "panel_cp_source_frame_map.png"));
  }
  const refWin = path.join(framesDir, "Interface windows.png");
  if (fs.existsSync(refWin)) {
    copyFile(refWin, path.join(out.panels, "panel_cp_source_interface_windows.png"));
  }

  const barsDir = path.join(PACK, "2 Bars");
  if (fs.existsSync(barsDir)) {
    for (const name of fs.readdirSync(barsDir)) {
      if (!name.toLowerCase().endsWith(".png")) continue;
      const base = path.basename(name, ".png");
      const dest = path.join(out.components, `component_cp_bar_${base.replace(/\s+/g, "_").toLowerCase()}.png`);
      copyFile(path.join(barsDir, name), dest);
    }
  }

  const iconDir = path.join(PACK, "3 Icons", "Icons");
  if (fs.existsSync(iconDir)) {
    for (let i = 1; i <= 40; i++) {
      const src = path.join(iconDir, `Icon_${String(i).padStart(2, "0")}.png`);
      if (!fs.existsSync(src)) continue;
      const slug = ICON_SLUGS[i - 1] || `icon_pack_${String(i).padStart(2, "0")}`;
      copyFile(src, path.join(out.icons, `${slug}.png`));
    }
  }

  const btn2 = path.join(PACK, "3 Icons", "Buttons2");
  if (fs.existsSync(btn2)) {
    const files = fs.readdirSync(btn2).filter((f) => f.toLowerCase().endsWith(".png")).sort();
    let k = 0;
    for (const name of files) {
      k += 1;
      copyFile(path.join(btn2, name), path.join(out.components, `component_cp_button_alt_${String(k).padStart(2, "0")}.png`));
    }
  }

  const logoDir = path.join(PACK, "5 Logo");
  if (fs.existsSync(logoDir)) {
    for (const name of fs.readdirSync(logoDir)) {
      if (!name.toLowerCase().endsWith(".png")) continue;
      const m = name.match(/(\d+)/);
      const idx = m ? m[1] : name;
      copyFile(path.join(logoDir, name), path.join(out.panels, `panel_cp_logo_${idx}.png`));
    }
  }

  const pal = path.join(PACK, "4 Palette", "1.png");
  if (fs.existsSync(pal)) {
    copyFile(pal, path.join(out.panels, "panel_cp_palette_swatches.png"));
  }

  const btnRoot = path.join(PACK, "6 Buttons");
  if (fs.existsSync(btnRoot)) {
    for (const name of fs.readdirSync(btnRoot)) {
      const full = path.join(btnRoot, name);
      const st = fs.statSync(full);
      if (st.isFile() && name.toLowerCase().endsWith(".png")) {
        const base = path.basename(name, ".png");
        copyFile(full, path.join(out.components, `component_cp_button_${base.replace(/\s+/g, "_").toLowerCase()}.png`));
      }
    }
    for (const sub of fs.readdirSync(btnRoot, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const sd = path.join(btnRoot, sub.name);
      const files = fs.readdirSync(sd).filter((f) => f.toLowerCase().endsWith(".png")).sort();
      for (const name of files) {
        const base = path.basename(name, ".png");
        copyFile(
          path.join(sd, name),
          path.join(out.components, `component_cp_btn_style${sub.name}_${base}.png`),
        );
      }
    }
  }

  console.log(DRY ? "Dry run complete." : "Cyberpunk UI kit copied under assets/ui/{icons,windows,panels,components}/");
}

main();
