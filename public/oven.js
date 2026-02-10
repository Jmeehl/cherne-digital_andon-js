// public/oven.js
// Oven Shift Performance (Option A: one chart at a time)
//
// Views:
// - Time Series: single-pen (default All sizes, selectable Size 1..4); downtime shading based on total.
// - Shift Totals: grouped bars by size within each shift (1st/2nd/3rd) + Grand Total.
// - Shift Instances: grouped bars by size within each shift instance (Day + Shift) + Grand Total.
//
// Quick ranges:
// - Today  : production day (yesterday 21:00 -> today 21:00)
// - Yesterday: production day (two days ago 21:00 -> yesterday 21:00)
// - Last Week: 7 production days ending today 21:00
//
// This file matches your existing HTML IDs and control layout.
// (Based on your latest oven.js structure.)
// ---------------------------------------------------------------------------

/* ---------- DOM ---------- */
const startEl = document.getElementById("start");
const endEl = document.getElementById("end");
const applyBtn = document.getElementById("applyBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const todayBtn = document.getElementById("todayBtn");
const shiftBtn = document.getElementById("shiftBtn");
const last8Btn = document.getElementById("last8Btn");
const yesterdayBtn = document.getElementById("yesterdayBtn");
const lastWeekBtn = document.getElementById("lastWeekBtn");
const liveEl = document.getElementById("live");

const chartViewEl = document.getElementById("chartView");
const shiftSizeFilterEl = document.getElementById("shiftSizeFilter"); // bar-mode filter now disabled
const tsSizeFilterEl = document.getElementById("tsSizeFilter");        // NEW: time-series size selector

const timeseriesSection = document.getElementById("timeseriesSection");
const shiftBarsSection = document.getElementById("shiftBarsSection");

const canvas = document.getElementById("chart");
const shiftBarCanvas = document.getElementById("shiftBarChart");

const legendEl = document.getElementById("legend");
const shiftLegendEl = document.getElementById("shiftLegend");
const errorEl = document.getElementById("error");

const shiftCardsEl = document.getElementById("shiftCards");
const kpiCardsEl = document.getElementById("kpiCards");

/* ---------- State ---------- */
let liveTimer = null;
let lastOvenData = null;

/* ---------- Constants ---------- */
const COLORS = ["#0066cc", "#cc3300", "#2e7d32", "#6a1b9a", "#ff8f00", "#00838f"];
const EMPTY_MOLD_SECONDS = 15;
const SHADE_AFTER_EMPTY_BUCKETS = 1; // 1 empty 5-min bucket => shade

/* ---------- Utils ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function isDark() { return document.documentElement.classList.contains("theme-dark"); }

function toLocalInputValue(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
function fromLocalInputValue(s) { return new Date(s); }

function showError(msg) {
  errorEl.style.display = msg ? "block" : "none";
  errorEl.textContent = msg || "";
}

/* ---------- Shift logic (local) ----------
   Shift 1: 05:00–13:00
   Shift 2: 13:00–21:00 
   Shift 3: 21:00–05:00 (cross-midnight). Adjust if you keep 05:30/21:30.
------------------------------------------ */
function minutesSinceMidnight(d) { return d.getHours() * 60 + d.getMinutes(); }
function whichShift(localDate) {
  const mins = minutesSinceMidnight(localDate);

  // Shift 3: 21:00 → 24:00 OR 00:00 → 05:30
  // If you decided on 05:00 exact, change s3End to 5*60.
  const s3Start = 21 * 60;
  const s3End = 5 * 60;
  if (mins >= s3Start || mins < s3End) return 3;

  // Shift 2: 13:00 → 21:00 (or 21:30 if you confirm)
  const s2Start = 13 * 60;
  const s2End = 21 * 60; // or 21*60 + 30;
  if (mins >= s2Start && mins < s2End) return 2;

  // Shift 1: 05:00 → 13:00
  const s1Start = 5 * 60;
  const s1End = 13 * 60;
  if (mins >= s1Start && mins < s1End) return 1;

  return 1;
}

function currentShiftRange(now = new Date()) {
  const s = whichShift(now);
  const base = new Date(now);
  function setTime(d, hh, mm) {
    const x = new Date(d); x.setHours(hh, mm, 0, 0); return x;
  }
  if (s === 1) return { shift: 1, start: setTime(base, 5, 0),  end: setTime(base, 13, 0) };
  if (s === 2) return { shift: 2, start: setTime(base, 13, 0), end: setTime(base, 21, 0) };
  // Shift 3 crosses midnight
  const mins = minutesSinceMidnight(base);
  if (mins >= 21 * 60) {
    const start = setTime(base, 21, 0);
    const end = new Date(setTime(base, 5, 0).getTime() + 24 * 60 * 60 * 1000); // if end=05:30
    return { shift: 3, start, end };
  } else {
    const end = setTime(base, 5, 0);
    const start = new Date(setTime(base, 21, 0).getTime() - 24 * 60 * 60 * 1000);
    return { shift: 3, start, end };
  }
}

// For shift-instance grouping: start time of the shift occurrence for a given local bucket time
function shiftInstanceStart(localDate) {
  const d = new Date(localDate);
  const sh = whichShift(d);
  const start = new Date(d);
  start.setSeconds(0, 0);

  if (sh === 1) { start.setHours(5, 0, 0, 0);  return start; }
  if (sh === 2) { start.setHours(13, 0, 0, 0); return start; }

  // shift 3
  const mins = minutesSinceMidnight(d);
  if (mins >= 21 * 60) {
    start.setHours(21, 0, 0, 0);
    return start;
  } else {
    start.setDate(start.getDate() - 1);
    start.setHours(21, 0, 0, 0);
    return start;
  }
}

/* ---------- Production day range (21:00 → next-day 21:00) ---------- */
function prodDayRangeFor(day /* Date local */) {
  const end = new Date(day);   end.setHours(21, 0, 0, 0);            // 21:00 local
  const start = new Date(end); start.setDate(start.getDate() - 1);   // previous day 21:00
  return { start, end };
}
function todayProdDayRange() {
  const today = new Date(); return prodDayRangeFor(today);
}
function yesterdayProdDayRange() {
  const y = new Date(); y.setDate(y.getDate() - 1); return prodDayRangeFor(y);
}
function lastWeekProdDayRange() {
  const { end } = todayProdDayRange();
  const start = new Date(end); start.setDate(start.getDate() - 7);
  return { start, end };
}

/* ---------- Fetch (LOCAL params) ----------
   The server's parseRange(req) prefers startLocal/endLocal (YYYY-MM-DDTHH:mm).
   (Your server.js already implements that path.)
------------------------------------------------ */
async function fetchData() {
  const startLocal = startEl.value;
  const endLocal = endEl.value;

  if (!startLocal || !endLocal) {
    throw new Error("Start and End must be selected");
  }

  const url = `/api/oven/plug-performance?startLocal=${encodeURIComponent(startLocal)}&endLocal=${encodeURIComponent(endLocal)}`;
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || "Failed to load data");
  return data;
}

