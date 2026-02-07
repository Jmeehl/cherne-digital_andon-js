// public/oven.js
// Performance dashboard: counts per hour by MoldSize where Plug_Present_In_Mold = true
// Enhancements:
// - Shades "stopped" periods (hours with total == 0) so downtime is visible on the chart.

const startEl = document.getElementById("start");
const endEl = document.getElementById("end");
const applyBtn = document.getElementById("applyBtn");
const todayBtn = document.getElementById("todayBtn");
const shiftBtn = document.getElementById("shiftBtn");
const last8Btn = document.getElementById("last8Btn");
const liveEl = document.getElementById("live");
const canvas = document.getElementById("chart");
const legendEl = document.getElementById("legend");
const errorEl = document.getElementById("error");
const shiftCardsEl = document.getElementById("shiftCards");

let liveTimer = null;

const COLORS = ["#0066cc", "#cc3300", "#2e7d32", "#6a1b9a", "#ff8f00", "#00838f"];

function pad(n) { return String(n).padStart(2, "0"); }

// Convert Date -> "YYYY-MM-DDTHH:mm" for datetime-local
function toLocalInputValue(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

// Parse datetime-local input -> Date (local time)
function fromLocalInputValue(s) {
  return new Date(s);
}

// ------------------------------------------------------------------
// Shift logic (local time)
// Overlaps assigned to later shift:
// - 13:00–13:29 counts as Shift 2
// - 21:00–21:29 counts as Shift 3
// ------------------------------------------------------------------
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

  // Shift 1: 05:00 -> 13:00 (overlap goes to shift 2)
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

  if (s === 1) {
    return { shift: 1, start: setTime(base, 5, 0), end: setTime(base, 13, 30) };
  }
  if (s === 2) {
    return { shift: 2, start: setTime(base, 13, 0), end: setTime(base, 21, 30) };
  }

  // Shift 3 crosses midnight
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

// ------------------------------------------------------------------
// Data fetch + helpers
// ------------------------------------------------------------------
function showError(msg) {
  errorEl.style.display = msg ? "block" : "none";
  errorEl.textContent = msg || "";
}

async function fetchData(start, end) {
  const url = `/api/oven/plug-performance?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || "Failed to load data");
  return data;
}

function isDark() {
  return document.documentElement.classList.contains("theme-dark");
}

function buildLegend(sizes) {
  legendEl.innerHTML = "";

  // Series legend (sizes)
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

  // Downtime legend
  const dt = document.createElement("div");
  dt.className = "item";
  const sw2 = document.createElement("span");
  sw2.className = "swatch";
  sw2.style.background = isDark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  dt.appendChild(sw2);
  dt.appendChild(document.createTextNode("Shaded = no completions (stopped/idle)"));
  legendEl.appendChild(dt);
}

function renderShiftCards(hours, sizes, series) {
  const totals = { 1: {}, 2: {}, 3: {} };
  for (const sh of [1, 2, 3]) for (const s of sizes) totals[sh][s] = 0;

  hours.forEach((iso, idx) => {
    const d = new Date(iso); // UTC ISO -> local Date for shift calculation
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

// Compute downtime mask: total across all sizes at each hour
function computeDowntimeMask(sizes, series, N) {
  const mask = new Array(N).fill(false);
  for (let i = 0; i < N; i++) {
    let total = 0;
    for (const s of sizes) total += (series[s]?.[i] || 0);
    mask[i] = (total === 0);
  }
  return mask;
}

// Draw shaded regions for contiguous downtime hours
function shadeDowntime(ctx, mask, padL, padT, plotW, plotH, N) {
  if (!N || N < 2) return;

  // Determine x position for each index
  const xFor = (i) => padL + plotW * (i / (N - 1));

  // Shade uses subtle overlay
  ctx.save();
  ctx.fillStyle = isDark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";

  let i = 0;
  while (i < N) {
    if (!mask[i]) { i++; continue; }
    let j = i;
    while (j + 1 < N && mask[j + 1]) j++;

    // Convert i..j to pixel span. Add half-step padding so it looks like full-hour shading.
    const stepPx = plotW / (N - 1);
    const x0 = Math.max(padL, xFor(i) - stepPx / 2);
    const x1 = Math.min(padL + plotW, xFor(j) + stepPx / 2);

    ctx.fillRect(x0, padT, x1 - x0, plotH);
    i = j + 1;
  }

  ctx.restore();
}

function drawChart(hours, sizes, series) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // Layout
  const padL = 60, padR = 20, padT = 18, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const N = hours.length;

  // Compute max
  let maxY = 0;
  for (const s of sizes) {
    for (const v of (series[s] || [])) maxY = Math.max(maxY, v);
  }
  maxY = Math.max(5, Math.ceil(maxY * 1.15));

  // Background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = isDark() ? "#0f1419" : "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Downtime shading BEFORE grid/lines (so lines stay crisp)
  const downtimeMask = computeDowntimeMask(sizes, series, N);
  shadeDowntime(ctx, downtimeMask, padL, padT, plotW, plotH, N);

  // Grid
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.08)" : "#e6e6e6";
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

  // X labels (every Nth)
  const step = Math.max(1, Math.floor(N / 10));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < N; i += step) {
    const x = padL + (plotW * (N === 1 ? 0 : i / (N - 1)));
    const d = new Date(hours[i]);
    const label = `${pad(d.getHours())}:00`;
    ctx.fillText(label, x, padT + plotH + 10);
  }

  // Axes
  ctx.strokeStyle = isDark() ? "rgba(255,255,255,0.35)" : "#333";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // Lines per size
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

// ------------------------------------------------------------------
// Refresh + controls
// ------------------------------------------------------------------
async function refresh() {
  try {
    showError("");
    const start = fromLocalInputValue(startEl.value);
    const end = fromLocalInputValue(endEl.value);

    const data = await fetchData(start, end);

    buildLegend(data.sizes);
    renderShiftCards(data.hours, data.sizes, data.series);
    drawChart(data.hours, data.sizes, data.series);
  } catch (e) {
    showError(e.message);
  }
}

function setRange(start, end) {
  startEl.value = toLocalInputValue(start);
  endEl.value = toLocalInputValue(end);
}

applyBtn.addEventListener("click", refresh);

todayBtn.addEventListener("click", () => {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  setRange(start, end);
  refresh();
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

// Re-draw on theme toggle (so shading/background changes immediately)
window.addEventListener("storage", (e) => {
  if (e.key && e.key.startsWith("flooralerts_theme_")) refresh();
});

// Init default = current shift
(function init() {
  const { start, end } = currentShiftRange(new Date());
  setRange(start, end);
  refresh();
})();