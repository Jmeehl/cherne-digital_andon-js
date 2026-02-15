// public/oven.js
// Oven Shift Performance
//
// Chart Views:
// - timeseries      : Completions (5-min buckets), single-pen with size selector
// - cureTimeseries  : Avg Cure Time (5-min buckets), single-pen with size selector + goalposts
// - shiftType       : Shift Totals (1st/2nd/3rd), grouped bars
// - shiftInstance   : Shift Instances (Day + Shift), grouped bars
//
// Quick ranges:
// - Today      : production day (yesterday 21:00 -> today 21:00)
// - Yesterday  : production day (two days ago 21:00 -> yesterday 21:00)
// - Last Week  : previous calendar week (Sunday 00:00 -> Sunday 00:00)
// - Last Prod Hour (live): rolling [now-1h, now]

/* ---------- DOM ---------- */
const startEl = document.getElementById("start");
const endEl = document.getElementById("end");
const applyBtn = document.getElementById("applyBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");

const todayBtn = document.getElementById("todayBtn");
const shiftBtn = document.getElementById("shiftBtn");
const yesterdayBtn = document.getElementById("yesterdayBtn");
const lastWeekBtn = document.getElementById("lastWeekBtn");
const lastHourBtn = document.getElementById("lastHourBtn");
const liveEl = document.getElementById("live");

const chartViewEl = document.getElementById("chartView");
const tsSizeFilterEl = document.getElementById("tsSizeFilter");

const timeseriesSection = document.getElementById("timeseriesSection");
const shiftBarsSection = document.getElementById("shiftBarsSection");

const canvas = document.getElementById("chart");
const shiftBarCanvas = document.getElementById("shiftBarChart");

const legendEl = document.getElementById("legend");
const shiftLegendEl = document.getElementById("shiftLegend");
const errorEl = document.getElementById("error");

const shiftCardsEl = document.getElementById("shiftCards");
const kpiCardsEl = document.getElementById("kpiCards");

const cureSection = document.getElementById("cureSection");
const cureCanvas = document.getElementById("cureChart");

/* ---------- State ---------- */
let liveTimer = null;
let lastOvenData = null;
let hoverTsIndex = null;
let hoverRAF = null;
let pendingHoverIdx = null;

// Last hour live mode
let liveHourTimer = null;
let liveHourActive = false;

/* ---------- Constants ---------- */
const COLORS = ["#0066cc", "#cc3300", "#2e7d32", "#6a1b9a", "#ff8f00", "#00838f"];
const EMPTY_MOLD_SECONDS = 15;
const SHADE_AFTER_EMPTY_BUCKETS = 1;

// Cure time goalposts
const CURE_LOW_MIN = 45;
const CURE_HIGH_MIN = 120;

/* ---------- Utils ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function isDark() { return document.documentElement.classList.contains("theme-dark"); }
function isLight() { return !isDark(); }

function toLocalInputValue(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
function fromLocalInputValue(s) { return new Date(s); }

function showError(msg) {
  if (!errorEl) return;
  errorEl.style.display = msg ? "block" : "none";
  errorEl.textContent = msg || "";
}

function fmtDowntimeMinutes(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return "0m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtDuration(seconds) {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "0m";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return `${h}h ${r}m`;
}

function fmtMinutes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 10) / 10} min`;
}

/* ---------- Shift logic (local) ----------
   Shift 1: 05:00–13:00
   Shift 2: 13:00–21:00
   Shift 3: 21:00–05:00 (cross-midnight)
------------------------------------------ */
function minutesSinceMidnight(d) { return d.getHours() * 60 + d.getMinutes(); }
function whichShift(localDate) {
  const mins = minutesSinceMidnight(localDate);

  // Shift 3: 21:00 -> 24:00 OR 00:00 -> 05:00
  const s3Start = 21 * 60;
  const s3End = 5 * 60;
  if (mins >= s3Start || mins < s3End) return 3;

  // Shift 2: 13:00 -> 21:00
  const s2Start = 13 * 60;
  const s2End = 21 * 60;
  if (mins >= s2Start && mins < s2End) return 2;

  // Shift 1: 05:00 -> 13:00
  return 1;
}

function currentShiftRange(now = new Date()) {
  const s = whichShift(now);
  const base = new Date(now);

  function setTime(d, hh, mm) {
    const x = new Date(d); x.setHours(hh, mm, 0, 0); return x;
  }

  if (s === 1) return { shift: 1, start: setTime(base, 5, 0), end: setTime(base, 13, 0) };
  if (s === 2) return { shift: 2, start: setTime(base, 13, 0), end: setTime(base, 21, 0) };

  // Shift 3 crosses midnight
  const mins = minutesSinceMidnight(base);
  if (mins >= 21 * 60) {
    const start = setTime(base, 21, 0);
    const end = new Date(setTime(base, 5, 0).getTime() + 24 * 60 * 60 * 1000);
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

  if (sh === 1) { start.setHours(5, 0, 0, 0); return start; }
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
  const end = new Date(day);   end.setHours(21, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 1);
  return { start, end };
}
function todayProdDayRange() {
  return prodDayRangeFor(new Date());
}
function yesterdayProdDayRange() {
  const y = new Date(); y.setDate(y.getDate() - 1);
  return prodDayRangeFor(y);
}

// Previous calendar week: Sunday 00:00 -> this Sunday 00:00
function previousWeekSundayToSundayRange(now = new Date()) {
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setHours(0, 0, 0, 0);
  startOfThisWeek.setDate(startOfThisWeek.getDate() - startOfThisWeek.getDay()); // 0=Sun

  const start = new Date(startOfThisWeek);
  start.setDate(start.getDate() - 7);

  const end = startOfThisWeek;
  return { start, end };
}

/* ---------- Fetch ---------- */
async function fetchData() {
  const startLocal = startEl?.value;
  const endLocal = endEl?.value;

  if (!startLocal || !endLocal) throw new Error("Start and End must be selected");

  const url = `/api/oven/plug-performance?startLocal=${encodeURIComponent(startLocal)}&endLocal=${encodeURIComponent(endLocal)}`;
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || "Failed to load data");
  return data;
}