/* ---------- Normalize API shape ---------- */
function unpackSeries(data) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : (Array.isArray(data.hours) ? data.hours : []);
  const sizes = Array.isArray(data.sizes) ? data.sizes : [];
  const series = data.series || {};
  return { buckets, sizes, series };
}

/* ---------- System Status (from series totals) ---------- */
function computeSystemStatusFromSeries() {
  if (!lastOvenData) return { status: "—", sinceMin: null };

  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  if (!buckets.length) return { status: "—", sinceMin: null };

  let lastNonZeroIdx = -1;
  for (let i = 0; i < buckets.length; i++) {
    let total = 0;
    for (const s of sizes) total += (series[s]?.[i] || 0);
    if (total > 0) lastNonZeroIdx = i;
  }
  if (lastNonZeroIdx === -1) return { status: "Idle/Off", sinceMin: null };

  const lastTs = new Date(buckets[lastNonZeroIdx]).getTime();
  const sinceMin = Math.max(0, Math.round((Date.now() - lastTs) / 60000));
  const status = sinceMin <= 10 ? "Running" : "Idle/Off";
  return { status, sinceMin };
}

/* ---------- KPIs ---------- */
function fmtDuration(seconds) {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "0m";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return `${h}h ${r}m`;
}

function renderKpis(kpis) {
  if (!kpiCardsEl) return;

  const filled = Number(kpis?.filledTotal);
  const empty = Number(kpis?.emptyTotal);
  const total = Number(kpis?.totalCycles);

  const eff = (kpis?.efficiencyPct === null || kpis?.efficiencyPct === undefined)
    ? "—" : `${kpis.efficiencyPct}%`;

  const lost = fmtDuration(kpis?.lostSeconds);

  const filledDisp = Number.isFinite(filled) ? filled : "—";
  const emptyDisp  = Number.isFinite(empty)  ? empty  : "—";
  const totalDisp  = Number.isFinite(total)  ? total  : "—";

  const emptyRate = (Number.isFinite(empty) && Number.isFinite(total) && total > 0)
    ? `${Math.round((empty / total) * 1000) / 10}%` : "—";

  const sys = computeSystemStatusFromSeries();
  const sysText = (sys.sinceMin === null) ? sys.status : `${sys.status} (last ${sys.sinceMin}m)`;

  kpiCardsEl.innerHTML = `
    <div class="card">
      <h3>System Status</h3>
      <div class="muted">${sysText}</div>
      <div class="muted" style="margin-top:6px;">Based on recent completions</div>
    </div>

    <div class="card">
      <h3>Fill Efficiency</h3>
      <div class="muted">${eff}</div>
      <div class="muted" style="margin-top:6px;">Filled / Total</div>
      <div class="muted">${filledDisp} / ${totalDisp}</div>
    </div>

    <div class="card">
      <h3>Time Loss (Empty)</h3>
      <div class="muted">${lost}</div>
      <div class="muted" style="margin-top:6px;">Empty molds × ${EMPTY_MOLD_SECONDS}s</div>
      <div class="muted">${emptyDisp} × ${EMPTY_MOLD_SECONDS}s</div>
    </div>

    <div class="card">
      <h3>Empty Rate</h3>
      <div class="muted">${emptyRate}</div>
      <div class="muted" style="margin-top:6px;">Empty / Total</div>
      <div class="muted">${emptyDisp} / ${totalDisp}</div>
    </div>

    <div class="card">
      <h3>Total Cycles</h3>
      <div class="muted">${totalDisp}</div>
      <div class="muted" style="margin-top:6px;">(Filled + Empty)</div>
    </div>
  `;
}

