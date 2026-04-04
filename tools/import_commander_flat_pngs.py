#!/usr/bin/env python3
"""
Import commander sprites from the RgsDev-style flat naming:
  commander_idle_0.png … commander_run_7.png … commander_shot_0.png …
into:
  attached_assets/sprites/commander/<clip>/<n>.png

Source folder (Google Drive — download in browser, unzip if needed):
  https://drive.google.com/drive/folders/1G437Hhgn2AzMl5wCX4mD1RpHk8uggPES?usp=sharing

After download, put all PNGs in:
  attached_assets/_commander_flat/

Then run from repo root:
  python tools/import_commander_flat_pngs.py
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT / "attached_assets/_commander_flat"
DST = ROOT / "attached_assets/sprites/commander"

# Matches commander_idle_0.png, COMMANDER_RUN_7.png, etc.
PAT = re.compile(r"^commander_(idle|run|shot|dead|fall|jump|reload)_(\d+)\.png$", re.IGNORECASE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="Folder containing commander_*.png")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = args.src
    if not src.is_dir():
        print(f"Source folder not found: {src}", file=sys.stderr)
        print("\n1) Open:", file=sys.stderr)
        print("   https://drive.google.com/drive/folders/1G437Hhgn2AzMl5wCX4mD1RpHk8uggPES?usp=sharing", file=sys.stderr)
        print("2) Download all images (or the folder as zip) into:", file=sys.stderr)
        print(f"   {DEFAULT_SRC}", file=sys.stderr)
        print("3) Run this script again.", file=sys.stderr)
        return 1

    matched = 0
    skipped: list[str] = []

    for f in sorted(src.iterdir()):
        if not f.is_file() or f.suffix.lower() != ".png":
            continue
        m = PAT.match(f.name)
        if not m:
            skipped.append(f.name)
            continue
        clip = m.group(1).lower()
        idx = int(m.group(2))
        out_dir = DST / clip
        out_path = out_dir / f"{idx}.png"
        if args.dry_run:
            print(f"{f.name} -> {out_path.relative_to(ROOT)}")
        else:
            out_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, out_path)
        matched += 1

    if not args.dry_run and matched:
        # Remove stale frames in commander/ that weren't in this import (optional cleanup per clip)
        pass

    print(f"Imported {matched} commander frame(s) -> {DST}")
    if skipped:
        print(f"Skipped {len(skipped)} non-matching file(s) (first few): {skipped[:8]}")
    return 0 if matched else 1


if __name__ == "__main__":
    raise SystemExit(main())
