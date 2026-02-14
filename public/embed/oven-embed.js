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

  // ---------- URL params ----------
  const params = new URLSearchParams(location.search);
  const chartMode = (params.get("chart") || "timeseries").toLowerCase();
  const rangeName = (params.get("range") || "lasthour").toLowerCase();
  const sizeFilter = (params.get("size") || "ALL").toUpperCase();
  const titleOverride = params.get("title");
  const theme = (params.get("theme") || "auto").toLowerCase();

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

  function computeRangeFromParam() {
    if (rangeName === "prevweek") return computePrevWeekWindow();
    if (rangeName === "prevshift") return computePrevShiftWindow();
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
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
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

    const grid = isLight() ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.10)";
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

  // ---------- data / render ----------
  let lastData = null;

  function setHeading(rangeObj) {
    const rangeText = `${fmtLocal(rangeObj.start)} → ${fmtLocal(rangeObj.end)}`;
    const modeTitle = (chartMode === "curetimeseries") ? "Cure Time" : "Completions";
    const sizeText = (sizeFilter === "ALL") ? "All Sizes" : `Size ${sizeFilter}`;

    titleEl.textContent = titleOverride || `Oven ${modeTitle} — ${rangeObj.label} — ${sizeText}`;
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

  function render(data, rangeObj) {
    resizeCanvas();
    const ctx = canvas.getContext("2d");

    const buckets = data.buckets || [];
    const padL = 78, padR = 24, padT = 64, padB = 46; // leave room for heading overlay
    if (!buckets.length) {
      // blank
      ctx.fillStyle = isLight() ? "#fff" : "#0f1419";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const line = lineForMode(data);
    const maxY = computeMaxY(line);

    drawAxesAndGrid(ctx, padL, padR, padT, padB, maxY);
    drawShiftBoundaries(ctx, buckets, padL, padR, padT, padB);
    drawLine(ctx, buckets, line, padL, padR, padT, padB, maxY);

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
