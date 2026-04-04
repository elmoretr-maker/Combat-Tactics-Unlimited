Place your downloaded "Combat Tactics Sprites.zip" (or RgsDev soldier pack) here.

Steps:
1. Move the .zip into this folder (attached_assets/_rgsdev_pack/).
2. Do NOT use "Open With" on a random app. Right-click the zip -> Extract Here or Extract All.
   (Opening with 7-Zip/WinRAR is fine if you use Extract, not only preview.)
3. You should end up with subfolders like soldier_2, soldier_3, soldier_5, commander
   (or one top-level folder — the import script will find them).
4. From the project root run:
     python tools/import_rgsdev_soldiers.py

Commander-only flat PNGs go in attached_assets/_commander_flat/ instead
(see tools/import_commander_flat_pngs.py).
