# Soldier (CraftPix TDS Modern)

Place soldier sprite PNGs here. Expected subfolder structure (matching gunner/sniper pattern):

```
soldier/
  Soldier/
    Base.png              (idle frame)
    Walk/
      SoldierWalk_01.png
      SoldierWalk_02.png
      ...
    Fire/ or Shot/
      SoldierShot.png
      ...
    Die/
      SoldierDie_01.png
      SoldierDie_02.png
      ...
```

Adapt folder/file names to match whatever the CraftPix pack ships.
Once files are in place, a `soldier_cp` entry will be added to `js/config/spriteAnimations.json` with `craftpixClips` paths.
