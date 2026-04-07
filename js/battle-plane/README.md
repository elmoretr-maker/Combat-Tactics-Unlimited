# `battle-plane` — plane-over-grid battle stack (opt-in)

This folder is **not** the legacy battle renderer. It adds an optional stack:

1. **Battle mat** — `assets/maps/{grass|urban|desert}/base.png` (or `battlePlaneLayer.matImage`).
2. **Dim overlay** — `battlePlaneLayer.overlayAlpha` (default `0.2`).
3. **Grid** — drawn by `drawGrid(..., { stackMode: "plane" })` (lines only, no per-cell tile atlas).
4. **Scattered props** — `proceduralBoard` fills `game.mapObjects` (move + LOS blocking).

## Fog of war

Default game settings use **fog on**. With the plane stack, fog was drawn **after** the grid lines, which hid the tactical grid and **all enemies** outside LOS — it looked like “no units / no features.” Mitigations:

- **`computeVisibleCells`** in `main.js` returns **`null`** (no fog) when `getArenaRenderMode(scenario) === "mat"` (`js/render/renderMode.js`), until LOS fog is redesigned for props.
- Scenarios may set **`"fogOfWar": false`** (see `plane_layer_demo.json`).

## When it runs

Only if the merged scenario includes:

```json
"battlePlaneLayer": { "enabled": true }
```

All other scenarios behave as before (full legacy tile rendering, no mat, no `mapObjects`).

## Entry points

- **`runtime.js`** — `isBattlePlaneEnabled()`, `createBattlePlaneController()` (called from `main.js` after `GameState` is constructed).
- **`planeManager.js`** — loads and draws the mat + overlay.
- **`scatterObstacles.js`** — `generateBattleObstacles()` → mutates `game.mapObjects`.
- **`mapObjects.js`** / **`pathfindingCost.js`** — shared helpers; **`gameState.js`** imports these for `costAt` when `mapObjects` is non-empty.

## Test scenario

Hub → **Battle mat lab** uses `js/config/scenarios/plane_layer_demo.json`.

## Legacy vs this module (debugging)

| Concern | Legacy | This module |
|--------|--------|-------------|
| Ground pixels | `canvasGrid.js` tile PNGs / colors | Mat image under grid |
| Obstacles | Terrain types only | `mapObjects` + terrain |
| LOS | `los.js` + `tileTypes` | Same + `mapObjects` on interior cells |
| Imports from here | None unless scenario flag is on | `gameState.js`, `los.js`, `combat.js`, `main.js` only use `mapObjects` / plane when enabled |

Former WIP under `js/wip-board-layer/` is superseded; safe to delete after verifying this tree.
