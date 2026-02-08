// public/oven.js
// Oven Shift Performance (Option A: one chart at a time)
// - Chart View dropdown: Time Series (5-min) | Shift Totals | Shift Instances
// - Size filter for bar chart views
// - Downtime shading on time series when total completions == 0 for a bucket
// - KPI cards (efficiency/time-loss) render with placeholders if offline

const startEl = document.getElementById("start");
const endEl = document.getElementById("end");
const applyBtn = document.getElementById("applyBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const todayBtn = document.getElementById("todayBtn");
const shiftBtn = document.getElementById("shiftBtn");
const last8Btn = document.getElementById("last8Btn");
const liveEl = document.getElementById("live");

const chartViewEl = document.getElementById("chartView");
const shiftSizeFilterEl = document.getElementById("shiftSizeFilter");

const timeseriesSection = document.getElementById("timeseriesSection");
const shiftBarsSection = document.getElementById("shiftBarsSection");

const canvas = document.getElementById("chart");
const shiftBarCanvas = document.getElementById("shiftBarChart");

const legendEl = document.getElementById("legend");
const shiftLegendEl = document.getElementById("shiftLegend");
const errorEl = document.getElementById("error");

const shiftCardsEl = document.getElementById("shiftCards");
const kpiCardsEl = document.getElementById("kpiCards");

let liveTimer = null;
let lastOvenData = null;

const COLORS = ["#0066cc", "#cc3300", "#2e7d32", "#6a1b9a", "#ff8f00", "#00838f"];
const EMPTY_MOLD_SECONDS = 15;

// For shading: shade after 1 empty bucket (5 minutes) per your preference
const SHADE_AFTER_EMPTY_BUCKETS = 1;

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

// ------------------------
// Shift logic (local time) with your overlap rules
// ------------------------
function minutesSinceMidnight(d) { return d.getHours() * 60 + d.getMinutes(); }

function whichShift(localDate) {
  const mins = minutesSinceMidnight(localDate);

  // Shift 3: 21:00 -> 24:00 and 00:00 -> 05:30
  const s3Start = 21 * 60;
  const s3End = 5 * 60 + 30;
  if (mins >= s3Start || mins < s3End) return 3;

  // Shift 2: 13:00 -> 21:30
  const s2Start = 13 * 60;
  const s2End = 21 * 60 + 30;
  if (mins >= s2Start && mins < s2End) return 2;

  // Shift 1: 05:00 -> 13:00 (13:00-13:29 overlap belongs to shift 2)
  const s1Start = 5 * 60;
  const s1End = 13 * 60;
  if (mins >= s1Start && mins < s1End) return 1;

  return 1;
}

function currentShiftRange(now = new Date()) {
  const s = whichShift(now);
  const base = new Date(now);

  function setTime(d, hh, mm) {
    const x = new Date(d);
    x.setHours(hh, mm, 0, 0);
    return x;
  }

  if (s === 1) return { shift: 1, start: setTime(base, 5, 0), end: setTime(base, 13, 30) };
  if (s === 2) return { shift: 2, start: setTime(base, 13, 0), end: setTime(base, 21, 30) };

  // shift 3 crosses midnight
  const mins = minutesSinceMidnight(base);
  if (mins >= 21 * 60) {
    const start = setTime(base, 21, 0);
    const end = new Date(setTime(base, 5, 30).getTime() + 24 * 60 * 60 * 1000);
    return { shift: 3, start, end };
  } else {
    const end = setTime(base, 5, 30);
    const start = new Date(setTime(base, 21, 0).getTime() - 24 * 60 * 60 * 1000);
    return { shift: 3, start, end };
  }
}

// For shift-instance grouping: compute the start time of the shift occurrence for a given local date.
function shiftInstanceStart(localDate) {
  const d = new Date(localDate);
  const sh = whichShift(d);

  const start = new Date(d);
  start.setSeconds(0, 0);

  if (sh === 1) { start.setHours(5, 0, 0, 0); return start; }
  if (sh === 2) { start.setHours(13, 0, 0, 0); return start; }

  // shift 3 starts at 21:00; if before 05:30, start is previous day 21:00
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= 21 * 60) {
    start.setHours(21, 0, 0, 0);
    return start;
  } else {
    start.setDate(start.getDate() - 1);
    start.setHours(21, 0, 0, 0);
    return start;
  }
}

