// public/cell.js
// Tablet page script for /cell/:id
// - Maintenance = multi-ticket per cell
// - Other departments = one open call per dept per cell
// - Shows active calls at this cell (including maintenance tickets + status)
// - Hold-to-cancel (2s) with “Hold…” then “Keep holding…” verbiage (translated)
// - Maintenance request modal is fully translated (title, cell, help text, labels, placeholder, buttons, errors)
// - Dept names in Notify dropdown translated via dept_* keys
// - Language selector lives in top nav (nav.js) and triggers cherneassist:langChanged

const cellNameEl = document.getElementById("cellName");
const cellStatusEl = document.getElementById("cellStatus");
const deptSelect = document.getElementById("deptSelect");
const activeCallsEl = document.getElementById("activeCalls");
const requestBtn = document.getElementById("requestBtn");
const cancelBtn = document.getElementById("cancelBtn");
const holdHint = document.getElementById("holdHint");

const notifyLabel = document.getElementById("notifyLabel");
const activeCallsTitle = document.getElementById("activeCallsTitle");

// Maintenance modal elements
const maintModal = document.getElementById("maintModal");
const maintTitle = document.getElementById("maintTitle");
const maintCellTag = document.getElementById("maintCellTag");
const maintHelp = document.getElementById("maintHelp");
const maintAssetLabel = document.getElementById("maintAssetLabel");
const maintAsset = document.getElementById("maintAsset");
const maintPriorityLabel = document.getElementById("maintPriorityLabel");
const maintPriority = document.getElementById("maintPriority");
const maintDescLabel = document.getElementById("maintDescLabel");
const maintDesc = document.getElementById("maintDesc");
const maintCancel = document.getElementById("maintCancel");
const maintSubmit = document.getElementById("maintSubmit");
const maintError = document.getElementById("maintError");

// /cell/<id>
const parts = location.pathname.split("/").filter(Boolean);
const cellId = parts[1];

let config = { departments: [], cells: [] };
let currentSnap = null;

// socket join cell room
const socket = io({
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  query: { cellId }
});

/* =========================================================================
   Helpers
   ========================================================================= */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll("`", "&#96;");
}

