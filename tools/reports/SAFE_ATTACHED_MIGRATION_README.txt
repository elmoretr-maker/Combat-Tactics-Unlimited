SAFE staged migration: attached_assets ? assets
===============================================

Current state (after correction)
--------------------------------
- Bulk `assets/_import/` mirror and global ref swap were **reverted**; `attached_assets/` is again the live path in JSON/JS where not yet migrated.
- `assets/_import/` directory was **removed** (it was a duplicate mirror, not `attached_assets` itself).
- **canvasGrid.js**: tries `assets/tiles/classic/tile_NNN.png` first, then **fallback** `attached_assets/tiles/tile_NNN.png` (dual system; classic dir may be empty until you run copy).
- **battleVfx.js**: accepts full `assets/…` or `attached_assets/…` paths; bare filenames still use `attached_assets/vfx/`.
- **attached_assets/DEPRECATED.md** marks the tree as legacy for new work.

Commands
--------
  npm run migrate-attached:mapping   ? tools/reports/attached_migration_mapping.json
  npm run migrate-attached:dry-run   ? tools/reports/attached_migration_dry_run.json
  npm run migrate-attached:copy      ? copy only missing dest files (does not delete attached_assets)

Workflow (your steps)
---------------------
STEP 0–1: Mapping is generated from authoritative refs (configs + fxLayer/main/craftpix + scenario JSON + index/css literals). See mapping JSON.

STEP 2: Dry-run JSON lists missingSource, ambiguous, conflicts, ok. Fix pathMapper for any ambiguous before copy.

STEP 3: Run `migrate-attached:copy` after dry-run is clean (or fix sources).

STEP 4: Update references **only** for paths you have copied — per-file or small scripted pass; do **not** bulk-replace unresolved paths.

STEP 5: After all VFX exist under `assets/` and configs point there, simplify battleVfx (drop bare-name attached prefix). Keep canvasGrid dual-path until classic tiles are verified.

STEP 6: Manual playtest + optional path existence check.

STEP 7: Use dry-run + copy_log + git diff for the report.

STEP 8: **attached_assets/DEPRECATED.md** — no deletion until you are satisfied.

Last dry-run summary (regenerate locally)
-----------------------------------------
See attached_migration_dry_run.json "summary" (example: 370 refs, 0 missing, 0 ambiguous when collector is healthy).
