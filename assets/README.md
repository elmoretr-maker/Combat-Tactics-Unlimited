# Curated game assets (`assets/`)

| Path | Purpose |
|------|---------|
| `New_Arrivals/` | Drop new art here, then run `npm run catalog-assets`. |
| `guns/handgun`, `rifle`, `machine_gun` | Firearm sprites (sorted by Librarian). |
| `buildings/{small,medium,large,fortified}` | Structure art by footprint class. |
| `tiles/{desert,urban}` | Ground tiles by biome. |
| `obstacles/{urban,desert,grass}` | Props for procedural scatter (trees, crates, …). |
| `ui/buttons` | HUD / menu button art (e.g. Picsart exports). |

The **Librarian** refreshes `js/config/assetManifest.json`, which mapgen reads at runtime.

**Note:** If `npm run catalog-assets` reported moves but **Total catalogued assets: 0**, update the repo (fixed `collectAssetsUnder` bucket matching) and run again — or rely on the script’s **promotion** step, which moves obvious tile sheets out of `obstacles/` into `tiles/` and button art into `ui/buttons/`.

Large packs already in `attached_assets/` stay there; the catalog script lists them under `externalRootsScan` for reference.