function t(key, vars) {
  try {
    if (typeof I18N !== "undefined" && I18N?.t) return I18N.t(key, vars);
  } catch {}
  // fallback
  if (!vars) return key;
  let s = key;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{{${k}}}`, String(v));
  }
  return s;
}

function deptLabel(deptId, fallbackName = "") {
  const key = `dept_${String(deptId).replaceAll("-", "_")}`; // mfg-eng -> dept_mfg_eng
  const translated = t(key);
  if (translated === key) return fallbackName || deptId;
  return translated;
}

function deptName(deptId) {
  // Use translated label when available
  const fallback = config.departments.find(d => d.id === deptId)?.name || deptId;
  return deptLabel(deptId, fallback);
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

function showMaintError(msg) {
  if (!maintError) return;
  maintError.style.display = msg ? "block" : "none";
  maintError.textContent = msg || "";
}

function selectedDept() {
  return deptSelect.value || "quality";
}

function normalizeMaintTickets(snap) {
  const tix = snap?.active?.maintenance?.tickets;
  return Array.isArray(tix) ? tix : [];
}

/* =========================================================================
   Translate static UI
   ========================================================================= */
function applyStaticTranslations() {
  // Tablet UI
  if (notifyLabel) notifyLabel.textContent = t("tablet_notify");
  if (activeCallsTitle) activeCallsTitle.textContent = t("tablet_active_calls");
  if (requestBtn) requestBtn.textContent = t("tablet_request");
  if (cancelBtn) cancelBtn.textContent = t("tablet_hold_cancel");

  // Maintenance modal UI
  if (maintTitle) maintTitle.textContent = t("maint_submit_title");
  if (maintHelp) maintHelp.textContent = t("maint_asset_help");
  if (maintAssetLabel) maintAssetLabel.textContent = t("maint_asset");
  if (maintPriorityLabel) maintPriorityLabel.textContent = t("maint_priority");
  if (maintDescLabel) maintDescLabel.textContent = t("maint_description");
  if (maintDesc) maintDesc.placeholder = t("maint_description_ph");
  if (maintCancel) maintCancel.textContent = t("cancel");
  if (maintSubmit) maintSubmit.textContent = t("submit");

  // Translate priority option labels but keep values stable (Low/Medium/High)
  if (maintPriority) {
    const map = {
      "Low": t("maint_low"),
      "Medium": t("maint_medium"),
      "High": t("maint_high")
    };
    [...maintPriority.options].forEach(opt => {
      if (map[opt.value]) opt.textContent = map[opt.value];
    });
  }
}

/* =========================================================================
   Config + snapshots
   ========================================================================= */
async function loadConfig() {
  const r = await fetch("/api/config", { cache: "no-store" });
  config = await r.json();

  // Translate department names in Notify dropdown
  deptSelect.innerHTML = (config.departments || [])
    .map(d => {
      const name = deptLabel(d.id, d.name);
      return `<option value="${escapeAttr(d.id)}">${escapeHtml(name)}</option>`;
    })
    .join("");

  const key = `dept_default_${cellId}`;
  const saved = localStorage.getItem(key);

  if (saved && config.departments.some(d => d.id === saved)) deptSelect.value = saved;
  else deptSelect.value = "quality";

  deptSelect.addEventListener("change", () => {
    localStorage.setItem(key, deptSelect.value);
    if (currentSnap) render(currentSnap);
  });
}

async function refreshSnapshot() {
  const r = await fetch(`/api/cell/${encodeURIComponent(cellId)}/snapshot`, { cache: "no-store" });
  const snap = await r.json();
  render(snap);
}

/* =========================================================================
   Hold-to-cancel helper with “Hold…” then “Keep holding…”
   ========================================================================= */
function attachHoldToCancel(buttonEl, payloadBuilder) {
  if (!buttonEl) return;

  let cancelTimer = null;
  let hintTimer = null;

  const clear = () => {
    if (cancelTimer) clearTimeout(cancelTimer);
    if (hintTimer) clearTimeout(hintTimer);
    cancelTimer = null;
    hintTimer = null;
    if (holdHint) holdHint.style.display = "none";
  };

  buttonEl.addEventListener("pointerdown", () => {
    if (!holdHint) return;

    holdHint.style.display = "block";
    holdHint.textContent = t("tablet_hold_hint");

    hintTimer = setTimeout(() => {
      if (!holdHint) return;
      holdHint.style.display = "block";
      holdHint.textContent = t("tablet_keep_holding");
    }, 750);

    cancelTimer = setTimeout(async () => {
      try {
        const payload = payloadBuilder();
        await fetch("/api/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } finally {
        if (holdHint) holdHint.style.display = "none";
      }
    }, 2000);
  });

  buttonEl.addEventListener("pointerup", clear);
  buttonEl.addEventListener("pointerleave", clear);
  buttonEl.addEventListener("pointercancel", clear);
}

/* =========================================================================
   Active calls list (includes maintenance status)
   ========================================================================= */
function buildOpenCallsList(snap) {
  const now = snap.now;
  const items = [];

  // Non-maint single calls (one per dept per cell)
  for (const d of config.departments || []) {
    if (d.id === "maintenance") continue;
    const slot = snap.active?.[d.id];
    if (slot?.status === "WAITING" && slot.requestedAt) {
      items.push({
        kind: "single",
        dept: d.id,
        deptName: deptLabel(d.id, d.name),
        requestedAt: slot.requestedAt,
        callId: slot.callId || null,
        machine: "—",
        note: "—",
        status: ""
      });
    }
  }

  // Maintenance tickets
  const tickets = normalizeMaintTickets(snap);
  for (const tix of tickets) {
    items.push({
      kind: "ticket",
      dept: "maintenance",
      deptName: deptLabel("maintenance", "Maintenance"),
      requestedAt: tix.createdAt,
      ticketId: tix.ticketId,
      machine: tix.assetLabel || "—",
      note: tix.issue || "—",
      status: tix.progressStatus || "",
      priority: tix.priority || "Medium",
      fiix: tix.fiix || null
    });
  }

  // Oldest first
  items.sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));

  if (!items.length) {
    activeCallsEl.innerHTML = `<div style="color:#666;font-weight:800;">${escapeHtml(t("none"))}</div>`;
    return;
  }

  activeCallsEl.innerHTML = items.map((it, idx) => {
    const wait = fmtElapsed(now - it.requestedAt);

    const payload = it.kind === "ticket"
      ? { dept: "maintenance", cellId, ticketId: it.ticketId, cancelledBy: "operator", reason: "Cancelled from tablet" }
      : { dept: it.dept, cellId, callId: it.callId || null };

    const statusText = (it.kind === "ticket" && String(it.status || "").trim())
      ? t("open_calls_status_prefix", { status: String(it.status).trim() })
      : "";

    const btnId = `rowCancel_${idx}`;

    return `
      <div class="open-call-line">
        <div class="ocl-left">
          <span class="ocl-dept">${escapeHtml(it.deptName)}</span>
          <span class="ocl-sep"> | </span>
          <span class="ocl-wait">${escapeHtml(wait)}</span>
          <span class="ocl-sep"> | </span>
          <span class="ocl-machine" title="${escapeAttr(it.machine)}">${escapeHtml(it.machine)}</span>
          <span class="ocl-sep"> | </span>
          <span class="ocl-note" title="${escapeAttr(it.note)}">${escapeHtml(it.note)}</span>
          ${
            statusText
              ? `<span class="ocl-sep"> | </span>
                 <span class="ocl-status" title="${escapeAttr(statusText)}">${escapeHtml(statusText)}</span>`
              : ""
          }
        </div>

        <button
          id="${btnId}"
          class="btn secondary ocl-cancel"
          type="button"
          data-payload="${escapeAttr(JSON.stringify(payload))}">
          ${escapeHtml(t("open_calls_cancel"))}
        </button>
      </div>
    `;
  }).join("");

  // Attach hold-to-cancel to each row button
  items.forEach((_, idx) => {
    const btn = document.getElementById(`rowCancel_${idx}`);
    if (!btn) return;
    attachHoldToCancel(btn, () => {
      const raw = btn.getAttribute("data-payload") || "{}";
      try { return JSON.parse(raw); } catch { return {}; }
    });
  });
}

/* =========================================================================
   Render main status + buttons
   ========================================================================= */
function render(snap) {
  currentSnap = snap;

  const cellName = snap.cell?.name || cellId;
  cellNameEl.textContent = cellName.toUpperCase();

  buildOpenCallsList(snap);

  const dept = selectedDept();

  // Maintenance: allow multiple
  if (dept === "maintenance") {
    const openCount = normalizeMaintTickets(snap).length;
    cellStatusEl.textContent = openCount
      ? `${t("tablet_status")} ${t("status_ready_maintenance_count", { count: openCount })}`
      : `${t("tablet_status")} ${t("status_ready_maintenance")}`;

    requestBtn.style.display = "block";
    cancelBtn.style.display = "none";
    if (holdHint) holdHint.style.display = "none";
    requestBtn.disabled = false;
    return;
  }

  const slot = snap.active?.[dept] || { status: "READY", requestedAt: null, callId: null };

  if (slot.status === "WAITING") {
    const elapsed = slot.requestedAt ? fmtElapsed(snap.now - slot.requestedAt) : "00:00";
    cellStatusEl.textContent = `${t("tablet_status")} ${t("status_waiting_for", { dept: deptName(dept), time: elapsed })}`;
    requestBtn.style.display = "none";
    cancelBtn.style.display = "block";
  } else {
    cellStatusEl.textContent = `${t("tablet_status")} ${t("status_ready_for", { dept: deptName(dept) })}`;
    requestBtn.style.display = "block";
    cancelBtn.style.display = "none";
    if (holdHint) holdHint.style.display = "none";
    requestBtn.disabled = false;
  }
}

/* =========================================================================
   Maintenance modal helpers
   ========================================================================= */
function normalizeAssetsForDropdown(rawAssets) {
  const out = [];
  for (const a of (rawAssets || [])) {
    if (!a) continue;
    if (a.value !== undefined && a.label !== undefined) {
      out.push({ value: String(a.value), label: String(a.label) });
      continue;
    }
    if (a.id !== undefined && a.name !== undefined) {
      out.push({ value: String(a.id), label: String(a.name) });
    }
  }
  return out;
}

function openMaintModal(cellName) {
  if (maintCellTag) maintCellTag.textContent = t("maint_cell", { cell: cellName });

  if (maintPriority) maintPriority.value = "Medium";
  if (maintDesc) maintDesc.value = "";
  showMaintError("");

  fetch(`/api/maintenance/assets?cellId=${encodeURIComponent(cellId)}`, { cache: "no-store" })
    .then(r => r.json())
    .then(data => {
      const generalLabel = t("maint_general_no_asset");

      if (!data.ok) {
        showMaintError(data.error || t("maint_load_assets_fail"));
        maintAsset.innerHTML = `<option value="">${escapeHtml(generalLabel)}</option>`;
        return;
      }

      const assets = normalizeAssetsForDropdown(data.assets);
      const opts = [
        `<option value="">${escapeHtml(generalLabel)}</option>`,
        ...assets.map(a => `<option value="${escapeAttr(a.value)}">${escapeHtml(a.label)}</option>`)
      ];
      maintAsset.innerHTML = opts.join("");
    })
    .catch(() => {
      showMaintError(t("maint_load_assets_fail"));
      maintAsset.innerHTML = `<option value="">${escapeHtml(t("maint_general_no_asset"))}</option>`;
    });

  maintModal.classList.add("show");
  setTimeout(() => maintDesc?.focus(), 50);
}

function closeMaintModal() {
  maintModal?.classList.remove("show");
  showMaintError("");
}

/* =========================================================================
   Actions
   ========================================================================= */
requestBtn.addEventListener("click", async () => {
  const dept = selectedDept();

  if (dept === "maintenance") {
    const cellName = currentSnap?.cell?.name || cellId;
    openMaintModal(cellName);
    return;
  }

  requestBtn.disabled = true;
  await fetch("/api/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dept, cellId })
  });
  requestBtn.disabled = false;
});

// Big cancel button (selected dept) hold 2s
attachHoldToCancel(cancelBtn, () => ({
  dept: selectedDept(),
  cellId
}));

// Submit maintenance request
maintSubmit?.addEventListener("click", async () => {
  const description = (maintDesc?.value || "").trim();
  const priority = maintPriority?.value || "Medium";
  const assetValue = maintAsset?.value || "";

  if (!description) {
    showMaintError(t("maint_desc_required"));
    return;
  }

  maintSubmit.disabled = true;
  showMaintError("");

  try {
    const resp = await fetch("/api/maintenance/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cellId, assetValue, priority, description })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      showMaintError(data.error || t("maint_submit_fail"));
      return;
    }

    closeMaintModal();
  } catch {
    showMaintError(t("maint_submit_fail"));
  } finally {
    maintSubmit.disabled = false;
  }
});

maintCancel?.addEventListener("click", closeMaintModal);
maintModal?.addEventListener("click", (e) => { if (e.target === maintModal) closeMaintModal(); });

/* =========================================================================
   Socket updates + timer refresh
   ========================================================================= */
socket.on("cellSnapshot", (snap) => render(snap));
socket.on("connect", () => refreshSnapshot());

setInterval(() => {
  if (!currentSnap) return;
  render({ ...currentSnap, now: Date.now() });
}, 1000);

/* =========================================================================
   Language change event (from nav)
   ========================================================================= */
window.addEventListener("cherneassist:langChanged", async () => {
  applyStaticTranslations();
  await loadConfig(); // rebuild dept dropdown labels
  if (currentSnap) render(currentSnap);
});

/* =========================================================================
   Init
   ========================================================================= */
(async function init() {
  // Load language first (defaults to English, remembers selection)
  if (typeof I18N !== "undefined" && I18N?.load) {
    await I18N.load(I18N.getLang());
  }

  await loadConfig();
  applyStaticTranslations();
  await refreshSnapshot();
})();