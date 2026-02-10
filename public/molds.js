// public/molds.js
// Mold Cleaning page: full list + dynamic "Mold Unloaded" flag + sorting
// Change requested: "Active only" now uses dynamic cutoff (Loaded) when system is running.

const ACTIVE_WINDOW_MIN = 180;   // fallback when system is idle/off
const RUNNING_WINDOW_MIN = 30;   // "system running" heuristic

const thresholdEl = document.getElementById("threshold");
const saveThresholdBtn = document.getElementById("saveThreshold");
const sizeFilterEl = document.getElementById("sizeFilter");
const statusFilterEl = document.getElementById("statusFilter");
const activeOnlyEl = document.getElementById("activeOnly");
const sortByEl = document.getElementById("sortBy");
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

// Live updates
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
  // size-number format
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

// ---------- Normalization ----------
function normalizeMolds() {
  const list = Array.isArray(snapshot?.molds) ? snapshot.molds : [];
  return list.map((m) => ({
    ...m,
    lastExtractTs: m.lastExtractTs ? Number(m.lastExtractTs) : null,
  }));
}

function computeAgeMinutes(m, now) {
  if (!m.lastExtractTs) return null;
  return Math.max(0, Math.round((now - m.lastExtractTs) / 60000));
}

// ---------- Dynamic "Unloaded" cutoff ----------
function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.floor(p * (sortedNums.length - 1))));
  return sortedNums[idx];
}

function computeDynamicUnloadedCutoff(agesSortedAsc) {
  // 98th percentile + 30 min buffer, clamped
  const p98 = percentile(agesSortedAsc, 0.98);
  if (p98 === null) return 180;
  return Math.min(360, Math.max(120, Math.round(p98 + 30)));
}

function statusRank(s) {
  if (s === "OVERDUE") return 3;
  if (s === "DUE_SOON") return 2;
  return 1;
}

function sortMolds(list, mode) {
  const arr = [...list];
  arr.sort((a, b) => {
    if (mode === "sizeNumber") {
      const ds = (a.moldSize ?? 0) - (b.moldSize ?? 0);
      if (ds !== 0) return ds;
      return (a.moldNumber ?? 0) - (b.moldNumber ?? 0);
    }
    if (mode === "moldNumber") {
      return (a.moldNumber ?? 0) - (b.moldNumber ?? 0);
    }
    if (mode === "cycles") {
      return (b.cyclesSince ?? 0) - (a.cyclesSince ?? 0);
    }
    if (mode === "lastNew") {
      return (b.lastExtractTs ?? 0) - (a.lastExtractTs ?? 0);
    }
    if (mode === "lastOld") {
      return (a.lastExtractTs ?? 0) - (b.lastExtractTs ?? 0);
    }

    if (mode === "unloaded") {
      const du = (b.isUnloaded ? 1 : 0) - (a.isUnloaded ? 1 : 0);
      if (du !== 0) return du;
      // then fall through to worst ordering
    }

    // Worst (default)
    const sr = statusRank(b.status) - statusRank(a.status);
    if (sr !== 0) return sr;
    const ob = (b.overBy ?? 0) - (a.overBy ?? 0);
    if (ob !== 0) return ob;
    return (b.cyclesSince ?? 0) - (a.cyclesSince ?? 0);
  });

  return arr;
}

// ---------- Filtering ----------
// NOTE: requested change is here: activeOnly uses dynamic cutoff when running
function applyFilters(list, now, running, unloadedCutoffMin) {
  const size = (sizeFilterEl.value || "").trim();
  const status = (statusFilterEl.value || "").trim();
  const q = (searchEl.value || "").trim().toLowerCase();
  const loadedOnly = !!activeOnlyEl.checked; // same checkbox, new meaning

  return list.filter((m) => {
    if (size && String(m.moldSize) !== size) return false;
    if (status && String(m.status) !== status) return false;

    if (q) {
      const s1 = String(m.moldNumber ?? "").toLowerCase();
      const s2 = moldLabel(m).toLowerCase();
      if (!s1.includes(q) && !s2.includes(q)) return false;
    }

    if (loadedOnly) {
      const age = computeAgeMinutes(m, now);
      if (age === null) return false;

      // ✅ If running, "loaded" means age <= dynamic cutoff
      if (running && unloadedCutoffMin) return age <= unloadedCutoffMin;

      // Fallback when system idle/off (dynamic cutoff not meaningful)
      return age <= ACTIVE_WINDOW_MIN;
    }

    return true;
  });
}

// ---------- Render KPIs ----------
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