/* ---------- Shift cards (for quick glance; time-series only) ---------- */
function renderShiftCards(buckets, sizes, series) {
  const totals = { 1: {}, 2: {}, 3: {} };
  for (const sh of [1, 2, 3]) for (const s of sizes) totals[sh][s] = 0;

  buckets.forEach((iso, idx) => {
    const d = new Date(iso);
    const sh = whichShift(d);
    for (const s of sizes) totals[sh][s] += (series[s]?.[idx] || 0);
  });

  shiftCardsEl.innerHTML = "";
  [1, 2, 3].forEach((sh) => {
    const card = document.createElement("div");
    card.className = "card";
    const h3 = document.createElement("h3");
    h3.textContent = `${sh} ${sh === 1 ? "st" : sh === 2 ? "nd" : "rd"} Shift Total`;
    const p = document.createElement("div");
    p.className = "muted";
    const lines = sizes.map((s) => `Size ${s}: ${totals[sh][s]}`);
    p.textContent = lines.join("  |  ");
    card.appendChild(h3);
    card.appendChild(p);
    shiftCardsEl.appendChild(card);
  });
}

/* ---------- Single-pen Time Series helpers ---------- */
function ensureTsSizeOptions(sizes) {
  if (!tsSizeFilterEl) return;
  const current = tsSizeFilterEl.value || "ALL";
  tsSizeFilterEl.innerHTML = `<option value="ALL">All sizes</option>` +
    sizes.map(s => `<option value="${String(s)}">Size ${s}</option>`).join("");
  if ([...tsSizeFilterEl.options].some(o => o.value === current)) {
    tsSizeFilterEl.value = current;
  }
}

function getTsLine(buckets, sizes, series, sel) {
  if (sel === "ALL") {
    const line = buckets.map((_, i) =>
      sizes.reduce((t, s) => t + (series[s]?.[i] || 0), 0)
    );
    return { line, label: "All sizes" };
  }
  const data = series[sel] || [];
  const line = buckets.map((_, i) => Number(data[i] || 0));
  return { line, label: `Size ${sel}` };
}

function buildTimeSeriesLegendSingle(label) {
  legendEl.innerHTML = "";
  const item = document.createElement("div");
  item.className = "item";
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = COLORS[0];
  item.appendChild(sw);
  item.appendChild(document.createTextNode(label));
  legendEl.appendChild(item);

  const dt = document.createElement("div");
  dt.className = "item";
  const sw2 = document.createElement("span");
  sw2.className = "swatch";
  sw2.style.background = isDark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";
  dt.appendChild(sw2);
  dt.appendChild(document.createTextNode("Shaded = no completions (stopped/idle)"));
  legendEl.appendChild(dt);
}

