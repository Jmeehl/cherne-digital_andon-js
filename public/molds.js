// public/molds.js
// Mold Cleaning page: full list + "In system (active)" inference (heartbeat from lastExtractTs)

const ACTIVE_WINDOW_MIN = 180;     // user-selected: 180 minutes
const RUNNING_WINDOW_MIN = 30;     // "oven/system running" heuristic

const thresholdEl = document.getElementById("threshold");
const saveThresholdBtn = document.getElementById("saveThreshold");
const sizeFilterEl = document.getElementById("sizeFilter");
const statusFilterEl = document.getElementById("statusFilter");
const activeOnlyEl = document.getElementById("activeOnly");
const searchEl = document.getElementById("searchMold");
const refreshBtn = document.getElementById("refresh");

const kpisEl = document.getElementById("kpis");
const rowsEl = document.getElementById("rows");

const systemDotEl = document.getElementById("systemDot");
const systemStateEl = document.getElementById("systemState");
const activeTotalEl = document.getElementById("activeTotal");
const sinceLatestEl = document.getElementById("sinceLatest");
const activeCountsEl = document.getElementById("activeCounts");
const activeMoldsEl = document.getElementById("activeMolds");

let snapshot = null;
let config = null;

// Join molds socket room for live updates
const socket = io({ query: { room: "molds" }, transports: ["websocket", "polling"] });
socket.on("moldsSnapshot", (snap) => {
  snapshot = snap;
  render();
});

function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function fmtAgeMinutes(mins) {
  if (mins === null || mins === undefined) return "—";
  const m = Number(mins);
  if (!Number.isFinite(m)) return "—";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h ${r}m`;
}

function moldLabel(m) {
  // Requested format: "size-number" (e.g., 2-47)
  return `${m.moldSize}-${m.moldNumber}`;
}

async function loadConfig() {
  const r = await fetch("/api/molds/config", { cache: "no-store" });
  config = await r.json();
  thresholdEl.value = config.cleanThresholdCycles ?? 250;
}

async function loadSnapshot() {
  const r = await fetch("/api/molds/snapshot", { cache: "no-store" });
  snapshot = await r.json();
  render();
}

async function saveThreshold() {
  const v = Number(thresholdEl.value);
  if (!Number.isFinite(v) || v < 1) return;

  const r = await fetch("/api/molds/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cleanThresholdCycles: v,
      dueSoonRatio: config?.dueSoonRatio ?? 0.85
    })
  });

  if (!r.ok) {
    alert("Failed to save threshold");
    return;
  }
  config = await r.json();
}

function normalizeMolds() {
  const list = Array.isArray(snapshot?.molds) ? snapshot.molds : [];
  return list.map((m) => ({
    ...m,
    lastExtractTs: m.lastExtractTs ? Number(m.lastExtractTs) : null
  }));
}

function computeAgeMinutes(m, now) {
  if (!m.lastExtractTs) return null;
  return Math.max(0, Math.round((now - m.lastExtractTs) / 60000));
}

function isActive(m, now) {
  const age = computeAgeMinutes(m, now);
  if (age === null) return false;
  return age <= ACTIVE_WINDOW_MIN;
}

function applyFilters(list, now) {
  const size = (sizeFilterEl.value || "").trim();
  const status = (statusFilterEl.value || "").trim();
  const q = (searchEl.value || "").trim().toLowerCase();
  const activeOnly = !!activeOnlyEl.checked;

  return list.filter((m) => {
    if (size && String(m.moldSize) !== size) return false;
    if (status && String(m.status) !== status) return false;

    if (q) {
      const s1 = String(m.moldNumber ?? "").toLowerCase();
      const s2 = moldLabel(m).toLowerCase();
      if (!s1.includes(q) && !s2.includes(q)) return false;
    }

    if (activeOnly && !isActive(m, now)) return false;
    return true;
  });
}

function renderKpis(moldsAll) {
  const counts = snapshot?.counts ?? { total: moldsAll.length, overdue: 0, dueSoon: 0, ok: 0 };
  const worst = snapshot?.worst ?? (moldsAll.length ? moldsAll[0] : null);

  const worstText = worst ? moldLabel(worst) : "—";

  kpisEl.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Total Molds</div>
      <div class="kpi-value">${counts.total ?? moldsAll.length}</div>
      <div class="kpi-sub">All molds in snapshot</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Overdue</div>
      <div class="kpi-value">${counts.overdue ?? 0}</div>
      <div class="kpi-sub">Needs cleaning</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Due Soon</div>
      <div class="kpi-value">${counts.dueSoon ?? 0}</div>
      <div class="kpi-sub">Approaching threshold</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">OK</div>
      <div class="kpi-value">${counts.ok ?? 0}</div>
      <div class="kpi-sub">Below due soon</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Worst Mold</div>
      <div class="kpi-value">${worstText}</div>
      <div class="kpi-sub">${worst ? `Over by ${worst.overBy ?? 0} cycles` : ""}</div>
    </div>
  `;
}

