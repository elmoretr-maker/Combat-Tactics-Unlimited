#!/usr/bin/env python3
"""
Scan attached_assets for terrain tiles and unit sprite frames expected by the game.
Run from repo root:  python tools/verify_game_assets.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ATTACHED = ROOT / "attached_assets"
TILES_DIR = ATTACHED / "tiles"
SPRITES_DIR = ATTACHED / "sprites"
CFG = ROOT / "js" / "config"


def load_json(name: str) -> dict:
    p = CFG / name
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> int:
    anims = load_json("spriteAnimations.json")
    missing_tiles = []
    # Indices referenced by canvasGrid TILE_MAP (duplicated here for a quick check)
    tile_indices = sorted(
        set(
            [
                0, 1, 9, 10, 11, 14, 18, 19, 20, 21, 22, 25, 26, 27, 28, 30, 31, 32,
                94, 95, 96, 97, 118, 119, 120, 121, 129, 130, 131, 132,
            ]
        )
    )
    for i in tile_indices:
        name = f"tile_{i:03d}.png"
        if not (TILES_DIR / name).is_file():
            missing_tiles.append(name)

    missing_sprites: list[str] = []
    for set_id, cfg in anims.items():
        if cfg.get("craftpixClips"):
            continue
        counts = cfg.get("frameCounts") or {}
        for clip, n in counts.items():
            if cfg.get("treadVehicle") and clip not in ("run", "shot", "dead"):
                # tank only uses run/shot/dead in practice; still verify declared clips
                pass
            folder = SPRITES_DIR / set_id / clip
            for fi in range(int(n)):
                fp = folder / f"{fi}.png"
                if not fp.is_file():
                    missing_sprites.append(str(fp.relative_to(ROOT)))

    print("Combat Tactics Unlimited — asset verification")
    print(f"Root: {ROOT}")
    print()
    print(f"Terrain tiles missing (sample set): {len(missing_tiles)} / {len(tile_indices)} checked")
    if missing_tiles:
        for m in missing_tiles[:25]:
            print(f"  - tiles/{m}")
        if len(missing_tiles) > 25:
            print(f"  ... and {len(missing_tiles) - 25} more")
    else:
        print("  (all checked indices present)")
    print()
    print(f"Sprite frames missing: {len(missing_sprites)}")
    if missing_sprites:
        for m in missing_sprites[:40]:
            print(f"  - {m}")
        if len(missing_sprites) > 40:
            print(f"  ... and {len(missing_sprites) - 40} more")
    else:
        print("  (all frames from spriteAnimations.json present)")
    print()
    portraits = ATTACHED / "units"
    if portraits.is_dir():
        n = len(list(portraits.glob("*.png")))
        print(f"Portraits in attached_assets/units: {n} PNG file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