function computeStoppedMask(sizes, series, N) {
  const mask = new Array(N).fill(false);
  for (let i = 0; i < N; i++) {
    let total = 0;
    for (const s of sizes) total += (series[s]?.[i] || 0);
    mask[i] = (total === 0);
  }
  return mask;
}

function shadeStopped(ctx, mask, padL, padT, plotW, plotH, N) {
  if (N < 2) return;
  const stepPx = plotW / (N - 1);
  const xFor = (i) => padL + plotW * (i / (N - 1));
  ctx.save();
  ctx.fillStyle = isDark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";
  let i = 0;
  while (i < N) {
    if (!mask[i]) { i++; continue; }
    let j = i; while (j + 1 < N && mask[j + 1]) j++;
    const runLen = (j - i + 1);
    if (runLen >= SHADE_AFTER_EMPTY_BUCKETS) {
      const x0 = Math.max(padL, xFor(i) - stepPx / 2);
      const x1 = Math.min(padL + plotW, xFor(j) + stepPx / 2);
      ctx.fillRect(x0, padT, x1 - x0, plotH);
    }
    i = j + 1;
  }
  ctx.restore();
}

function drawTimeSeriesSingle(buckets, sizes, series, sel) {
  const { line, label } = getTsLine(buckets, sizes, series, sel);

  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const padL = 60, padR = 20, padT = 18, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const N = buckets.length;

  let maxY = 0;
  for (const v of line) maxY = Math.max(maxY, v);
  maxY = Math.max(5, Math.ceil(maxY * 1.15));

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const stoppedMask = computeStoppedMask(sizes, series, N);
  shadeStopped(ctx, stoppedMask, padL, padT, plotW, plotH, N);

  // Grid
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.10)" : "#e6e6e6";
  ctx.lineWidth = 1;
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH * i / gridLines);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  // Y labels
  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY * (1 - i / gridLines));
    const y = padT + (plotH * i / gridLines);
    ctx.fillText(String(val), padL - 8, y);
  }

  // X labels (HH:mm)
  const step = Math.max(1, Math.floor(N / 12));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < N; i += step) {
    const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
    const d = new Date(buckets[i]);
    const labelX = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    ctx.fillText(labelX, x, padT + plotH + 10);
  }

  // Axes
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // Single line
  ctx.strokeStyle = COLORS[0];
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
    const y = padT + plotH - (plotH * (line[i] / maxY));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  buildTimeSeriesLegendSingle(label);
}

/* ---------- Grouped bars (Shift Totals / Shift Instances) ---------- */
function buildBarLegendSizes(sizeOrder) {
  if (!shiftLegendEl) return;

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.style.marginTop = "8px";
  legend.style.display = "flex";
  legend.style.flexWrap = "wrap";
  legend.style.gap = "14px";

  sizeOrder.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "item";
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "8px";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.width = "14px";
    sw.style.height = "14px";
    sw.style.borderRadius = "3px";
    sw.style.background = COLORS[i % COLORS.length];
    item.appendChild(sw);
    item.appendChild(document.createTextNode(`Size ${s}`));
    legend.appendChild(item);
  });

  shiftLegendEl.innerHTML = "";
  shiftLegendEl.appendChild(legend);
}

function computeTotalsByShiftTypeGrouped(buckets, sizes, series) {
  const sizeOrder = [...sizes].sort((a, b) => Number(a) - Number(b));
  const bySize = new Map(sizeOrder.map(s => [s, [0, 0, 0]])); // [shift1, shift2, shift3]

  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]);
    const sh = whichShift(d);
    const idx = sh - 1;
    for (const s of sizeOrder) {
      const v = Number(series[s]?.[i] || 0);
      bySize.get(s)[idx] += v;
    }
  }

  const labels = ["1st Shift", "2nd Shift", "3rd Shift"];
  const seriesMap = Object.fromEntries(sizeOrder.map(s => [s, bySize.get(s)]));
  const totals = labels.map((_, col) =>
    sizeOrder.reduce((sum, s) => sum + (seriesMap[s][col] || 0), 0)
  );

  return { labels, sizeOrder, seriesMap, totals };
}