function renderSystemPanel(moldsAll, now) {
  // Active list & latest record age
  let latestTs = null;
  for (const m of moldsAll) {
    if (m.lastExtractTs && (!latestTs || m.lastExtractTs > latestTs)) latestTs = m.lastExtractTs;
  }
  const latestAgeMin = latestTs ? Math.max(0, Math.round((now - latestTs) / 60000)) : null;

  const activeMolds = moldsAll
    .map((m) => ({ m, age: computeAgeMinutes(m, now) }))
    .filter((x) => x.age !== null && x.age <= ACTIVE_WINDOW_MIN)
    .map((x) => ({ ...x.m, ageMinutes: x.age }));

  activeTotalEl.textContent = `Active: ${activeMolds.length}`;
  sinceLatestEl.textContent = `Latest Record: ${fmtAgeMinutes(latestAgeMin)}`;

  // "Running" heuristic: any mold updated in last RUNNING_WINDOW_MIN
  const running = moldsAll.some((m) => {
    const age = computeAgeMinutes(m, now);
    return age !== null && age <= RUNNING_WINDOW_MIN;
  });

  // Display status
  systemDotEl.classList.remove("dot-ok", "dot-warn", "dot-off");
  if (!latestTs) {
    systemDotEl.classList.add("dot-off");
    systemStateEl.innerHTML = `<span class="status-dot dot-off" id="systemDot"></span>Status: No data`;
  } else if (running) {
    systemDotEl.classList.add("dot-ok");
    systemStateEl.innerHTML = `<span class="status-dot dot-ok"></span>Status: Running`;
  } else {
    systemDotEl.classList.add("dot-warn");
    systemStateEl.innerHTML = `<span class="status-dot dot-warn"></span>Status: Idle/Off`;
  }

  // Active counts by size
  const bySize = new Map();
  for (const m of activeMolds) {
    const s = String(m.moldSize ?? "—");
    bySize.set(s, (bySize.get(s) ?? 0) + 1);
  }
  const sizes = Array.from(bySize.keys()).sort((a, b) => Number(a) - Number(b));
  activeCountsEl.innerHTML = sizes.length
    ? sizes.map((s) => `<tr><td>${s}</td><td>${bySize.get(s)}</td></tr>`).join("")
    : `<tr><td colspan="2">0</td></tr>`;

  // Active mold list: sorted size then mold number
  activeMolds.sort((a, b) => {
    const ds = (a.moldSize ?? 0) - (b.moldSize ?? 0);
    if (ds !== 0) return ds;
    return (a.moldNumber ?? 0) - (b.moldNumber ?? 0);
  });

  activeMoldsEl.innerHTML = activeMolds.length
    ? activeMolds.slice(0, 800).map((m) => `
        <tr>
          <td>${moldLabel(m)}</td>
          <td>${fmtAgeMinutes(m.ageMinutes)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="2">None</td></tr>`;
}

function renderMainTable(moldsFiltered, now) {
  rowsEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const m of moldsFiltered) {
    const ageMin = computeAgeMinutes(m, now);
    const active = ageMin !== null && ageMin <= ACTIVE_WINDOW_MIN;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${moldLabel(m)}</td>
      <td>${m.moldSize ?? "—"}</td>
      <td>${m.cyclesSince ?? "—"}</td>
      <td>${m.overBy ?? 0}</td>
      <td>${m.ttdCycles ?? "—"}</td>
      <td>${fmtTs(m.lastExtractTs)}</td>
      <td>${ageMin === null ? "—" : ageMin}</td>
      <td>${m.status ?? "—"}</td>
      <td>${ageMin === null ? "—" : (active ? "YES" : "NO")}</td>
    `;
    frag.appendChild(tr);
  }

  rowsEl.appendChild(frag);
}

function render() {
  if (!snapshot) return;

  const now = Date.now();
  const moldsAll = normalizeMolds();

  // KPI uses full list
  renderKpis(moldsAll);

  // Side panel uses full list
  renderSystemPanel(moldsAll, now);

  // Main table uses filters but never slices (shows entire quantity)
  const moldsFiltered = applyFilters(moldsAll, now);
  renderMainTable(moldsFiltered, now);
}

// Events
saveThresholdBtn.addEventListener("click", async () => {
  await saveThreshold();
  await loadSnapshot();
});

refreshBtn.addEventListener("click", loadSnapshot);

[sizeFilterEl, statusFilterEl, activeOnlyEl, searchEl].forEach((el) => {
  el.addEventListener("input", render);
  el.addEventListener("change", render);
});

// Init
(async function init() {
  await loadConfig().catch(() => {});
  await loadSnapshot().catch(() => {});
})();