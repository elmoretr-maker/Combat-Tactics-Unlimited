import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export function walkStrings(obj, fn) {
  if (typeof obj === "string") {
    if (obj.includes("attached_assets/")) fn(obj);
    return;
  }
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) return obj.forEach((x) => walkStrings(x, fn));
  for (const v of Object.values(obj)) walkStrings(v, fn);
}

/** Quoted / templated paths only  preserves spaces (e.g. PNG City). Skips ${} templates. */
export function extractAttachedFromText(text) {
  const out = new Set();
  const patterns = [
    /"attached_assets\/[^"]+"/g,
    /'attached_assets\/[^']+'/g,
    /`attached_assets\/[^`]+`/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      let s = m[0].slice(1, -1);
      if (s.includes("${")) continue;
      out.add(s);
    }
  }
  return [...out];
}

function isPlausibleRasterRef(p) {
  if (!p.startsWith("attached_assets/")) return false;
  if (p.includes("*") || p.includes("${")) return false;
  if (p === "attached_assets/craftpix_pack" || p === "attached_assets/craftpix_pack/") return false;
  const lower = p.toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|mp4|webm)$/i.test(lower);
}

/** Unique attached_assets paths referenced by runtime configs + selected renderers. */
export function collectAuthoritativeAttachedPaths() {
  const set = new Set();

  function addFile(abs) {
    if (!fs.existsSync(abs)) return;
    const text = fs.readFileSync(abs, "utf8");
    for (const p of extractAttachedFromText(text)) {
      if (isPlausibleRasterRef(p)) set.add(p);
    }
  }

  function walkJsonDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walkJsonDir(full);
      else if (name.name.endsWith(".json")) {
        try {
          const j = JSON.parse(fs.readFileSync(full, "utf8"));
          walkStrings(j, (s) => {
            if (typeof s === "string" && isPlausibleRasterRef(s)) set.add(s);
          });
        } catch {
          addFile(full);
        }
      }
    }
  }

  const sa = path.join(ROOT, "js/config/spriteAnimations.json");
  const ae = path.join(ROOT, "js/config/attackEffects.json");
  if (fs.existsSync(sa)) {
    walkStrings(JSON.parse(fs.readFileSync(sa, "utf8")), (s) => {
      if (typeof s === "string" && isPlausibleRasterRef(s)) set.add(s);
    });
  }
  if (fs.existsSync(ae)) {
    walkStrings(JSON.parse(fs.readFileSync(ae, "utf8")), (s) => {
      if (typeof s === "string" && isPlausibleRasterRef(s)) set.add(s);
    });
  }

  walkJsonDir(path.join(ROOT, "js/config/scenarios"));

  for (const rel of [
    "js/render/fxLayer.js",
    "js/main.js",
    "js/craftpixHandler.js",
    "index.html",
    "css/ctu-metal.css",
  ]) {
    addFile(path.join(ROOT, rel));
  }

  /* fxLayer dynamic sequences */
  const smokeBases = [
    "attached_assets/craftpix_pack/effects/PNG smoke/smoke_middle_gray/smoke1",
    "attached_assets/craftpix_pack/effects/PNG smoke/smoke_dark_gray/smoke1",
    "attached_assets/craftpix_pack/effects/PNG smoke/smoke_bright_gray/smoke1",
    "attached_assets/craftpix_pack/effects/PNG smoke/smoke_brown/smoke1",
  ];
  for (const base of smokeBases) {
    for (let i = 1; i <= 7; i++) set.add(`${base}/smoke1_${i}.png`);
  }
  for (let expId = 1; expId <= 6; expId++) {
    const expBase = `attached_assets/craftpix_pack/city/PNG City/Explosion${expId}`;
    for (let i = 1; i <= 10; i++) {
      set.add(`${expBase}/Explosion${expId}_${i}.png`);
      set.add(
        `attached_assets/craftpix_pack/city/PNG City/Shadows/Explosion${expId}_${i}.png`,
      );
    }
  }

  return [...set].sort();
}
