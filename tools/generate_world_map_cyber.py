"""
Generate assets/ui_master/world map.jpg — cyber neon green ocean + black land,
geographically accurate coastlines (Natural Earth 110m), matching reference mood.

Also prints THEATER_WORLD_ANCHORS-style coordinates (greedy land sampling) for js/main.js.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import distance_transform_edt, gaussian_filter

try:
    from matplotlib import pyplot as plt
    from matplotlib.collections import PolyCollection
except ImportError as e:
    print("Need matplotlib:", e, file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "assets" / "ui_master" / "world map.jpg"
GEOJSON = Path(__file__).resolve().parent / "ne_110m_land.geojson"

W, H = 1024, 721
SUPER = 2
SW, SH = W * SUPER, H * SUPER


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    x = (lon + 180.0) / 360.0 * SW
    y = (90.0 - lat) / 180.0 * SH
    return x, y


def load_polygons() -> list[np.ndarray]:
    with open(GEOJSON, "r", encoding="utf-8") as f:
        gj = json.load(f)
    verts: list[list[tuple[float, float]]] = []
    for feat in gj["features"]:
        geom = feat["geometry"]
        t = geom["type"]
        coords = geom["coordinates"]
        if t == "Polygon":
            rings = [coords]
        elif t == "MultiPolygon":
            rings = coords
        else:
            continue
        for poly in rings:
            outer = poly[0]
            xy = np.array([lonlat_to_xy(lon, lat) for lon, lat in outer], dtype=np.float64)
            if len(xy) < 3:
                continue
            verts.append(xy)
    return verts


def render_land_mask(verts: list[np.ndarray]) -> np.ndarray:
    dpi = 128
    fig = plt.figure(figsize=(SW / dpi, SH / dpi), dpi=dpi)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(0, SW)
    ax.set_ylim(SH, 0)
    ax.axis("off")
    ax.set_facecolor("black")
    fig.patch.set_facecolor("black")
    coll = PolyCollection(
        verts,
        closed=True,
        facecolors="white",
        edgecolors="none",
        antialiased=False,
    )
    ax.add_collection(coll)
    fig.canvas.draw()
    buf = np.asarray(fig.canvas.buffer_rgba())[:, :, 0]
    plt.close(fig)
    return buf > 200


def noise_layer(shape: tuple[int, int], seed: int = 42) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = rng.random(shape).astype(np.float32)
    n = gaussian_filter(n, sigma=min(shape) * 0.012)
    n = (n - n.min()) / (n.max() - n.min() + 1e-9)
    return n


def build_cyber_rgb(land: np.ndarray) -> np.ndarray:
    """Reference-inspired: dark green base + neon glow from coast; land = black."""
    ocean = ~land
    # Distance from ocean pixel to nearest land (land = False in ocean mask for EDT)
    inv = np.ones(land.shape, dtype=np.uint8)
    inv[land] = 0
    dist = distance_transform_edt(inv)

    n = noise_layer(land.shape, seed=7)
    n2 = noise_layer(land.shape, seed=91)

    # Dark ocean (from reference p10-ish) + variation
    base_r = 10 + n * 18 + n2 * 8
    base_g = 28 + n * 45 + n2 * 22
    base_b = 4 + n * 12 + n2 * 6

    # Coast glow (reference p90 highlights; wide bloom + crisp inner ring)
    g = np.exp(-dist / (22 * SUPER)) + 0.35 * np.exp(-dist / (6 * SUPER))
    g = gaussian_filter(g, sigma=2.8 * SUPER)
    glow_r = 52 * g
    glow_g = 218 * g
    glow_b = 82 * g

    r = np.clip(base_r + glow_r, 0, 255)
    gch = np.clip(base_g + glow_g, 0, 255)
    b = np.clip(base_b + glow_b, 0, 255)

    rgb = np.stack([r, gch, b], axis=-1).astype(np.uint8)
    rgb[land] = 0
    return rgb


def downsample(rgb: np.ndarray) -> np.ndarray:
    im = Image.fromarray(rgb)
    return np.array(im.resize((W, H), Image.Resampling.LANCZOS))


def add_photo_texture(rgb: np.ndarray) -> np.ndarray:
    """Subtle grain + vignette like a lit wall."""
    rng = np.random.default_rng(303)
    grain = rng.normal(0, 3.5, rgb.shape).astype(np.float32)
    grain = gaussian_filter(grain, sigma=0.6)
    x = np.linspace(-1, 1, W)
    y = np.linspace(-1, 1, H)
    xv, yv = np.meshgrid(x, y)
    vig = 1.0 - 0.22 * (xv * xv + yv * yv)
    vig = vig[:, :, np.newaxis]
    out = rgb.astype(np.float32) * vig + grain
    return np.clip(out, 0, 255).astype(np.uint8)


def erode(mask: np.ndarray, it: int) -> np.ndarray:
    x = mask.copy()
    for _ in range(it):
        x = (
            x
            & np.roll(x, 1, 0)
            & np.roll(x, -1, 0)
            & np.roll(x, 1, 1)
            & np.roll(x, -1, 1)
        )
    return x


def greedy_pct(
    mask: np.ndarray,
    x0: int,
    x1: int,
    y0: int,
    y1: int,
    n: int,
    min_px: float,
    *,
    permute_seed: int | None = None,
) -> list[tuple[float, float]]:
    sub = mask[y0:y1, x0:x1]
    ys, xs = np.where(sub)
    if len(xs) == 0:
        return []
    cands = list(zip(xs + x0, ys + y0))
    if permute_seed is not None:
        rng = np.random.default_rng(permute_seed)
        rng.shuffle(cands)
    else:
        cands = sorted(cands, key=lambda t: (t[1] // 35, t[0] // 35))
    picked: list[tuple[int, int]] = []
    min_px2 = min_px * min_px
    for x, y in cands:
        if len(picked) >= n:
            break
        if all((x - x2) ** 2 + (y - y2) ** 2 >= min_px2 for x2, y2 in picked):
            picked.append((x, y))
    return [(round(x / W * 100, 2), round(y / H * 100, 2)) for x, y in picked]


def geo_box(lon_w: float, lon_e: float, lat_n: float, lat_s: float) -> tuple[float, float, float, float]:
    """Plate Carree → fractional bounds (x0,x1,y0,y1) matching image pixel order."""
    x0 = (lon_w + 180.0) / 360.0
    x1 = (lon_e + 180.0) / 360.0
    y_top = (90.0 - lat_n) / 180.0  # north (smaller y)
    y_bot = (90.0 - lat_s) / 180.0  # south (larger y)
    return (min(x0, x1), max(x0, x1), min(y_top, y_bot), max(y_top, y_bot))


def anchors_for_js(land_small: np.ndarray) -> None:
    """Sample interior land; print JS snippet for THEATER_WORLD_ANCHORS."""
    gray = land_small.astype(np.float32)
    land = gray > 0.5
    land[:4, :] = land[-4:, :] = land[:, :4] = land[:, -4:] = False

    def gp(mask, box, n, mp, **kw):
        x0, x1 = int(W * box[0]), int(W * box[1])
        y0, y1 = int(H * box[2]), int(H * box[3])
        return greedy_pct(mask, x0, x1, y0, y1, n, mp, **kw)

    land3 = erode(land, 3)
    land2 = erode(land, 2)
    land1 = erode(land, 1)

    # Geographic boxes on equirectangular Natural Earth (not the old stylized silhouette).
    sah = gp(land3, geo_box(-18, 38, 34, 16), 9, 18 * (W / 1024))
    aus = gp(land1, geo_box(112, 156, -10, -42), 7, 22 * (W / 1024))
    amz = gp(land3, geo_box(-81, -44, 12, -22), 9, 20 * (W / 1024))
    nam = gp(land2, geo_box(-168, -52, 52, 22), 14, 20 * (W / 1024))
    eur = gp(land3, geo_box(-10, 32, 60, 44), 10, 22 * (W / 1024))
    # Shuffled candidate order avoids a single latitude band when the interior mask is wide.
    afr = gp(
        land1,
        geo_box(-18, 52, 22, -35),
        12,
        26 * (W / 1024),
        permute_seed=20260411,
    )

    print("\n--- Paste into THEATER_WORLD_ANCHORS (replace existing keys) ---\n")
    print("  desert: [")
    for p in sah + aus:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  amazon_dense_forest: [")
    for p in amz:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  arctic: [")
    for p in aus:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  north_america_mixed: [")
    for p in nam:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  europe_urban: [")
    for p in eur:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  africa_urban: [")
    for p in afr:
        print(f"    {{ leftPct: {p[0]}, topPct: {p[1]} }},")
    print("  ],")
    print("  fallback: [")
    if eur:
        print(f"    {{ leftPct: {eur[0][0]}, topPct: {eur[0][1]} }},")
    if sah:
        print(f"    {{ leftPct: {sah[0][0]}, topPct: {sah[0][1]} }},")
    if amz:
        print(f"    {{ leftPct: {amz[0][0]}, topPct: {amz[0][1]} }},")
    print("  ],")


def main() -> None:
    verts = load_polygons()
    print("polygons", len(verts))
    land_hr = render_land_mask(verts)
    rgb_hr = build_cyber_rgb(land_hr)
    rgb = downsample(rgb_hr)
    rgb = add_photo_texture(rgb)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(OUT_PATH, quality=93, subsampling=0, optimize=True)
    print("wrote", OUT_PATH)

    land_small = (np.array(Image.fromarray(rgb).convert("L")) < 14).astype(np.uint8)
    anchors_for_js(land_small)


if __name__ == "__main__":
    main()