function computeTotalsByShiftInstanceGrouped(buckets, sizes, series) {
  const sizeOrder = [...sizes].sort((a, b) => Number(a) - Number(b));

  const keyMeta = new Map(); // key -> { start, sh }
  const keysSet = new Set();

  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]);
    const sh = whichShift(d);
    const start = shiftInstanceStart(d);
    const key = `${start.toISOString()}|${sh}`;
    if (!keysSet.has(key)) {
      keysSet.add(key);
      keyMeta.set(key, { start, sh });
    }
  }

  const keys = Array.from(keysSet).sort((a, b) =>
    (keyMeta.get(a)?.start?.getTime() ?? 0) - (keyMeta.get(b)?.start?.getTime() ?? 0)
  );

  const seriesMap = Object.fromEntries(sizeOrder.map(s => [s, new Array(keys.length).fill(0)]));
  const keyIndex = new Map(keys.map((k, i) => [k, i]));

  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]);
    const sh = whichShift(d);
    const start = shiftInstanceStart(d);
    const key = `${start.toISOString()}|${sh}`;
    const k = keyIndex.get(key);
    if (k === undefined) continue;

    for (const s of sizeOrder) {
      const v = Number(series[s]?.[i] || 0);
      seriesMap[s][k] += v;
    }
  }

  const labels = keys.map(k => {
    const { start, sh } = keyMeta.get(k);
    const day = `${start.getMonth()+1}/${start.getDate()}`;
    const shName = sh === 1 ? "1st" : sh === 2 ? "2nd" : "3rd";
    return `${day} ${shName}`;
  });

  const totals = labels.map((_, col) =>
    sizeOrder.reduce((sum, s) => sum + (seriesMap[s][col] || 0), 0)
  );

  return { labels, sizeOrder, seriesMap, totals };
}

/* Render a simple Grand Total box under the grouped bar legend */
function renderGrandTotalBox(grandTotal) {
  if (!shiftLegendEl) return;
  // Create/replace a small total box
  let box = document.getElementById("barGrandTotal");
  if (!box) {
    box = document.createElement("div");
    box.id = "barGrandTotal";
    box.style.marginTop = "8px";
    box.style.fontWeight = "900";
    box.style.padding = "8px 10px";
    box.style.border = "1px solid #ddd";
    box.style.borderRadius = "8px";
    box.style.display = "inline-block";
    box.style.background = isDark() ? "#12171d" : "#ffffff";
    shiftLegendEl.appendChild(box);
  }
  box.textContent = `Grand Total: ${grandTotal}`;
}

