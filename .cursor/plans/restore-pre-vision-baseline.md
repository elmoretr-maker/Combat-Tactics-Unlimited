# Baseline: toggle removal + red round dock (plan iteration)

## “Base page black” — git reference you remembered

There are two plausible matches in history; the **battle / map “base”** is the stronger fit for wording like “base page … black.”

### Primary: **`bdeb416`** — black **stage** + **battle zoom / fullscreen** (same commit)

- **Message:** `Map theater with 20 scenarios, battle zoom/fullscreen, black stage styling`
- **When:** 2026-04-03 23:09 -0400 (night **before** the Apr 4 red-dial commits and **before** giant **`608b32a`**).
- **Cross-reference (your two memories):** In git, **“make the back black”** (black stage) and **“zoom in so the battle looks bigger”** (zoom/fullscreen) are **not** two separate commits — they land together in **`bdeb416`**. `git log -S applyBattleZoom` and the commit subject both point here.
- **What it touched:** Large feature drop — [style.css](style.css) battle/map theater styling, [index.html](index.html), [js/main.js](js/main.js), `mapCatalog.json`, many `map_*.json` scenarios, [js/render/fxLayer.js](js/render/fxLayer.js), etc.

If your memory is “we made the fight surface black **and** added zoom so the field wasn’t tiny,” **`bdeb416`** is the single anchor to **checkout or diff from**.

**How long ago (wall-clock):** From **`bdeb416` (Apr 3 23:09)** to **`608b32a` (Apr 4 00:15)** is ~**1h 6m**; to **`0ff5c95` (Apr 4 01:09)** is ~**2h**. From **`bdeb416`** to “now” on **Sat Apr 4** depends on the time of day (e.g. Saturday evening → on the order of **~20+ hours**).

### Alternate: **`f73f8e2`** — black **app canvas** (whole page behind UI)

- **Message:** `v2.0 Surgical Restore: fix boot failure, harden initApp, fix sprite mapping`
- **Evidence:** `git log -S "solid black" -- style.css` shows [style.css](style.css) gained the comment **“App canvas: solid black behind all screens”** in this commit (literal **html/body** base, not only battle).

If your memory is “make the overall page / shell black,” use **`f73f8e2`** (earlier than **`bdeb416`**).

### How this lines up with other milestones

```text
f73f8e2  (Apr 3 ~21h)  … app canvas black + surgical restore
   →
bdeb416  (Apr 3 ~23h)  … map theater + battle black stage
   →
608b32a  (Apr 4 ~00h)  … giant “redo 20 maps / hand-crafted terrain”
   →
1937913…b9da3d4       … red round dock / toggle strip work
   →
0ff5c95               … Combat Vision (landing-hud) — avoid as baseline
```

**Assessment:** If “everything worked” right after **black base** but **before** red-dial churn, test **`bdeb416`** or **`608b32a`** (depending whether you need the later map redo). If it worked **through** red dials, still use **`548e558` / `c613384`** from the section below.

### Timing: “~3 hours ago” vs git

- **Git only records commits**, not Cursor chat. A request like “make the back black” **~3 hours ago** in conversation does **not** necessarily produce a new commit; it may have been repeating an earlier change already on disk.
- On the **recorded timeline** (all **-0400**):
  - **`bdeb416`** (black stage in message): **2026-04-03 23:09**
  - **`608b32a`** (giant map redo): **2026-04-04 00:15** → about **1h 6m** after `bdeb416`
  - Red-dial commits: **00:24–00:52**
  - **`0ff5c95`** (Combat Vision): **2026-04-04 01:09** → about **2h** after `bdeb416`
- So the **last commit that explicitly says black stage** is still **`bdeb416`**, not something in the last 3 wall-clock hours relative to **`01:09`** on Apr 4. If your “3 hours” is **now** (e.g. later on Apr 4), that window lines up with **post–Combat Vision / local edits**, which **would not** show up as a new “black” commit unless you committed it.

---

## What you meant by “not here”

