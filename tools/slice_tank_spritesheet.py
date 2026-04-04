#!/usr/bin/env python3
"""
Re-slice Enemy_Boss_Tank_SpriteSheet.png into tank_t/ run, shot, dead folders.
Default: 16 frames in one row (matches 368×200 sheet from Drive).

Usage (from repo root):
  python tools/slice_tank_spritesheet.py
  python tools/slice_tank_spritesheet.py --cols 8 --rows 2
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT / "attached_assets/sprites/Enemy_Boss_Tank_SpriteSheet.png"
OUT_BASE = ROOT / "attached_assets/sprites/tank_t"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--src", type=Path, default=DEFAULT_SRC)
    p.add_argument("--cols", type=int, default=16, help="frames per row")
    p.add_argument("--rows", type=int, default=1, help="rows of frames")
    args = p.parse_args()

    img = Image.open(args.src).convert("RGBA")
    w, h = img.size
    cols, rows = args.cols, args.rows
    fw, fh = w // cols, h // rows
    frames = []
    for r in range(rows):
        for c in range(cols):
            frames.append(img.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)))

    # Match js/config/spriteAnimations.json tank_t
    need_run, need_shot, need_dead = 12, 1, 1
    if len(frames) < need_run + need_shot + need_dead:
        raise SystemExit(f"Not enough frames: got {len(frames)}, need {need_run + need_shot + need_dead}")

    for i in range(need_run):
        d = OUT_BASE / "run"
        d.mkdir(parents=True, exist_ok=True)
        frames[i].save(d / f"{i}.png")

    (OUT_BASE / "shot").mkdir(parents=True, exist_ok=True)
    (OUT_BASE / "dead").mkdir(parents=True, exist_ok=True)
    frames[need_run].save(OUT_BASE / "shot" / "0.png")
    frames[need_run + 1].save(OUT_BASE / "dead" / "0.png")

    print(f"Sliced {args.src.name} ({w}×{h}) grid {cols}×{rows} cell {fw}×{fh} -> {OUT_BASE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
