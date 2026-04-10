/**
 * combat_frame.png (landing / HUD bezel) → cyber-tinted PNG for #app.ctu-cyber-art-enabled.
 * Same silhouette as metal landing; hue/saturation aligned with process_craftpix_bonus_cyber.mjs.
 *
 * Source: attached_assets/ui/combat_frame.png
 * Output: assets/ui_master/cyber_derived/combat_frame_cyber.png (pipeline; not manual window frames)
 */
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = path.join(root, "attached_assets", "ui", "combat_frame.png");
const outDir = path.join(root, "assets", "ui_master", "cyber_derived");
const dest = path.join(outDir, "combat_frame_cyber.png");

/** Slightly softer than small Bonus sprites so the large bezel stays readable */
const HUE_SHIFT = 142;
const SATURATION = 1.08;
const BRIGHTNESS = 1.02;

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await sharp(src)
    .ensureAlpha()
    .modulate({
      hue: HUE_SHIFT,
      saturation: SATURATION,
      brightness: BRIGHTNESS,
    })
    .png()
    .toFile(dest);
  console.log("wrote", path.relative(root, dest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