function drawGroupedBars(labels, seriesMap, sizeOrder, hintText) {
  if (!shiftBarCanvas) return;
  const ctx = shiftBarCanvas.getContext("2d");
  const W = shiftBarCanvas.width, H = shiftBarCanvas.height;

  // More bottom padding to fit x-label + group-total box
  const padL = 60, padR = 20, padT = 18, padB = 96;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const N = labels.length;         // Number of shift groups
  const S = sizeOrder.length;      // Number of bars per group (sizes)

  // ---- Compute per-group totals + grand total (used for boxes & sidebar)
  const totals = labels.map((_, i) =>
    sizeOrder.reduce((sum, s) => sum + (seriesMap[s]?.[i] || 0), 0)
  );
  const grandTotal = totals.reduce((a, b) => a + b, 0);

  // ----------------------------------------------------------
  // Y‑axis scaling — based ONLY on the highest single bar
  // ----------------------------------------------------------
  const highestSingleBar = Math.max(
    5, // minimum height so small datasets still look okay
    ...sizeOrder.map(s => Math.max(...(seriesMap[s] || [0])))
  );

  const HEADROOM = 1.05;   // 5% headroom (looks good)
  const MIN_Y    = 100;    // minimum axis height (tune or set to 0 to disable)
  const maxY = Math.max(MIN_Y, Math.ceil(highestSingleBar * HEADROOM));

  // ---- Background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ---- Grid lines
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.10)" : "#e6e6e6";
  ctx.lineWidth = 1;
  const gridLines = 5;

  for (let i = 0; i <= gridLines; i++) {
    const y = Math.round(padT + (plotH * i / gridLines));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  // ---- Y-axis labels
  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY * (1 - i / gridLines));
    const y = Math.round(padT + (plotH * i / gridLines));
    ctx.fillText(String(val), padL - 8, y);
  }

  // ---- Axis lines
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  if (N === 0) {
    shiftLegendEl.textContent = "No data in selected range.";
    return;
  }

  // ----------------------------------------------------------
  // Group + bar geometry
  // ----------------------------------------------------------
  const groupGap = Math.max(16, Math.min(40, Math.floor(plotW / Math.max(6, N * 6))));
  const groupW   = (plotW - groupGap * (N + 1)) / N;

  const barGap   = Math.max(6, Math.min(14, Math.floor(groupW / Math.max(6, S * 6))));
  let barW       = (groupW - barGap * (S - 1)) / S;

  if (barW < 3) {
    const spare = Math.min(barGap - 2, 6);
    const newGap = Math.max(2, barGap - spare);
    barW = (groupW - newGap * (S - 1)) / S;
  }
  barW = Math.max(4, Math.floor(barW));

  const textColor = isDark() ? "#e6e8ea" : "#333";

  // ----------------------------------------------------------
  // Render bars + labels + group totals
  // ----------------------------------------------------------
  for (let i = 0; i < N; i++) {
    const xGroup = Math.round(padL + groupGap + i * (groupW + groupGap));

    // ---- Bars per size inside group
    sizeOrder.forEach((s, si) => {
      const v = Number(seriesMap[s]?.[i] || 0);
      const h = Math.round(plotH * (v / maxY));
      const y0 = Math.round(padT + plotH - h);
      const x0 = Math.round(xGroup + si * (barW + barGap));

      // Draw bar
      const barColor = COLORS[si % COLORS.length];
      ctx.fillStyle = barColor;

      const safeBarW = Math.max(1, Math.min(barW, padL + plotW - x0));
      ctx.fillRect(x0, y0, safeBarW, h);

      // ---- Value label ON the bar
      const label = String(v);
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";

      if (h >= 18) {
        // Inside bar
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(label, Math.round(x0 + safeBarW / 2), Math.round(y0 + h / 2));
      } else {
        // Just above bar
        ctx.fillStyle = textColor;
        ctx.textBaseline = "bottom";
        ctx.fillText(label, Math.round(x0 + safeBarW / 2), Math.round(y0 - 2));
      }
    });

    // ---- X-axis label
    const xLabel = Math.round(xGroup + groupW / 2);
    const yLabel = Math.round(padT + plotH + 12);

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "12px sans-serif";
    ctx.fillText(labels[i], xLabel, yLabel);

    // ---- Per-group total BOX (under the label)
    const tot = totals[i];
    const boxText = String(tot);
    const paddingX = 8, paddingY = 4;
    const textW = ctx.measureText(boxText).width;

    const boxW = Math.ceil(textW + paddingX * 2);
    const boxH = 22;
    const boxX = Math.round(xLabel - boxW / 2);
    const boxY = Math.round(yLabel + 14);

    // Box background
    ctx.fillStyle = isDark() ? "#12171d" : "#ffffff";
    ctx.strokeStyle = isDark() ? "#2a3139" : "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    // Box text
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(boxText, Math.round(boxX + boxW / 2), Math.round(boxY + boxH / 2));
  }

  // ----------------------------------------------------------
  // Legend + right-side ALL SHIFTS panel
  // ----------------------------------------------------------
  shiftLegendEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.justifyContent = "space-between";
  wrap.style.alignItems = "flex-start";
  wrap.style.gap = "16px";
  wrap.style.flexWrap = "wrap";

  // ---------- LEFT: hint + size legend ----------
  const left = document.createElement("div");
  left.style.display = "flex";
  left.style.flexDirection = "column";
  left.style.gap = "8px";

  const hint = document.createElement("div");
  hint.textContent = hintText || "";
  hint.style.fontWeight = "700";
  left.appendChild(hint);

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.style.display = "flex";
  legend.style.flexWrap = "wrap";
  legend.style.gap = "14px";

  sizeOrder.forEach((s, i) => {
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.gap = "8px";

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.width = "14px";
    sw.style.height = "14px";
    sw.style.borderRadius = "3px";
    sw.style.background = COLORS[i % COLORS.length];

    item.appendChild(sw);
    item.appendChild(document.createTextNode(`Size ${s}`));
    legend.appendChild(item);
  });

  left.appendChild(legend);

  // ---------- RIGHT: ALL SHIFTS panel ----------
  const right = document.createElement("div");
  right.style.minWidth = "220px";
  right.style.border = "1px solid " + (isDark() ? "#2a3139" : "#ddd");
  right.style.borderRadius = "10px";
  right.style.padding = "10px 12px";
  right.style.background = isDark() ? "#12171d" : "#ffffff";
  right.style.fontWeight = "900";

  const title = document.createElement("div");
  title.textContent = "ALL Shifts";
  title.style.marginBottom = "6px";

  const ul = document.createElement("div");
  ul.style.display = "grid";
  ul.style.gridTemplateColumns = "1fr auto";
  ul.style.gap = "4px 10px";

  // per-size sums across all groups
  sizeOrder.forEach((s, i) => {
    const sum = (seriesMap[s] || []).reduce((a, b) => a + (b || 0), 0);
    const name = document.createElement("div");
    name.textContent = `Size ${s}:`;

    const val = document.createElement("div");
    val.textContent = String(sum);
    val.style.textAlign = "right";
    val.style.color = COLORS[i % COLORS.length];

    ul.appendChild(name);
    ul.appendChild(val);
  });

  const hr = document.createElement("div");
  hr.style.height = "1px";
  hr.style.background = isDark() ? "#2a3139" : "#ddd";
  hr.style.margin = "8px 0";

  const totalRow = document.createElement("div");
  totalRow.style.display = "grid";
  totalRow.style.gridTemplateColumns = "1fr auto";
  totalRow.style.gap = "4px 10px";

  const totalLabel = document.createElement("div");
  totalLabel.textContent = "Total Balls";

  const totalVal = document.createElement("div");
  totalVal.textContent = String(grandTotal);
  totalVal.style.textAlign = "right";

  right.appendChild(title);
  right.appendChild(ul);
  right.appendChild(hr);
  right.appendChild(totalLabel);
  right.appendChild(totalVal);

  // Combine left + right into final legend pane
  wrap.appendChild(left);
  wrap.appendChild(right);
  shiftLegendEl.appendChild(wrap);
}