The earlier pin on **`b9da3d4`** (Combat buttons asset pack) is **after** the back-and-forth you care about. That commit and **`00b61db`** / **`4bca3a7`** are follow-ups (hero CTA, deploy overlay chrome, extra PNG pack), not the core “kill toggle art, use red round dials” thread.

## Git arc: removing toggles and replacing with red round buttons

All of these are **after** the giant maps commit **`608b32a`** and **before** Combat Vision **`0ff5c95`**. **No `*.js`** changes appear in this range on `main` (Hub/Codex logic unchanged by these commits).

| Order | Commit   | What it is (re your thread) |
|-------|----------|-----------------------------|
| 1 | **1937913** | Replace command strip dock tags with **red glow** button images |
| 2 | **b1a84d7** | **Circular red dial** images above labels |
| 3 | **0493b61** | Remove **toggle-button borders**; align circular dials |
| 4 | **548e558** | **Strip global toggle PNG from landing dock tags** (circle-only layer) — direct “toggle off dock” |
| 5 | **c613384** | Center dial row, larger buttons, labels under each dial |
| 6 | **4bca3a7** | Deploy overlay metal frame (adjacent UI, not dock-toggle core) |
| 7 | **00b61db** | Remove hero Enter CTA + its toggle styling |
| 8 | **b9da3d4** | Picsart asset pack (downstream of the dial work) |

## Recommended “last time that conversation’s outcome felt right”

Use one of these SHAs for checkout / diff, depending on how tight you want the window:

1. **`548e558`** — Best semantic match for **“toggles removed from dock; red circle layer only.”**
2. **`c613384`** — If you remember things feeling right **after** the dial row was centered and sized (one step later).
3. **`1937913`** — Narrowest “red buttons first landed” (may still have rough edges before border/toggle strip fixes).

**Avoid using `b9da3d4` alone** as the definition of that thread unless you explicitly want “including asset pack”; you said that era is **not** what you meant by “here.”

## Assessment steps (unchanged in spirit, new SHAs)

1. Run the app at **`548e558`** (then **`c613384`** if needed) over **HTTP** (`npm start` / `python tools/serve_dev.py`). Confirm Hub + Codex lists render.
2. If good: diff **`548e558`..HEAD** (and your working tree) for [style.css](style.css), [css/ctu-metal.css](css/ctu-metal.css), [index.html](index.html), [css/ctu-v2.css](css/ctu-v2.css) — restore only what regresses list/layout.
3. Keep map-engine WIP on a branch; isolate **import/init** errors in [js/main.js](js/main.js) if Codex is still empty on a clean checkout.

## Still excluded from this thread

- **`0ff5c95`** Combat Vision (`landing-hud`, `ctu-landing-hud.css`) — separate “assessment” that you already associate with breakage.

---

## Evaluation: **`bdeb416`** (zoom + black stage) vs **now** — UI/UX and “features showing”

**“Now”** means two layers: **`origin/main` @ `0ff5c95`** (committed), plus **your local working tree** (Combat Vision partially reverted, map-engine WIP, extra `ctu-metal` / `style` edits).

### 1. Landmark: zoom / black stage commit is **not** the same as “map skirmish loadout” DOM

- **`bdeb416`** introduced battle **zoom/fullscreen**, **black stage**, **map theater** screen, `mapCatalog`, and large `style.css` / `main.js` / `index.html` churn.
- **`#screen-map-skirmish`** (Deploy on [map] + pick grid + confirm) **does not exist in `bdeb416`’s `index.html`**. It first appears in **`608b32a`** (`git log -S "screen-map-skirmish" -- index.html` → only that commit).
- **`main.js` after `bdeb416` on `main`** is touched only by **`608b32a`** (map loadout, `openMapSkirmishLoadout`, hub “maps” action, `mergeScenarioForBattle` skirmish loadout, etc.).

So: if “everything worked” included **click map → squad loadout screen → battle**, that state is **at least `608b32a`**, not `bdeb416` alone. **`bdeb416`** is still the right anchor for **“black stage + zoom UI”** specifically.