// ---------- Render side panel ----------
function renderSystemPanel(moldsAll, now, running, unloadedCutoffMin) {
  let latestTs = null;
  for (const m of moldsAll) {
    if (m.lastExtractTs && (!latestTs || m.lastExtractTs > latestTs)) latestTs = m.lastExtractTs;
  }
  const latestAgeMin = latestTs ? Math.max(0, Math.round((now - latestTs) / 60000)) : null;

  // Loaded molds = dynamic cutoff when running; fallback to ACTIVE_WINDOW_MIN when idle/off
  const loadedMolds = moldsAll
    .map((m) => ({ m, age: computeAgeMinutes(m, now) }))
    .filter((x) => x.age !== null)
    .filter((x) => {
      if (running && unloadedCutoffMin) return x.age <= unloadedCutoffMin;
      return x.age <= ACTIVE_WINDOW_MIN;
    })
    .map((x) => ({ ...x.m, ageMinutes: x.age }));

  // Update pills
  activeTotalEl.textContent = `Loaded: ${loadedMolds.length}`;
  sinceLatestEl.textContent = `Latest Record: ${fmtAgeMinutes(latestAgeMin)}`;

  // Display system state
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

  // Subtitle text (optional, but keeps wording accurate)
  const metaEl = document.getElementById("activeMeta");
  if (metaEl) {
    if (running && unloadedCutoffMin) {
      metaEl.textContent = `Loaded = age ≤ ${unloadedCutoffMin} min (dynamic while running). Fallback: ${ACTIVE_WINDOW_MIN} min when idle/off.`;
    } else {
      metaEl.textContent = `Loaded = mold has a record within the last ${ACTIVE_WINDOW_MIN} minutes.`;
    }
  }

  // Loaded counts by size
  const bySize = new Map();
  for (const m of loadedMolds) {
    const s = String(m.moldSize ?? "—");
    bySize.set(s, (bySize.get(s) ?? 0) + 1);
  }
  const sizes = Array.from(bySize.keys()).sort((a, b) => Number(a) - Number(b));
  activeCountsEl.innerHTML = sizes.length
    ? sizes.map((s) => `<tr><td>${s}</td><td>${bySize.get(s)}</td></tr>`).join("")
    : `<tr><td colspan="2">0</td></tr>`;

  // Loaded mold list sorted size then mold number
  loadedMolds.sort((a, b) => {
    const ds = (a.moldSize ?? 0) - (b.moldSize ?? 0);
    if (ds !== 0) return ds;
    return (a.moldNumber ?? 0) - (b.moldNumber ?? 0);
  });

  activeMoldsEl.innerHTML = loadedMolds.length
    ? loadedMolds
        .slice(0, 800)
        .map((m) => `<tr><td>${moldLabel(m)}</td><td>${fmtAgeMinutes(m.ageMinutes)}</td></tr>`)
        .join("")
    : `<tr><td colspan="2">None</td></tr>`;
}

// ---------- Render main table ----------
function renderMainTable(moldsFiltered, now, running, unloadedCutoffMin) {
  rowsEl.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const m of moldsFiltered) {
    const ageMin = m.ageMinutes ?? computeAgeMinutes(m, now);

    let loadedText = "—";
    if (ageMin !== null && unloadedCutoffMin !== null) {
      loadedText = (running && m.isUnloaded) ? "Mold Unloaded" : "YES";
    } else if (ageMin !== null) {
      loadedText = "YES";
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${moldLabel(m)}</td>
      <td>${m.cyclesSince ?? "—"}</td>
      <td>${m.overBy ?? 0}</td>
      <td>${m.ttdCycles ?? "—"}</td>
      <td>${fmtTs(m.lastExtractTs)}</td>
      <td>${ageMin === null ? "—" : ageMin}</td>
      <td>${m.status ?? "—"}</td>
      <td>${loadedText}</td>
    `;
    frag.appendChild(tr);
  }

  rowsEl.appendChild(frag);
}

// ---------- Main render ----------
function render() {
  if (!snapshot) return;

  const now = Date.now();
  const moldsAll = normalizeMolds();

  // Compute ages once
  for (const m of moldsAll) m.ageMinutes = computeAgeMinutes(m, now);

  // Running heuristic (same as before)
  const running = moldsAll.some((m) => m.ageMinutes !== null && m.ageMinutes <= RUNNING_WINDOW_MIN);

  // Dynamic cutoff only meaningful if running
  const ages = moldsAll
    .map((m) => m.ageMinutes)
    .filter((x) => x !== null)
    .sort((a, b) => a - b);

  const unloadedCutoffMin = running ? computeDynamicUnloadedCutoff(ages) : null;

  // Mark unloaded flags for sorting/display
  for (const m of moldsAll) {
    m.isUnloaded = (running && unloadedCutoffMin !== null && m.ageMinutes !== null)
      ? (m.ageMinutes > unloadedCutoffMin)
      : false;
  }

  renderKpis(moldsAll);

  // Update side panel using dynamic cutoff too
  renderSystemPanel(moldsAll, now, running, unloadedCutoffMin);

  // Filters + sorting
  let moldsFiltered = applyFilters(moldsAll, now, running, unloadedCutoffMin);
  const sortMode = sortByEl?.value || "worst";
  moldsFiltered = sortMolds(moldsFiltered, sortMode);

  renderMainTable(moldsFiltered, now, running, unloadedCutoffMin);
}

// Events
saveThresholdBtn.addEventListener("click", async () => {
  await saveThreshold();
  await loadSnapshot();
});

refreshBtn.addEventListener("click", loadSnapshot);

[sizeFilterEl, statusFilterEl, activeOnlyEl, sortByEl, searchEl].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", render);
  el.addEventListener("change", render);
});

// Init
(async function init() {
  await loadConfig().catch(() => {});
  await loadSnapshot().catch(() => {});
})();