/* ---------- CSV ---------- */
function csvEscape(v) {
  const s = String(v ?? "");
  return (/[",\n]/.test(s)) ? `"${s.replaceAll('"', '""')}"` : s;
}
function downloadTextAsFile(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function fmtIsoLocalLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildOvenCsv() {
  if (!lastOvenData) return "Note,No data loaded yet. Try Apply/Refresh while on network.\n";

  const mode = chartViewEl?.value || "timeseries";
  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  const k = lastOvenData.kpis || null;

  const lines = [];
  lines.push(["GeneratedAt", new Date().toISOString()].map(csvEscape).join(","));
  lines.push(["RangeStart", lastOvenData.start ?? ""].map(csvEscape).join(","));
  lines.push(["RangeEnd",   lastOvenData.end   ?? ""].map(csvEscape).join(","));
  lines.push(["ChartView", mode].map(csvEscape).join(","));
  lines.push("");

  lines.push("KPIs");
  lines.push(["FilledTotal", k?.filledTotal ?? ""].map(csvEscape).join(","));
  lines.push(["EmptyTotal",  k?.emptyTotal  ?? ""].map(csvEscape).join(","));
  lines.push(["TotalCycles", k?.totalCycles ?? ""].map(csvEscape).join(","));
  lines.push(["EfficiencyPct", k?.efficiencyPct ?? ""].map(csvEscape).join(","));
  lines.push(["LostSeconds", k?.lostSeconds ?? ""].map(csvEscape).join(","));
  lines.push("");

  if (mode === "timeseries") {
    lines.push("TimeSeries_Buckets");
    const header = ["BucketLocal", ...sizes.map((s) => `Size_${s}`), "Total"];
    lines.push(header.map(csvEscape).join(","));

    for (let i = 0; i < buckets.length; i++) {
      let total = 0;
      const row = [fmtIsoLocalLabel(buckets[i])];
      for (const s of sizes) {
        const v = Number(series[s]?.[i] || 0);
        total += v; row.push(v);
      }
      row.push(total);
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");
  } else if (mode === "shiftType") {
    const g = computeTotalsByShiftTypeGrouped(buckets, sizes, series);
    lines.push("ShiftTotals_ByType_Grouped");
    lines.push(["Shift", ...g.sizeOrder.map(s => `Size_${s}`), "Total"].map(csvEscape).join(","));
    for (let i = 0; i < g.labels.length; i++) {
      const row = [g.labels[i], ...g.sizeOrder.map(s => g.seriesMap[s][i]),
        g.sizeOrder.reduce((t,s)=> t + (g.seriesMap[s][i] || 0), 0)];
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");
  } else {
    const g = computeTotalsByShiftInstanceGrouped(buckets, sizes, series);
    lines.push("ShiftTotals_ByInstance_Grouped");
    lines.push(["ShiftInstance", ...g.sizeOrder.map(s => `Size_${s}`), "Total"].map(csvEscape).join(","));
    for (let i = 0; i < g.labels.length; i++) {
      const row = [g.labels[i], ...g.sizeOrder.map(s => g.seriesMap[s][i]),
        g.sizeOrder.reduce((t,s)=> t + (g.seriesMap[s][i] || 0), 0)];
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/* ---------- View controller ---------- */
function setChartMode(mode) {
  const isTime = mode === "timeseries";
  timeseriesSection.style.display = isTime ? "block" : "none";
  shiftBarsSection.style.display  = isTime ? "none"  : "block";
  shiftCardsEl.style.display      = isTime ? "flex"  : "none";

  // Bar modes always include all sizes now, so bar-size filter is disabled.
  if (shiftSizeFilterEl) shiftSizeFilterEl.disabled = true;

  // Show TS size filter only for time series
  if (tsSizeFilterEl && tsSizeFilterEl.parentElement) {
    tsSizeFilterEl.parentElement.style.display = isTime ? "block" : "none";
  }
}

function renderCurrentView() {
  if (!lastOvenData) return;

  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  const mode = chartViewEl?.value || "timeseries";

  if (mode === "timeseries") {
    ensureTsSizeOptions(sizes);
    const sel = tsSizeFilterEl?.value || "ALL";
    drawTimeSeriesSingle(buckets, sizes, series, sel);
    renderShiftCards(buckets, sizes, series);
  } else if (mode === "shiftType") {
    const g = computeTotalsByShiftTypeGrouped(buckets, sizes, series);
    const hint = "Shift totals by size";
    drawGroupedBars(g.labels, g.seriesMap, g.sizeOrder, hint);
  } else {
    const g = computeTotalsByShiftInstanceGrouped(buckets, sizes, series);
    const hint = "Shift instances by size";
    drawGroupedBars(g.labels, g.seriesMap, g.sizeOrder, hint);
  }
}

/* ---------- Refresh ---------- */
async function refresh() {
  try {
    showError("");
    const data = await fetchData();
    lastOvenData = data;
    renderKpis(data.kpis);
    renderCurrentView();
  } catch (e) {
    showError(e.message);
    renderKpis(null);
    if (lastOvenData) renderCurrentView();
  }
}

function setRange(start, end) {
  startEl.value = toLocalInputValue(start);
  endEl.value = toLocalInputValue(end);
}

/* ---------- Controls ---------- */
applyBtn.addEventListener("click", refresh);

todayBtn.addEventListener("click", () => {
  const { start, end } = todayProdDayRange();
  setRange(start, end);
  refresh();
});

yesterdayBtn?.addEventListener("click", () => {
  const { start, end } = yesterdayProdDayRange();
  setRange(start, end);
  refresh();
});

lastWeekBtn?.addEventListener("click", () => {
  const { start, end } = lastWeekProdDayRange();
  setRange(start, end);
  refresh();
});

downloadCsvBtn?.addEventListener("click", () => {
  const mode = chartViewEl?.value || "timeseries";
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const filename = `oven_${mode}_ALL_${stamp}.csv`;
  const csv = buildOvenCsv();
  downloadTextAsFile(filename, csv);
});

shiftBtn.addEventListener("click", () => {
  const { start, end } = currentShiftRange(new Date());
  setRange(start, end);
  refresh();
});

liveEl.addEventListener("change", () => {
  if (liveEl.checked) {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(refresh, 60000);
  } else {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }
});

// View changes
chartViewEl.addEventListener("change", () => {
  setChartMode(chartViewEl.value);
  renderCurrentView();
});

// Time Series size selector
tsSizeFilterEl?.addEventListener("change", renderCurrentView);

/* ---------- Init ---------- */
(function init() {
  // Default to today's production day window (21:00 -> 21:00)
  const { start, end } = todayProdDayRange();
  setRange(start, end);
  setChartMode(chartViewEl?.value || "timeseries");
  refresh();
})();