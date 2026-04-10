/**
 * CraftPix HUD PNG/Bonus → cyberpunk-tinted PNGs in assets/ui/hud_craftpix/.
 * Shifts bronze/military hues toward cyan (matches CTU cyber hybrid palette).
 *
 * Source: attached_assets/craftpix_pack/hud/HUD PNG/Bonus/*.png
 * Re-run after replacing source art.
 */
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const bonusDir = path.join(
  root,
  "attached_assets",
  "craftpix_pack",
  "hud",
  "HUD PNG",
  "Bonus"
);
const outDir = path.join(root, "assets", "ui", "hud_craftpix");

/** Degrees — bronze/gold → teal/cyan band */
const HUE_SHIFT = 148;
const SATURATION = 1.12;
const BRIGHTNESS = 1.03;

async function main() {
  const names = (await fs.readdir(bonusDir)).filter((f) => /\.png$/i.test(f));
  if (!names.length) {
    console.warn("No PNGs in", bonusDir);
    return;
  }
  await fs.mkdir(outDir, { recursive: true });

  for (const name of names.sort()) {
    const base = name.replace(/\.png$/i, "").replace(/\s+/g, "_").toLowerCase();
    const dest = path.join(outDir, `${base}_cyber.png`);
    const src = path.join(bonusDir, name);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