function unpackSeries(data) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
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
function renderKpis(kpis) {
  if (!kpiCardsEl) return;

  const filled = Number(kpis?.filledTotal);
  const empty = Number(kpis?.emptyTotal);
  const total = Number(kpis?.totalCycles);

  const eff = (kpis?.efficiencyPct === null || kpis?.efficiencyPct === undefined)
    ? "—" : `${kpis.efficiencyPct}%`;

  const lost = fmtDuration(kpis?.lostSeconds);

  const filledDisp = Number.isFinite(filled) ? filled : "—";
  const emptyDisp = Number.isFinite(empty) ? empty : "—";
  const totalDisp = Number.isFinite(total) ? total : "—";

  const sys = computeSystemStatusFromSeries();
  const sysText = (sys.sinceMin === null) ? sys.status : `${sys.status} (last ${sys.sinceMin}m)`;

  const lastCure = fmtMinutes(kpis?.lastCureMinutes);
  const avgCure = fmtMinutes(kpis?.avgCureMinutes);

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
      <h3>Last Cure Time</h3>
      <div class="muted">${lastCure}</div>
      <div class="muted" style="margin-top:6px;">Extract − Mold Close</div>
    </div>

    <div class="card">
      <h3>Avg Cure Time</h3>
      <div class="muted">${avgCure}</div>
      <div class="muted" style="margin-top:6px;">Filled cycles in range</div>
    </div>
  `;
}

/* ---------- Shift cards (time-series completions only) ---------- */
function renderShiftCards(buckets, sizes, series) {
  if (!shiftCardsEl) return;

  const totals = { 1: {}, 2: {}, 3: {} };
  for (const sh of [1, 2, 3]) for (const s of sizes) totals[sh][s] = 0;

  buckets.forEach((t, idx) => {
    const d = new Date(t);
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
    p.textContent = sizes.map((s) => `Size ${s}: ${totals[sh][s]}`).join("  |  ");
    card.appendChild(h3);
    card.appendChild(p);
    shiftCardsEl.appendChild(card);
  });
}

/* ---------- Size selector ---------- */
function ensureTsSizeOptions(sizes) {
  if (!tsSizeFilterEl) return;
  const current = tsSizeFilterEl.value || "ALL";
  tsSizeFilterEl.innerHTML =
    `<option value="ALL">All sizes</option>` +
    sizes.map((s) => `<option value="${String(s)}">Size ${s}</option>`).join("");
  if ([...tsSizeFilterEl.options].some(o => o.value === current)) {
    tsSizeFilterEl.value = current;
  }
}

/* ---------- Time series (completions) ---------- */
function getTsLine(buckets, sizes, series, sel) {
  if (sel === "ALL") {
    const line = buckets.map((_, i) => sizes.reduce((t, s) => t + (series[s]?.[i] || 0), 0));
    return { line, label: "All sizes" };
  }
  const data = series[sel] || [];
  const line = buckets.map((_, i) => Number(data[i] || 0));
  return { line, label: `Size ${sel}` };
}

function buildTimeSeriesLegendSingle(label) {
  if (!legendEl) return;
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
  const runs = [];
  if (N < 2) return runs;

  const stepPx = plotW / (N - 1);
  const xFor = (i) => padL + plotW * (i / (N - 1));

  ctx.save();
  ctx.fillStyle = isDark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";

  let i = 0;
  while (i < N) {
    if (!mask[i]) { i++; continue; }

    let j = i;
    while (j + 1 < N && mask[j + 1]) j++;

    const runLen = (j - i + 1);
    if (runLen >= SHADE_AFTER_EMPTY_BUCKETS) {
      const x0 = Math.max(padL, xFor(i) - stepPx / 2);
      const x1 = Math.min(padL + plotW, xFor(j) + stepPx / 2);
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      runs.push({ i, j, x0, x1, runLen });
    }

    i = j + 1;
  }

  ctx.restore();
  return runs;
}

/* ---------- Event bars (Maintenance + Mfg End) ---------- */
function drawEventBars(ctx, buckets, padL, padT, plotW, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  if (!Array.isArray(buckets) || buckets.length < 2) return;

  const rangeStart = Number(buckets[0]);
  const rangeEnd = Number(buckets[buckets.length - 1]);
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return;

  const xForTime = (tMs) => {
    const tt = Math.max(rangeStart, Math.min(rangeEnd, Number(tMs)));
    const p = (tt - rangeStart) / (rangeEnd - rangeStart);
    return padL + plotW * p;
  };

  const barH = 14;
  const barY = padT + 6; // near top of plot
  const r = 6;

  const fillMaint = isDark() ? "rgba(255,165,0,0.22)" : "rgba(255,140,0,0.22)";
  const fillMfg   = isDark() ? "rgba(0,140,255,0.20)" : "rgba(0,102,204,0.18)";
  const stroke    = isDark() ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.14)";
  const textCol   = isDark() ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.80)";

  function roundRect(x, y, w, h, rr) {
    const rad = Math.max(0, Math.min(rr, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const ev of events) {
    const s = Number(ev.startMs);
    const e = Number(ev.endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;

    const x0 = xForTime(s);
    const x1 = xForTime(e);
    const w = Math.max(3, x1 - x0);

    ctx.fillStyle = (ev.dept === "maintenance") ? fillMaint : fillMfg;
    roundRect(x0, barY, w, barH, r);
    ctx.fill();
    ctx.stroke();

    const base = ev.label || (ev.dept === "maintenance" ? "Maint" : "Mfg End");
    const detail = ev.detail ? ` ${ev.detail}` : "";
    const full = `${base}${detail}`;

    // only draw text if it fits
    let label = full;
    if (ctx.measureText(label).width > (w - 10)) label = base;

    if (w >= 40 && ctx.measureText(label).width <= (w - 10)) {
      ctx.fillStyle = textCol;
      ctx.fillText(label, x0 + w / 2, barY + barH / 2);
    }
  }

  ctx.restore();
}

function shiftBoundaryLabel(d) {
  // assumes d is local Date
  const h = d.getHours();
  const m = d.getMinutes();
  if (m !== 0) return null;
  if (h === 5) return "S1";
  if (h === 13) return "S2";
  if (h === 21) return "S3";
  return null;
}

function drawTimeSeriesSingle(buckets, sizes, series, sel) {
  if (!canvas) return;
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
  const runs = shadeStopped(ctx, stoppedMask, padL, padT, plotW, plotH, N);

  // Event bars (Maintenance + Mfg End) from API response
  if (lastOvenData?.events) {
    drawEventBars(ctx, buckets, padL, padT, plotW, lastOvenData.events);
  }

  // ---- Shift boundary markers (05:00 / 13:00 / 21:00) ----
  if (N >= 2) {
    ctx.save();

    ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
    ctx.lineWidth = 2;

    ctx.fillStyle = isDark() ? "rgba(255,255,255,0.70)" : "rgba(0,0,0,0.60)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const xFor = (i) => padL + plotW * (N === 1 ? 0 : i / (N - 1));

    for (let i = 0; i < N; i++) {
      const d = new Date(buckets[i]);
      const lab = shiftBoundaryLabel(d);
      if (!lab) continue;

      const x = xFor(i);

      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();

      ctx.fillText(lab, x, padT + 2);
    }

    ctx.restore();
  }

  // Label each shaded run with its duration (dynamic sizing + fallback)
  const bucketMinutes = Number(lastOvenData?.bucketMinutes ?? 5);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isDark() ? "rgba(255,255,255,0.78)" : "rgba(0,0,0,0.65)";

  for (const r of runs) {
    const minutes = r.runLen * bucketMinutes;

    function compactLabel(m) {
      if (!Number.isFinite(m) || m <= 0) return "0m";
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      const rem = m % 60;
      return rem ? `${h}h ${rem}m` : `${h}h`;
    }

    const fullLabel = compactLabel(minutes);
    const compactOne = (minutes >= 60 && (minutes % 60) !== 0)
      ? `${Math.floor(minutes / 60)}h${minutes % 60}`
      : `${minutes}m`;

    const maxWidth = r.x1 - r.x0 - 8;
    const minFontPx = 9;
    let fontPx = 12;

    ctx.font = `${fontPx}px sans-serif`;
    let measured = ctx.measureText(fullLabel).width;

    while (measured > maxWidth && fontPx > minFontPx) {
      fontPx -= 1;
      ctx.font = `${fontPx}px sans-serif`;
      measured = ctx.measureText(fullLabel).width;
    }

    const xMid = (r.x0 + r.x1) / 2;
    const yMid = padT + plotH / 8;

    if (measured <= maxWidth && (r.x1 - r.x0) >= 34) {
      ctx.fillText(fullLabel, xMid, yMid);
    } else {
      let compFont = Math.max(minFontPx, Math.min(11, fontPx));
      ctx.font = `${compFont}px sans-serif`;
      measured = ctx.measureText(compactOne).width;

      if (measured <= maxWidth && (r.x1 - r.x0) >= 28) {
        ctx.fillText(compactOne, xMid, yMid);
      } else {
        // rotated fallback
        const vFont = Math.max(minFontPx, Math.min(11, compFont));
        ctx.font = `${vFont}px sans-serif`;

        ctx.save();
        ctx.translate(xMid, yMid);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(compactOne, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.restore();

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

  // X labels
  const step = Math.max(1, Math.floor(N / 12));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < N; i += step) {
    const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
    const d = new Date(buckets[i]);
    ctx.fillText(`${pad(d.getHours())}:${pad(d.getMinutes())}`, x, padT + plotH + 10);
  }

  // Axes
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // Line
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

/* ---------- Tooltip: snap to nearest bucket on hover ---------- */
const tooltipEl = document.getElementById("chartTooltip");

function formatIsoLocal(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function xToBucketIndex(canvasEl, mouseX, bucketsCount) {
  // MUST match drawTimeSeriesSingle padding
  const padL = 60, padR = 20;
  const W = canvasEl.width;
  const plotW = W - padL - padR;
  if (bucketsCount <= 1) return 0;
  const rel = mouseX - padL;
  const t = Math.max(0, Math.min(1, rel / (plotW || 1)));
  const idx = Math.round(t * (bucketsCount - 1));
  return idx;
}

function drawCrosshairOnTimeSeries(idx) {
  if (!canvas || !lastOvenData) return;
  const { buckets: b, sizes, series } = unpackSeries(lastOvenData);
  if (!b.length) return;

  const sel = (tsSizeFilterEl?.value) || "ALL";

  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const padL = 60, padR = 20, padT = 18, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const N = b.length;

  if (idx < 0 || idx >= N) return;

  let yVal = 0;
  if (sel === "ALL") {
    yVal = sizes.reduce((t, s) => t + (series[s]?.[idx] || 0), 0);
  } else {
    yVal = Number(series[sel]?.[idx] || 0);
  }

  const { line } = getTsLine(b, sizes, series, sel);
  let maxY = 0;
  for (const v of line) maxY = Math.max(maxY, v);
  maxY = Math.max(5, Math.ceil(maxY * 1.15));

  const x = padL + plotW * (N === 1 ? 0 : idx / (N - 1));
  const y = padT + plotH - (plotH * (yVal / maxY));

  ctx.save();
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, padT);
  ctx.lineTo(x, padT + plotH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(padL, y);
  ctx.lineTo(padL + plotW, y);
  ctx.stroke();

  ctx.fillStyle = isDark() ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.75)";
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function findRunContainingIndex(sizes, series, idx) {
  const N = (series && sizes && sizes.length) ? (series[sizes[0]]?.length ?? 0) : 0;
  if (!N) return null;

  const mask = new Array(N).fill(false);
  for (let i = 0; i < N; i++) {
    let total = 0;
    for (const s of sizes) total += (series[s]?.[i] || 0);
    mask[i] = (total === 0);
  }
  if (!mask[idx]) return null;

  let i = idx, j = idx;
  while (i - 1 >= 0 && mask[i - 1]) i--;
  while (j + 1 < N && mask[j + 1]) j++;
  return { i, j, runLen: j - i + 1 };
}

function tooltipContentForIndex(idx) {
  if (!lastOvenData) return "";
  const buckets = Array.isArray(lastOvenData.buckets) ? lastOvenData.buckets : [];
  const sizes = Array.isArray(lastOvenData.sizes) ? lastOvenData.sizes : [];
  const series = lastOvenData.series || {};

  if (idx < 0 || idx >= buckets.length) return "";

  const sel = (tsSizeFilterEl?.value) || "ALL";
  const timeLocal = formatIsoLocal(buckets[idx]);

  let completions;
  if (sel === "ALL") {
    completions = sizes.reduce((t, s) => t + (series[s]?.[idx] || 0), 0);
  } else {
    completions = Number(series[sel]?.[idx] || 0);
  }

  const run = findRunContainingIndex(sizes, series, idx);
  const bucketMinutes = Number(lastOvenData?.bucketMinutes ?? 5);
  const runMinutes = run ? (run.runLen * bucketMinutes) : 0;
  const isDown = !!run;

  let cureVal = null;
  if (lastOvenData.cure && lastOvenData.cure.series) {
    const cureSeriesAll = lastOvenData.cure.series || {};
    const sKey = (sel === "ALL") ? null : sel;
    if (sKey) {
      cureVal = cureSeriesAll[sKey] ? cureSeriesAll[sKey][idx] : null;
    } else {
      const vals = (lastOvenData.cure.sizes || []).map(s => cureSeriesAll[s]?.[idx]).filter(v => v !== null && v !== undefined);
      cureVal = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    }
  }

  const parts = [];
  parts.push(`<div style="font-weight:700;margin-bottom:6px">${timeLocal}</div>`);
  parts.push(`<div>Completions: <strong>${completions}</strong></div>`);

  if (isDown) {
    const downColor = isDark() ? "#ffd0d0" : "#7a0000";
    const downBg = isDark() ? "rgba(255,80,80,0.12)" : "rgba(200,0,0,0.10)";
    parts.push(
      `<div style="margin-top:6px;color:${downColor};font-weight:700;background:${downBg};display:inline-block;padding:2px 6px;border-radius:6px">
         Downtime run: ${fmtDowntimeMinutes(runMinutes)}
       </div>`
    );

    const startT = formatIsoLocal(lastOvenData.buckets[run.i]);
    const endT = formatIsoLocal(lastOvenData.buckets[run.j]);
    parts.push(`<div style="font-size:12px;color:#ddd">Run: ${startT} → ${endT}</div>`);
  } else {
    const runColor = isDark() ? "#cfe8ff" : "#003b7a";
    parts.push(`<div style="margin-top:6px;color:${runColor};font-weight:600">Running / has completions</div>`);
  }

  if (cureVal !== null && cureVal !== undefined) {
    const c = Math.round(Number(cureVal) * 10) / 10;
    parts.push(`<div style="margin-top:6px">Avg Cure: <strong>${c} min</strong></div>`);
  }

  return parts.join("");
}

function showTooltipAt(clientX, clientY, html) {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = "block";

  if (isDark()) {
    tooltipEl.style.background = "rgba(20,20,24,0.92)";
    tooltipEl.style.color = "#fff";
  } else {
    tooltipEl.style.background = "rgba(255,255,255,0.98)";
    tooltipEl.style.color = "#111";
  }

  const padPx = 12;
  const rect = tooltipEl.getBoundingClientRect();
  let left = clientX + 16;
  let top = clientY + 12;

  if (left + rect.width + padPx > window.innerWidth) left = clientX - rect.width - 16;
  if (left < padPx) left = padPx;

  if (top + rect.height + padPx > window.innerHeight) top = clientY - rect.height - 16;
  if (top < padPx) top = padPx;

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.style.display = "none";
  tooltipEl.innerHTML = "";
}

function onChartMouseMove(ev) {
  if (!canvas || !lastOvenData) return;
  const rect = canvas.getBoundingClientRect();
  const mouseX = ev.clientX - rect.left;

  const buckets = Array.isArray(lastOvenData.buckets) ? lastOvenData.buckets : [];
  if (!buckets.length) { hideTooltip(); return; }

  const idx = xToBucketIndex(canvas, mouseX, buckets.length);
  const html = tooltipContentForIndex(idx);

  pendingHoverIdx = idx;
  if (!hoverRAF) {
    hoverRAF = requestAnimationFrame(() => {
      hoverRAF = null;
      if (pendingHoverIdx === null || pendingHoverIdx === undefined) return;

      if (hoverTsIndex !== pendingHoverIdx) {
        hoverTsIndex = pendingHoverIdx;
        renderCurrentView();
        drawCrosshairOnTimeSeries(hoverTsIndex);
      }
    });
  }

  if (!html) { hideTooltip(); return; }
  showTooltipAt(ev.clientX, ev.clientY, html);
}

function onChartMouseLeave() {
  pendingHoverIdx = null;
  hoverTsIndex = null;
  if (hoverRAF) cancelAnimationFrame(hoverRAF);
  hoverRAF = null;
  renderCurrentView();
  hideTooltip();
}

if (canvas) {
  canvas.removeEventListener("mousemove", onChartMouseMove);
  canvas.removeEventListener("mouseleave", onChartMouseLeave);
  canvas.addEventListener("mousemove", onChartMouseMove);
  canvas.addEventListener("mouseleave", onChartMouseLeave);
}

/* ---------- Cure time series ---------- */
function drawCureTimeSeries(cure, selSize = "ALL") {
  if (!cureCanvas || !cure?.buckets?.length) return;

  const buckets = cure.buckets;
  const sizes = cure.sizes || [];
  const series = cure.series || {};

  let line = [];
  let label = "All sizes";

  if (selSize !== "ALL") {
    label = `Size ${selSize}`;
    line = buckets.map((_, i) => {
      const v = series[selSize]?.[i];
      return (v === null || v === undefined) ? null : Number(v);
    });
  } else {
    line = buckets.map((_, i) => {
      const vals = sizes
        .map(s => series[s]?.[i])
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number);
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
  }

  const ctx = cureCanvas.getContext("2d");
  const W = cureCanvas.width, H = cureCanvas.height;
  const padL = 60, padR = 20, padT = 18, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const N = buckets.length;

  let maxY = Math.max(CURE_HIGH_MIN, 5);
  let minY = Math.min(CURE_LOW_MIN, 0);

  for (const v of line) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    maxY = Math.max(maxY, n);
    minY = Math.min(minY, n);
  }
  maxY = Math.ceil(maxY * 1.10);
  minY = Math.floor(Math.max(0, minY - 5));

  function yFor(val) {
    const t = (val - minY) / (maxY - minY || 1);
    return padT + plotH - (plotH * t);
  }
  function xFor(i) {
    return padL + plotW * (N === 1 ? 0 : i / (N - 1));
  }

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.10)" : "#e6e6e6";
  ctx.lineWidth = 1;
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH * i / gridLines);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }

  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY - (maxY - minY) * (i / gridLines));
    const y = padT + (plotH * i / gridLines);
    ctx.fillText(String(val), padL - 8, y);
  }

  const step = Math.max(1, Math.floor(N / 12));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < N; i += step) {
    const x = xFor(i);
    const d = new Date(buckets[i]);
    ctx.fillText(`${pad(d.getHours())}:${pad(d.getMinutes())}`, x, padT + plotH + 10);
  }

  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;

  ctx.strokeStyle = isDark() ? "rgba(0,255,0,0.55)" : "rgba(0,160,0,0.65)";
  ctx.beginPath(); ctx.moveTo(padL, yFor(CURE_LOW_MIN)); ctx.lineTo(padL + plotW, yFor(CURE_LOW_MIN)); ctx.stroke();

  ctx.strokeStyle = isDark() ? "rgba(255,165,0,0.55)" : "rgba(220,120,0,0.70)";
  ctx.beginPath(); ctx.moveTo(padL, yFor(CURE_HIGH_MIN)); ctx.lineTo(padL + plotW, yFor(CURE_HIGH_MIN)); ctx.stroke();

  ctx.restore();

  ctx.strokeStyle = COLORS[0];
  ctx.lineWidth = 3;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < N; i++) {
    const v = line[i];
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      started = false;
      continue;
    }
    const x = xFor(i);
    const y = yFor(Number(v));
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`Avg Cure Time — ${label}`, padL, 6);
}

/* ---------- Grouped bars (shift totals / instances) ---------- */
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
  return { labels, sizeOrder, seriesMap };
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
    const day = `${start.getMonth() + 1}/${start.getDate()}`;
    const shName = sh === 1 ? "1st" : sh === 2 ? "2nd" : "3rd";
    return `${day} ${shName}`;
  });

  return { labels, sizeOrder, seriesMap };
}

function drawGroupedBars(labels, seriesMap, sizeOrder, hintText) {
  if (!shiftBarCanvas || !shiftLegendEl) return;
  const ctx = shiftBarCanvas.getContext("2d");
  const W = shiftBarCanvas.width, H = shiftBarCanvas.height;

  const padL = 60, padR = 20, padT = 18, padB = 96;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const N = labels.length;
  const S = sizeOrder.length;

  const totals = labels.map((_, i) =>
    sizeOrder.reduce((sum, s) => sum + (seriesMap[s]?.[i] || 0), 0)
  );
  const grandTotal = totals.reduce((a, b) => a + b, 0);

  const highestSingleBar = Math.max(
    5,
    ...sizeOrder.map(s => Math.max(...(seriesMap[s] || [0])))
  );
  const maxY = Math.max(100, Math.ceil(highestSingleBar * 1.05));

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

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

  const textColor = isDark() ? "#e6e8ea" : "#333";
  ctx.fillStyle = textColor;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY * (1 - i / gridLines));
    const y = Math.round(padT + (plotH * i / gridLines));
    ctx.fillText(String(val), padL - 8, y);
  }

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

  const groupGap = Math.max(16, Math.min(40, Math.floor(plotW / Math.max(6, N * 6))));
  const groupW = (plotW - groupGap * (N + 1)) / N;

  const barGap = Math.max(6, Math.min(14, Math.floor(groupW / Math.max(6, S * 6))));
  let barW = (groupW - barGap * (S - 1)) / S;
  barW = Math.max(4, Math.floor(barW));

  for (let i = 0; i < N; i++) {
    const xGroup = Math.round(padL + groupGap + i * (groupW + groupGap));

    sizeOrder.forEach((s, si) => {
      const v = Number(seriesMap[s]?.[i] || 0);
      const h = Math.round(plotH * (v / maxY));
      const y0 = Math.round(padT + plotH - h);
      const x0 = Math.round(xGroup + si * (barW + barGap));

      ctx.fillStyle = COLORS[si % COLORS.length];
      ctx.fillRect(x0, y0, barW, h);

      const label = String(v);
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      if (h >= 18) {
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(label, Math.round(x0 + barW / 2), Math.round(y0 + h / 2));
      } else {
        ctx.fillStyle = textColor;
        ctx.textBaseline = "bottom";
        ctx.fillText(label, Math.round(x0 + barW / 2), Math.round(y0 - 2));
      }
    });

    const xLabel = Math.round(xGroup + groupW / 2);
    const yLabel = Math.round(padT + plotH + 12);
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "12px sans-serif";
    ctx.fillText(labels[i], xLabel, yLabel);

    const tot = totals[i];
    const boxText = String(tot);
    const paddingX = 8;
    const textW = ctx.measureText(boxText).width;
    const boxW = Math.ceil(textW + paddingX * 2);
    const boxH = 22;
    const boxX = Math.round(xLabel - boxW / 2);
    const boxY = Math.round(yLabel + 14);

    ctx.fillStyle = isDark() ? "#12171d" : "#ffffff";
    ctx.strokeStyle = isDark() ? "#2a3139" : "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(boxText, Math.round(boxX + boxW / 2), Math.round(boxY + boxH / 2));
  }

  shiftLegendEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.justifyContent = "space-between";
  wrap.style.alignItems = "flex-start";
  wrap.style.gap = "16px";
  wrap.style.flexWrap = "wrap";

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
    item.className = "item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = COLORS[i % COLORS.length];
    item.appendChild(sw);
    item.appendChild(document.createTextNode(`Size ${s}`));
    legend.appendChild(item);
  });

  left.appendChild(legend);

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

  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "1fr auto";
  grid.style.gap = "4px 10px";

  sizeOrder.forEach((s, i) => {
    const sum = (seriesMap[s] || []).reduce((a, b) => a + (b || 0), 0);
    const name = document.createElement("div");
    name.textContent = `Size ${s}:`;
    const val = document.createElement("div");
    val.textContent = String(sum);
    val.style.textAlign = "right";
    val.style.color = COLORS[i % COLORS.length];
    grid.appendChild(name);
    grid.appendChild(val);
  });

  const hr = document.createElement("div");
  hr.style.height = "1px";
  hr.style.background = isDark() ? "#2a3139" : "#ddd";
  hr.style.margin = "8px 0";

  const totalLabel = document.createElement("div");
  totalLabel.textContent = "Total Balls";
  const totalVal = document.createElement("div");
  totalVal.textContent = String(grandTotal);
  totalVal.style.textAlign = "right";

  right.appendChild(title);
  right.appendChild(grid);
  right.appendChild(hr);
  right.appendChild(totalLabel);
  right.appendChild(totalVal);

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
function fmtIsoLocalLabel(x) {
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return String(x);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildOvenCsv() {
  if (!lastOvenData) return "Note,No data loaded yet.\n";

  const mode = chartViewEl?.value || "timeseries";
  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  const k = lastOvenData.kpis || null;

  const lines = [];
  lines.push(["GeneratedAt", new Date().toISOString()].map(csvEscape).join(","));
  lines.push(["RangeStart", lastOvenData.start ?? ""].map(csvEscape).join(","));
  lines.push(["RangeEnd", lastOvenData.end ?? ""].map(csvEscape).join(","));
  lines.push(["ChartView", mode].map(csvEscape).join(","));
  lines.push("");

  lines.push("KPIs");
  lines.push(["FilledTotal", k?.filledTotal ?? ""].map(csvEscape).join(","));
  lines.push(["EmptyTotal", k?.emptyTotal ?? ""].map(csvEscape).join(","));
  lines.push(["TotalCycles", k?.totalCycles ?? ""].map(csvEscape).join(","));
  lines.push(["EfficiencyPct", k?.efficiencyPct ?? ""].map(csvEscape).join(","));
  lines.push(["LostSeconds", k?.lostSeconds ?? ""].map(csvEscape).join(","));
  lines.push(["LastCureMinutes", k?.lastCureMinutes ?? ""].map(csvEscape).join(","));
  lines.push(["AvgCureMinutes", k?.avgCureMinutes ?? ""].map(csvEscape).join(","));
  lines.push("");

  if (mode === "timeseries") {
    lines.push("Completions_TimeSeries_Buckets");
    const header = ["BucketLocal", ...sizes.map(s => `Size_${s}`), "Total"];
    lines.push(header.map(csvEscape).join(","));

    for (let i = 0; i < buckets.length; i++) {
      let total = 0;
      const row = [fmtIsoLocalLabel(buckets[i])];
      for (const s of sizes) {
        const v = Number(series[s]?.[i] || 0);
        total += v;
        row.push(v);
      }
      row.push(total);
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");

  } else if (mode === "cureTimeseries") {
    const cure = lastOvenData.cure;
    const cb = Array.isArray(cure?.buckets) ? cure.buckets : [];
    const cs = Array.isArray(cure?.sizes) ? cure.sizes : [];
    const cseries = cure?.series || {};

    lines.push("Cure_TimeSeries_Buckets");
    const header = ["BucketLocal", ...cs.map(s => `Size_${s}`), "AllSizes_Avg"];
    lines.push(header.map(csvEscape).join(","));

    for (let i = 0; i < cb.length; i++) {
      const row = [fmtIsoLocalLabel(cb[i])];

      const vals = [];
      for (const s of cs) {
        const v = cseries[s]?.[i];
        row.push(v === null || v === undefined ? "" : Number(v));
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) vals.push(Number(v));
      }

      const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : "";
      row.push(avg === "" ? "" : Math.round(avg * 10) / 10);

      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");

  } else if (mode === "shiftType") {
    const g = computeTotalsByShiftTypeGrouped(buckets, sizes, series);
    lines.push("ShiftTotals_ByType_Grouped");
    lines.push(["Shift", ...g.sizeOrder.map(s => `Size_${s}`), "Total"].map(csvEscape).join(","));
    for (let i = 0; i < g.labels.length; i++) {
      const row = [g.labels[i], ...g.sizeOrder.map(s => g.seriesMap[s][i])];
      row.push(g.sizeOrder.reduce((t, s) => t + (g.seriesMap[s][i] || 0), 0));
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");

  } else {
    const g = computeTotalsByShiftInstanceGrouped(buckets, sizes, series);
    lines.push("ShiftTotals_ByInstance_Grouped");
    lines.push(["ShiftInstance", ...g.sizeOrder.map(s => `Size_${s}`), "Total"].map(csvEscape).join(","));
    for (let i = 0; i < g.labels.length; i++) {
      const row = [g.labels[i], ...g.sizeOrder.map(s => g.seriesMap[s][i])];
      row.push(g.sizeOrder.reduce((t, s) => t + (g.seriesMap[s][i] || 0), 0));
      lines.push(row.map(csvEscape).join(","));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/* ---------- View controller ---------- */
function setChartMode(mode) {
  const isTime = (mode === "timeseries" || mode === "cureTimeseries");

  if (timeseriesSection) timeseriesSection.style.display = isTime ? "block" : "none";
  if (shiftBarsSection) shiftBarsSection.style.display = isTime ? "none" : "block";

  if (tsSizeFilterEl?.parentElement) {
    tsSizeFilterEl.parentElement.style.display = isTime ? "block" : "none";
  }

  if (shiftCardsEl) shiftCardsEl.style.display = (mode === "timeseries") ? "flex" : "none";
  if (cureSection) cureSection.style.display = (mode === "cureTimeseries") ? "block" : "none";

  if (canvas) canvas.style.display = (mode === "timeseries") ? "block" : "none";
  if (legendEl) legendEl.style.display = (mode === "timeseries") ? "flex" : "none";
}

function renderCurrentView() {
  if (!lastOvenData) return;

  const mode = chartViewEl?.value || "timeseries";

  if (mode === "timeseries") {
    const { buckets, sizes, series } = unpackSeries(lastOvenData);
    ensureTsSizeOptions(sizes);
    const sel = tsSizeFilterEl?.value || "ALL";
    drawTimeSeriesSingle(buckets, sizes, series, sel);
    renderShiftCards(buckets, sizes, series);

  } else if (mode === "cureTimeseries") {
    const cure = lastOvenData.cure;
    const cureSizes = Array.isArray(cure?.sizes) ? cure.sizes : [];
    ensureTsSizeOptions(cureSizes.length ? cureSizes : (lastOvenData.sizes || []));
    const sel = tsSizeFilterEl?.value || "ALL";
    drawCureTimeSeries(cure, sel);

  } else if (mode === "shiftType") {
    const { buckets, sizes, series } = unpackSeries(lastOvenData);
    const g = computeTotalsByShiftTypeGrouped(buckets, sizes, series);
    drawGroupedBars(g.labels, g.seriesMap, g.sizeOrder, "Shift totals by size");

  } else {
    const { buckets, sizes, series } = unpackSeries(lastOvenData);
    const g = computeTotalsByShiftInstanceGrouped(buckets, sizes, series);
    drawGroupedBars(g.labels, g.seriesMap, g.sizeOrder, "Shift instances by size");
  }
}

/* ---------- Refresh ---------- */
async function refresh() {
  try {
    showError("");
    const data = await fetchData();
    lastOvenData = data;
    renderKpis(data.kpis);
    setChartMode(chartViewEl?.value || "timeseries");
    renderCurrentView();
  } catch (e) {
    showError(e.message);
    renderKpis(null);
    if (lastOvenData) {
      setChartMode(chartViewEl?.value || "timeseries");
      renderCurrentView();
    }
  }
}

function setRange(start, end) {
  if (startEl) startEl.value = toLocalInputValue(start);
  if (endEl) endEl.value = toLocalInputValue(end);
}

/* ---------- Controls ---------- */
applyBtn?.addEventListener("click", refresh);

todayBtn?.addEventListener("click", () => {
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
  const { start, end } = previousWeekSundayToSundayRange(new Date());
  setRange(start, end);
  refresh();
});

shiftBtn?.addEventListener("click", () => {
  const { start, end } = currentShiftRange(new Date());
  setRange(start, end);
  refresh();
});

downloadCsvBtn?.addEventListener("click", () => {
  const mode = chartViewEl?.value || "timeseries";
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const filename = `oven_${mode}_${stamp}.csv`;
  downloadTextAsFile(filename, buildOvenCsv());
});

liveEl?.addEventListener("change", () => {
  if (!liveEl) return;
  if (liveEl.checked) {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(refresh, 60000);
  } else {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }
});

function rerenderForThemeChange() {
  if (!lastOvenData) return;
  setChartMode(chartViewEl?.value || "timeseries");
  renderCurrentView();
  renderKpis(lastOvenData.kpis);
}

// Rolling last hour helpers
function setLastHourRangeAndRefresh() {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);
  setRange(start, now);
  refresh();
}
function startLiveLastHour(freqMs = 60000) {
  if (liveHourActive) return;
  liveHourActive = true;

  setLastHourRangeAndRefresh();

  if (liveHourTimer) clearInterval(liveHourTimer);
  liveHourTimer = setInterval(setLastHourRangeAndRefresh, freqMs);

  lastHourBtn?.classList.add("active");
}
function stopLiveLastHour() {
  if (!liveHourActive) return;
  liveHourActive = false;
  if (liveHourTimer) clearInterval(liveHourTimer);
  liveHourTimer = null;
  lastHourBtn?.classList.remove("active");
}

lastHourBtn?.addEventListener("click", () => {
  if (!liveHourActive) {
    startLiveLastHour(60000);
    lastHourBtn.textContent = "Last Production Hour (live) — ON";
  } else {
    stopLiveLastHour();
    lastHourBtn.textContent = "Last Production Hour (live)";
  }
});

[startEl, endEl].forEach(el => {
  el?.addEventListener("input", () => {
    if (liveHourActive) {
      stopLiveLastHour();
      if (lastHourBtn) lastHourBtn.textContent = "Last Production Hour (live)";
    }
  });
});

// View changes
chartViewEl?.addEventListener("change", () => {
  setChartMode(chartViewEl.value);
  renderCurrentView();
});

// Size selector changes
tsSizeFilterEl?.addEventListener("change", renderCurrentView);

/* ---------- Init ---------- */
(function init() {
  const { start, end } = todayProdDayRange();
  setRange(start, end);

  setChartMode(chartViewEl?.value || "timeseries");

  (function watchThemeChanges() {
    const root = document.documentElement;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          rerenderForThemeChange();
          break;
        }
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (mq?.addEventListener) {
      mq.addEventListener("change", () => rerenderForThemeChange());
    } else if (mq?.addListener) {
      mq.addListener(() => rerenderForThemeChange());
    }
  })();

  refresh();
})();
