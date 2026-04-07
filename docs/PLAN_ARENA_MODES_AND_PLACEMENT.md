# Plan: Arena modes, placement, and manifest safety (CTU)

**Status:** **Approved — implemented** (Phases A–E; F skipped; G = document-only).  
**Last updated:** 2026-04-06

---

## Self-assessment (for this plan)

| Verdict | **Good with a few changes** |
|--------|------------------------------|
| **Excellent** | SSOT table matches the real codebase; rejects Galaxy `window` toggles and duplicate engines; phases are ordered low-risk → higher impact; clear approval gates. |
| **Good** | Scoped non-goals, verification checklist, optional phases F/G. |
| **Changes suggested** | (1) Add a short **“Verify you’re testing the right build”** note (hard refresh, correct server root, `js/main.js` module). (2) Phase G: pick a **default recommendation** (e.g. document-only until someone implements draw). (3) Phase F: mark **optional / cosmetic** — skip if you want fewer files. (4) Note **no automated test suite** assumed — verification is manual + spot-check seeds. |
| **Not practical** | — (full Pixi migration or rewriting all maps were correctly excluded.) |
| **Bad** | — |

---

## 1. Goals

- **One simulation:** `GameState` + `scenario.terrain` + `tileTypes` + `mapObjects` for all arenas.
- **Two visuals:** **Tiled battlefield** (full per-cell terrain art) vs **Battle mat** (static mat + grid overlay); controlled by existing scenario flag, not globals.
- **Safer props:** Theme/terrain-aware obstacle picking; reduced straight-line clutter; consistent tall-prop grounding.

## 2. Non-goals

- Pixi or other renderer migration.
- Rewriting all hand-authored theater JSON maps.
- Full `flowConnectors` sprite autotiling (unless a later phase is explicitly approved).

## 3. Single sources of truth

| Topic | SSOT | Do not add |
|--------|------|------------|
| Mat vs tiled | `scenario.battlePlaneLayer?.enabled` (helper: `getArenaRenderMode` → `"mat"` \| `"tiled"`) | `window.battlePlaneLayer` |
| Render branch | `main.js` + `drawGrid(..., { stackMode })` | Second engine owning units/fog |
| Terrain | `game.grid.cells[y][x]` | Obstacles encoded as terrain symbols |
| Movement | `GameState.costAtForUnit` + `astar` | Per-mode pathfinders |
| Catalog | `assetManifest.json` + `assetQuery` / themes | Filename-only rules as the only filter |
| Procedural skirmish placement | `js/mapgen/tacticalPlacement.js`, `tacticalAssets.js`, `pipeline.js` | Shadow file with same name elsewhere |
| Mat lab scatter | `scatterObstacles.js` + `proceduralBoard` | Unseeded duplicate logic |

---

## 4. Pre-implementation verification (when testing changes)

- Hard refresh (`Ctrl+Shift+R`) or disable cache while developing.
- Serve **repo root** so `index.html` → `js/main.js` matches this tree.
- Confirm scenario has `battlePlaneLayer` only when you intend mat mode (e.g. `plane_layer_demo.json`).

---

## 5. Phases (implement in order)

### Phase A — Document the toggle

- **Deliverable:** “Arena render modes” in `docs/CTU_UI_BOOT_AND_NAV_NOTES.md` and/or `js/battle-plane/README.md`: flag on scenario, `main.js` draw order, `stackMode`, fog caveat.
- **Optional:** `getArenaRenderMode(scenario)` read-only helper (no call sites required).
- **Approve:** ☐ Yes ☐ Defer helper

### Phase B — Canonical `getArenaRenderMode(scenario)`

- **Deliverable:** One helper; replace scattered `battlePlaneLayer?.enabled` reads where safe (non-rule-breaking).
- **Naming:** `"mat" | "tiled"` vs `"plane" | "legacy"` — pick one and use in docs + code.
- **Approve:** ☐ Naming locked: _______________

### Phase C — Manifest / terrain filter for obstacles

- **Deliverable:** Filter obstacle pool at pick time using cell terrain + theme; prefer manifest **tags** or small schema extension (`allowedTerrainTypes` / `disallowedTerrainTypes` / `waterOnly`).
- **Approve:** ☐ Tags ☐ Explicit terrain lists ☐ Hybrid

### Phase D — Anti-line / spacing (seeded)

- **Deliverable:** Rule for “3+ collinear blocking props” (define axis system: orthogonal, Chebyshev); integrate in `tacticalPlacement.js`; mirror in `scatterObstacles.js` if mat-lab should match.
- **RNG:** Existing seeded PRNG only.
- **Approve:** ☐ Reject placement ☐ Try alternate cell ☐ Mix

### Phase E — Bottom anchor policy

- **Deliverable:** Audit `mapObjectLayer.js`; default bottom-style anchor for agreed `visualKind` / tall heuristics; document which kinds stay center.
- **Approve:** ☐ Tall kinds list approved separately

### Phase F — Optional `renderBridge.js` facade

- **Deliverable:** Thin delegate only (e.g. background draw); **no** duplicate tile loop.
- **Approve:** ☐ Include ☐ Skip (keep `main.js`/`canvasGrid.js` only)

### Phase G — `flowConnectors` policy (recommended default)

- **Recommended default:** **(c)** Treat embedded `flowConnectors` in static JSON as **documentation / tooling** until a dedicated rendering phase; document in same doc as Phase A. Revisit (a) draw or (b) strip in a later milestone.
- **Approve:** ☐ (a) implement draw ☐ (b) strip from JSON ☐ (c) document-only (default)

---

## 6. Verification checklist (after B–E)

- [ ] Procedural urban: tiles + fords + filtered props.
- [ ] Procedural desert: desert-appropriate pool + water variants.
- [ ] Mat lab: mat + overlay; movement matches `terrain`.
- [ ] Map theater preset: unchanged unless explicitly filtering hand `mapObjects`.
- [ ] Restart / inline scenario: metadata preserved.

---

## 7. Maintainer sign-off

| Item | Initials / date |
|------|-----------------|
| Plan approved for build | Yes |
| Phases in scope (A–G circle) | A–E in code; **F skipped**; **G = (c) document-only** |
| Notes / scope changes | B: `"mat"` \| `"tiled"`; C: tags `water_only`, `urban_ok`, `water_adjacent`; D: reject spacing + orthogonal line ≥3; E: `propAnchor: bottom` for tree, ruins, house; ratio mix in `placementRatios.js` |

---

## 8. Post-approval: implementation order

1. A → B → C → D → E (as approved).  
2. F if approved.  
3. G per chosen option (default c).

When sign-off is complete, implementation can proceed without adopting external “drop-in” modules that use `window` toggles or replace `js/mapgen/tacticalPlacement.js` from outside `js/mapgen/`.
