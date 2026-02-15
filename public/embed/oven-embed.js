/* public/embed/oven-embed.js
   Chart-only TV embed for Oven performance

   URL params:
   - chart=timeseries|cureTimeseries   (default timeseries)
   - range=lastHour|prevShift|prevWeek (default lastHour)
   - size=ALL|1|2|3|4                  (default ALL)
   - title=...                         (optional override)
   - theme=dark|light|auto             (default auto)
   - refreshSec=...                    (optional override)
*/

(function () {
  const canvas = document.getElementById("tvCanvas");
  const titleEl = document.getElementById("tvTitle");
  const metaEl = document.getElementById("tvMeta");
  const errEl = document.getElementById("tvError");
  const shiftCardsEl = document.getElementById("shiftCards");
  const kpiCardsEl = document.getElementById("kpiCards");


  // ---------- URL params ----------
  const params = new URLSearchParams(location.search);
  const chartMode = (params.get("chart") || "timeseries").toLowerCase();
  const rangeName = (params.get("range") || "lasthour").toLowerCase();
  const sizeFilter = (params.get("size") || "ALL").toUpperCase();
  const titleOverride = params.get("title");
  const theme = (params.get("theme") || "light").toLowerCase();


  const deptParam = (params.get("dept") || "").toLowerCase();
function deptLabel() {
  if (!deptParam) return "";
  if (deptParam === "quality") return "QUALITY";
  if (deptParam === "maintenance") return "MAINTENANCE";
  return deptParam.toUpperCase();
}


  // ---------- theme ----------
  function applyTheme() {
    const root = document.documentElement;
    root.classList.remove("theme-light");
    if (theme === "light") root.classList.add("theme-light");
    else if (theme === "auto") {
      const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
      if (prefersLight) root.classList.add("theme-light");
    }
  }
  applyTheme();
  if (theme === "auto" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    if (mq.addEventListener) mq.addEventListener("change", applyTheme);
    else if (mq.addListener) mq.addListener(applyTheme);
  }

  function isLight() {
    return document.documentElement.classList.contains("theme-light");
  }

  // ---- Match main oven page styling ----
const BUCKET_MINUTES_DEFAULT = 5;

// Shade only if downtime run is at least this many buckets (matches your main behavior)
const SHADE_AFTER_EMPTY_BUCKETS = 3;

function fmtDowntimeMinutes(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return "0m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Build a "stopped" mask based on completions across ALL sizes (same idea as main page)
function computeStoppedMaskFromCompletions(data) {
  const buckets = data.buckets || [];
  const N = buckets.length;
  const sizes = data.sizes || [];
  const series = data.series || {};
  const mask = new Array(N).fill(false);

  for (let i = 0; i < N; i++) {
    let total = 0;
    for (const s of sizes) total += (series[s]?.[i] || 0);
    mask[i] = (total === 0);
  }
  return mask;
}

// Shade runs of stopped buckets, return run info so we can label them
function shadeStoppedRuns(ctx, mask, padL, padT, plotW, plotH, N) {
  const runs = [];
  if (N < 2) return runs;

  const stepPx = plotW / (N - 1);
  const xFor = (i) => padL + plotW * (i / (N - 1));

  ctx.save();
  ctx.fillStyle = isLight() ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.10)";

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
      runs.push({ i, j, runLen, x0, x1 });
    }
    i = j + 1;
  }

  ctx.restore();
  return runs;
}

