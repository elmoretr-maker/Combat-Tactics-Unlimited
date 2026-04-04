#!/usr/bin/env python3
"""
Import "Soldier Characters Pack by RgsDev" into attached_assets/sprites/
layout expected by js/render/unitRenderer.js + js/config/spriteAnimations.json.

Automated download from Google Drive is not reliable from all environments.
Download the folder in a browser (signed in), unzip, then either:

  1) Put the extracted root here (must contain soldier_2, soldier_3, … folders):
       attached_assets/_rgsdev_pack/

  2) Or pass --staging "C:\\path\\to\\extracted\\pack"

Then run from repo root:
  python tools/import_rgsdev_soldiers.py

Drive folder:
  https://drive.google.com/drive/folders/18-nGLw1JqcKUBiVk1kG2bBpFwbpUtKcz?usp=sharing
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STAGING = ROOT / "attached_assets/_rgsdev_pack"
ANIM_JSON = ROOT / "js/config/spriteAnimations.json"
SPRITES_OUT = ROOT / "attached_assets/sprites"

# Engine clip name -> acceptable folder names (lowercase) inside each character folder
CLIP_FOLDER_ALIASES: dict[str, tuple[str, ...]] = {
    "idle": ("idle",),
    "run": ("run", "walk", "running"),
    "shot": ("shot", "shoot", "attack", "fire", "shooting"),
    "shoot": ("shoot", "shot", "attack", "fire"),
    "dead": ("dead", "death", "die", "dying"),
    "fall": ("fall", "falling"),
    "jump": ("jump", "jumping"),
    "reload": ("reload", "reloading"),
}


def natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]


def find_pack_root(staging: Path) -> Path:
    """Directory that directly contains soldier_2, soldier_3, …"""
    if (staging / "soldier_2").is_dir():
        return staging
    for p in staging.rglob("soldier_2"):
        if p.is_dir() and p.name.lower() == "soldier_2":
            return p.parent
    return staging


def list_png_frames(clip_dir: Path) -> list[Path]:
    files = [p for p in clip_dir.iterdir() if p.suffix.lower() in (".png", ".webp")]
    files.sort(key=natural_key)
    return files


# When RgsDev uses flat files: soldier_3_idle_0.png (not idle/0.png)
FLAT_CLIP_FILE_PREFIX: dict[str, tuple[str, ...]] = {
    "idle": ("idle",),
    "run": ("run",),
    "shot": ("shot", "shoot"),
    "shoot": ("shoot", "shot"),
    "dead": ("dead",),
    "fall": ("fall",),
    "jump": ("jump",),
    "reload": ("reload",),
}


def list_flat_clip_frames(char_dir: Path, set_id: str, engine_clip: str) -> list[Path]:
    """e.g. commander_idle_0.png, soldier_3_run_7.png"""
    variants = FLAT_CLIP_FILE_PREFIX.get(engine_clip, (engine_clip.lower(),))
    for fc in variants:
        found: list[tuple[int, Path]] = []
        pat = re.compile(rf"^{re.escape(set_id)}_{re.escape(fc)}_(\d+)\.png$", re.IGNORECASE)
        for p in char_dir.iterdir():
            if not p.is_file() or p.suffix.lower() != ".png":
                continue
            m = pat.match(p.name)
            if m:
                found.append((int(m.group(1)), p))
        if found:
            found.sort(key=lambda t: t[0])
            return [x[1] for x in found]
    return []


def find_clip_folder(char_dir: Path, engine_clip: str) -> Path | None:
    aliases = CLIP_FOLDER_ALIASES.get(engine_clip, (engine_clip.lower(),))
    for sub in char_dir.iterdir():
        if not sub.is_dir():
            continue
        low = sub.name.lower()
        if "outline" in low or low.endswith("_outline"):
            continue
        if low in aliases:
            return sub
    # loose: folder contains alias as substring
    for sub in char_dir.iterdir():
        if not sub.is_dir():
            continue
        low = sub.name.lower()
        if "outline" in low:
            continue
        for a in aliases:
            if a in low:
                return sub
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Import RgsDev soldier pack into CTU sprite folders.")
    ap.add_argument("--staging", type=Path, default=DEFAULT_STAGING, help="Path to extracted Drive folder")
    ap.add_argument("--dry-run", action="store_true", help="Print actions only")
    args = ap.parse_args()

    staging = args.staging
    if not staging.is_dir():
        print(f"Staging folder not found: {staging}", file=sys.stderr)
        print("\nDownload the pack from Google Drive, unzip, and copy it to:", file=sys.stderr)
        print(f"  {DEFAULT_STAGING}", file=sys.stderr)
        print("\nDrive:", file=sys.stderr)
        print("  https://drive.google.com/drive/folders/18-nGLw1JqcKUBiVk1kG2bBpFwbpUtKcz?usp=sharing", file=sys.stderr)
        return 1

    pack_root = find_pack_root(staging)
    anims = json.loads(ANIM_JSON.read_text(encoding="utf-8"))

    imported = 0
    warnings: list[str] = []

    for set_id, cfg in anims.items():
        if cfg.get("treadVehicle"):
            continue
        char_dir = pack_root / set_id
        if not char_dir.is_dir():
            try:
                rel = char_dir.relative_to(staging)
            except ValueError:
                rel = char_dir
            warnings.append(f"Missing character folder: {rel}")
            continue

        frame_counts: dict[str, int] = cfg.get("frameCounts") or {}
        for clip, need in frame_counts.items():
            clip_src = find_clip_folder(char_dir, clip)
            if clip_src is not None:
                frames = list_png_frames(clip_src)
            else:
                frames = list_flat_clip_frames(char_dir, set_id, clip)
            if not frames:
                if clip_src is not None:
                    warnings.append(f"{set_id}/{clip}: empty folder {clip_src}")
                else:
                    warnings.append(
                        f"{set_id}/{clip}: no subfolder or flat {set_id}_{clip}_N.png in {char_dir.name}"
                    )
                continue

            out_dir = SPRITES_OUT / set_id / clip
            if not args.dry_run:
                out_dir.mkdir(parents=True, exist_ok=True)
                for old in out_dir.glob("*.png"):
                    old.unlink()

            use = frames[:need]
            if len(frames) < need:
                warnings.append(
                    f"{set_id}/{clip}: need {need} frames, found {len(frames)} — padded with last frame"
                )
                while len(use) < need and use:
                    use.append(use[-1])
            elif len(frames) > need:
                warnings.append(f"{set_id}/{clip}: using first {need} of {len(frames)} frames")

            for i, src in enumerate(use):
                dst = out_dir / f"{i}.png"
                if args.dry_run:
                    print(f"copy {src} -> {dst}")
                else:
                    shutil.copy2(src, dst)
                imported += 1

    print(f"Imported {imported} frame file(s) into {SPRITES_OUT}")
    if warnings:
        print("\nWarnings:")
        for w in warnings:
            print(f"  - {w}")
    if imported == 0:
        print(
            "\nNo PNGs were copied. If you only see .txt in the zip, re-download the full bundle from Drive.\n"
            "Otherwise ensure soldier_2, soldier_3, … folders contain PNGs (subfolders or flat names like soldier_3_idle_0.png).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
