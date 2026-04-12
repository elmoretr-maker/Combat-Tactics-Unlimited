/**
 * Generate "street" variants of road_ground cobble sprites: asphalt + dashed yellow center divider(s).
 * Preserves alpha and dimensions; outputs PNGs under assets/New_Arrivals/road_ground/street/
 *
 * Usage: node tools/generate_street_tiles_from_road_ground.mjs
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const ROOT = path.resolve("assets/New_Arrivals/road_ground");
const OUT_DIR = path.join(ROOT, "street");

const YELLOW = { r: 244, g: 208, b: 58 };
const ALPHA_CUT = 40;

function collectOpaquePixels(data, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a > ALPHA_CUT) pts.push([x, y]);
    }
  }
  return pts;
}

function pcaAxis(pts) {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx;
    const dy = y - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  cxx /= n;
  cxy /= n;
  cyy /= n;
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
  const l1 = trace * 0.5 + disc;
  const l2 = trace * 0.5 - disc;
  let vx;
  let vy;
  if (Math.abs(cxy) > 1e-6) {
    vx = l1 - cyy;
    vy = cxy;
  } else {
    vx = cxx >= cyy ? 1 : 0;
    vy = cxx >= cyy ? 0 : 1;
  }
  const len = Math.hypot(vx, vy) || 1;
  vx /= len;
  vy /= len;
  // Second axis (perpendicular in PCA basis)
  let wx = -vy;
  let wy = vx;
  return { mx, my, vx, vy, wx, wy, l1: Math.max(l1, 0), l2: Math.max(l2, 0) };
}

function projectRange(pts, mx, my, vx, vy) {
  let tmin = Infinity;
  let tmax = -Infinity;
  for (const [x, y] of pts) {
    const t = (x - mx) * vx + (y - my) * vy;
    tmin = Math.min(tmin, t);
    tmax = Math.max(tmax, t);
  }
  return { tmin, tmax };
}

function asphaltFromPixel(r, g, b, x, y) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const base = (luma / 255) * 28 + 44;
  const grain = (((x * 73) ^ (y * 131)) & 3) - 1;
  let grey = Math.round(Math.max(36, Math.min(92, base + grain)));
  const cool = Math.round(grey * 0.98);
  return { r: cool, g: cool, b: Math.min(255, grey + 3) };
}

function paintDashedLine(data, w, h, mx, my, vx, vy, tmin, tmax, dashLen, gapLen, thickness) {
  const total = dashLen + gapLen;
  const range = tmax - tmin;
  if (range < 0.5) return;
  const samples = Math.max(12, Math.ceil(range * 3));
  for (let k = 0; k <= samples; k++) {
    const t = tmin + (k / samples) * range;
    const u = t - tmin;
    const cycle = ((u % total) + total) % total;
    if (cycle >= dashLen) continue;
    const cx = mx + t * vx;
    const cy = my + t * vy;
    const px = Math.round(cx);
    const py = Math.round(cy);
    for (let dy = -thickness; dy <= thickness; dy++) {
      for (let dx = -thickness; dx <= thickness; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        if (data[i + 3] <= ALPHA_CUT) continue;
        data[i] = YELLOW.r;
        data[i + 1] = YELLOW.g;
        data[i + 2] = YELLOW.b;
      }
    }
  }
}

async function processFile(filename) {
  const inPath = path.join(ROOT, filename);
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const buf = Buffer.from(data);
  const pts = collectOpaquePixels(buf, w, h);
  if (pts.length < 8) {
    console.warn(`skip ${filename}: too few opaque pixels`);
    return;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = buf[i + 3];
      if (a <= ALPHA_CUT) continue;
      const { r, g, b } = asphaltFromPixel(buf[i], buf[i + 1], buf[i + 2], x, y);
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }

  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of pts) {
    minx = Math.min(minx, x);
    miny = Math.min(miny, y);
    maxx = Math.max(maxx, x);
    maxy = Math.max(maxy, y);
  }
  const bw = maxx - minx + 1;
  const bh = maxy - miny + 1;
  const bboxAr = bw / Math.max(bh, 1);
  const squareish = bboxAr > 0.55 && bboxAr < 1.85 && Math.min(bw, bh) > 16;

  const dashLen = Math.max(3, Math.round(Math.min(w, h) * 0.08));
  const gapLen = Math.max(2, Math.round(dashLen * 0.55));
  const thick = w + h > 120 ? 1 : 0;

  const { mx, my, vx, vy } = pcaAxis(pts);

  if (squareish) {
    const hSeg = projectRange(pts, mx, my, 1, 0);
    paintDashedLine(buf, w, h, mx, my, 1, 0, hSeg.tmin, hSeg.tmax, dashLen, gapLen, thick);
    const vSeg = projectRange(pts, mx, my, 0, 1);
    paintDashedLine(buf, w, h, mx, my, 0, 1, vSeg.tmin, vSeg.tmax, dashLen, gapLen, thick);
  } else {
    const primary = projectRange(pts, mx, my, vx, vy);
    paintDashedLine(buf, w, h, mx, my, vx, vy, primary.tmin, primary.tmax, dashLen, gapLen, thick);
  }

  const outName = `street_${path.basename(filename, ".png")}.png`;
  const outPath = path.join(OUT_DIR, outName);
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error("Missing:", ROOT);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".png") && f.startsWith("sprite_"))
    .sort();
  for (const f of files) {
    await processFile(f);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
