# CraftPix TDS Modern mega-set (local layout)

Copy **PNG** (and other runtime-ready) assets from the purchased pack into the folders below. **PSD** folders are source-only — keep them outside the game tree or in a separate `_source/` backup if you want them on disk.

| Folder | CraftPix source (examples) |
|--------|----------------------------|
| `city/` | PNG City, PNG City 2 |
| `city_buildings/` | Building tiles/sprites from city sets (optional split from `city/`) |
| `boats/` | Boats PNG |
| `shadows/` | Shadows |
| `smoke/` | PNG smoke |
| `hud/` | HUD PNG |
| `effects/` | Effects |
| `units/sniper/` | Sniper |
| `units/gunner/` | Gunner |
| `units/helicopter/` | Helicopter |
| `bomber/` | Bomber |
| `vehicles/acs_tank_damage/` | ACS Tank with Damage |
| `units/` | Other infantry (see inner README) |
| `heavy_weapons/` | Artillery, mortar (see README) |
| `environment/` | Generic terrain props (see README) |
| `fx/` | Game-facing VFX staging (explosions, etc.; see README) |

Loader code: `js/craftpixHandler.js` exports `CRAFTPIX_BASE` and `CRAFTPIX` path map.
