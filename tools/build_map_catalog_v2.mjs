/**
 * Build js/config/mapCatalogV2.json from scenarios_v2 JSON tree
 * plus mapCatalog.json when ids match.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const V2_ROOT = path.join(ROOT, "js", "config", "scenarios_v2");
const CATALOG_PATH = path.join(ROOT, "js", "config", "mapCatalog.json");
const OUT_PATH = path.join(ROOT, "js", "config", "mapCatalogV2.json");

function walkJson(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJson(full, out);
    else if (ent.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function inferSizeCategory(w, h) {
  if (w >= 18 && h >= 14) return "grand";
  if (w >= 15 || h >= 12) return "large";
  if (w <= 11 && h <= 9) return "small";
  return "medium";
}

function biomeToEnvironment(biome) {
  switch (biome) {
    case "forest":
      return "wild";
    case "desert":
      return "desert";
    case "winter":
      return "arctic";
    case "urban":
      return "urban";
    default:
      return "urban";
  }
}

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
const byId = new Map((catalog.maps || []).map((m) => [m.id, m]));

const maps = [];
for (const abs of walkJson(V2_ROOT)) {
  const rel = path.relative(V2_ROOT, abs);
  const posixPath = "js/config/scenarios_v2/" + rel.split(path.sep).join("/");
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  const baseId = raw.id;
  const v2Id = `${baseId}_v2`;
  const baseEntry = byId.get(baseId);
  const w = raw.width;
  const h = raw.height;
  const biome = raw.biome || baseEntry?.biome || "urban";
  const sizeCategory = baseEntry?.sizeCategory || inferSizeCategory(w, h);
  const environment = baseEntry?.environment || biomeToEnvironment(biome);
  const baseName = String(
    baseEntry?.name || raw.name || baseId,
  ).replace(/\s+v2$/i, "").trim();
  const name = `${baseName} (layout v2)`;
  const tmpl = raw.generator?.migrationV2?.templateUsed;
  const blurb = baseEntry?.blurb
    ? `${baseEntry.blurb} [Layout v2${tmpl ? `: ${tmpl}` : ""}.]`
    : `Structured template layout (scenarios_v2)${tmpl ? ` — ${tmpl}` : ""}.`;

  maps.push({
    id: v2Id,
    name,
    path: posixPath,
    sizeCategory,
    environment,
    biome,
    width: w,
    height: h,
    blurb,
  });
}

maps.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(OUT_PATH, JSON.stringify({ maps }, null, 2) + "\n");
console.log("Wrote", maps.length, "entries ->", path.relative(ROOT, OUT_PATH));
