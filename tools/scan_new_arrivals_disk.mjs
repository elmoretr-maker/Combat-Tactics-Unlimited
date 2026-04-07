#!/usr/bin/env node
/**
 * Raw disk scan of assets/New_Arrivals (no Git).
 * Run: node tools/scan_new_arrivals_disk.mjs
 *
 * If this prints 0 rasters but Explorer shows PNGs, check OneDrive
 * "Always keep on this device" and that files are not 0-byte placeholders.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const NEW_ARRIVALS = path.join(ROOT, "assets", "New_Arrivals");
const RASTER_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error("[scan] cannot read:", dir, e.code || e.message);
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "README.md") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (RASTER_EXT.has(ext)) {
        const st = fs.statSync(full);
        out.push({ full, rel: path.relative(ROOT, full), size: st.size });
      }
    }
  }
}

const hits = [];
if (fs.existsSync(NEW_ARRIVALS)) {
  walk(NEW_ARRIVALS, hits);
} else {
  console.error("Missing:", NEW_ARRIVALS);
  process.exit(1);
}

hits.sort((a, b) => a.rel.localeCompare(b.rel));
console.log("Root:", NEW_ARRIVALS);
console.log("Raster files found:", hits.length);

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
const inUrban = hits.filter((h) => {
  const segs = norm(h.rel).split("/");
  return segs.some((s) => s === "urban");
});
const inWeaponColor = hits.filter((h) => norm(h.rel).includes("weapon_color"));
console.log("  in URBAN path segment:", inUrban.length);
console.log("  in Weapon_Color path:", inWeaponColor.length);
if (inUrban.length) {
  console.log("\nFirst 5 PNG/JPG under URBAN:");
  inUrban.slice(0, 5).forEach((h) => console.log(h.full));
}
if (inWeaponColor.length) {
  console.log("\nFirst 5 PNG/JPG under Weapon_Color:");
  inWeaponColor.slice(0, 5).forEach((h) => console.log(h.full));
}

if (hits.length) {
  console.log("\nFirst file (proof path):");
  console.log(hits[0].full);
  console.log("Size bytes:", hits[0].size);
  if (process.platform === "win32") {
    try {
      const a = execSync(`attrib "${hits[0].full}"`, { encoding: "utf8" });
      console.log("attrib:", a.trim());
    } catch {
      /* optional */
    }
  }
  if (hits.length > 1) {
    console.log("\nAll paths:");
    for (const h of hits) console.log(h.size, h.full);
  }
} else {
  console.log(
    "\nNo rasters on disk under New_Arrivals. Same rules as catalog walkFiles:",
    "skips names starting with '.' and README.md; spaces in folder names are OK.",
  );
  console.log(
    "If Explorer shows PNGs here, force-download from cloud or confirm path matches above.",
  );
}
