// public/history.js
// Maintenance reliability dashboard enhancements:
// - Date range filtering (start/end + presets)
// - Machine dropdown (maintenance only) from /api/maintenance/assets/all
// - Time Open KPIs (elapsedMs = ticket open time)
// - MTBF (proxy) = time between completion events for same machine (shows in hours/days)
// - Repeat offender KPIs (repeat within 7 days of prior completion)
// - Stable canvas sizing (prevents chart growth) + debounced metric redraw

(() => {
  // -----------------------
  // DOM
  // -----------------------
  const rowsEl = document.getElementById("rows");
  const searchEl = document.getElementById("search");
  const refreshBtn = document.getElementById("refresh");
  const exportCsv = document.getElementById("exportCsv");
  const export8hrBtn = document.getElementById("export8hrBtn");
  const rangeEl = document.getElementById("range");

  const startDateEl = document.getElementById("startDate");
  const endDateEl = document.getElementById("endDate");
  const presetRangeEl = document.getElementById("presetRange");

  const assetSelect = document.getElementById("assetSelect");
  const assetLabel = document.getElementById("assetLabel");

  const histSubtitle = document.getElementById("histSubtitle");
  const kpisEl = document.getElementById("kpis");

  const trendCanvas = document.getElementById("trendChart");
  const responderCanvas = document.getElementById("responderChart");
  const cellCanvas = document.getElementById("cellChart");

  const trendSubtitle = document.getElementById("trendSubtitle");
  const responderSubtitle = document.getElementById("responderSubtitle");
  const cellSubtitle = document.getElementById("cellSubtitle");

  const titleEl = document.getElementById("histTitle");

  const moldCleaningBtn = document.getElementById("moldCleaningBtn")

  // Delete modal
  const deleteBtn = document.getElementById("deleteHistoryBtn");
  const deleteModal = document.getElementById("deleteModal");
  const cancelDelete = document.getElementById("cancelDelete");
  const confirmDelete = document.getElementById("confirmDelete");

  // Responders modal
  const respondersModal = document.getElementById("respondersModal");
  const closeRespondersBtn = document.getElementById("closeRespondersBtn");
  const newResponderEl = document.getElementById("newResponder");
  const addResponderBtn = document.getElementById("addResponderBtn");
  const responderListEl = document.getElementById("responderList");

  // Dept from /history/:dept
  const pathParts = location.pathname.split("/").filter(Boolean);
  const dept = pathParts[1] || "quality";

  const deptNameMap = {
    "quality": "Quality",
    "mfg-eng": "Manufacturing Engineering",
    "supervisor": "Supervisor / Leads",
    "safety": "Safety",
    "maintenance": "Maintenance"
  };

  const isMaint = dept === "maintenance";
  if (moldCleaningBtn) moldCleaningBtn.style.display = isMaint ? "" : "none"

  // Settings
  const DOWN_8H_MS = 8 * 60 * 60 * 1000; // 8 hours
  const REPEAT_WINDOW_DAYS = 7;
  const REPEAT_WINDOW_MS = REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  if (titleEl) titleEl.textContent = `${deptNameMap[dept] || dept} History`;

  // Data
  let allLogs = [];
  let responders = [];
  let responderCanon = new Map();
  let allAssets = [];

  // Debounce metrics redraw (table can update immediately)
  let metricsDebounce = null;
  function scheduleMetrics() {
    if (metricsDebounce) clearTimeout(metricsDebounce);
    metricsDebounce = setTimeout(() => requestAnimationFrame(renderMetrics), 140);
  }

  // -----------------------
  // Helpers
  // -----------------------
  function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

  function normKey(s) {
    return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function canonicalResponder(name) {
    const k = normKey(name);
    return responderCanon.get(k) || (name ?? "").trim() || "Unknown";
  }

  function fmtElapsedMs(ms) {
    if (typeof ms !== "number" || ms < 0) return "";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function msToPretty(ms) {
    if (typeof ms !== "number" || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${String(mm).padStart(2, "0")}m`;
  }

  function hours(ms) {
    return (ms || 0) / 3600000;
  }

  // For MTBF proxy display: use days when large
  function prettyHoursOrDays(ms) {
    if (typeof ms !== "number" || ms <= 0) return "—";
    const h = ms / 3600000;
    if (h >= 48) return `${(h / 24).toFixed(1)}d`;
    return `${h.toFixed(1)}h`;
  }

  function percentile(sortedArr, p) {
    if (!sortedArr.length) return null;
    const idx = (p / 100) * (sortedArr.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    const w = idx - lo;
    return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
  }

  function getAccent() {
    return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1565c0";
  }

  // Stable canvas setup to prevent growth on redraw:
  // - Measure width from .chart-card (stable)
  // - Height from the canvas height="" attribute (stable)
  // - Lock style.height to that attribute value
  function setupCanvas(canvas) {
    if (!canvas) return null;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const card = canvas.closest(".chart-card");
    const cssWidth = Math.max(320, Math.floor(card?.clientWidth || 320));

    const cssHeight = canvas.getAttribute("height")
      ? Number(canvas.getAttribute("height"))
      : 180;

    // Lock displayed height to prevent vertical growth loops
    canvas.style.height = cssHeight + "px";
    canvas.style.width = "100%";

    const needW = Math.floor(cssWidth * dpr);
    const needH = Math.floor(cssHeight * dpr);

    if (canvas.width !== needW) canvas.width = needW;
    if (canvas.height !== needH) canvas.height = needH;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssWidth, h: cssHeight };
  }

  // -----------------------
  // Date range
  // -----------------------
  function todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function toStartOfDayMs(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }

  function toEndOfDayMs(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  function defaultRange() {
    // Default last 30 days
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    const fmt = (dt) => {
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      return `${dt.getFullYear()}-${mm}-${dd}`;
    };
    return { start: fmt(start), end: fmt(end) };
  }

  function applyPreset(preset) {
    const end = new Date();
    let start = null;

    if (preset === "7d") start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
    if (preset === "30d") start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    if (preset === "90d") start = new Date(end.getTime() - 90 * 24 * 3600 * 1000);
    if (preset === "1y") start = new Date(end.getTime() - 365 * 24 * 3600 * 1000);

    if (preset === "ytd") {
      start = new Date(end.getFullYear(), 0, 1, 0, 0, 0, 0);
    }

    if (!start) return;

    const fmt = (dt) => {
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      return `${dt.getFullYear()}-${mm}-${dd}`;
    };

    if (startDateEl) startDateEl.value = fmt(start);
    if (endDateEl) endDateEl.value = fmt(end);
  }

  function getSelectedRangeMs() {
    const s = toStartOfDayMs(startDateEl?.value);
    const e = toEndOfDayMs(endDateEl?.value);
    if (!s || !e) return null;
    return { startMs: s, endMs: e };
  }

  // -----------------------
  // Maintenance asset key
  // -----------------------
  function assetKeyFromLog(l) {
    const a = (l?.fiix?.requestAsset ?? "").trim();
    return a || "General Maintenance (No Asset)";
  }

  function selectedAssetKey() {
    if (!isMaint) return "";
    return String(assetSelect?.value || "").trim();
  }

  // -----------------------
  // Column toggles
  // -----------------------
  function setColumnsForDept() {
    document.querySelectorAll(".col-part").forEach(el => el.style.display = isMaint ? "none" : "");
    document.querySelectorAll(".col-note").forEach(el => el.style.display = isMaint ? "none" : "");
    document.querySelectorAll(".col-fiix").forEach(el => el.style.display = isMaint ? "" : "none");
    document.querySelectorAll(".col-issue").forEach(el => el.style.display = isMaint ? "" : "none");
    document.querySelectorAll(".col-solution").forEach(el => el.style.display = isMaint ? "" : "none");
    document.querySelectorAll(".col-asset").forEach(el => el.style.display = isMaint ? "" : "none");

    if (assetSelect) assetSelect.style.display = isMaint ? "" : "none";
    if (assetLabel) assetLabel.style.display = isMaint ? "" : "none";
    if (export8hrBtn) export8hrBtn.style.display = isMaint ? "" : "none";
  }

  // -----------------------
  // Responders
  // -----------------------
  async function fetchResponders() {
    try {
      const r = await fetch(`/api/responders?dept=${encodeURIComponent(dept)}`, { cache: "no-store" });
      const data = await r.json();
      responders = Array.isArray(data?.responders) ? data.responders : [];
    } catch {
      responders = [];
    }
    responderCanon = new Map();
    for (const name of responders) responderCanon.set(normKey(name), name);
  }

  function renderRespondersModalList() {
    if (!responderListEl) return;
    if (!responders.length) {
      responderListEl.innerHTML = `<div style="color:#666;font-weight:800;">No responders added yet.</div>`;
      return;
    }
    responderListEl.innerHTML = responders.map(name => `
      <div class="responder-item">
        <div>${escapeHtml(name)}</div>
        <button data-name="${encodeURIComponent(name)}" type="button">Remove</button>
      </div>
    `).join("");

    responderListEl.querySelectorAll("button[data-name]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = decodeURIComponent(btn.getAttribute("data-name") || "");
        if (!name) return;
        if (!confirm(`Remove responder "${name}"?`)) return;

        await fetch(`/api/responders?dept=${encodeURIComponent(dept)}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
        await fetchResponders();
        renderRespondersModalList();
        renderTable();
        scheduleMetrics();
      });
    });
  }

  async function addResponder() {
    const name = (newResponderEl?.value || "").trim().replace(/\s+/g, " ");
    if (!name) return alert("Please enter a responder name.");

    const r = await fetch("/api/responders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dept, name })
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => "Unable to add responder.");
      return alert(msg);
    }

    newResponderEl.value = "";
    await fetchResponders();
    renderRespondersModalList();
    renderTable();
    scheduleMetrics();
  }

  function openResponders() {
    if (!respondersModal) return;
    fetchResponders().then(() => {
      renderRespondersModalList();
      respondersModal.classList.add("show");
      newResponderEl?.focus();
    });
  }

  window.addEventListener("flooralerts:openResponders", () => {
    try { openResponders(); } catch (e) { console.error(e); }
  });

  closeRespondersBtn?.addEventListener("click", () => respondersModal?.classList.remove("show"));
  respondersModal?.addEventListener("click", (e) => { if (e.target === respondersModal) respondersModal.classList.remove("show"); });
  addResponderBtn?.addEventListener("click", addResponder);
  newResponderEl?.addEventListener("keydown", (e) => { if (e.key === "Enter") addResponder(); });

  // -----------------------
  // Load ALL maintenance assets for dropdown
  // -----------------------
  async function loadAllAssetsForDropdown() {
    if (!isMaint || !assetSelect) return;

    try {
      const r = await fetch("/api/maintenance/assets/all", { cache: "no-store" });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Unable to load assets");
      allAssets = Array.isArray(data.assets) ? data.assets : [];
    } catch {
      allAssets = [];
    }

    const saved = localStorage.getItem("maint_asset_filter") || "";

    const labels = allAssets
      .map(a => String(a.label || "").trim())
      .filter(Boolean);

    labels.sort((a, b) => a.localeCompare(b));

    const opts = [
      `<option value="">All machines</option>`,
      `<option value="General Maintenance (No Asset)">General Maintenance (No Asset)</option>`,
      ...labels.map(label => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`)
    ];

    assetSelect.innerHTML = opts.join("");

    if (saved && [...assetSelect.options].some(o => o.value === saved)) {
      assetSelect.value = saved;
    }
  }

  // -----------------------
  // Filtering
  // -----------------------
  function filterLogsBase(logs) {
    const q = (searchEl?.value || "").trim().toLowerCase();
    const range = getSelectedRangeMs();
    const assetFilter = selectedAssetKey();

    return logs.filter(l => {
      // Date range
      if (range) {
        if (l.ts < range.startMs || l.ts > range.endMs) return false;
      }

      // Machine filter (maintenance only)
      if (isMaint && assetFilter) {
        if (assetKeyFromLog(l) !== assetFilter) return false;
      }

      // Search
      if (!q) return true;

      const responder = canonicalResponder(l.responderName || "");
      const cell = (l.cellName || l.cellId || "");
      const deptNm = (l.deptName || l.dept || "");
      const result = (l.result || "");
      const part = (l.partNumber || "");
      const note = (l.note || "");
      const fiixWo = (l.fiix?.workOrderNumber || "");
      const issue = (l.fiix?.requestDescription || "");
      const asset = assetKeyFromLog(l);

      return [deptNm, cell, asset, responder, result, part, note, fiixWo, issue]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }

  // -----------------------
  // Table
  // -----------------------
  function renderTable() {
    if (!rowsEl) return;

    const filtered = filterLogsBase(allLogs);

    rowsEl.innerHTML = filtered.map(l => {
      const dt = new Date(l.ts).toLocaleString();
      const dur = fmtElapsedMs(l.elapsedMs);
      const deptNm = l.deptName || l.dept || "";
      const cellNm = l.cellName || l.cellId || "";
      const responder = canonicalResponder(l.responderName || "");
      const result = l.result || "";

      if (isMaint) {
        const asset = assetKeyFromLog(l);
        const fiixWo = l.fiix?.workOrderNumber || "";
        const issue = l.fiix?.requestDescription || "";
        const solution = l.note || "";

        return `
          <tr>
            <td>${escapeHtml(dt)}</td>
            <td>${escapeHtml(deptNm)}</td>
            <td>${escapeHtml(cellNm)}</td>
            <td class="col-asset">${escapeHtml(asset)}</td>
            <td>${escapeHtml(responder)}</td>
            <td class="col-fiix">${escapeHtml(fiixWo)}</td>
            <td class="col-issue">${escapeHtml(issue)}</td>
            <td class="col-solution">${escapeHtml(solution)}</td>
            <td>${escapeHtml(result)}</td>
            <td>${escapeHtml(dur)}</td>
          </tr>
        `;
      }

      const part = l.partNumber || "";
      const noteHtml = escapeHtml(l.note || "").replace(/\n/g, "<br/>");

      return `
        <tr>
          <td>${escapeHtml(dt)}</td>
          <td>${escapeHtml(deptNm)}</td>
          <td>${escapeHtml(cellNm)}</td>
          <td>${escapeHtml(responder)}</td>
          <td class="col-part">${escapeHtml(part)}</td>
          <td>${escapeHtml(result)}</td>
          <td>${escapeHtml(dur)}</td>
          <td class="col-note note">${noteHtml}</td>
        </tr>
      `;
    }).join("");
  }

  // -----------------------
  // Metrics: Time Open stats (MTTR proxy)
  // -----------------------
  function calcTimeOpenStats(logs) {
    const times = logs.map(l => l.elapsedMs).filter(x => typeof x === "number" && x >= 0);
    const s = [...times].sort((a, b) => a - b);

    const avg = s.length ? (s.reduce((a, b) => a + b, 0) / s.length) : null;
    const med = s.length ? percentile(s, 50) : null;
    const p90 = s.length ? percentile(s, 90) : null;
    const max = s.length ? s[s.length - 1] : null;

    return {
      count: logs.length,
      avg,
      med,
      p90,
      max,
      totalMs: times.reduce((a, b) => a + b, 0)
    };
  }

  // MTBF (proxy): time between completion events for the same machine (selected)
  function calcMtbfProxy(logsForAsset) {
    const ts = logsForAsset
      .map(l => l.ts)
      .filter(x => typeof x === "number" && x > 0)
      .sort((a, b) => a - b);

    if (ts.length < 2) {
      return { nIntervals: 0, avg: null, med: null, p10: null, p90: null, min: null };
    }

    const deltas = [];
    for (let i = 1; i < ts.length; i++) deltas.push(ts[i] - ts[i - 1]);
    deltas.sort((a, b) => a - b);

    return {
      nIntervals: deltas.length,
      avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      med: percentile(deltas, 50),
      p10: percentile(deltas, 10),
      p90: percentile(deltas, 90),
      min: deltas[0]
    };
  }

  // Repeat offenders within 7 days of prior completion
  function calcRepeatOffenders(logs) {
    const byAsset = new Map();

    for (const l of logs) {
      const ts = l?.ts;
      if (typeof ts !== "number" || ts <= 0) continue;
      const asset = assetKeyFromLog(l);
      if (!byAsset.has(asset)) byAsset.set(asset, []);
      byAsset.get(asset).push(ts);
    }

    let totalRepeatEvents = 0;
    const perAsset = [];

    for (const [asset, tsList] of byAsset.entries()) {
      tsList.sort((a, b) => a - b);

      let repeats = 0;
      let minGap = null;

      for (let i = 1; i < tsList.length; i++) {
        const gap = tsList[i] - tsList[i - 1];
        if (gap <= REPEAT_WINDOW_MS) {
          repeats++;
          totalRepeatEvents++;
          if (minGap === null || gap < minGap) minGap = gap;
        }
      }

      if (repeats > 0) {
        perAsset.push({ asset, repeats, minGap });
      }
    }

    perAsset.sort((a, b) => {
      if (b.repeats !== a.repeats) return b.repeats - a.repeats;
      return (a.minGap ?? Infinity) - (b.minGap ?? Infinity);
    });

    return {
      totalRepeatEvents,
      uniqueRepeatAssets: perAsset.length,
      worst: perAsset[0] || null,
      perAsset
    };
  }

  // -----------------------
  // KPIs
  // -----------------------
  function renderKPIs(filteredLogs) {
    if (!kpisEl) return;

    const stats = calcTimeOpenStats(filteredLogs);
    const cards = [
      { label: "Total events", value: String(stats.count), sub: "Filtered range" },
      { label: "Avg time open", value: msToPretty(stats.avg), sub: "Mean request → complete" },
      { label: "Median time open", value: msToPretty(stats.med), sub: "50th percentile" },
      { label: "P90 time open", value: msToPretty(stats.p90), sub: "90th percentile" },
      { label: "Longest time open", value: msToPretty(stats.max), sub: "Max request → complete" },
      { label: "Total time open", value: `${hours(stats.totalMs).toFixed(1)}h`, sub: "Sum of elapsed time" }
    ];

    if (isMaint) {
      // 8+ hour events
      const longOpen = filteredLogs.filter(l => typeof l.elapsedMs === "number" && l.elapsedMs >= DOWN_8H_MS);

      // Repeat offenders (within 7 days)
      const repeat = calcRepeatOffenders(filteredLogs);

      // Put maintenance-specific KPIs at the front
      const maintCards = [];

      if (repeat.worst) {
        maintCards.push({
          label: "Worst repeat offender",
          value: `${repeat.worst.asset} (${repeat.worst.repeats})`,
          sub: repeat.worst.minGap != null ? `Shortest gap: ${prettyHoursOrDays(repeat.worst.minGap)}` : "Shortest gap: —"
        });
      }

      maintCards.push(
        { label: `Repeat ≤${REPEAT_WINDOW_DAYS}d (range)`, value: String(repeat.totalRepeatEvents), sub: "Events repeating within window" },
        { label: "Repeat machines", value: String(repeat.uniqueRepeatAssets), sub: "Machines with ≥1 repeat" },
        { label: "8+ hr events", value: String(longOpen.length), sub: "Count in range" }
      );

      // MTBF proxy only meaningful when a machine is selected
      const assetFilter = selectedAssetKey();
      if (assetFilter) {
        const mt = calcMtbfProxy(filteredLogs);
        maintCards.push(
          { label: "MTBF (proxy)", value: mt.avg ? prettyHoursOrDays(mt.avg) : "—", sub: "Avg time between events" },
          { label: "MTBF median", value: mt.med ? prettyHoursOrDays(mt.med) : "—", sub: "Median between events" }
        );
      } else {
        maintCards.push({ label: "MTBF (proxy)", value: "Select a machine", sub: "Shown when machine selected" });
      }

      // Combine
      kpisEl.innerHTML = [...maintCards, ...cards].map(c => `
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(c.label)}</div>
          <div class="kpi-value">${escapeHtml(c.value)}</div>
          <div class="kpi-sub">${escapeHtml(c.sub)}</div>
        </div>
      `).join("");

      return;
    }

    // Non-maint
    kpisEl.innerHTML = cards.map(c => `
      <div class="kpi-card">
        <div class="kpi-label">${escapeHtml(c.label)}</div>
        <div class="kpi-value">${escapeHtml(c.value)}</div>
        <div class="kpi-sub">${escapeHtml(c.sub)}</div>
      </div>
    `).join("");
  }

  // -----------------------
  // Charts
  // -----------------------
  function drawTrend(filteredLogs) {
    // Trend: last N events time-open (seconds)
    const recent = [...filteredLogs].slice(0, 180).reverse();
    const points = recent
      .filter(l => typeof l.elapsedMs === "number" && l.elapsedMs >= 0)
      .map(l => ({ x: l.ts, y: l.elapsedMs / 1000 }));

    const s = setupCanvas(trendCanvas);
    if (!s) return;
    const { ctx, w, h } = s;
    ctx.clearRect(0, 0, w, h);

    if (points.length < 2) {
      if (trendSubtitle) trendSubtitle.textContent = "Not enough data to chart.";
      return;
    }

    const padding = { l: 44, r: 12, t: 10, b: 28 };
    const innerW = w - padding.l - padding.r;
    const innerH = h - padding.t - padding.b;

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);

    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = 0, maxY = Math.max(...ys) * 1.1;

    // axes
    ctx.strokeStyle = "rgba(120,120,120,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.l, padding.t);
    ctx.lineTo(padding.l, padding.t + innerH);
    ctx.lineTo(padding.l + innerW, padding.t + innerH);
    ctx.stroke();

    // line
    const accent = getAccent();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = padding.l + ((p.x - minX) / (maxX - minX)) * innerW;
      const y = padding.t + innerH - ((p.y - minY) / (maxY - minY)) * innerH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (trendSubtitle) trendSubtitle.textContent = `Showing last ${points.length} completes (filtered)`;
  }

  function drawBarChart(canvas, subtitleEl, items, leftPad) {
  const s = setupCanvas(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);

  if (!items.length) {
    if (subtitleEl) subtitleEl.textContent = "No data yet.";
    return;
  }

  const padding = { l: leftPad, r: 40, t: 10, b: 18 };
  const innerW = w - padding.l - padding.r;
  const rowH = Math.max(14, Math.floor((h - padding.t - padding.b) / items.length));
  const maxVal = Math.max(...items.map(i => i.value)) || 1;

  const accent = getAccent();

  ctx.font = "12px system-ui";
  ctx.textBaseline = "alphabetic";

  items.forEach((it, idx) => {
    const y = padding.t + idx * rowH;
    const barW = (it.value / maxVal) * innerW;

    // Left category label
    ctx.fillStyle = "#6f6f6f";
    ctx.fillText(it.name, 10, y + rowH * 0.72);

    // Bar
    ctx.fillStyle = accent;
    ctx.fillRect(padding.l, y + 3, barW, rowH - 6);

    // Value label
    const label = String(it.label ?? it.value);
    const labelW = ctx.measureText(label).width;

    const gap = 6;
    const outsideX = padding.l + barW + gap;
    const outsideFits = outsideX + labelW <= (w - padding.r);

    // If it fits outside, draw outside in gray
    if (outsideFits) {
      ctx.fillStyle = "#6f6f6f";
      ctx.fillText(label, outsideX, y + rowH * 0.72);
      return;
    }

    // Otherwise, try inside the bar (right-aligned)
    const insidePadding = 6;
    const insideX = padding.l + barW - labelW - insidePadding;
    const insideFits = insideX >= padding.l + 2;

    if (insideFits && barW >= labelW + insidePadding + 6) {
      // Inside label: white for contrast
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(label, insideX, y + rowH * 0.72);
      return;
    }

    // Fallback: clamp near the right edge
    const clampedX = Math.max(padding.l + 2, w - padding.r - labelW);
    ctx.fillStyle = "#6f6f6f";
    ctx.fillText(label, clampedX, y + rowH * 0.72);
  });

  if (subtitleEl && !subtitleEl.textContent) subtitleEl.textContent = " ";
}

  function drawResponderBars(filteredLogs) {
    const counts = new Map();
    for (const l of filteredLogs) {
      const name = canonicalResponder(l.responderName || "");
      counts.set(name, (counts.get(name) || 0) + 1);
    }

    const items = [...counts.entries()]
      .map(([name, count]) => ({ name, value: count, label: String(count) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    drawBarChart(responderCanvas, responderSubtitle, items, 160);
    if (responderSubtitle) responderSubtitle.textContent = `Top responders (filtered). Unique: ${counts.size}`;
  }

  function drawDrivers(filteredLogs) {
    if (!isMaint) {
      // Top cells by count
      const counts = new Map();
      for (const l of filteredLogs) {
        const cell = (l.cellName || l.cellId || "").trim() || "Unknown";
        counts.set(cell, (counts.get(cell) || 0) + 1);
      }

      const items = [...counts.entries()]
        .map(([name, count]) => ({ name, value: count, label: String(count) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);

      drawBarChart(cellCanvas, cellSubtitle, items, 170);
      if (cellSubtitle) cellSubtitle.textContent = `Top drivers (filtered). Unique: ${counts.size}`;
      return;
    }

    // Maintenance: Top machines by TOTAL time open (hours)
    const totals = new Map();
    for (const l of filteredLogs) {
      const asset = assetKeyFromLog(l);
      const ms = typeof l.elapsedMs === "number" ? l.elapsedMs : 0;
      totals.set(asset, (totals.get(asset) || 0) + ms);
    }

    const items = [...totals.entries()]
      .map(([name, ms]) => ({ name, value: ms, label: `${hours(ms).toFixed(1)}h` }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    drawBarChart(cellCanvas, cellSubtitle, items, 200);
    if (cellSubtitle) cellSubtitle.textContent = `Top machines by total time open (filtered). Unique: ${totals.size}`;
  }

  function renderMetrics() {
    const filtered = filterLogsBase(allLogs);

    renderKPIs(filtered);
    drawTrend(filtered);
    drawResponderBars(filtered);
    drawDrivers(filtered);

    if (histSubtitle) {
      const range = getSelectedRangeMs();
      const asset = selectedAssetKey();
      const rangeTxt = range
        ? `${new Date(range.startMs).toLocaleDateString()} → ${new Date(range.endMs).toLocaleDateString()}`
        : "All dates";
      const assetTxt = (isMaint && asset) ? ` | Machine: ${asset}` : "";
      histSubtitle.textContent = `Completed calls (${rangeTxt})${assetTxt} — filter applies to charts & table`;
    }
  }

  // -----------------------
  // Export 8+ hr report for selected range (maintenance)
  // -----------------------
  function export8hrRangeCsv() {
    if (!isMaint) return;

    const filtered = filterLogsBase(allLogs);
    const longOpen = filtered.filter(l => typeof l.elapsedMs === "number" && l.elapsedMs >= DOWN_8H_MS);
    longOpen.sort((a, b) => a.ts - b.ts);

    const header = ["CompletedAt","Cell","Machine","FiixWorkOrder","TimeOpenHours","Cause(Result)","Issue","Solution","Responder"];
    const lines = [header.join(",")];

    for (const l of longOpen) {
      const completedAt = new Date(l.ts).toISOString();
      const cell = (l.cellName || l.cellId || "").replace(/"/g, '""');
      const asset = assetKeyFromLog(l).replace(/"/g, '""');
      const fiixWo = (l.fiix?.workOrderNumber || "").replace(/"/g, '""');
      const openH = hours(l.elapsedMs || 0).toFixed(2);
      const cause = (l.result || "").replace(/"/g, '""');
      const issue = (l.fiix?.requestDescription || "").replace(/"/g, '""');
      const solution = (l.note || "").replace(/"/g, '""');
      const responder = (l.responderName || "").replace(/"/g, '""');

      lines.push(
        [`"${completedAt}"`, `"${cell}"`, `"${asset}"`, `"${fiixWo}"`, openH, `"${cause}"`, `"${issue}"`, `"${solution}"`, `"${responder}"`].join(",")
      );
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);

    const range = getSelectedRangeMs();
    const stamp = range ? `${startDateEl?.value || "start"}_to_${endDateEl?.value || "end"}` : "range";
    a.download = `maintenance_8hr_report_${stamp}.csv`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // -----------------------
  // Fetch logs
  // -----------------------
  async function fetchLogs() {
    const n = Number(rangeEl?.value) || 500;

    const r = await fetch(`/api/history?dept=${encodeURIComponent(dept)}&n=${n}`, { cache: "no-store" });
    const data = await r.json();
    allLogs = Array.isArray(data?.logs) ? data.logs : [];

    if (exportCsv) exportCsv.href = `/api/export.csv?dept=${encodeURIComponent(dept)}&n=5000`;

    setColumnsForDept();
    renderTable();
    scheduleMetrics();
  }

  // -----------------------
  // Delete history modal
  // -----------------------
  deleteBtn?.addEventListener("click", () => deleteModal?.classList.add("show"));
  cancelDelete?.addEventListener("click", () => deleteModal?.classList.remove("show"));
  confirmDelete?.addEventListener("click", async () => {
    await fetch(`/api/history?dept=${encodeURIComponent(dept)}`, { method: "DELETE" });
    deleteModal?.classList.remove("show");
    await fetchLogs();
  });

  // -----------------------
  // UI events
  // -----------------------
  searchEl?.addEventListener("input", () => {
    renderTable();
    scheduleMetrics();
  });

  refreshBtn?.addEventListener("click", fetchLogs);
  rangeEl?.addEventListener("change", fetchLogs);

  presetRangeEl?.addEventListener("change", () => {
    const p = presetRangeEl.value;
    if (!p) return;
    applyPreset(p);
    presetRangeEl.value = "";
    renderTable();
    scheduleMetrics();
  });

  startDateEl?.addEventListener("change", () => { renderTable(); scheduleMetrics(); });
  endDateEl?.addEventListener("change", () => { renderTable(); scheduleMetrics(); });

  assetSelect?.addEventListener("change", () => {
    localStorage.setItem("maint_asset_filter", assetSelect.value || "");
    renderTable();
    scheduleMetrics();
  });

  export8hrBtn?.addEventListener("click", export8hrRangeCsv);

  // -----------------------
  // Init
  // -----------------------
  (async function init() {
    setColumnsForDept();

    // default date range if empty
    const def = defaultRange();
    if (startDateEl && !startDateEl.value) startDateEl.value = def.start;
    if (endDateEl && !endDateEl.value) endDateEl.value = def.end;

    try {
      await fetchResponders();
      if (isMaint) await loadAllAssetsForDropdown();
      await fetchLogs();
    } catch (e) {
      console.error("History init failed:", e);
      if (histSubtitle) histSubtitle.textContent = "History failed to load — check console.";
    }
  })();
})();