### 2. Committed delta **`bdeb416` → `0ff5c95`** (UI/UX–relevant)

| Area | At **`bdeb416`** (roughly) | By **`0ff5c95`** (committed “now” on `main`) |
|------|----------------------------|-----------------------------------------------|
| **Landing shell** | Video stage + dock **directly under** `#screen-landing`; **hero had** “Enter command hub” CTA (`lp-hero__cta`). | **Hero CTA removed** (`00b61db`). **Red circular dock** styling (`::before` PNGs, label structure) via **`style.css`** + commits **`1937913`…`548e558`**. **Maps** dock item + flyout card added. **`v2-ops-layer`** wrapped in **metal frame** (`4bca3a7`). **Combat Vision** (`0ff5c95`): extra **`landing-hud`** wrapper + **`ctu-landing-hud.css`** (stacking/flex tokens). |
| **Stylesheets** | No `ctu-landing-hud.css`. | **`ctu-landing-hud.css`** linked; **`style.css`** / **`ctu-v2.css`** / **`ctu-metal.css`** materially different from `bdeb416` (hundreds of lines net change across the range). |
| **Fixed landing + main** | `#screen-landing.screen--active` **position:fixed** + flex column already present in the landing redesign (not introduced in `0ff5c95` alone); risk of **`<main>` in-flow height ~0** while landing open (discussed in debugging). | Same pattern; Combat Vision adds **another flex column** (`landing-hud`) inside the fixed section → more stacking/flex interaction. |
| **Global buttons** | `#app button` toggle texture affects hub/codex unless overridden. | Same base rule; **later `ctu-metal.css`** adds **`#app button.hub-mode-card`**, **`.btn` / `.cta`**, etc., to strip toggle art (exact set evolved in **uncommitted** work too). |
| **Hub / Codex behavior (JS)** | `renderHubModes` / `renderCodex` / `initApp` **unchanged between `608b32a` and `0ff5c95`** on committed `main`. | Empty lists are **not** explained by Combat Vision commits alone; suspect **runtime** (e.g. `file://`, failed **`main.js` import**, `initApp` throw) or **CSS collapse** (e.g. bad flex/`min-height` on list containers — some fixes were tried in chat). |
| **Battle** | Zoom bar, black stage, `applyBattleZoom`, floating tools — from **`bdeb416`**. | Largely same **committed** surface; **local** `main.js` / `canvasGrid` / `MapManager` change **render/input**, not hub list markup. |

### 3. Local working tree vs **`0ff5c95`** (additional UI/UX drift)

- **`index.html`**: Combat Vision **rolled back** (no `landing-hud`, no `ctu-landing-hud` link) — closer to **`b9da3d4`–era** shape than to **`0ff5c95`**.
- **`css/ctu-landing-hud.css`**: **deleted** locally; **HEAD** still expects it if you reset to **`0ff5c95`** without this file → broken link.
- **`css/ctu-metal.css` / `style.css`**: extra rules (e.g. **`#app > main { min-height: … }`**, dock `pointer-events`, removed “first-child flex” block) — can **help or hurt** list visibility depending on selectors.
- **`js/main.js` + new engine modules**: **`MapManager`**, **`BattleInputHandler`**, etc. — if any **import fails**, the **entire module** can fail → **no `initApp`**, **empty Codex/hub**.

### 4. Practical takeaway

- To match **“zoom + black stage worked”** visually: diff **`bdeb416`** (or **`608b32a`** if map loadout screen must exist) vs current **`style.css`** / **`index.html`** / **`ctu-v2.css`** / **`ctu-metal.css`** for **landing, battle, `#app > main`**, and **dock**.
- To match **“all hub/codex features visible”** on committed history: **`608b32a`…`548e558`** is a stronger “gameplay+UI stable” band than **`0ff5c95`**, because **`0ff5c95`** only adds landing structure + doc.
- **Resolve “now”** by testing **(A)** clean **`git checkout 608b32a`** or **`548e558`** over HTTP, then **(B)** your **full working tree** with DevTools **console** for import/init errors.
