// public/dashboard.js
// Up-to-date changes:
// - Fixed escapeHtml/escapeAttr (previous versions were corrupted)
// - Maintenance tickets styled to match mockup (Cell name, big timer, rows)
// - WO button copies WO number (if present) + opens Fiix base URL only
// - Status editing via popup modal (dropdown from JSON + custom note), Save closes popup
// - Maintenance dashboard no longer fully re-renders every second; timers update only
// - Adds maintenance-grid class so CSS can do 6 columns on maintenance only

const grid = document.getElementById("grid");
const subhead = document.getElementById("subhead");
const clockEl = document.getElementById("clock");
const titleEl = document.getElementById("title");

const backdrop = document.getElementById("completeBackdrop");
const modalCellName = document.getElementById("modalCellName");
const modalFiixWo = document.getElementById("modalFiixWo");
const responderEl = document.getElementById("responderName");
const partNumberEl = document.getElementById("partNumber");
const pnLabel = document.getElementById("pnLabel");
const resultEl = document.getElementById("result");
const noteEl = document.getElementById("note");
const cancelModalBtn = document.getElementById("cancelModal");
const submitBtn = document.getElementById("submitComplete");
const holdProgress = document.getElementById("holdProgress");

const soundToggleBtn = document.getElementById("soundToggle");
const chime = new Audio("/assets/chime.mp3");
chime.volume = 0.75;

// /dashboard/:dept
const parts = location.pathname.split("/").filter(Boolean);
const dept = parts[1] || "quality";

// Apply maintenance-only grid class (so CSS can make it 6 columns)
grid?.classList.toggle("maintenance-grid", dept === "maintenance");

// Dept name mapping
const deptNameMap = {
  "quality": "Quality",
  "mfg-eng": "Manufacturing Engineering",
  "supervisor": "Supervisor / Leads",
  "safety": "Safety",
  "maintenance": "Maintenance"
};

if (titleEl) titleEl.textContent = `${(deptNameMap[dept] || dept).toUpperCase()} DASHBOARD`; // [2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

/* =========================================================================
   Helpers (fixed)
   ========================================================================= */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
} // [2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

function escapeAttr(str) {
  return escapeHtml(str).replaceAll("`", "&#96;");
} // [2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