// ------------------------
// Fetch
// ------------------------
async function fetchData(start, end) {
  const url = `/api/oven/plug-performance?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || "Failed to load data");
  return data;
}

// Normalize the server response for both new (buckets) and old (hours) shapes
function unpackSeries(data) {
  const buckets = Array.isArray(data.buckets) ? data.buckets : (Array.isArray(data.hours) ? data.hours : []);
  const sizes = Array.isArray(data.sizes) ? data.sizes : [];
  const series = data.series || {};
  return { buckets, sizes, series };
}

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

  // Running if last completion within 10 minutes (2× 5-minute buckets)
  const status = sinceMin <= 10 ? "Running" : "Idle/Off";
  return { status, sinceMin };
}

// ------------------------
// KPI rendering (placeholders if offline)
// ------------------------
function fmtDuration(seconds) {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "0m";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return `${h}h ${r}m`;
}

function csvEscape(v) {
  const s = String(v ?? "");
  // Escape quotes and wrap in quotes if needed
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function downloadTextAsFile(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtIsoLocalLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderKpis(kpis) {
  if (!kpiCardsEl) return;

  const filled = Number(kpis?.filledTotal);
  const empty = Number(kpis?.emptyTotal);
  const total = Number(kpis?.totalCycles);

  const eff =
    (kpis?.efficiencyPct === null || kpis?.efficiencyPct === undefined)
      ? "—"
      : `${kpis.efficiencyPct}%`;

  const lost = fmtDuration(kpis?.lostSeconds);

  const filledDisp = Number.isFinite(filled) ? filled : "—";
  const emptyDisp = Number.isFinite(empty) ? empty : "—";
  const totalDisp = Number.isFinite(total) ? total : "—";

  const emptyRate =
    (Number.isFinite(empty) && Number.isFinite(total) && total > 0)
      ? `${Math.round((empty / total) * 1000) / 10}%`
      : "—";

  const sys = computeSystemStatusFromSeries();
  const sysText = (sys.sinceMin === null)
    ? sys.status
    : `${sys.status} (last ${sys.sinceMin}m)`;

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

// ------------------------
// Shift cards (keep for quick glance; shown only in time series view)
// ------------------------
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

// ------------------------
// Legends
// ------------------------
function buildTimeSeriesLegend(sizes) {
  legendEl.innerHTML = "";

  sizes.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = COLORS[i % COLORS.length];
    item.appendChild(sw);
    item.appendChild(document.createTextNode(`Size ${s}`));
    legendEl.appendChild(item);
  });

  const dt = document.createElement("div");
  dt.className = "item";
  const sw2 = document.createElement("span");
  sw2.className = "swatch";
  sw2.style.background = isDark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";
  dt.appendChild(sw2);
  dt.appendChild(document.createTextNode("Shaded = no completions (stopped/idle)"));
  legendEl.appendChild(dt);
}

// ------------------------
// Time series chart with downtime shading
// ------------------------
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
    let j = i;
    while (j + 1 < N && mask[j + 1]) j++;

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

function drawTimeSeries(buckets, sizes, series) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const padL = 60, padR = 20, padT = 18, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const N = buckets.length;

  let maxY = 0;
  for (const s of sizes) for (const v of (series[s] || [])) maxY = Math.max(maxY, v);
  maxY = Math.max(5, Math.ceil(maxY * 1.15));

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const stoppedMask = computeStoppedMask(sizes, series, N);
  shadeStopped(ctx, stoppedMask, padL, padT, plotW, plotH, N);

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

  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY * (1 - i / gridLines));
    const y = padT + (plotH * i / gridLines);
    ctx.fillText(String(val), padL - 8, y);
  }

  // x labels (HH:mm) ~12 labels max
  const step = Math.max(1, Math.floor(N / 12));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < N; i += step) {
    const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
    const d = new Date(buckets[i]);
    const label = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    ctx.fillText(label, x, padT + plotH + 10);
  }

  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  sizes.forEach((s, si) => {
    const data = series[s] || [];
    ctx.strokeStyle = COLORS[si % COLORS.length];
    ctx.lineWidth = 3;
    ctx.beginPath();

    data.forEach((v, i) => {
      const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
      const y = padT + plotH - (plotH * (v / maxY));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  });
}

// ------------------------
// Bar chart helpers
// ------------------------
function computeTotalsByShiftType(buckets, sizes, series, sizeFilter) {
  const totals = { 1: 0, 2: 0, 3: 0 };
  const useAll = !sizeFilter || sizeFilter === "ALL";

  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]);
    const sh = whichShift(d);

    let count = 0;
    if (useAll) {
      for (const s of sizes) count += (series[s]?.[i] || 0);
    } else {
      count = (series[sizeFilter]?.[i] || 0);
    }
    totals[sh] += count;
  }

  return {
    labels: ["1st Shift", "2nd Shift", "3rd Shift"],
    values: [totals[1], totals[2], totals[3]]
  };
}

function computeTotalsByShiftInstance(buckets, sizes, series, sizeFilter) {
  const useAll = !sizeFilter || sizeFilter === "ALL";
  const map = new Map();     // key -> total
  const keyMeta = new Map(); // key -> { start, sh }

  for (let i = 0; i < buckets.length; i++) {
    const d = new Date(buckets[i]);
    const sh = whichShift(d);
    const start = shiftInstanceStart(d);

    const key = `${start.toISOString()}|${sh}`;
    keyMeta.set(key, { start, sh });

    let count = 0;
    if (useAll) {
      for (const s of sizes) count += (series[s]?.[i] || 0);
    } else {
      count = (series[sizeFilter]?.[i] || 0);
    }

    map.set(key, (map.get(key) ?? 0) + count);
  }

  const keys = Array.from(map.keys()).sort((a, b) => {
    const sa = keyMeta.get(a)?.start?.getTime() ?? 0;
    const sb = keyMeta.get(b)?.start?.getTime() ?? 0;
    return sa - sb;
  });

  const labels = keys.map((k) => {
    const meta = keyMeta.get(k);
    const start = meta.start;
    const sh = meta.sh;
    const day = `${start.getMonth() + 1}/${start.getDate()}`;
    const shName = sh === 1 ? "1st" : sh === 2 ? "2nd" : "3rd";
    return `${day} ${shName}`;
  });

  const values = keys.map((k) => map.get(k) ?? 0);
  return { labels, values };
}

function buildOvenCsv() {
  if (!lastOvenData) {
    // Still export a tiny file so users know it worked
    return [
      "Note,No data loaded yet. Try Apply/Refresh while on network."
    ].join("\n");
  }

  const mode = chartViewEl?.value || "timeseries";
  const sizeFilter = shiftSizeFilterEl?.value || "ALL";

  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  const k = lastOvenData.kpis || null;

  const lines = [];
  lines.push(["GeneratedAt", new Date().toISOString()].map(csvEscape).join(","));
  lines.push(["RangeStart", lastOvenData.start ?? ""].map(csvEscape).join(","));
  lines.push(["RangeEnd", lastOvenData.end ?? ""].map(csvEscape).join(","));
  lines.push(["ChartView", mode].map(csvEscape).join(","));
  lines.push(["ShiftSizeFilter", sizeFilter].map(csvEscape).join(","));
  lines.push("");

  // KPIs section
  lines.push("KPIs");
  lines.push(["FilledTotal", k?.filledTotal ?? ""].map(csvEscape).join(","));
  lines.push(["EmptyTotal", k?.emptyTotal ?? ""].map(csvEscape).join(","));
  lines.push(["TotalCycles", k?.totalCycles ?? ""].map(csvEscape).join(","));
  lines.push(["EfficiencyPct", k?.efficiencyPct ?? ""].map(csvEscape).join(","));
  lines.push(["LostSeconds", k?.lostSeconds ?? ""].map(csvEscape).join(","));
  lines.push("");

  // Always include shift summaries (useful for schedulers/managers)
  // By shift type
  lines.push("ShiftTotals_ByType");
  const typeRes = computeTotalsByShiftType(buckets, sizes, series, sizeFilter);
  lines.push(["Shift", "TotalCompleted"].map(csvEscape).join(","));
  for (let i = 0; i < typeRes.labels.length; i++) {
    lines.push([typeRes.labels[i], typeRes.values[i]].map(csvEscape).join(","));
  }
  lines.push("");

  // By shift instance
  lines.push("ShiftTotals_ByInstance");
  const instRes = computeTotalsByShiftInstance(buckets, sizes, series, sizeFilter);
  lines.push(["ShiftInstance", "TotalCompleted"].map(csvEscape).join(","));
  for (let i = 0; i < instRes.labels.length; i++) {
    lines.push([instRes.labels[i], instRes.values[i]].map(csvEscape).join(","));
  }
  lines.push("");

  // If time series view, include bucket-level data too
  if (mode === "timeseries") {
    lines.push("TimeSeries_Buckets");
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
  }

  return lines.join("\n");
}

function drawBarChart(labels, values, hintText) {
  if (!shiftBarCanvas) return;
  const ctx = shiftBarCanvas.getContext("2d");

  const W = shiftBarCanvas.width;
  const H = shiftBarCanvas.height;

  const padL = 60, padR = 20, padT = 18, padB = 70;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const N = labels.length;
  const maxV = Math.max(...values, 5);
  const maxY = Math.ceil(maxV * 1.15);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

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

  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= gridLines; i++) {
    const val = Math.round(maxY * (1 - i / gridLines));
    const y = padT + (plotH * i / gridLines);
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
    if (shiftLegendEl) shiftLegendEl.textContent = "No data in selected range.";
    return;
  }

  const gap = Math.max(6, Math.min(16, Math.floor(plotW / (N * 6))));
  const barW = Math.max(8, (plotW - gap * (N + 1)) / N);

  const barColor = "#1565c0";
  for (let i = 0; i < N; i++) {
    const x0 = padL + gap + i * (barW + gap);
    const h = plotH * (values[i] / maxY);
    const y0 = padT + plotH - h;

    ctx.fillStyle = barColor;
    ctx.fillRect(x0, y0, barW, h);

    ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = "12px sans-serif";
    ctx.fillText(String(values[i]), x0 + barW / 2, y0 - 4);
  }

  // X labels (rotate if many)
  ctx.save();
  ctx.fillStyle = isDark() ? "#e6e8ea" : "#333";
  ctx.font = "12px sans-serif";
  const rotate = N > 6;

  for (let i = 0; i < N; i++) {
    const x = padL + gap + i * (barW + gap) + barW / 2;
    const y = padT + plotH + 10;

    if (rotate) {
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(labels[i], 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(labels[i], x, y);
    }
  }
  ctx.restore();

  if (shiftLegendEl) shiftLegendEl.textContent = hintText || "";
}

// ------------------------
// View controller
// ------------------------
function setChartMode(mode) {
  const isTime = mode === "timeseries";
  timeseriesSection.style.display = isTime ? "block" : "none";
  shiftBarsSection.style.display = isTime ? "none" : "block";

  // show shiftCards only for time series (bar chart already represents shift performance)
  shiftCardsEl.style.display = isTime ? "flex" : "none";

  // Size filter only relevant for bar modes
  shiftSizeFilterEl.disabled = isTime;
}

function renderCurrentView() {
  if (!lastOvenData) return;

  const { buckets, sizes, series } = unpackSeries(lastOvenData);
  const mode = chartViewEl.value || "timeseries";
  const sizeFilter = shiftSizeFilterEl.value || "ALL";

  if (mode === "timeseries") {
    buildTimeSeriesLegend(sizes);
    renderShiftCards(buckets, sizes, series);
    drawTimeSeries(buckets, sizes, series);
  } else if (mode === "shiftType") {
    const res = computeTotalsByShiftType(buckets, sizes, series, sizeFilter);
    const hint = `Shift totals (${sizeFilter === "ALL" ? "All sizes" : "Size " + sizeFilter})`;
    drawBarChart(res.labels, res.values, hint);
  } else {
    const res = computeTotalsByShiftInstance(buckets, sizes, series, sizeFilter);
    const hint = `Shift instances (${sizeFilter === "ALL" ? "All sizes" : "Size " + sizeFilter})`;
    drawBarChart(res.labels, res.values, hint);
  }
}

// ------------------------
// Refresh
// ------------------------
async function refresh() {
  try {
    showError("");

    const start = fromLocalInputValue(startEl.value);
    const end = fromLocalInputValue(endEl.value);

    const data = await fetchData(start, end);
    lastOvenData = data;

    renderKpis(data.kpis);
    renderCurrentView();

  } catch (e) {
    showError(e.message);
    // Keep KPI boxes visible even offline
    renderKpis(null);
    // Don’t clear lastOvenData; if we have old data, keep rendering it.
    if (lastOvenData) renderCurrentView();
  }
}

function setRange(start, end) {
  startEl.value = toLocalInputValue(start);
  endEl.value = toLocalInputValue(end);
}

// Controls
applyBtn.addEventListener("click", refresh);

todayBtn.addEventListener("click", () => {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  setRange(start, end);
  refresh();
});

downloadCsvBtn?.addEventListener("click", () => {
  const mode = chartViewEl?.value || "timeseries";
  const sizeFilter = shiftSizeFilterEl?.value || "ALL";
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const filename = `oven_${mode}_${sizeFilter}_${stamp}.csv`;
  const csv = buildOvenCsv();
  downloadTextAsFile(filename, csv);
});

last8Btn.addEventListener("click", () => {
  const end = new Date();
  const start = new Date(end.getTime() - 8 * 60 * 60 * 1000);
  setRange(start, end);
  refresh();
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

// View changes (no refetch needed)
chartViewEl.addEventListener("change", () => {
  setChartMode(chartViewEl.value);
  renderCurrentView();
});
shiftSizeFilterEl.addEventListener("change", renderCurrentView);

// Init
(function init() {
  const { start, end } = currentShiftRange(new Date());
  setRange(start, end);

  // default mode
  setChartMode(chartViewEl.value || "timeseries");

  refresh();
})();