# Combat Vision — Landing HUD architecture

**Status:** The **Combat Vision** experiment (`landing-hud` wrapper + `css/ctu-landing-hud.css`) is **not** in the current tree; landing uses the **pre–Combat Vision** DOM (`#screen-landing` → stage + dock, as in commit `b9da3d4`). This file is kept as a design record only.

**Mission:** *Combat Tactics Unlimited* is a **hardcore tactical simulator**. Modern Ops landing chrome should read as **military briefing / C2 interface**, not a generic marketing page. Layout uses **flex column + explicit z-index tokens**—no accidental float overlap.

---

## 1. Z-index stack (mental map)

| Layer | Role | Token (`#screen-landing`) | Typical nodes |
|------|------|---------------------------|----------------|
| **L0** | Sensor feed | `--ctu-landing-z-feed: 0` | `#lp-bg-video`, poster |
| **L1** | Atmosphere / scan (non-interactive) | `--ctu-landing-z-atmosphere: 1` | `.lp-hero__grid`, `.lp-cinematic__readability` |
| **L2** | Intel strip (interactive text) | `--ctu-landing-z-interactive: 2` | `.lp-hero` / title banner |
| **—** | Metal bezel (DOM siblings in `ctu-metal-frame`) | *(see `css/ctu-metal.css`)* | corners, edges, rivets — painted above plate |
| **L30** | Command deck | `--ctu-landing-z-command-deck: 30` | `.lp-dock-shell` toolbar |
| **L40** | Deploy module | `--ctu-landing-z-deploy: 40` | `#v2-ops-layer` |
| **L45** | Flyouts above deck | `--ctu-landing-z-flyout: 45` | `.lp-dock-panel` |

**App chrome:** `#app` header `.top-bar` uses `z-index: 100` (`ctu-metal.css`) so primary nav stays above the landing screen (`#screen-landing` is `z-index: 1` when active).

**Battle / global:** tooltips, overlays, and loading layers use their own high values in `style.css` (50–300); they are **not** part of the landing stack.

---

## 2. Component map (HTML)

*(Historical)* Landing was wrapped in **`landing-hud`** (`data-ctu-component="landing-hud"`):

| Slot | `data-ctu-slot` | Contents |
|------|-----------------|----------|
| **Briefing stage** | `briefing` | Full `lp-stage-frame` — video viewport + metal HUD bezel + intel strip inside cinematic |
| **Command deck** | `command-deck` | `lp-dock-shell` — Command strip + dial buttons + flyout cards |
| **Deploy module** | `deploy` | `#v2-ops-layer` — Urban Siege / Classic (positioned above deck via CSS) |

IDs preserved for **`main.js`**, **`wireLandingDock`**, and **`syncV2OpsLayer`**.

---

## 3. Stylesheet load order

1. `style.css` — base + landing details  
2. `css/ctu-metal.css` — bitmap frame system, global `#app button`  
3. `css/ctu-v2.css` — deploy module sizing/position  
4. ~~**`css/ctu-landing-hud.css`**~~ — **removed** from the product; layer tokens live in `style.css` / `ctu-metal.css` for the current shell.

---

## 4. Asset inventory — `assets/` (repo root)

| Path | Notes |
|------|--------|
| `assets/hero-cover.png` | OG / social preview |
| `assets/buttons/red button glow off.png` | Command strip dial (idle) |
| `assets/buttons/red button glow on.png` | Command strip dial (hover / active) |
| `assets/buttons/Combat buttons/*.png` | Additional button art pack (Picsart exports + `preview.png`) |

**Not under `assets/` (but in repo):**

- **TDS Modern GUI / tiles / units:** `attached_assets/craftpix_pack/` (see `craftpixAssetMap.json`, pack READMEs). There is **no** separate folder named “TDS Modern GUI pack” under `assets/`; the licensed layout lives under **`attached_assets`**.
- **Landing video / poster:** `attached_assets/bg_video.mp4`, `attached_assets/bg_video_poster.jpg`
- **Urban Siege** as a **scenario** (JSON + in-engine map), not a static background file: `js/config/scenarios/urban_siege.json` — booted via Urban Siege button / `bootUrbanSiege()`.

---

## 5. Flexbox rule (blindness fix)

- **`#screen-landing.screen--active`:** column flex, full viewport.  
- **`.landing-hud`:** `flex: 1 1 auto; min-height: 0; flex-direction: column; position: relative` — single column for briefing + deck; absolute children (`#v2-ops-layer`) anchor here.  
- **`.lp-stage-frame`:** grows (`flex: 1`); viewport + `.lp-cinematic` stay `min-height: 0` so video doesn’t overflow the flex chain.

---

## 6. Future work (out of scope for this pass)

- No new gameplay features until this structure is stable.  
- Optional: split more landing rules from `style.css` into `ctu-landing-hud.css` incrementally.  
- Optional: rename legacy `lp-*` classes to `landing-hud__*` over time (keep aliases during migration).