function fmtClock(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtElapsed(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function priorityRank(p) {
  const x = String(p ?? "Medium").toLowerCase();
  if (x === "high") return 0;
  if (x === "medium") return 1;
  if (x === "low") return 2;
  return 3;
}

/* =========================================================================
   Responders
   ========================================================================= */
let responders = [];

async function loadResponders() {
  if (!responderEl) return;
  try {
    const r = await fetch(`/api/responders?dept=${encodeURIComponent(dept)}`, { cache: "no-store" });
    const data = await r.json();
    responders = Array.isArray(data?.responders) ? data.responders : [];
  } catch {
    responders = [];
  }

  responderEl.innerHTML =
    `<option value="">Select…</option>` +
    responders.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join("");

  const key = `last_responder_${dept}`;
  const saved = localStorage.getItem(key);
  if (saved && responders.includes(saved)) responderEl.value = saved;
} // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

/* =========================================================================
   Sound cadence
   ========================================================================= */
let soundEnabled = false;
let cadenceTimer = null;
const CHIME_INTERVAL_MS = 150000;

function setSoundButton() {
  if (!soundToggleBtn) return;
  soundToggleBtn.textContent = soundEnabled ? "Sound: ON" : "Enable Sound";
}

async function playChime() {
  if (!soundEnabled) return;
  try {
    chime.currentTime = 0;
    await chime.play();
  } catch {
    soundEnabled = false;
    setSoundButton();
  }
}

function startCadence() {
  if (cadenceTimer) return;
  playChime();
  cadenceTimer = setInterval(() => playChime(), CHIME_INTERVAL_MS);
}

function stopCadence() {
  if (cadenceTimer) clearInterval(cadenceTimer);
  cadenceTimer = null;
}

setSoundButton();
soundToggleBtn?.addEventListener("click", async () => {
  soundEnabled = true;
  setSoundButton();
  await playChime();
});

/* =========================================================================
   Maintenance Status Options (from JSON file)
   ========================================================================= */
let statusOptions = null;

async function loadStatusOptions() {
  if (statusOptions) return statusOptions;
  try {
    const r = await fetch("/maintenance_status_options.json", { cache: "no-store" });
    const data = await r.json();
    const opts = Array.isArray(data?.options) ? data.options : [];
    statusOptions = opts.map(s => String(s).trim()).filter(Boolean);
  } catch {
    statusOptions = [];
  }
  return statusOptions;
} // JSON served by express.static(public). [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)

/* =========================================================================
   Status Popup Modal (dropdown + custom note)
   ========================================================================= */
let statusModal = null;
let statusModalCtx = null; // { cellId, ticketId, cellName, currentStatus }
let statusModalOpen = false;

function ensureStatusModal() {
  if (statusModal) return;

  const wrap = document.createElement("div");
  wrap.id = "statusBackdrop";
  wrap.className = "modal-backdrop"; // uses existing modal backdrop styling [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)
  wrap.innerHTML = `
    <div class="modal status-modal" role="dialog" aria-modal="true">
      <h2 style="margin:0 0 8px 0;">Update Status</h2>
      <div class="cell-tag" id="statusModalCell">Cell: —</div>

      <label for="statusSelect">Status option</label>
      <select id="statusSelect">
        <option value="">Select…</option>
      </select>
      <div class="chart-subtitle" style="margin-top:6px;">
        Choose an option, and optionally add a note below.
      </div>

      <label for="statusNote">Custom note (optional)</label>
      <textarea id="statusNote" placeholder="Type a custom status note…"></textarea>

      <div id="statusErr" style="display:none;" class="maint-error"></div>

      <div class="row">
        <button class="btn secondary" id="statusCancelBtn" type="button">Cancel</button>
        <button class="btn" id="statusSaveBtn" type="button">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const cancelBtn = wrap.querySelector("#statusCancelBtn");
  const saveBtn = wrap.querySelector("#statusSaveBtn");

  cancelBtn?.addEventListener("click", closeStatusModal);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeStatusModal(); });

  saveBtn?.addEventListener("click", async () => {
    const sel = wrap.querySelector("#statusSelect");
    const note = wrap.querySelector("#statusNote");
    const err = wrap.querySelector("#statusErr");

    if (!statusModalCtx) return;

    const selected = String(sel?.value || "").trim();
    const noteTxt = String(note?.value || "").trim();

    // Compose final status
    let finalStatus = "";
    if (selected && noteTxt) finalStatus = `${selected} — ${noteTxt}`;
    else if (selected) finalStatus = selected;
    else finalStatus = noteTxt;

    finalStatus = finalStatus.trim().slice(0, 160);

    if (!finalStatus) {
      if (err) {
        err.style.display = "block";
        err.textContent = "Please select a status option or enter a note.";
      }
      return;
    }

    if (err) { err.style.display = "none"; err.textContent = ""; }

    // Save to server
    try {
      saveBtn.disabled = true;
      await fetch("/api/maintenance/ticket/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cellId: statusModalCtx.cellId,
          ticketId: statusModalCtx.ticketId,
          progressStatus: finalStatus
        })
      }); // Server persists progressStatus and emits updates. [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)

      // Optimistically update current DOM + local snapshot so it feels instant
      const key = `${statusModalCtx.cellId}::${statusModalCtx.ticketId}`;
      const statusEl = document.querySelector(`[data-status-key="${CSS.escape(key)}"]`);
      if (statusEl) statusEl.textContent = finalStatus;

      // Also patch lastSnapshot in-memory (so timer ticks / UI doesn't regress)
      if (lastSnapshot?.tickets && Array.isArray(lastSnapshot.tickets)) {
        const t = lastSnapshot.tickets.find(x => x.cellId === statusModalCtx.cellId && x.ticketId === statusModalCtx.ticketId);
        if (t) t.progressStatus = finalStatus;
      }

      closeStatusModal();
    } catch (e) {
      if (err) {
        err.style.display = "block";
        err.textContent = "Failed to save status. Please try again.";
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  statusModal = wrap;
}

async function openStatusModal(ctx) {
  ensureStatusModal();
  statusModalCtx = ctx;
  statusModalOpen = true;

  const cellLine = statusModal.querySelector("#statusModalCell");
  const sel = statusModal.querySelector("#statusSelect");
  const note = statusModal.querySelector("#statusNote");
  const err = statusModal.querySelector("#statusErr");

  if (err) { err.style.display = "none"; err.textContent = ""; }
  if (cellLine) cellLine.textContent = `Cell: ${ctx.cellName || ctx.cellId || "—"}`;

  // Populate dropdown from JSON file
  const opts = await loadStatusOptions();
  sel.innerHTML =
    `<option value="">Select…</option>` +
    opts.map(o => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join("");

  // Pre-fill: try matching an option; otherwise put current status into note
  const cur = String(ctx.currentStatus || "").trim();
  note.value = "";
  if (cur) {
    const match = opts.find(o => o.toLowerCase() === cur.toLowerCase());
    if (match) sel.value = match;
    else note.value = cur;
  }

  statusModal.classList.add("show");
  setTimeout(() => note.focus(), 50);
}

function closeStatusModal() {
  statusModalOpen = false;
  statusModalCtx = null;
  statusModal?.classList.remove("show");
}

/* =========================================================================
   Snapshots + Rendering
   ========================================================================= */
let lastSnapshot = null;
let modalContext = null;

const socket = io({
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  query: { dept }
}); // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

function renderMaintenance(snapshot) {
  const now = snapshot?.now ?? Date.now();
  const tickets = Array.isArray(snapshot?.tickets) ? snapshot.tickets : [];

  if (tickets.length) startCadence(); else stopCadence();

  if (subhead) {
    const oldest = tickets.length ? Math.min(...tickets.map(t => now - (t.createdAt ?? now))) : 0;
    subhead.innerHTML = tickets.length
      ? `<span class="alert">Active Tickets: ${tickets.length} Oldest: ${escapeHtml(fmtElapsed(oldest))}</span>`
      : `Active Tickets: 0`;
  }

  // Sort: priority, then age, then cell
  const sorted = [...tickets].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const age = (a.createdAt ?? 0) - (b.createdAt ?? 0);
    if (age !== 0) return age;
    return String(a.cellName ?? "").localeCompare(String(b.cellName ?? ""));
  });

  grid.innerHTML = "";

  for (const t of sorted) {
    const ageTxt = fmtElapsed(now - (t.createdAt ?? now));
    const pri = String(t.priority ?? "Medium").toUpperCase();
    const priClass = String(t.priority ?? "medium").toLowerCase();
    const asset = t.assetLabel ?? "";
    const issue = t.issue ?? "";
    const statusTxt = String(t.progressStatus ?? "").trim();
    const woNum = t.fiix?.workOrderNumber ?? "";

    const key = `${t.cellId}::${t.ticketId}`;

    const card = document.createElement("div");
    card.className = `ticket pri-${priClass}`;

    // Fiix URL always base for now
    const fiixBaseUrl = "https://oateyscs.macmms.com/"; // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

    card.innerHTML = `
      <div class="mnt-ticket" data-created-at="${escapeAttr(String(t.createdAt ?? ""))}">
        <div class="mnt-title">${escapeHtml(t.cellName ?? t.cellId ?? "CELL")}</div>
        <div class="mnt-timer">${escapeHtml(ageTxt)}</div>

        <div class="mnt-rows">
          <div class="mnt-row">
            <div class="mnt-key">Priority:</div>
            <div class="mnt-val mnt-pri ${escapeAttr(priClass)}">${escapeHtml(pri)}</div>
          </div>

          <div class="mnt-row">
            <div class="mnt-key">Machine:</div>
            <div class="mnt-val">${escapeHtml(asset || "—")}</div>
          </div>

          <div class="mnt-row">
            <div class="mnt-key">WO:</div>
            <button class="mnt-wo fiix-open-btn" type="button"
              data-wo="${escapeAttr(woNum)}"
              data-url="${escapeAttr(fiixBaseUrl)}"
              title="Copy WO + open Fiix"
            >${escapeHtml(woNum || "Open Fiix")}</button>
          </div>

          <div class="mnt-row mnt-row-top">
            <div class="mnt-key">Issue:</div>
            <div class="mnt-val mnt-issue">${escapeHtml(issue || "—")}</div>
          </div>

          <div class="mnt-row mnt-row-top">
            <div class="mnt-key">Status:</div>
            <div class="mnt-val mnt-status">
              <button class="mnt-status-btn" type="button" title="Update status">
                <span class="mnt-status-text" data-status-key="${escapeAttr(key)}">${escapeHtml(statusTxt || "Set status…")}</span>
              </button>
            </div>
          </div>
        </div>

        <button class="mnt-complete btn complete ticket-complete" type="button">COMPLETE</button>
      </div>
    `;

    // WO: copy + open base URL
    const fiixBtn = card.querySelector(".fiix-open-btn");
    fiixBtn?.addEventListener("click", async () => {
      const url = fiixBtn.getAttribute("data-url") || "https://oateyscs.macmms.com/";
      const woCode = fiixBtn.getAttribute("data-wo") || "";
      if (woCode) {
        try { await navigator.clipboard.writeText(woCode); } catch {}
      }
      window.open(url, "_blank", "noopener");
    });

    // Status: open modal
    const statusBtn = card.querySelector(".mnt-status-btn");
    statusBtn?.addEventListener("click", () => {
      openStatusModal({
        cellId: t.cellId,
        ticketId: t.ticketId,
        cellName: t.cellName,
        currentStatus: statusTxt
      });
    });

    // Complete -> existing complete modal
    const completeBtn = card.querySelector(".ticket-complete");
    completeBtn.onclick = () => openCompleteModal({
      kind: "ticket",
      cellId: t.cellId,
      cellName: t.cellName,
      ticketId: t.ticketId,
      fiixWo: woNum
    }); // Completion closes Fiix server-side when workOrderId exists. [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

    grid.appendChild(card);
  }
}

function renderNonMaintenance(snapshot) {
  const now = snapshot?.now ?? Date.now();
  const cells = Array.isArray(snapshot?.cells) ? snapshot.cells : [];

  const waiting = [];
  const ready = [];

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    c.__baseIndex = i;
    if (c.status === "WAITING") waiting.push(c);
    else ready.push(c);
  }

  waiting.sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0));
  ready.sort((a, b) => a.__baseIndex - b.__baseIndex);

  const ordered = waiting.concat(ready);

  if (ordered.some(c => c.status === "WAITING")) startCadence();
  else stopCadence();

  if (subhead) {
    const w = ordered.filter(c => c.status === "WAITING" && c.requestedAt);
    const oldest = w.length ? Math.min(...w.map(c => now - c.requestedAt)) : 0;
    subhead.innerHTML = w.length
      ? `<span class="alert">Active Requests: ${w.length} Oldest: ${escapeHtml(fmtElapsed(oldest))}</span>`
      : `Active Requests: 0`;
  }

  grid.innerHTML = "";

  for (const c of ordered) {
    const tile = document.createElement("div");
    tile.className = `tile ${c.status === "WAITING" ? "waiting" : "ready"}`;

    const elapsed = c.status === "WAITING" && c.requestedAt ? fmtElapsed(now - c.requestedAt) : "00:00";

    tile.innerHTML = `
      <div class="name">${escapeHtml(c.name ?? c.id ?? "CELL")}</div>
      <div class="status">${escapeHtml(c.status ?? "READY")}</div>
      <div class="timer">${escapeHtml(elapsed)}</div>
    `;

    if (c.status === "WAITING") {
      const btn = document.createElement("button");
      btn.className = "btn complete";
      btn.textContent = "COMPLETE";
      btn.onclick = () => openCompleteModal({ kind: "cell", cellId: c.id, cellName: c.name });
      tile.appendChild(btn);
    }

    grid.appendChild(tile);
  }
}

function render(snapshot) {
  lastSnapshot = snapshot;

  if (dept === "maintenance") {
    renderMaintenance(snapshot);
    return;
  }
  renderNonMaintenance(snapshot);
} // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

/* =========================================================================
   Maintenance timer-only updates (NO full re-render each second)
   This avoids UI disruptions and keeps things stable.
   ========================================================================= */
function updateMaintenanceTimers() {
  if (dept !== "maintenance") return;
  if (!lastSnapshot) return;

  const now = Date.now();

  // Update each ticket timer without rebuilding DOM
  document.querySelectorAll(".mnt-ticket[data-created-at]").forEach((wrap) => {
    const createdAt = Number(wrap.getAttribute("data-created-at"));
    const timerEl = wrap.querySelector(".mnt-timer");
    if (!createdAt || !timerEl) return;
    timerEl.textContent = fmtElapsed(now - createdAt);
  });

  // Update subhead (oldest) without full render
  const tickets = Array.isArray(lastSnapshot?.tickets) ? lastSnapshot.tickets : [];
  if (subhead) {
    const oldest = tickets.length ? Math.min(...tickets.map(t => now - (t.createdAt ?? now))) : 0;
    subhead.innerHTML = tickets.length
      ? `<span class="alert">Active Tickets: ${tickets.length} Oldest: ${escapeHtml(fmtElapsed(oldest))}</span>`
      : `Active Tickets: 0`;
  }
}

/* =========================================================================
   Completion modal (existing)
   ========================================================================= */
function openCompleteModal(ctx) {
  modalContext = ctx;
  if (modalCellName) modalCellName.textContent = `Cell: ${ctx.cellName ?? ctx.cellId ?? "—"}`;
  if (resultEl) resultEl.value = "";
  if (noteEl) noteEl.value = "";
  if (partNumberEl) partNumberEl.value = "";

  if (modalFiixWo) {
    if (dept === "maintenance" && ctx.kind === "ticket" && ctx.fiixWo) {
      modalFiixWo.style.display = "";
      modalFiixWo.textContent = `Fiix WO: ${ctx.fiixWo}`;
    } else {
      modalFiixWo.style.display = "none";
      modalFiixWo.textContent = "Fiix WO: —";
    }
  } // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

  if (dept === "quality") {
    pnLabel.style.display = "";
    partNumberEl.style.display = "";
    pnLabel.textContent = "Part Number (required)";
  } else {
    pnLabel.style.display = "none";
    partNumberEl.style.display = "none";
  } // Dept IDs and Quality requirement enforced server-side too. [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

  loadResponders();
  if (holdProgress) holdProgress.style.width = "0%";
  backdrop?.classList.add("show");
}

function closeModal() {
  modalContext = null;
  if (holdProgress) holdProgress.style.width = "0%";
  backdrop?.classList.remove("show");
  stopHoldSubmit();
}

/* =========================================================================
   Hold-to-submit (1s)
   ========================================================================= */
let holdTimer = null;
let holdStartAt = null;

function startHoldSubmit() {
  if (!modalContext) return;

  const responderName = (responderEl?.value || "").trim();
  const partNumber = (partNumberEl?.value || "").trim();
  const result = (resultEl?.value || "").trim();

  if (!responderName) return alert("Responder name is required.");
  if (!result) return alert("Result is required.");
  if (dept === "quality" && !partNumber) return alert("Part Number is required for Quality.");

  localStorage.setItem(`last_responder_${dept}`, responderName);

  holdStartAt = performance.now();
  if (holdProgress) holdProgress.style.width = "0%";

  const tick = () => {
    if (!holdStartAt) return;
    const elapsed = performance.now() - holdStartAt;
    const pct = Math.min(100, (elapsed / 1000) * 100);
    if (holdProgress) holdProgress.style.width = pct + "%";
    if (pct >= 100) {
      doSubmitComplete();
      stopHoldSubmit();
      return;
    }
    holdTimer = requestAnimationFrame(tick);
  };

  holdTimer = requestAnimationFrame(tick);
}

function stopHoldSubmit() {
  if (holdTimer) cancelAnimationFrame(holdTimer);
  holdTimer = null;
  holdStartAt = null;
  if (holdProgress) holdProgress.style.width = "0%";
}

async function doSubmitComplete() {
  if (!modalContext) return;

  const payload = {
    dept,
    cellId: modalContext.cellId,
    responderName: (responderEl?.value || "").trim(),
    partNumber: (partNumberEl?.value || "").trim(),
    result: (resultEl?.value || "").trim(),
    note: (noteEl?.value || "").trim()
  };

  if (dept === "maintenance" && modalContext.kind === "ticket") {
    payload.ticketId = modalContext.ticketId;
  } // Server completes correct ticket + closes Fiix WO if present. [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

  await fetch("/api/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }); // [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

  closeModal();
}

submitBtn?.addEventListener("pointerdown", startHoldSubmit);
submitBtn?.addEventListener("pointerup", stopHoldSubmit);
submitBtn?.addEventListener("pointerleave", stopHoldSubmit);
submitBtn?.addEventListener("pointercancel", stopHoldSubmit);
cancelModalBtn?.addEventListener("click", closeModal);
backdrop?.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

/* =========================================================================
   Socket events + initial fetch
   ========================================================================= */
socket.on("deptSnapshot", (snap) => render(snap));
socket.on("connect", async () => {
  await loadResponders();
  // Preload status options (non-blocking)
  if (dept === "maintenance") loadStatusOptions();
  const r = await fetch(`/api/snapshot?dept=${encodeURIComponent(dept)}`, { cache: "no-store" });
  render(await r.json());
}); // Dept snapshots and initial fetch are part of existing architecture. [1](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/nav.js)[2](https://oateyscs-my.sharepoint.com/personal/jmeehl_oatey_com/Documents/Microsoft%20Copilot%20Chat%20Files/store.js)

/* =========================================================================
   Clock refresh + timer updates
   ========================================================================= */
setInterval(() => {
  if (clockEl) clockEl.textContent = fmtClock();
  if (!lastSnapshot) return;

  if (dept === "maintenance") {
    updateMaintenanceTimers(); // no DOM rebuild
    return;
  }

  // Non-maint: re-render to keep timers current
  render({ ...lastSnapshot, now: Date.now() });
}, 1000);

// Init
loadResponders();