function labelStoppedRuns(ctx, runs, padT, plotH, bucketMinutes) {
  ctx.save();
  ctx.fillStyle = isLight() ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.75)";
  ctx.font = `${Math.round(12 * (canvas.width / 1920))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Put labels higher (similar to what you asked on main chart)
  const y = padT + plotH * 0.22;

  for (const r of runs) {
    const width = r.x1 - r.x0;
    if (width < 60) continue; // avoid clutter in tiny runs

    const minutes = r.runLen * bucketMinutes;
    const label = fmtDowntimeMinutes(minutes);
    const x = (r.x0 + r.x1) / 2;
    ctx.fillText(label, x, y);
  }

  ctx.restore();
}


  // ---------- utils ----------
  function pad(n) { return String(n).padStart(2, "0"); }

  function startOfDayLocal(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  // Always returns the previous week’s Sunday (not “this” week)
  function previousSundayLocal(now) {
    const base = startOfDayLocal(now);
    const dow = base.getDay(); // 0..6
    base.setDate(base.getDate() - dow);  // this week's Sunday
    base.setDate(base.getDate() - 7);    // previous week's Sunday
    return base;
  }

  function fmtLocal(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toLocalInputValue(d) {
    // your server parseRange accepts "YYYY-MM-DDTHH:MM"
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Range: prevWeek = Sunday 20:00 -> Saturday 14:00 (previous week)
  function computePrevWeekWindow(now = new Date()) {
    const sun = previousSundayLocal(now);
    const start = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate(), 20, 0, 0, 0);
    const end = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + 6, 14, 0, 0, 0);
    return { start, end, label: "Prev Week" };
  }

  // Range: prevShift using 05:00 / 13:00 / 21:00 boundaries
  function computePrevShiftWindow(now = new Date()) {
    const shifts = [5, 13, 21];
    const today0 = startOfDayLocal(now);

    let curStart = null;
    for (const h of shifts) {
      const c = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate(), h, 0, 0, 0);
      if (c <= now) curStart = c;
    }
    if (!curStart) {
      const y = new Date(today0); y.setDate(y.getDate() - 1);
      curStart = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 21, 0, 0, 0);
    }

    let prevStart;
    if (curStart.getHours() === 5) {
      const y = new Date(today0); y.setDate(y.getDate() - 1);
      prevStart = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 21, 0, 0, 0);
    } else if (curStart.getHours() === 13) {
      prevStart = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate(), 5, 0, 0, 0);
    } else {
      prevStart = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate(), 13, 0, 0, 0);
    }

    return { start: prevStart, end: curStart, label: "Prev Shift" };
  }

  function computeLastHourWindow(now = new Date()) {
    const end = now;
    const start = new Date(now.getTime() - 60 * 60 * 1000);
    return { start, end, label: "Last Hour" };
  }

  function computePrevDayWindow(now = new Date()) {
    const today = startOfDayLocal(now);
    const start = new Date(today);
    start.setDate(start.getDate() - 1); // yesterday 00:00
    const end = new Date(today);        // today 00:00
    return { start, end, label: "Previous Day" };
  }

  function computeThisShiftWindow(now = new Date()) {
    const shifts = [5, 13, 21];
    const today0 = startOfDayLocal(now);

    let curStart = null;
    for (const h of shifts) {
      const c = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate(), h, 0, 0, 0);
      if (c <= now) curStart = c;
    }

    if (!curStart) {
      const y = new Date(today0);
      y.setDate(y.getDate() - 1);
      curStart = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 21, 0, 0, 0);
    }

    const nextShift = new Date(curStart);
    nextShift.setHours(curStart.getHours() + 8);

    return { start: curStart, end: nextShift, label: "Current Shift" };
  }


  function computeRangeFromParam() {
    if (rangeName === "prevweek") return computePrevWeekWindow();
    if (rangeName === "prevshift") return computePrevShiftWindow();
    if (rangeName === "prevday") return computePrevDayWindow();
    if (rangeName === "thisshift") return computeThisShiftWindow();
    return computeLastHourWindow();
  }

  function defaultRefreshSec() {
    // fast for rolling windows, slower for big windows
    if (rangeName === "lasthour") return 30;
    if (rangeName === "prevshift") return 120;
    if (rangeName === "prevweek") return 600;
    return 60;
  }

  const refreshSec = Math.max(5, Number(params.get("refreshSec") || defaultRefreshSec()) || defaultRefreshSec());

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = "block";
  }
  function clearError() {
    errEl.textContent = "";
    errEl.style.display = "none";
  }

  // ---------- canvas sizing (sharp on TVs) ----------
  function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect(); // respects the padded frame
  const w = Math.floor(rect.width * dpr);
  const h = Math.floor(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

  window.addEventListener("resize", () => { resizeCanvas(); renderLast(); });
  resizeCanvas();

  // ---------- drawing ----------
  function drawAxesAndGrid(ctx, padL, padR, padT, padB, maxY) {
    const W = canvas.width, H = canvas.height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // bg
    ctx.fillStyle = isLight() ? "#ffffff" : "#0f1419";
    ctx.fillRect(0, 0, W, H);

    const grid = isLight() ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.10)";
    const axis = isLight() ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.25)";
    const text = isLight() ? "rgba(0,0,0,0.70)" : "rgba(255,255,255,0.70)";

    // horizontal grid + y labels
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;

    ctx.fillStyle = text;
    ctx.font = `${Math.round(12 * (canvas.width / 1920))}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const y = padT + plotH * (i / steps);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      const v = Math.round(maxY * (1 - i / steps));
      ctx.fillText(String(v), padL - 8, y);
    }

    // axes
    ctx.strokeStyle = axis;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
  }

  function shiftBoundaryLabel(d) {
    const h = d.getHours();
    const m = d.getMinutes();
    if (m !== 0) return null;
    if (h === 5) return "S1";
    if (h === 13) return "S2";
    if (h === 21) return "S3";
    return null;
  }

  function drawShiftBoundaries(ctx, buckets, padL, padR, padT, padB) {
    const W = canvas.width, H = canvas.height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const N = buckets.length;
    if (N < 2) return;

    ctx.save();
    ctx.strokeStyle = isLight() ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;

    ctx.fillStyle = isLight() ? "rgba(0,0,0,0.50)" : "rgba(255,255,255,0.55)";
    ctx.font = `${Math.round(12 * (canvas.width / 1920))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const xFor = (i) => padL + plotW * (i / (N - 1));

    for (let i = 0; i < N; i++) {
      const lab = shiftBoundaryLabel(new Date(buckets[i]));
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

  function lineForMode(data) {
    const sizes = data.sizes || [];
    const N = (data.buckets || []).length;

    if (chartMode === "curetimeseries") {
      const cure = data.cure;
      if (!cure || !cure.series) return new Array(N).fill(null);
      if (sizeFilter === "ALL") {
        // average across sizes for each bucket
        const out = new Array(N).fill(null);
        for (let i = 0; i < N; i++) {
          const vals = (cure.sizes || []).map(s => cure.series[s]?.[i]).filter(v => v !== null && v !== undefined);
          out[i] = vals.length ? (vals.reduce((a,b)=>a+b,0) / vals.length) : null;
        }
        return out;
      }
      return (cure.series[sizeFilter] || new Array(N).fill(null)).map(v => (v === undefined ? null : v));
    }

    // timeseries (completions)
    const series = data.series || {};
    if (sizeFilter === "ALL") {
      const out = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        let total = 0;
        for (const s of sizes) total += (series[s]?.[i] || 0);
        out[i] = total;
      }
      return out;
    }
    return (series[sizeFilter] || new Array(N).fill(0)).map(v => Number(v || 0));
  }

    function computeShiftTotals(data) {
    const buckets = data.buckets || [];
    const sizes = data.sizes || [];
    const series = data.series || {};

    const totals = { 1: {}, 2: {}, 3: {} };
    for (const sh of [1, 2, 3]) {
      for (const s of sizes) totals[sh][s] = 0;
    }

    buckets.forEach((t, idx) => {
      const d = new Date(t);
      const sh = whichShift(d);
      for (const s of sizes) {
        totals[sh][s] += (series[s]?.[idx] || 0);
      }
    });

    return totals;
  }


  function computeMaxY(line) {
    let maxY = 0;
    for (const v of line) {
      if (v === null || v === undefined) continue;
      maxY = Math.max(maxY, Number(v) || 0);
    }
    if (chartMode === "curetimeseries") {
      // cure minutes scale
      return Math.max(60, Math.ceil(maxY * 1.15));
    }
    return Math.max(5, Math.ceil(maxY * 1.15));
  }

  function drawLine(ctx, buckets, line, padL, padR, padT, padB, maxY) {
    const W = canvas.width, H = canvas.height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const N = buckets.length;
    if (N < 2) return;

    const stroke = isLight() ? "rgba(0,0,0,0.80)" : "rgba(255,255,255,0.85)";
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const xFor = (i) => padL + plotW * (i / (N - 1));
    const yFor = (v) => padT + plotH - (plotH * (v / maxY));

    ctx.beginPath();
    let started = false;
    for (let i = 0; i < N; i++) {
      const v = line[i];
      if (v === null || v === undefined) continue;
      const x = xFor(i);
      const y = yFor(Number(v) || 0);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
    ctx.restore();

    // optional goalposts for cure
    if (chartMode === "curetimeseries") {
      const low = 45, high = 120;
      ctx.save();
      ctx.strokeStyle = isLight() ? "rgba(0,120,0,0.35)" : "rgba(120,255,120,0.25)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);

      const yLow = padT + plotH - (plotH * (low / maxY));
      const yHigh = padT + plotH - (plotH * (high / maxY));
      ctx.beginPath(); ctx.moveTo(padL, yLow); ctx.lineTo(padL + plotW, yLow); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, yHigh); ctx.lineTo(padL + plotW, yHigh); ctx.stroke();

      ctx.setLineDash([]);
      ctx.fillStyle = isLight() ? "rgba(0,100,0,0.70)" : "rgba(170,255,170,0.60)";
      ctx.font = `${Math.round(12 * (canvas.width / 1920))}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("Low 45m", padL + 6, yLow - 4);
      ctx.textBaseline = "top";
      ctx.fillText("High 120m", padL + 6, yHigh + 4);
      ctx.restore();
    }
  }

  function renderShiftTotalsChart(data, rangeObj) {
  resizeCanvas();
  const ctx = canvas.getContext("2d");

  const padL = 120, padR = 40, padT = 330, padB = 80;
  const W = canvas.width;
  const H = canvas.height;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const totals = computeShiftTotals(data);
  const sizes = data.sizes || [];
  const shifts = [1, 2, 3];

  ctx.fillStyle = isLight() ? "#ffffff" : "#0f1419";
  ctx.fillRect(0, 0, W, H);

  const maxVal = Math.max(
    5,
    ...shifts.flatMap(sh => sizes.map(s => totals[sh][s] || 0))
  );

  const groupWidth = plotW / shifts.length;
  const barWidth = groupWidth / (sizes.length + 1);

  shifts.forEach((sh, si) => {
    const groupX = padL + si * groupWidth;

    sizes.forEach((s, bi) => {
      const val = totals[sh][s] || 0;
      const h = plotH * (val / maxVal);
      const x = groupX + bi * barWidth + 10;
      const y = padT + plotH - h;

      ctx.fillStyle = isLight() ? "#1565c0" : "#4dabf7";
      ctx.fillRect(x, y, barWidth * 0.8, h);

      ctx.fillStyle = isLight() ? "#000" : "#fff";
      ctx.font = `${Math.round(14 * (canvas.width / 1920))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(String(val), x + barWidth * 0.4, y - 6);
    });

    ctx.fillStyle = isLight() ? "#000" : "#fff";
    ctx.font = `${Math.round(16 * (canvas.width / 1920))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(
      `${sh} ${sh === 1 ? "st" : sh === 2 ? "nd" : "rd"} Shift`,
      groupX + groupWidth / 2,
      padT + plotH + 30
    );
  });
}


  const EMPTY_MOLD_SECONDS = 15;

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

// Similar to main oven.js “System Status” logic :contentReference[oaicite:7]{index=7}
function computeSystemStatusFromData(data) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const sizes = Array.isArray(data?.sizes) ? data.sizes : [];
  const series = data?.series || {};
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

// Mirrors the card content from public/oven.js :contentReference[oaicite:8]{index=8}:contentReference[oaicite:9]{index=9}
function renderKpis(kpis, data) {
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

  const sys = computeSystemStatusFromData(data);
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


  // ---------- data / render ----------
  let lastData = null;

  function setHeading(rangeObj) {
    const rangeText = `${fmtLocal(rangeObj.start)} → ${fmtLocal(rangeObj.end)}`;
    const modeTitle = (chartMode === "curetimeseries") ? "Cure Time" : "Completions";
    const sizeText = (sizeFilter === "ALL") ? "All Sizes" : `Size ${sizeFilter}`;

    const dept = deptLabel();
    const prefix = dept ? `${dept} — ` : "";

    titleEl.textContent =
    titleOverride ||
    `${prefix}Oven ${modeTitle} — ${rangeObj.label} — ${sizeText}`;

    metaEl.textContent = rangeText;
  }

  async function fetchData(rangeObj) {
    const url =
      `/api/oven/plug-performance?startLocal=${encodeURIComponent(toLocalInputValue(rangeObj.start))}` +
      `&endLocal=${encodeURIComponent(toLocalInputValue(rangeObj.end))}`;

    const resp = await fetch(url, { cache: "no-store" });
    const data = await resp.json();
    if (!data || !data.ok) throw new Error(data?.error || "API error");
    return data;
  }

    // ---- Shift logic (local) - matches public/oven.js ---- :contentReference[oaicite:5]{index=5}
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

  // Same as renderShiftCards() from public/oven.js :contentReference[oaicite:6]{index=6}
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


  function render(data, rangeObj) {
    resizeCanvas();
    const ctx = canvas.getContext("2d");

    const buckets = data.buckets || [];
    const padL = 78, padR = 24, padT = 330, padB = 46; // leave room for heading overlay
    if (!buckets.length) {
      // blank
      ctx.fillStyle = isLight() ? "#fff" : "#0f1419";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    renderShiftCards(buckets, data.sizes || [], data.series || {});

    if (chartMode === "shifttotals") {
      renderShiftTotalsChart(data, rangeObj);
      renderKpis(data.kpis, data);
      setHeading(rangeObj);
      return;
    }

    const line = lineForMode(data);

    const maxY = computeMaxY(line);

    drawAxesAndGrid(ctx, padL, padR, padT, padB, maxY);

    // ✅ Downtime shading (use completions mask even if cure chart is selected)
    const stoppedMask = computeStoppedMaskFromCompletions(data);
    const W = canvas.width, H = canvas.height;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const N = buckets.length;

    const runs = shadeStoppedRuns(ctx, stoppedMask, padL, padT, plotW, plotH, N);

    // Shift boundaries on top of shading (nice visual)
    drawShiftBoundaries(ctx, buckets, padL, padR, padT, padB);

    // Main line on top
    drawLine(ctx, buckets, line, padL, padR, padT, padB, maxY);

    // Optional: label downtime runs (matches your main page feature)
    const bucketMinutes = Number(data.bucketMinutes || BUCKET_MINUTES_DEFAULT);
    labelStoppedRuns(ctx, runs, padT, plotH, bucketMinutes);
    renderKpis(data.kpis, data);

    setHeading(rangeObj);
  }

  function renderLast() {
    if (!lastData) return;
    const rangeObj = computeRangeFromParam();
    render(lastData, rangeObj);
  }

  async function refreshLoop() {
    try {
      clearError();
      const rangeObj = computeRangeFromParam();
      const data = await fetchData(rangeObj);
      lastData = data;
      render(data, rangeObj);
    } catch (e) {
      showError(e?.message || String(e));
    } finally {
      setTimeout(refreshLoop, refreshSec * 1000);
    }
  }

  // start
  refreshLoop();
})();
