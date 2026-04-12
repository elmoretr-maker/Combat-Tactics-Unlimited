/**
 * Last-resort visual hints for unified ingest place cards when routing produced no destinations.
 * Does not assign labels, routes, or destinations — only natural-language suggestions.
 */
import sharp from "sharp";

const MAX_HINTS = 6;

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h: h * 360, s, v };
}

/**
 * @param {string} absPath
 * @returns {Promise<string[]>}
 */
export async function analyzeUnifiedHeuristicHints(absPath) {
  const hints = [];
  try {
    const meta = await sharp(absPath).metadata();
    const w0 = meta.width || 0;
    const h0 = meta.height || 0;
    if (!w0 || !h0) return hints;

    const ar = w0 / h0;
    if (ar >= 2.5) {
      hints.push("Wide aspect ratio suggests a possible horizontal strip or sprite-sheet layout");
    } else if (ar <= 0.4) {
      hints.push("Tall aspect ratio suggests a possible vertical strip or tall sprite layout");
    }

    const { data, info } = await sharp(absPath)
      .ensureAlpha()
      .resize({
        width: 96,
        height: 96,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pw = info.width;
    const ph = info.height;
    const ch = info.channels;
    const n = pw * ph;
    if (ch < 3 || n < 1) return hints.slice(0, MAX_HINTS);

    let sumA = 0;
    let transparentish = 0;
    let earthLike = 0;
    let greenLike = 0;
    let grayLike = 0;

    const gray = new Float32Array(n);
    let gi = 0;
    for (let i = 0; i < n; i++) {
      const o = i * ch;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const a = ch >= 4 ? data[o + 3] : 255;
      sumA += a;
      if (a < 242) transparentish += 1;

      const { h, s, v } = rgbToHsv(r, g, b);
      if (s < 0.12 && v > 0.35 && v < 0.92) grayLike += 1;

      if (s > 0.15 && v > 0.15) {
        if (h >= 35 && h <= 85 && s > 0.12) greenLike += 1;
        if (h >= 15 && h <= 55 && s > 0.15 && v < 0.75) earthLike += 1;
      }

      gray[gi++] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    const meanA = sumA / n;
    const fracTrans = transparentish / n;
    if (fracTrans > 0.08 || meanA < 248) {
      hints.push(
        "Transparency is likely present — possible isolated object, icon, or UI element (not a full-frame opaque scene)",
      );
    }

    if (greenLike / n > 0.22) {
      hints.push("Dominant green tones suggest possible terrain or foliage-like content");
    }
    if (earthLike / n > 0.18) {
      hints.push("Dominant brown/earth tones suggest possible terrain or ground-like content");
    }
    if (grayLike / n > 0.45) {
      hints.push("Large neutral-gray regions suggest possible UI chrome, concrete, or low-contrast art");
    }

    let edgeSum = 0;
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1; x < pw - 1; x++) {
        const i = y * pw + x;
        const c = gray[i];
        const gx = Math.abs(gray[i + 1] - gray[i - 1]);
        const gy = Math.abs(gray[i + pw] - gray[i - pw]);
        edgeSum += gx + gy;
      }
    }
    const inner = Math.max(1, (pw - 2) * (ph - 2));
    const edgeDensity = edgeSum / (inner * 255);

    if (edgeDensity > 0.25) {
      hints.push("Structured edges are likely — possible object, building, or mechanical detail");
    } else if (edgeDensity < 0.08 && fracTrans < 0.05) {
      hints.push("Smooth regions with few edges may suggest a blob-like or flat-fill asset");
    }

    const rows = 4;
    const cols = 4;
    const rh = Math.floor(ph / rows);
    const cw = Math.floor(pw / cols);
    if (rh > 2 && cw > 2) {
      const means = [];
      for (let ry = 0; ry < rows; ry++) {
        for (let cx = 0; cx < cols; cx++) {
          let s = 0;
          let cnt = 0;
          for (let y = ry * rh; y < (ry + 1) * rh && y < ph; y++) {
            for (let x = cx * cw; x < (cx + 1) * cw && x < pw; x++) {
              s += gray[y * pw + x];
              cnt++;
            }
          }
          if (cnt) means.push(s / cnt);
        }
      }
      if (means.length >= 8) {
        const rowMeans = [];
        for (let r = 0; r < rows; r++) {
          let row = 0;
          for (let c = 0; c < cols; c++) row += means[r * cols + c];
          rowMeans.push(row / cols);
        }
        const rowMeanAvg = rowMeans.reduce((a, b) => a + b, 0) / rowMeans.length;
        const rowVar =
          rowMeans.reduce((acc, m) => acc + (m - rowMeanAvg) ** 2, 0) / rowMeans.length;
        if (rowVar < 120 && edgeDensity > 0.12) {
          hints.push("Repeating horizontal structure suggests possible tile or strip layout");
        }
      }
    }
  } catch {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const h of hints) {
    const t = h.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}
