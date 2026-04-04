# CTU — UI boot, nav, and `#app button` (internal reference)

This note captures **why Hub/Codex once looked empty**, how the shell was recovered, and **gotchas** when styling buttons so future changes do not repeat the same failures.

## 1. “Chrome only, no lists” (Hub / Codex / roster empty)

**Symptom:** Frames, headers, and backgrounds render, but **Solo Modes**, **Roster**, **Codex grid**, and similar **never fill**.

**Root cause:** A **working-tree** `js/main.js` added **static** imports for modules that were **not committed** (shown as `??` in `git status`), e.g. `./engine/mapManager.js` and `./input/battleInput.js`. If the browser **cannot resolve any ES module** in the import graph, **`main.js` never finishes loading**, so **`initApp()` never runs** and **no render functions run**. This is **not** a flex/CSS “collapsed list” problem.

**Fix pattern:**

- Keep **`main.js` imports limited to tracked, always-present modules** (match `HEAD` / origin).
- Park experimental board/plane/grid code under something like **`js/wip-board-layer/`** and wire it with **`import()`** only on the battle path when stable—so Hub/Codex cannot be bricked by WIP.

**Diagnosis:** DevTools **Network** (failed `.js` 404) or **Console** (module load error). On boot failure from `fetch`, `showBootFailureBanner()` explains `file://` vs local server.

## 2. Combat Vision rollback

**Combat Vision** (`landing-hud` wrapper + `css/ctu-landing-hud.css`) lived on commit `0ff5c95`. The product shell was aligned back to the **pre–Combat Vision** landing DOM (e.g. `b9da3d4`-era): video stage + command strip **directly** under `#screen-landing`. `ctu-landing-hud.css` was removed from the tree so `index.html` does not reference a missing sheet.

Historical detail: `docs/COMBAT_VISION_ARCHITECTURE.md` is a **design record**, not the live architecture.

## 3. Global `#app button` (`css/ctu-metal.css`)

`#app button { … }` applies a **metal toggle bitmap**, **`border: none`**, and a **large min-height** to **every** button in `#app`. Specificity **beats** plain classes like `.map-theater-card`, so you get **wrong chrome** (e.g. giant rocker on map cards) unless you add an `#app button.…` override.

**Rule:** Any button that is **not** meant to look like the metal toggle needs an **`#app button.<class>`** exception (or the control must not be a `<button>`—rare).

**Known exceptions in the tree include:** `#app header .lp-dock-tag` and `#app #screen-landing .lp-dock-tag` (dial PNGs, not toggle art), `.lp-dock-go`, `.btn`, `.cta`, hub/codex tiles, **`#app button.map-theater-card`**, etc.

## 4. Top bar nav = same dial pattern as landing command strip

The **header primary nav** (Ops, Codex, Settings, Classic) uses the **same** building blocks as the landing **command strip**:

- Class **`lp-dock-tag`** + **`lp-dock-tag__labels`** (label under the dial).
- Modifier **`lp-dock-tag--header`** scales the **PNG dial** down so it fits the top bar; optional **`lp-dock-tag--header-accent`** keeps the “Classic” dial in the **lit** state for emphasis.

Assets: `assets/buttons/red button glow off.png` / `red button glow on.png`. The dial `::before` uses **`pointer-events: none`** so clicks hit the real button and labels.

## 5. Local server

ES modules and `fetch()` for JSON **fail on `file://`**. Use **`npm start`** / `python tools/serve_dev.py` or VS Code Live Server from the **project root**.
