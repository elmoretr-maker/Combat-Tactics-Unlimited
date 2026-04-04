import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, "..", "dev-editor.html");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CTU // UNIT OVERRIDE TERMINAL</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0a0e0d;
      --panel: #0f1614;
      --amber: #e8a838;
      --green: #6bdc7a;
      --dim: #5a7a66;
      --line: #1e2a24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--green);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 13px;
    }
    .scanlines {
      pointer-events: none;
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.12) 2px,
        rgba(0, 0, 0, 0.12) 4px
      );
      z-index: 9998;
    }
    header {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--amber);
      letter-spacing: 0.08em;
    }
    .sub {
      margin: 0.35rem 0 0;
      color: var(--dim);
      font-size: 0.75rem;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--line);
      align-items: center;
    }
    button, .btn-link {
      font-family: inherit;
      font-size: 12px;
      padding: 0.45rem 0.9rem;
      border: 1px solid var(--amber);
      background: transparent;
      color: var(--amber);
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    button:hover, .btn-link:hover {
      background: rgba(232, 168, 56, 0.12);
      color: var(--green);
      border-color: var(--green);
    }
    button.primary {
      background: rgba(107, 220, 122, 0.15);
      border-color: var(--green);
      color: var(--green);
    }
    .wrap {
      overflow: auto;
      padding: 0.75rem 1rem 2rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1100px;
    }
    th {
      text-align: left;
      color: var(--amber);
      font-weight: 600;
      padding: 0.5rem 0.35rem;
      border-bottom: 1px solid var(--amber);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    td {
      padding: 0.35rem;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    tr:hover td {
      background: rgba(107, 220, 122, 0.04);
    }
    input[type="text"],
    input[type="number"],
    select {
      width: 100%;
      max-width: 7rem;
      background: #050807;
      border: 1px solid var(--line);
      color: var(--green);
      font-family: inherit;
      font-size: 12px;
      padding: 0.25rem 0.35rem;
    }
    input.w-wide { max-width: 10rem; }
    input.w-sprite { max-width: 14rem; }
    td.chk { text-align: center; }
    td.chk input { width: auto; accent-color: var(--amber); }
    .id-cell {
      color: var(--dim);
      font-size: 11px;
      max-width: 6rem;
    }
    #toast {
      position: fixed;
      bottom: 1.25rem;
      right: 1.25rem;
      padding: 0.65rem 1rem;
      background: var(--panel);
      border: 1px solid var(--green);
      color: var(--green);
      font-weight: 600;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.2s, transform 0.2s;
      z-index: 9999;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    }
    #toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .err {
      color: #ff6b6b;
      padding: 1rem 1.25rem;
    }
  </style>
</head>
<body>
  <div class="scanlines" aria-hidden="true"></div>
  <header>
    <h1>CTU // UNIT OVERRIDE TERMINAL</h1>
    <p class="sub">localStorage key: <span style="color:var(--amber)">ctu_unit_overrides</span> — merge applied on every game load</p>
  </header>
  <div class="toolbar">
    <button type="button" class="primary" id="btn-save">Save to database</button>
    <button type="button" id="btn-reset">Reset to defaults</button>
    <a class="btn-link" href="index.html">← Return to game</a>
    <span id="status" class="sub" style="margin-left:auto;"></span>
  </div>
  <div id="load-err" class="err" hidden></div>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Unit name</th>
          <th>Sprite key</th>
          <th>Move</th>
          <th>Rng min</th>
          <th>Rng max</th>
          <th>Sight</th>
          <th>Indirect</th>
          <th>LOS</th>
          <th>Deadzone</th>
          <th>Special ability</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div id="toast" role="status">Unit Stats Updated!</div>

  <script type="module">
    import {
      loadOverridesObject,
      saveOverridesObject,
      clearOverridesInStorage,
      baselineRowFromShippedTemplate,
    } from "./js/config/unitOverridesStorage.js";

    const tbody = document.getElementById("tbody");
    const toast = document.getElementById("toast");
    const statusEl = document.getElementById("status");
    const loadErr = document.getElementById("load-err");

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2800);
    }

    function rowData(u, stored) {
      const base = baselineRowFromShippedTemplate(u);
      const o = stored[u.id];
      if (!o || typeof o !== "object") return base;
      return {
        ...base,
        ...o,
        id: u.id,
        isIndirect: o.isIndirect ?? (o.attackType === "indirect"),
        attackType: o.attackType ?? base.attackType,
      };
    }

    function render(units, stored) {
      tbody.innerHTML = "";
      for (const u of units) {
        const r = rowData(u, stored);
        const tr = document.createElement("tr");
        tr.dataset.unitId = u.id;
        tr.innerHTML =
          '<td class="id-cell">' +
          u.id +
          "</td>" +
          '<td><input type="text" class="w-wide" data-f="displayName" value="' +
          escapeAttr(r.displayName) +
          '" /></td>' +
          '<td><input type="text" class="w-sprite" data-f="mapSpriteSet" value="' +
          escapeAttr(r.mapSpriteSet) +
          '" /></td>' +
          '<td><input type="number" data-f="move" step="1" value="' +
          num(r.move) +
          '" /></td>' +
          '<td><input type="number" data-f="rangeMin" step="1" value="' +
          num(r.rangeMin) +
          '" /></td>' +
          '<td><input type="number" data-f="rangeMax" step="1" value="' +
          num(r.rangeMax) +
          '" /></td>' +
          '<td><input type="number" data-f="sightRange" step="1" value="' +
          num(r.sightRange) +
          '" /></td>' +
          '<td class="chk"><input type="checkbox" data-f="isIndirect"' +
          (r.isIndirect ? " checked" : "") +
          " /></td>" +
          '<td class="chk"><input type="checkbox" data-f="usesLos"' +
          (r.usesLos ? " checked" : "") +
          " /></td>" +
          '<td><input type="number" data-f="deadzoneRange" step="1" min="0" value="' +
          num(r.deadzoneRange) +
          '" /></td>' +
          "<td>" +
          abilitySelect(r.specialAbility) +
          "</td>";
        tbody.appendChild(tr);
      }
    }

    function escapeAttr(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
    }

    function num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }

    function abilitySelect(current) {
      const opts = ["None", "Counter-Attack", "Preemptive Strike"];
      let h = '<select data-f="specialAbility">';
      for (const o of opts) {
        h +=
          "<option" +
          (o === current ? " selected" : "") +
          ">" +
          o +
          "</option>";
      }
      h += "</select>";
      return h;
    }

    function collectPayload() {
      const out = {};
      for (const tr of tbody.querySelectorAll("tr[data-unit-id]")) {
        const id = tr.dataset.unitId;
        const get = (f) => tr.querySelector("[data-f='" + f + "']");
        const indirectEl = get("isIndirect");
        const isIndirect = indirectEl && indirectEl.checked;
        out[id] = {
          displayName: get("displayName").value.trim(),
          mapSpriteSet: get("mapSpriteSet").value.trim(),
          move: num(get("move").value),
          rangeMin: num(get("rangeMin").value),
          rangeMax: num(get("rangeMax").value),
          sightRange: num(get("sightRange").value),
          usesLos: get("usesLos").checked,
          isIndirect,
          attackType: isIndirect ? "indirect" : "direct",
          deadzoneRange: num(get("deadzoneRange").value),
          deadspace: num(get("deadzoneRange").value),
          specialAbility: get("specialAbility").value,
        };
      }
      return out;
    }

    document.getElementById("btn-save").addEventListener("click", () => {
      try {
        const payload = collectPayload();
        saveOverridesObject(payload);
        showToast("Unit Stats Updated!");
        statusEl.textContent = "Saved " + Object.keys(payload).length + " units.";
      } catch (e) {
        showToast("Save failed");
        console.error(e);
      }
    });

    document.getElementById("btn-reset").addEventListener("click", () => {
      if (!confirm("Clear ctu_unit_overrides and reload defaults in this table?")) return;
      clearOverridesInStorage();
      fetch("js/config/units.json")
        .then((r) => r.json())
        .then((units) => {
          render(units, {});
          showToast("Defaults loaded — Save to write DB or leave empty for shipped JSON.");
          statusEl.textContent = "Storage cleared.";
        })
        .catch((e) => {
          loadErr.hidden = false;
          loadErr.textContent = String(e);
        });
    });

    fetch("js/config/units.json")
      .then((r) => {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then((units) => {
        const stored = loadOverridesObject();
        render(units, stored);
        statusEl.textContent = units.length + " units — " +
          (Object.keys(stored).length ? "loaded overrides" : "using table defaults (empty storage)");
      })
      .catch((e) => {
        loadErr.hidden = false;
        loadErr.textContent =
          "Could not load js/config/units.json — use a local server (npm start), not file://";
        console.error(e);
      });
  </script>
</body>
</html>
`;

fs.writeFileSync(out, html, "utf8");
console.log("Wrote", out);
