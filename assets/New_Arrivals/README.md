# New Arrivals

Drop PNG/JPG/WebP/GIF files (or shallow subfolders) here, then run:

```bash
npm run catalog-assets
```

The **Librarian** (`tools/catalog_assets.mjs`) moves each file into `assets/guns/`, `assets/buildings/`, `assets/tiles/`, or `assets/obstacles/` and refreshes `js/config/assetManifest.json`.

**Tip:** Use descriptive filenames or subfolders (e.g. `rifle/m4.png`, `desert_sand_tile.png`) so automatic sorting is accurate.
