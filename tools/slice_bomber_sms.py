#!/usr/bin/env python3
"""
Slice side-view jet + bomb from SMS Enemy_Vehicles_SpriteSheet (cell 0,0).
Source: attached_assets/_rgsdev_pack/.../Enemy_Vehicles_SpriteSheet.png

Usage (from repo root):
  python tools/slice_bomber_sms.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = (
    ROOT
    / "attached_assets/_rgsdev_pack/Combat Tactics Sprites/SMS Asset Pack Spy Fighter"
    / "Enemy Vehicles/Enemy_Vehicles_SpriteSheet.png"
)
OUT_BASE = ROOT / "attached_assets/sprites/bomber_sms"


def tight_crop_rows(cell: Image.Image, y0: int, y1: int) -> Image.Image:
    sub = cell.crop((0, y0, cell.width, y1))
    a = np.array(sub.convert("RGBA"))[:, :, 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        raise SystemExit(f"No opaque pixels in band y={y0}..{y1}")
    pad = 1
    x0, x1 = max(0, int(xs.min()) - pad), min(sub.width, int(xs.max()) + 1 + pad)
    y0l, y1l = max(0, int(ys.min()) - pad), min(sub.height, int(ys.max()) + 1 + pad)
    return sub.crop((x0, y0l, x1, y1l))


def main() -> int:
    img = Image.open(DEFAULT_SRC).convert("RGBA")
    w, h = img.size
    cols, rows = 5, 4
    fw, fh = w // cols, h // rows
    cell = img.crop((0, 0, fw, fh))

    plane = tight_crop_rows(cell, 15, 45)
    bomb = tight_crop_rows(cell, 42, 62)

    for clip in ("idle", "run", "shot", "dead"):
        (OUT_BASE / clip).mkdir(parents=True, exist_ok=True)
    for i in range(4):
        plane.save(OUT_BASE / "idle" / f"{i}.png")
        plane.save(OUT_BASE / "run" / f"{i}.png")
    bomb.save(OUT_BASE / "shot" / "0.png")
    plane.save(OUT_BASE / "dead" / "0.png")

    print(
        f"Sliced {DEFAULT_SRC.name} cell 0,0 ({fw}×{fh}) -> {OUT_BASE} "
        f"(plane {plane.size}, bomb {bomb.size})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
