"""
Generate assets/hero-cover.png and attached_assets/units/*.png (placeholder roster art).
Run from repo root: python tools/gen-brand-assets.py
Requires: pip install pillow
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
UNITS = ROOT / "attached_assets" / "units"


def circle_mask(size: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return m


def draw_portrait(
    path: Path,
    initials: str,
    inner: tuple[int, int, int],
    outer: tuple[int, int, int],
    size: int = 256,
) -> None:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = size // 2, size // 2
    r = size // 2 - 4
    for i in range(r, 0, -1):
        t = i / r
        col = tuple(int(inner[j] + (outer[j] - inner[j]) * (1 - t)) for j in range(3))
        draw.ellipse((cx - i, cy - i, cx + i, cy + i), fill=col + (255,))
    ring = (60, 110, 160, 255)
    draw.ellipse((4, 4, size - 5, size - 5), outline=ring, width=5)
    try:
        font = ImageFont.truetype("arial.ttf", 72)
    except OSError:
        font = ImageFont.load_default()
    text = initials[:2].upper()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        (cx - tw // 2, cy - th // 2 - 6),
        text,
        fill=(240, 245, 255, 255),
        font=font,
    )
    mask = circle_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    path.parent.mkdir(parents=True, exist_ok=True)
    out.convert("RGB").save(path, "PNG", optimize=True)


def draw_hero(path: Path, w: int = 1600, h: int = 640) -> None:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            u = x / max(w - 1, 1)
            v = y / max(h - 1, 1)
            r = int(12 + u * 35 + v * 18)
            g = int(22 + u * 50 + v * 40)
            b = int(38 + u * 70 + v * 35)
            px[x, y] = (r, g, b)
    draw = ImageDraw.Draw(img)
    step = 48
    grid_c = (30, 55, 80, 80)
    for gx in range(0, w + step, step):
        draw.line([(gx, 0), (gx, h)], fill=grid_c, width=1)
    for gy in range(0, h + step, step):
        draw.line([(0, gy), (w, gy)], fill=grid_c, width=1)
    try:
        font = ImageFont.truetype("arial.ttf", 96)
        sub = ImageFont.truetype("arial.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
        sub = font
    title = "COMBAT TACTICS UNLIMITED"
    bbox = draw.textbbox((0, 0), title, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((w - tw) // 2, h // 2 - 80), title, fill=(230, 238, 248), font=font)
    tag = "Square-grid tactics"
    bb2 = draw.textbbox((0, 0), tag, font=sub)
    draw.text(((w - (bb2[2] - bb2[0])) // 2, h // 2 + 20), tag, fill=(140, 170, 200), font=sub)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)


PORTRAITS: list[tuple[str, str, tuple[int, int, int], tuple[int, int, int]]] = [
    ("infantry.png", "IN", (40, 70, 110), (90, 130, 170)),
    ("sniper.png", "SN", (35, 90, 55), (70, 130, 85)),
    ("mortar.png", "MO", (120, 70, 30), (180, 110, 50)),
    ("medic.png", "MD", (90, 40, 45), (140, 80, 85)),
    ("light_tank.png", "LT", (70, 85, 45), (110, 120, 70)),
    ("artillery.png", "AR", (55, 55, 60), (95, 95, 100)),
    ("commander_unit.png", "CO", (80, 60, 30), (140, 110, 60)),
    ("commandos.png", "CM", (30, 60, 40), (55, 100, 70)),
    ("heavy_infantry.png", "HI", (75, 55, 40), (120, 90, 65)),
]


def main() -> None:
    draw_hero(ASSETS / "hero-cover.png")
    for fname, initials, a, b in PORTRAITS:
        draw_portrait(UNITS / fname, initials, a, b)
    print("Wrote", ASSETS / "hero-cover.png")
    print("Wrote", len(PORTRAITS), "portraits in", UNITS)


if __name__ == "__main__":
    main()
