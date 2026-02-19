// server.js
// Andon + Fiix maintenance + Mold tracking + Oven performance (real-time)

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

import {
  fetchLatestMolds,
  fetchPlugPerformanceByHour,
  fetchOvenCureKpis,
  fetchOvenFillStats,
  fetchOvenRealtime
} from "./molds_sql.js";

import {
  CELLS,
  DEPARTMENTS,
  loadState,
  saveState,
  appendLog,
  readLogs,
  clearLogsByDept,
  loadResponders,
  addResponder,
  removeResponder
} from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));

const state = loadState();
const DEBUG_FIIX = (process.env.DEBUG_FIIX ?? "0") === "1";

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
function isValidDept(dept) {
  return DEPARTMENTS.some((d) => d.id === dept);
}
function isValidCell(cellId) {
  return CELLS.some((c) => c.id === cellId);
}
function nowMs() { return Date.now(); }
function makeId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function ensureStateShape() {
  if (!state.active) state.active = {};
  for (const d of DEPARTMENTS) {
    if (!state.active[d.id]) state.active[d.id] = {};
    for (const c of CELLS) {
      if (d.id === "maintenance") {
        const cur = state.active[d.id][c.id];
        if (!cur) {
          state.active[d.id][c.id] = { tickets: [] };
          continue;
        }
        // migrate legacy single-slot maintenance -> tickets list
        if (cur && !Array.isArray(cur.tickets)) {
          const migrated = { tickets: [] };
          if (cur.status === "WAITING" && cur.requestedAt) {
            migrated.tickets.push({
              ticketId: makeId("mnt"),
              status: "OPEN",
              createdAt: cur.requestedAt,
              priority: cur.fiix?.requestPriority ?? "Medium",
              issue: cur.fiix?.requestDescription ?? "",
              assetLabel: cur.fiix?.requestAsset ?? "",
              progressStatus: "",
              fiix: cur.fiix ?? null
            });
          }
          state.active[d.id][c.id] = migrated;
        } else if (!cur.tickets) {
          state.active[d.id][c.id] = { tickets: [] };
        }
      } else {
        const cur = state.active[d.id][c.id];
        if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
          state.active[d.id][c.id] = { status: "READY", requestedAt: null, callId: null, fiix: null };
          continue;
        }
        if (!("status" in cur)) cur.status = "READY";
        if (!("requestedAt" in cur)) cur.requestedAt = null;
        if (!("callId" in cur)) cur.callId = null;
        if (!("fiix" in cur)) cur.fiix = null;
      }
    }
  }
}

ensureStateShape();
saveState(state);

// ------------------------------------------------------------------
// Webhook notifications (Teams channels etc.)
// Configure via environment variables (WEBHOOK_MFG_ENG, WEBHOOK_MAINTENANCE)
// or at runtime via the debug endpoint which persists into `state.webhooks`.
// ------------------------------------------------------------------
let WEBHOOK_MAP = {
  "mfg-eng": (state.webhooks && state.webhooks["mfg-eng"]) || process.env.WEBHOOK_MFG_ENG || process.env.TEAMS_WEBHOOK_MFG_ENG || null,
  "maintenance": (state.webhooks && state.webhooks["maintenance"]) || process.env.WEBHOOK_MAINTENANCE || null
};

function notifyDeptWebhook(dept, body) {
  try {
    const url = WEBHOOK_MAP[dept];
    if (!url) return Promise.resolve({ ok: false, error: "no_webhook_configured" });
    // Build an Adaptive Card payload for Microsoft Teams (attachments)
    const buildCard = (evt, data) => {
      const status = String(data.status ?? evt ?? "open").toLowerCase();
      const statusColor = status === "cancel" || status === "cancelled" ? "attention"
        : status === "complete" || status === "completed" ? "good"
        : "warning";

      const title = data.title || (data.event || "Event");
      const facts = [];
      if (data.cellName) facts.push({ title: "Cell", value: String(data.cellName) });
      if (data.cellId) facts.push({ title: "Cell ID", value: String(data.cellId) });
      if (data.ticketId) facts.push({ title: "Ticket", value: String(data.ticketId) });
      if (data.callId) facts.push({ title: "Call", value: String(data.callId) });
      if (data.note) facts.push({ title: "Note", value: String(data.note) });
      if (data.fiix?.workOrderNumber) facts.push({ title: "WO", value: String(data.fiix.workOrderNumber) });
      if (data.ts) facts.push({ title: "Time", value: new Date(Number(data.ts)).toLocaleString() });

      const card = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
          { "type": "TextBlock", "text": `${(data.dept || "").toUpperCase()} — ${title}`, "weight": "Bolder", "size": "Medium" },
          { "type": "ColumnSet", "columns": [
            { "type": "Column", "width": "stretch", "items": [ { "type": "FactSet", "facts": facts } ] },
            { "type": "Column", "width": "auto", "items": [ { "type": "TextBlock", "text": String((data.status ?? "OPEN")).toUpperCase(), "weight": "Bolder", "color": statusColor } ] }
          ] }
        ]
      };

      // Add optional actions (link to Fiix)
      if (data.fiix && data.fiix.url) {
        const wo = data.fiix.workOrderNumber ? String(data.fiix.workOrderNumber) : null;
        const href = data.fiix.url + (wo ? `/${wo}` : "");
        card.actions = [ { "type": "Action.OpenUrl", "title": "Open Fiix", "url": href } ];
      }

      return card;
    };

    // POST with Adaptive Card attachment and return promise with result
    return (async () => {
      try {
        const card = buildCard(body.event ?? body.type, body);
        // Some Power Automate webhook endpoints expect the adaptive card JSON
        // as a string field (e.g. 'adaptiveCard' or 'card'). Detect Power
        // Automate endpoints and send the card as a string property to improve
        // compatibility. Otherwise send a Teams-style attachment payload.
        const isPowerAutomate = typeof url === 'string' && url.toLowerCase().includes('powerautomate');
        let payload;
        if (isPowerAutomate || process.env.FORCE_POWERAUTOMATE_MODE === '1') {
          // Send minimal text payload for Power Automate to simplify flow handling
          payload = {
            text: String((body && (body.note || body.event)) ? (body.note || body.event) : ((body && body.dept) ? `${String(body.dept).toUpperCase()} notification` : 'Andon notification'))
          };
        } else {
          payload = {
            type: "message",
            attachments: [ {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card
            } ]
          };
        }

        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const text = await resp.text().catch(() => "");
        if (!resp.ok) {
          console.error(`Webhook POST to ${dept} failed: ${resp.status}`);
          return { ok: false, status: resp.status, text };
        }
        return { ok: true, status: resp.status, text };
      } catch (e) {
        console.error(`Webhook POST to ${dept} error:`, e?.message ?? e);
        return { ok: false, error: e?.message ?? String(e) };
      }
    })();
  } catch (e) {
    console.error("notifyDeptWebhook error:", e?.message ?? e);
    return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
  }
}

// ------------------------------------------------------------------
// snapshots (dept + cell)
// ------------------------------------------------------------------
function deptSnapshot(dept) {
  const now = nowMs();

  if (dept === "maintenance") {
    const tickets = [];
    for (const c of CELLS) {
      const bucket = state.active.maintenance?.[c.id];
      const list = Array.isArray(bucket?.tickets) ? bucket.tickets : [];
      for (const t of list) {
        if (t.status !== "OPEN") continue;
        tickets.push({
          ticketId: t.ticketId,
          cellId: c.id,
          cellName: c.name,
          createdAt: t.createdAt,
          priority: t.priority ?? "Medium",
          issue: t.issue ?? t.fiix?.requestDescription ?? "",
          assetLabel: t.assetLabel ?? t.fiix?.requestAsset ?? "",
          progressStatus: t.progressStatus ?? "",
          fiix: t.fiix ?? null
        });
      }
    }
    return { now, dept, tickets };
  }

  const cells = CELLS.map((c) => {
    const slot = state.active?.[dept]?.[c.id] ?? { status: "READY", requestedAt: null, callId: null, fiix: null };
    return {
      id: c.id,
      name: c.name,
      status: slot.status,
      requestedAt: slot.requestedAt,
      callId: slot.callId ?? null,
      fiix: slot.fiix ?? null
    };
  });

  return { now, dept, cells };
}

function cellSnapshot(cellId) {
  const now = nowMs();
  const cell = CELLS.find((c) => c.id === cellId);
  const active = {};

  for (const d of DEPARTMENTS) {
    if (d.id === "maintenance") {
      const bucket = state.active.maintenance?.[cellId];
      const list = Array.isArray(bucket?.tickets) ? bucket.tickets : [];
      active.maintenance = {
        tickets: list
          .filter((t) => t.status === "OPEN")
          .map((t) => ({
            ticketId: t.ticketId,
            createdAt: t.createdAt,
            priority: t.priority ?? "Medium",
            issue: t.issue ?? t.fiix?.requestDescription ?? "",
            assetLabel: t.assetLabel ?? t.fiix?.requestAsset ?? "",
            progressStatus: t.progressStatus ?? "",
            fiix: t.fiix ?? null
          }))
      };
    } else {
      const slot = state.active?.[d.id]?.[cellId] ?? { status: "READY", requestedAt: null, callId: null, fiix: null };
      active[d.id] = {
        status: slot.status,
        requestedAt: slot.requestedAt,
        callId: slot.callId ?? null,
        fiix: slot.fiix ?? null
      };
    }
  }

  return {
    now,
    cell: cell ? { id: cell.id, name: cell.name } : { id: cellId, name: cellId },
    active
  };
}

function emitDept(dept) {
  io.to(`dept:${dept}`).emit("deptSnapshot", deptSnapshot(dept));
}
function emitCell(cellId) {
  io.to(`cell:${cellId}`).emit("cellSnapshot", cellSnapshot(cellId));
}

// ------------------------------------------------------------------
// Mold config + snapshot refresh (room "molds")
// ------------------------------------------------------------------
const MOLD_CONFIG_FILE = path.resolve(__dirname, "mold_config.json");

function loadMoldConfig() {
  try {
    return JSON.parse(fs.readFileSync(MOLD_CONFIG_FILE, "utf-8"));
  } catch {
    return {
      mode: "global",
      cleanThresholdCycles: 250,
      dueSoonRatio: 0.85,
      perSizeThresholds: { "1": 250, "2": 250, "3": 250, "4": 250 }
    };
  }
}
function saveMoldConfig(cfg) {
  fs.writeFileSync(MOLD_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let moldSnapshot = {
  now: Date.now(),
  updatedAt: Date.now(),
  config: loadMoldConfig(),
  counts: { total: 0, overdue: 0, dueSoon: 0, ok: 0 },
  molds: [],
  worst: null
};


function computeMoldSnapshot(rows, cfg) {
  const threshold = Number(cfg.cleanThresholdCycles ?? 250);
  const dueSoonAt = Math.round(threshold * Number(cfg.dueSoonRatio ?? 0.85));

  const molds = rows
    .map((r) => {
      const moldNumber = Number(r.MoldNumber);
      const moldSize = Number(r.MoldSize);
      const cyclesSince = Number(r.CyclesSinceLastCleaning ?? 0);
      const ttdCycles = Number(r.TTDCycles ?? 0);
      const lastExtractTs = r.Extract_DateTime ? new Date(r.Extract_DateTime).getTime() : null;

      let status = "OK";
      if (cyclesSince >= threshold) status = "OVERDUE";
      else if (cyclesSince >= dueSoonAt) status = "DUE_SOON";

      const overBy = Math.max(0, cyclesSince - threshold);
      return { moldNumber, moldSize, cyclesSince, ttdCycles, lastExtractTs, threshold, overBy, status };
    })
    .filter((m) => Number.isFinite(m.moldNumber) && m.moldNumber > 0)
    .sort((a, b) => {
      const rank = (x) => (x.status === "OVERDUE" ? 2 : x.status === "DUE_SOON" ? 1 : 0);
      const dr = rank(b) - rank(a);
      if (dr !== 0) return dr;
      const ob = (b.overBy ?? 0) - (a.overBy ?? 0);
      if (ob !== 0) return ob;
      return (b.cyclesSince ?? 0) - (a.cyclesSince ?? 0);
    });

  const counts = { total: molds.length, overdue: 0, dueSoon: 0, ok: 0 };
  for (const m of molds) {
    if (m.status === "OVERDUE") counts.overdue++;
    else if (m.status === "DUE_SOON") counts.dueSoon++;
    else counts.ok++;
  }
  const worst = molds.length ? molds[0] : null;
  return { now: Date.now(), updatedAt: Date.now(), config: cfg, counts, molds, worst };
}

let moldRefreshInFlight = false;

async function refreshMoldSnapshot() {
  if (moldRefreshInFlight) return;
  moldRefreshInFlight = true;

  const cfg = loadMoldConfig();
  try {
    const rows = await fetchLatestMolds();
    moldSnapshot = computeMoldSnapshot(rows, cfg);
    io.to("molds").emit("moldsSnapshot", moldSnapshot);
  } catch (e) {
    console.error("Mold snapshot refresh failed:", e?.message ?? e);
  } finally {
    moldRefreshInFlight = false;
  }
}

setInterval(refreshMoldSnapshot, 60000);
refreshMoldSnapshot();

// ------------------------------------------------------------------
// Oven real-time snapshot (room "oven")
// ------------------------------------------------------------------
let ovenSnapshot = {
  now: Date.now(),
  updatedAt: Date.now(),
  rangeMinutes: 240,
  bucketMinutes: 5,
  buckets: [],
  sizes: [],
  series: {},        // size -> counts aligned to buckets
  avgBakeSeries: {}, // size -> avg bake minutes aligned to buckets
  lastCloseAt: null,
  minutesSinceLastClose: null,
  lastBakeMinutes: null
};

function buildOvenSnapshot(rows, meta, start, end) {
  const bucketSet = new Set();
  const sizeSet = new Set();

  const countMap = new Map();   // key = bucketISO|size
  const bakeMap = new Map();    // key = bucketISO|siz3e

  for (const r of rows) {
    const b = new Date(r.BucketTime).toISOString();
    const s = String(r.PlugSize);
    bucketSet.add(b);
    sizeSet.add(s);

    countMap.set(`${b}|${s}`, Number(r.CloseCount) || 0);
    bakeMap.set(`${b}|${s}`, Number(r.AvgBakeMinutes) || 0);
  }

  const buckets = Array.from(bucketSet).sort();
  const sizes = Array.from(sizeSet).sort((a, b) => Number(a) - Number(b));

  const series = {};
  const avgBakeSeries = {};
  for (const s of sizes) {
    series[s] = buckets.map((b) => countMap.get(`${b}|${s}`) ?? 0);
    avgBakeSeries[s] = buckets.map((b) => bakeMap.get(`${b}|${s}`) ?? 0);
  }

  const lastCloseAt = meta?.LastClose ? new Date(meta.LastClose).toISOString() : null;
  const minutesSinceLastClose = lastCloseAt
    ? Math.max(0, Math.round((Date.now() - new Date(lastCloseAt).getTime()) / 60000))
    : null;

  return {
    now: Date.now(),
    updatedAt: Date.now(),
    rangeMinutes: Math.round((end - start) / 60000),
    bucketMinutes: ovenSnapshot.bucketMinutes,
    buckets,
    sizes,
    series,
    avgBakeSeries,
    lastCloseAt,
    minutesSinceLastClose,
    lastBakeMinutes: meta?.LastBakeMinutes ?? null
  };
}

async function refreshOvenSnapshot() {
  try {
    const rangeMinutes = Number(ovenSnapshot.rangeMinutes) || 240;
    const bucketMinutes = Number(ovenSnapshot.bucketMinutes) || 5;

    const end = new Date();
    const start = new Date(end.getTime() - rangeMinutes * 60000);

    const { rows, meta } = await fetchOvenRealtime({ startDate: start, endDate: end, bucketMinutes });
    ovenSnapshot = buildOvenSnapshot(rows, meta, start, end);

    io.to("oven").emit("ovenSnapshot", ovenSnapshot);
  } catch (e) {
    console.error("Oven snapshot refresh failed:", e?.message ?? e);
  }
}

setInterval(refreshOvenSnapshot, 15000);
refreshOvenSnapshot();

// ------------------------------------------------------------------
// sockets
// ------------------------------------------------------------------
io.on("connection", (socket) => {
  const dept = socket.handshake.query?.dept;
  const cellId = socket.handshake.query?.cellId;

  if (dept && isValidDept(dept)) {
    socket.join(`dept:${dept}`);
    socket.emit("deptSnapshot", deptSnapshot(dept));
  }
  if (cellId && isValidCell(cellId)) {
    socket.join(`cell:${cellId}`);
    socket.emit("cellSnapshot", cellSnapshot(cellId));
  }

  // rooms
  if (socket.handshake?.query?.room === "molds") {
    socket.join("molds");
    socket.emit("moldsSnapshot", moldSnapshot);
  }
  if (socket.handshake?.query?.room === "oven") {
    socket.join("oven");
    socket.emit("ovenSnapshot", ovenSnapshot);
  }
});

// ======================================================================
// Fiix Integration (Maintenance)
// ======================================================================
const FIIX_BASE = (process.env.FIIX_BASE ?? "https://oateyscs.macmms.com").replace(/\/2\/?$/, "");
const FIIX_APP_KEY = process.env.FIIX_APP_KEY ?? "";
const FIIX_ACCESS_KEY = process.env.FIIX_ACCESS_KEY ?? "";
const FIIX_SECRET_KEY = process.env.FIIX_SECRET_KEY ?? "";

// Priorities
const FIIX_PRIORITY_ID_HIGH = process.env.FIIX_PRIORITY_ID_HIGH ?? "";
const FIIX_PRIORITY_ID_MEDIUM = process.env.FIIX_PRIORITY_ID_MEDIUM ?? "";
const FIIX_PRIORITY_ID_LOW = process.env.FIIX_PRIORITY_ID_LOW ?? "";

// Statuses
const FIIX_WO_STATUS_ID_REQUESTED = process.env.FIIX_WO_STATUS_ID_REQUESTED ?? "28696";
const FIIX_WO_STATUS_ID_CLOSED_COMPLETE = process.env.FIIX_WO_STATUS_ID_CLOSED_COMPLETE ?? "28702";
const FIIX_WO_STATUS_ID_CANCELLED = process.env.FIIX_WO_STATUS_ID_CANCELLED ?? "";

// WorkOrder fields
const FIIX_WO_CLASS = process.env.FIIX_WO_CLASS ?? "WorkOrder";
const FIIX_FIELD_SUMMARY = process.env.FIIX_FIELD_SUMMARY ?? "strDescription";
const FIIX_FIELD_DETAILS = process.env.FIIX_FIELD_DETAILS ?? "strWorkInstructions";
const FIIX_FIELD_PRIORITY = process.env.FIIX_FIELD_PRIORITY ?? "intPriorityID";
const FIIX_FIELD_STATUS = process.env.FIIX_FIELD_STATUS ?? "intWorkOrderStatusID";
const FIIX_FIELD_SITE = process.env.FIIX_FIELD_SITE ?? "intSiteID";
const FIIX_WO_NUMBER_FIELD = process.env.FIIX_WO_NUMBER_FIELD ?? "strCode";

// Completion fields
const FIIX_FIELD_COMPLETED_BY = "intCompletedByUserID";
const FIIX_FIELD_COMPLETION_NOTES = "strCompletionNotes";
const FIIX_FIELD_DATE_COMPLETED = "dtmDateCompleted";

// WorkOrderAsset
const FIIX_WOASSET_CLASS = "WorkOrderAsset";
const FIIX_WOASSET_FIELD_WOID = "intWorkOrderID";
const FIIX_WOASSET_FIELD_ASSETID = "intAssetID";

// WorkOrderTask assignment
const FIIX_WOTASK_CLASS = "WorkOrderTask";
const FIIX_WOTASK_FIELD_ASSIGNEE = "intAssignedToUserID";

// UI base
const FIIX_UI_BASE = (process.env.FIIX_UI_BASE ?? `${FIIX_BASE}`).replace(/\/$/, "");

function loadJson(fileName, fallback) {
  const p = path.join(__dirname, fileName);
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function loadMaintenanceAssetsRaw() {
  const parsed = loadJson("maintenance_assets.json", {});
  return parsed && typeof parsed === "object" ? parsed : {};
}
function loadMaintenanceSiteMap() {
  const parsed = loadJson("maintenance_site_map.json", {});
  return parsed && typeof parsed === "object" ? parsed : {};
}
function normUserKey(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function loadMaintenanceFiixUsers() {
  const raw = loadJson("maintenance_fiix_users.json", {});
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row?.name || !row?.fiixUserId) continue;
      map.set(normUserKey(row.name), Number(row.fiixUserId));
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, id] of Object.entries(raw)) map.set(normUserKey(name), Number(id));
  }
  return map;
}
function normalizeAssetListForApi(rawList) {
  const out = [];
  for (const a of (rawList ?? [])) {
    if (!a) continue;
    const label = String(a.name ?? "").trim();
    if (!label) continue;

    if (a.id !== undefined && a.id !== null && String(a.id).trim() !== "") {
      const idNum = Number(a.id);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;
      out.push({ value: String(idNum), label, kind: "id" });
      continue;
    }
    if (a.code !== undefined && a.code !== null && String(a.code).trim() !== "") {
      out.push({ value: String(a.code).trim(), label, kind: "code" });
    }
  }
  return out;
}
function mapPriorityToFiixId(priorityLabel) {
  const p = (priorityLabel ?? "Medium").toLowerCase();
  if (p === "high" && FIIX_PRIORITY_ID_HIGH) return Number(FIIX_PRIORITY_ID_HIGH);
  if (p === "low" && FIIX_PRIORITY_ID_LOW) return Number(FIIX_PRIORITY_ID_LOW);
  if (FIIX_PRIORITY_ID_MEDIUM) return Number(FIIX_PRIORITY_ID_MEDIUM);
  return null;
}

// ---- Fiix request helpers ----
function fiixRequestUrl() {
  const ts = Date.now();
  const u = new URL("/api/", FIIX_BASE);
  u.searchParams.set("service", "cmms");
  u.searchParams.set("timestamp", String(ts));
  u.searchParams.set("appKey", FIIX_APP_KEY);
  u.searchParams.set("accessKey", FIIX_ACCESS_KEY);
  u.searchParams.set("signatureMethod", "HmacSHA256");
  u.searchParams.set("signatureVersion", "1");
  return u.toString();
}
function fiixAuthHeader(fullUrl) {
  const trimmed = fullUrl.replace(/^https?:\/\//, "");
  return crypto.createHmac("sha256", Buffer.from(FIIX_SECRET_KEY, "utf8"))
    .update(Buffer.from(trimmed, "utf8"))
    .digest("hex")
    .toLowerCase();
}
async function fiixCall(bodyObj) {
  const url = fiixRequestUrl();
  const auth = fiixAuthHeader(url);

  if (DEBUG_FIIX) {
    const safeUrl = url
      .replace(/appKey=[^&]+/i, "appKey=REDACTED")
      .replace(/accessKey=[^&]+/i, "accessKey=REDACTED");
    console.log("[fiix] url:", safeUrl);
    console.log("[fiix] _maCn:", bodyObj?._maCn, "className:", bodyObj?.className ?? bodyObj?.object?.className);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "Authorization": auth },
    body: JSON.stringify(bodyObj)
  });

  const text = (await resp.text()).trim();
  if (!(text.startsWith("{") || text.startsWith("["))) {
    throw new Error(`Fiix non-JSON response: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  if (data?.error) throw new Error(data.error?.message ?? "Fiix API error");
  return data;
}

async function resolveAssetIdFromCode(assetCode) {
  const req = {
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: "Asset",
    fields: "id,strCode,strName",
    filters: [{ ql: "strCode = ?", parameters: [String(assetCode)] }],
    maxObjects: 5
  };
  const res = await fiixCall(req);
  const obj = Array.isArray(res?.objects) ? res.objects[0] : null;
  return obj?.id ?? null;
}

async function fetchFiixWorkOrderNumber(workOrderId) {
  const req = {
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WO_CLASS,
    fields: `id,${FIIX_WO_NUMBER_FIELD}`,
    filters: [{ ql: "id = ?", parameters: [Number(workOrderId)] }],
    maxObjects: 1
  };
  const res = await fiixCall(req);
  const obj = Array.isArray(res?.objects) ? res.objects[0] : null;
  return obj ? (obj?.[FIIX_WO_NUMBER_FIELD] ?? null) : null;
}

async function addWorkOrderAssetLink(workOrderId, assetId) {
  const req = {
    _maCn: "AddRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WOASSET_CLASS,
    fields: "id",
    object: {
      className: FIIX_WOASSET_CLASS,
      [FIIX_WOASSET_FIELD_WOID]: Number(workOrderId),
      [FIIX_WOASSET_FIELD_ASSETID]: Number(assetId)
    }
  };
  return fiixCall(req);
}

async function findExistingWorkOrderTask(workOrderId) {
  const req = {
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WOTASK_CLASS,
    fields: "id,intWorkOrderID,strDescription,intAssignedToUserID",
    filters: [{ ql: "intWorkOrderID = ?", parameters: [Number(workOrderId)] }],
    maxObjects: 50
  };
  const res = await fiixCall(req);
  const tasks = Array.isArray(res?.objects) ? res.objects : [];
  if (!tasks.length) return null;
  tasks.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return tasks[0];
}

async function assignExistingWorkOrderTask(taskId, assigneeId) {
  const req = {
    _maCn: "ChangeRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WOTASK_CLASS,
    id: Number(taskId),
    changeFields: FIIX_WOTASK_FIELD_ASSIGNEE,
    object: {
      className: FIIX_WOTASK_CLASS,
      id: Number(taskId),
      [FIIX_WOTASK_FIELD_ASSIGNEE]: Number(assigneeId)
    },
    fields: "id"
  };
  return fiixCall(req);
}

async function createAssignedWorkOrderTask(workOrderId, assigneeId, desc) {
  const req = {
    _maCn: "AddRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WOTASK_CLASS,
    fields: "id",
    object: {
      className: FIIX_WOTASK_CLASS,
      intWorkOrderID: Number(workOrderId),
      strDescription: String(desc).slice(0, 250),
      intAssignedToUserID: Number(assigneeId)
    }
  };
  return fiixCall(req);
}

async function closeFiixWorkOrderWithCompletion({ workOrderId, responderName, completionNotes }) {
  if (!workOrderId) return;

  const userMap = loadMaintenanceFiixUsers();
  const completedById = userMap.get(normUserKey(responderName)) ?? null;

  if (completedById && Number.isFinite(completedById)) {
    try {
      const existing = await findExistingWorkOrderTask(workOrderId);
      if (existing?.id) await assignExistingWorkOrderTask(existing.id, completedById);
      else await createAssignedWorkOrderTask(workOrderId, completedById, "API Dispatch Task (assigned on completion)");
    } catch (e) {
      console.error("Fiix task assignment failed:", e.message);
    }
  }

  const completionObj = {
    className: FIIX_WO_CLASS,
    id: Number(workOrderId),
    [FIIX_FIELD_DATE_COMPLETED]: Date.now(),
    [FIIX_FIELD_COMPLETION_NOTES]: String(completionNotes ?? "").slice(0, 4000)
  };

  const fields = [FIIX_FIELD_DATE_COMPLETED, FIIX_FIELD_COMPLETION_NOTES];
  if (completedById && Number.isFinite(completedById)) {
    completionObj[FIIX_FIELD_COMPLETED_BY] = Number(completedById);
    fields.push(FIIX_FIELD_COMPLETED_BY);
  }

  await fiixCall({
    _maCn: "ChangeRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WO_CLASS,
    id: Number(workOrderId),
    changeFields: fields.join(","),
    object: completionObj,
    fields: "id"
  });

  await fiixCall({
    _maCn: "ChangeRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WO_CLASS,
    id: Number(workOrderId),
    changeFields: FIIX_FIELD_STATUS,
    object: {
      className: FIIX_WO_CLASS,
      id: Number(workOrderId),
      [FIIX_FIELD_STATUS]: Number(FIIX_WO_STATUS_ID_CLOSED_COMPLETE)
    },
    fields: "id"
  });
}

async function cancelFiixWorkOrder({ workOrderId, cancelledByName, reason }) {
  if (!workOrderId) return;
  if (!FIIX_WO_STATUS_ID_CANCELLED) throw new Error("FIIX_WO_STATUS_ID_CANCELLED is not set.");

  const note = `Cancelled by ${cancelledByName ?? "operator"}${reason ? `\n${reason}` : ""}`;

  await fiixCall({
    _maCn: "ChangeRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WO_CLASS,
    id: Number(workOrderId),
    changeFields: `${FIIX_FIELD_STATUS},${FIIX_FIELD_COMPLETION_NOTES}`,
    object: {
      className: FIIX_WO_CLASS,
      id: Number(workOrderId),
      [FIIX_FIELD_STATUS]: Number(FIIX_WO_STATUS_ID_CANCELLED),
      [FIIX_FIELD_COMPLETION_NOTES]: note.slice(0, 4000)
    },
    fields: "id"
  });
}

async function createFiixWorkOrderForMaintenance({ cellId, cellName, assetId, assetLabel, priority, description, siteId }) {
  if (!FIIX_APP_KEY || !FIIX_ACCESS_KEY || !FIIX_SECRET_KEY) return null;

  const shortDesc = String(description).trim().replace(/\s+/g, " ").slice(0, 120);
  const summary = `API Request - ${cellName} - ${shortDesc}`;

  const details =
    `Cell: ${cellName} (${cellId})\n` +
    (assetLabel ? `Asset: ${assetLabel}\n` : `Asset: General Maintenance (No Asset)\n`) +
    `Priority: ${priority}\n\n` +
    `Description:\n${description}\n\n` +
    `Submitted: ${new Date().toISOString()}`;

  const addRes = await fiixCall({
    _maCn: "AddRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: FIIX_WO_CLASS,
    fields: "id",
    object: {
      className: FIIX_WO_CLASS,
      [FIIX_FIELD_SUMMARY]: summary,
      [FIIX_FIELD_DETAILS]: details,
      [FIIX_FIELD_STATUS]: Number(FIIX_WO_STATUS_ID_REQUESTED),
      ...(siteId ? { [FIIX_FIELD_SITE]: Number(siteId) } : {})
    }
  });

  const workOrderId = addRes?.object?.id ?? null;
  if (!workOrderId) return null;

  const priId = mapPriorityToFiixId(priority);
  const changeObj = { className: FIIX_WO_CLASS, id: Number(workOrderId) };
  const changeFields = [];

  if (siteId) { changeObj[FIIX_FIELD_SITE] = Number(siteId); changeFields.push(FIIX_FIELD_SITE); }
  if (priId) { changeObj[FIIX_FIELD_PRIORITY] = Number(priId); changeFields.push(FIIX_FIELD_PRIORITY); }

  if (changeFields.length > 0) {
    await fiixCall({
      _maCn: "ChangeRequest",
      clientVersion: { major: 2, minor: 8, patch: 1 },
      className: FIIX_WO_CLASS,
      id: Number(workOrderId),
      changeFields: changeFields.join(","),
      object: changeObj,
      fields: "id"
    });
  }

  if (assetId) await addWorkOrderAssetLink(workOrderId, assetId);

  let workOrderNumber = null;
  try { workOrderNumber = await fetchFiixWorkOrderNumber(workOrderId); } catch { /* ignore */ }

  return {
    workOrderId,
    workOrderNumber,
    url: FIIX_UI_BASE,
    requestDescription: description,
    requestPriority: priority ?? "Medium",
    requestAsset: assetLabel ?? ""
  };
}

// ======================================================================
// State logic: non-maint single-call and maintenance multi-ticket
// ======================================================================
function openSingleCall(dept, cellId) {
  const slot = state.active[dept][cellId];
  if (slot.status === "WAITING") return slot.callId;

  slot.status = "WAITING";
  slot.requestedAt = nowMs();
  slot.callId = makeId(`call_${dept}`);
  slot.fiix = null;

  appendLog({
    type: "call_open",
    dept,
    cellId,
    callId: slot.callId,
    ts: slot.requestedAt
  });

  return slot.callId;
}

function cancelSingleCall(dept, cellId, callId = null) {
  const slot = state.active[dept][cellId];
  if (slot.status !== "WAITING") return false;
  if (callId && slot.callId && callId !== slot.callId) return false;

  // log BEFORE clearing
  appendLog({
    type: "call_cancel",
    dept,
    cellId,
    callId: slot.callId,
    ts: nowMs()
  });

  // Notify webhook of cancel
  notifyDeptWebhook(dept, {
    event: "call.cancel",
    ts: Date.now(),
    dept,
    cellId,
    callId: slot.callId,
    status: "cancelled"
  });

  slot.status = "READY";
  slot.requestedAt = null;
  slot.callId = null;
  slot.fiix = null;
  return true;
}


// Maintenance tickets
function getMaintBucket(cellId) {
  const bucket = state.active.maintenance[cellId];
  if (!bucket || !Array.isArray(bucket.tickets)) state.active.maintenance[cellId] = { tickets: [] };
  return state.active.maintenance[cellId];
}
function addMaintTicket(cellId, payload) {
  const bucket = getMaintBucket(cellId);
  const ticketId = makeId("mnt");
  bucket.tickets.push({
    ticketId,
    status: "OPEN",
    createdAt: nowMs(),
    priority: payload.priority ?? "Medium",
    issue: payload.issue ?? "",
    assetLabel: payload.assetLabel ?? "",
    progressStatus: payload.progressStatus ?? "",
    fiix: payload.fiix ?? null
  });
  return ticketId;
}
function findMaintTicket(cellId, ticketId) {
  const bucket = getMaintBucket(cellId);
  return bucket.tickets.find((t) => t.ticketId === ticketId) ?? null;
}
function findLatestOpenMaintTicket(cellId) {
  const bucket = getMaintBucket(cellId);
  const open = bucket.tickets.filter((t) => t.status === "OPEN");
  open.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return open[0] ?? null;
}
function findOldestOpenMaintTicket(cellId) {
  const bucket = getMaintBucket(cellId);
  const open = bucket.tickets.filter((t) => t.status === "OPEN");
  open.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return open[0] ?? null;
}
function cancelMaintTicket(cellId, ticketId) {
  const t = findMaintTicket(cellId, ticketId);
  if (!t || t.status !== "OPEN") return null;
  t.status = "CANCELLED";
  t.cancelledAt = nowMs();
  return t;
}
function completeMaintTicket(cellId, ticketId, completionMeta) {
  const t = findMaintTicket(cellId, ticketId);
  if (!t || t.status !== "OPEN") return null;
  t.status = "COMPLETED";
  t.completedAt = nowMs();
  t.completedBy = completionMeta.responderName;
  t.result = completionMeta.result;
  t.solutionNote = completionMeta.note;
  return t;
}

// ------------------------------------------------------------
// Oven event bars (maintenance + mfg-eng) for plug-performance
// ------------------------------------------------------------
function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && a1 > b0;
}

function buildOvenEvents(startMs, endMs) {
  const events = [];
  const now = Date.now();

  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const isBigOven = (t) => {
    const assetLabel = norm(t?.assetLabel);
    const reqAsset = norm(t?.fiix?.requestAsset);
    return assetLabel.includes("big oven") || reqAsset.includes("big oven");
  };

  // -----------------------------
  // 1) OPEN maintenance tickets (from in-memory state) — ONLY Baking + Big Oven
  // -----------------------------
  const bakingTickets = state.active?.maintenance?.baking?.tickets || [];
  for (const t of bakingTickets) {
    if (!t) continue;
    if (t.status !== "OPEN") continue;
    if (!isBigOven(t)) continue;

    const s = Number(t.createdAt ?? 0);
    const e = now;

    if (!Number.isFinite(s) || s <= 0) continue;
    if (!overlaps(s, e, startMs, endMs)) continue;

    events.push({
      kind: "maintenance",
      dept: "maintenance",
      deptName: "Maintenance",
      cellId: "baking",
      cellName: "Baking",
      ticketId: t.ticketId ?? "",
      workOrderNumber: t.fiix?.workOrderNumber ?? "",
      issue: t.issue ?? t.fiix?.requestDescription ?? "",
      result: t.result ?? "",
      note: t.solutionNote ?? t.note ?? "",
      responder: t.completedBy ?? "",
      asset: t.assetLabel ?? t.fiix?.requestAsset ?? "",
      startMs: s,
      endMs: e,
      status: "OPEN"
    });
  }

  // -----------------------------
  // 2) COMPLETED/CANCELLED events from logs.jsonl — FILTERED + Mfg-Eng OPEN intervals that end on cancel
  // -----------------------------
  const logs = readLogs(); // whole history; we filter

  // Helper to get a reasonable "start" timestamp from a log line
  const getStart = (l) => Number(l?.startedAt ?? l?.createdAt ?? l?.ts ?? 0);
  const getEndFromLine = (l, s) => {
    const e1 = Number(l?.ts ?? 0);
    if (Number.isFinite(e1) && e1 > 0) return e1;
    const elapsed = Number(l?.elapsedMs ?? 0) || 0;
    const e2 = Number(s + elapsed);
    return Number.isFinite(e2) && e2 > 0 ? e2 : 0;
  };

      // ---- 2A) Build Mfg-Eng Baking call intervals (OPEN -> COMPLETE/CANCEL)
      // Supports BOTH:
      //   - new style: type in ["call_open","call_cancel","call_complete"]
      //   - legacy style: type in ["request","cancel","complete"] (dept==="mfg-eng")
      const callOpenTypes = new Set(["call_open", "open", "request", "requested"]);
      const callCancelTypes = new Set(["call_cancel", "cancel", "canceled", "cancelled"]);
      const callCompleteTypes = new Set(["call_complete", "complete", "completed"]);

      // callId -> { openTs, openLog, endTs, endType, endLog }
      const calls = new Map();

      for (const l of logs) {
        if (!l) continue;
        if (l.dept !== "mfg-eng") continue;
        if (l.cellId !== "baking") continue;

        const callId = String(l.callId ?? "").trim();
        if (!callId) continue;

        const type = String(l.type ?? "").trim().toLowerCase();
        const ts = Number(l.ts ?? 0);

        // We ignore lines that don't have a usable timestamp at all
        if (!Number.isFinite(ts) || ts <= 0) continue;

        let rec = calls.get(callId);
        if (!rec) {
          rec = { openTs: 0, openLog: null, endTs: 0, endType: "", endLog: null };
          calls.set(callId, rec);
        }

        // OPEN
        if (callOpenTypes.has(type)) {
          const s = getStart(l);
          if (Number.isFinite(s) && s > 0) {
            // Keep the earliest open timestamp (in case of dup writes)
            if (!rec.openTs || s < rec.openTs) {
              rec.openTs = s;
              rec.openLog = l;
            }
          }
          continue;
        }

        // CANCEL
        if (callCancelTypes.has(type)) {
          // Keep the earliest end timestamp (in case of dup writes)
          if (!rec.endTs || ts < rec.endTs) {
            rec.endTs = ts;
            rec.endType = "CANCELLED";
            rec.endLog = l;
          }
          continue;
        }

        // COMPLETE
        if (callCompleteTypes.has(type)) {
          if (!rec.endTs || ts < rec.endTs) {
            rec.endTs = ts;
            rec.endType = "COMPLETED";
            rec.endLog = l;
          }
          continue;
        }
      }

  // Emit Mfg-Eng events:
  // - If cancelled: skip entirely (so the banner disappears after cancel)
  // - If completed: show with endTs
  // - If open: show running until now
  for (const [callId, rec] of calls.entries()) {
    const s = Number(rec.openTs || 0);
    if (!Number.isFinite(s) || s <= 0) continue;

    // If cancelled, do not show at all
    if (rec.endType === "CANCELLED") continue;

    const e = Number(rec.endTs || now);
    if (!Number.isFinite(e) || e <= 0) continue;
    if (!overlaps(s, e, startMs, endMs)) continue;

    const openLine = rec.openLog || {};
    const endLine = rec.endLog || {};

    events.push({
      kind: "mfg-eng",
      dept: "mfg-eng",
      deptName: openLine.deptName ?? "Manufacturing Engineering",
      cellId: "baking",
      cellName: openLine.cellName ?? "Baking",
      callId,
      responder: endLine.responderName ?? "",
      issue: openLine.issue ?? "",
      result: endLine.result ?? "",
      note: endLine.note ?? "",
      startMs: s,
      endMs: e,
      status: rec.endType || "OPEN"
    });
  }

  // ---- 2B) Maintenance COMPLETED events from logs.jsonl — ONLY Baking + Big Oven
  // Also supports your current "skip cancel bars" behavior.
  for (const l of logs) {
    if (!l) continue;

    // Normalize start/end times we might use
    const s = getStart(l);
    const e = getEndFromLine(l, s);

    if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) continue;
    if (!overlaps(s, e, startMs, endMs)) continue;

    // Skip cancels globally (as you already do) — we don't want canceled items drawn as bars
    if (String(l.type ?? "").trim().toLowerCase() === "cancel") continue;

    // Maintenance ticket completions — ONLY Baking + Big Oven
    if (l.dept === "maintenance") {
      if (l.cellId !== "baking") continue;
      if (!isBigOven(l)) continue;

      if (String(l.type ?? "").trim().toLowerCase() === "complete") {
        events.push({
          kind: "maintenance",
          dept: "maintenance",
          deptName: l.deptName ?? "Maintenance",
          cellId: "baking",
          cellName: l.cellName ?? "Baking",
          ticketId: l.ticketId ?? "",
          workOrderNumber: l.fiix?.workOrderNumber ?? "",
          issue: l.fiix?.requestDescription ?? l.issue ?? "",
          result: l.result ?? "",
          note: l.note ?? "",
          responder: l.responderName ?? "",
          asset: l.fiix?.requestAsset ?? l.assetLabel ?? "",
          startMs: Number(l.startedAt ?? s),
          endMs: Number(l.ts ?? e),
          status: "COMPLETED"
        });
      }
    }
  }

  // Sort by start time, stable
  events.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  return events;
}


// ======================================================================
// Routes
// ======================================================================
app.get("/api/config", (req, res) => res.json({ departments: DEPARTMENTS, cells: CELLS }));

app.get("/api/snapshot", (req, res) => {
  const dept = req.query.dept;
  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });
  res.json(deptSnapshot(dept));
});

// Helps tablets initial load (cell.js calls this)
app.get("/api/cell/:id/snapshot", (req, res) => {
  const cellId = req.params.id;
  if (!isValidCell(cellId)) return res.status(404).json({ ok: false, error: "Invalid cell" });
  res.json(cellSnapshot(cellId));
});

// Responders
app.get("/api/responders", (req, res) => {
  const dept = req.query.dept;
  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });
  const all = loadResponders();
  res.json({ ok: true, dept, responders: all[dept] ?? [] });
});
app.post("/api/responders", (req, res) => {
  const { dept, name } = req.body ?? {};
  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });
  const out = addResponder(dept, name);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true, dept, responders: out.responders });
});
app.delete("/api/responders", (req, res) => {
  const dept = req.query.dept;
  const name = req.query.name;
  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });
  const out = removeResponder(dept, name);
  if (!out.ok) return res.status(400).json(out);
  res.json({ ok: true, dept, responders: out.responders });
});

// Cell-specific PWA manifest
app.get("/manifest/:cellId.json", (req, res) => {
  const cellId = req.params.cellId;
  if (!isValidCell(cellId)) return res.status(404).json({ ok: false, error: "Invalid cell" });
  const cellName = CELLS.find((c) => c.id === cellId)?.name ?? cellId;
  res.json({
    name: `Cherne Assist - ${cellName}`,
    short_name: "Assist",
    start_url: `/cell/${encodeURIComponent(cellId)}?source=pwa`,
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/assets/cherne-assist-192.png", sizes: "192x192", type: "image/png" },
      { src: "/assets/cherne-assist-512.png", sizes: "512x512", type: "image/png" }
    ]
  });
});

// server.js (add near other /api/* routes)
app.get("/api/events", async (req, res) => {
  try {
    // Expect startLocal / endLocal as "YYYY-MM-DDTHH:MM"
    const startLocal = req.query.startLocal;
    const endLocal = req.query.endLocal;
    const dept = req.query.dept || null; // optional filter

    if (!startLocal || !endLocal) {
      return res.status(400).json({ ok: false, error: "Missing startLocal or endLocal" });
    }

    // parse to Date objects (server local timezone)
    const start = new Date(startLocal);
    const end = new Date(endLocal);

    // TODO: Replace the sample below with a DB query that returns events that overlap
    // the range: (event.start < end) AND (event.end > start)
    // The returned objects should look like:
    // { id: "F-123456", type: "fiix"|"mfg", start: "ISO", end: "ISO", summary: "..." }

    // ---- SAMPLE (for local testing) ----
    const sampleNow = new Date();
    const sample = [
      {
        id: "F-123456",
        type: "fiix",
        start: new Date(sampleNow.getTime() - 1000*60*140).toISOString(),
        end: new Date(sampleNow.getTime() - 1000*60*110).toISOString(),
        summary: "Replace heater"
      },
      {
        id: null,
        type: "mfg",
        start: new Date(sampleNow.getTime() - 1000*60*95).toISOString(),
        end: new Date(sampleNow.getTime() - 1000*60*90).toISOString(),
        summary: "Mfg eng call"
      }
    ];
    // filter sample to overlap requested range
    const events = sample.filter(ev => {
      const s = new Date(ev.start).getTime();
      const e = new Date(ev.end || ev.start).getTime();
      return s < end.getTime() && e > start.getTime();
    });

    return res.json({ ok: true, events });
  } catch (err) {
    console.error("GET /api/events error:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Build oven “event bars” from the log stream by pairing request -> complete/cancel.
  // We only care about Maintenance and Mfg Eng right now.
function buildOvenEventBars(rangeStartDate, rangeEndDate) {
  const startMs = rangeStartDate.getTime();
  const endMs = rangeEndDate.getTime();

  // Pull more than the window so request/end can be paired even if one falls near edges
  const logs = readLogs(20000);

  const callCancelTypes = new Set(["call_cancel", "cancel", "canceled", "cancelled"]);

  const relevant = logs.filter((l) => {
    const ts = Number(l?.ts);
    if (!Number.isFinite(ts)) return false;

    // small buffer around the time window
    if (ts < startMs - 7 * 24 * 60 * 60 * 1000) return false;
    if (ts > endMs + 7 * 24 * 60 * 60 * 1000) return false;

    // Only Maintenance + Mfg Eng
    if (l.dept !== "maintenance" && l.dept !== "mfg-eng") return false;

    // Only lifecycle events
    return (l.type === "request" || l.type === "complete" || callCancelTypes.has(l.type));
  });

  // Pair by ID
  const reqById = new Map(); // id -> request log
  const endById = new Map(); // id -> earliest end log

  for (const l of relevant) {
    const dept = l.dept;
    const id = (dept === "maintenance") ? l.ticketId : l.callId;
    if (!id) continue;

    if (l.type === "request") {
      const cur = reqById.get(id);
      if (!cur || Number(l.ts) < Number(cur.ts)) reqById.set(id, l);
    } else {
      const cur = endById.get(id);
      if (!cur || Number(l.ts) < Number(cur.ts)) endById.set(id, l);
    }
  }

  const bars = [];
  for (const [id, req] of reqById.entries()) {
    const dept = req.dept;
    const reqTs = Number(req.ts);
    const end = endById.get(id);
    const endTs = end ? Number(end.ts) : null;

    if (!Number.isFinite(reqTs)) continue;
    const rawStart = reqTs;
    const rawEnd = Number.isFinite(endTs) ? endTs : null;

    // Clip to requested range
    const clipStart = Math.max(startMs, rawStart);
    const clipEnd = rawEnd === null ? Math.min(endMs, Date.now()) : Math.min(endMs, rawEnd);
    if (clipEnd <= clipStart) continue;

    const label = (dept === "maintenance") ? "Maint" : "Mfg End";

    // If you have a Fiix ticket/workorder number, put it in detail (shown if bar is wide enough)
    let detail = "";
    if (dept === "maintenance") {
      const woNum = req.fiix?.workOrderNumber ?? end?.fiix?.workOrderNumber ?? null;
      const woId = req.fiix?.workOrderId ?? end?.fiix?.workOrderId ?? null;
      if (woNum) detail = String(woNum);
      else if (woId) detail = `#${woId}`;
    }

    if (callCancelTypes.has(end?.type)) continue;

    bars.push({
      id,
      dept,                         // "maintenance" or "mfg-eng"
      startMs: clipStart,
      endMs: clipEnd,

      // Display
      label,
      detail,                       // work order # if available

      // Tooltip fields
      status: end?.type ?? "open",  // "complete" | "cancel" | "open"
      issue: req?.note ?? req?.issue ?? req?.desc ?? "",

      // Who responded (best-effort: depends on what you log on completion)
      responder:
        end?.responderName ??
        end?.responder ??
        end?.by ??
        end?.name ??
        "",
      result:
        end?.result ??
        end?.resolution ??
        end?.notes ??
        end?.comment ??
        end?.message ??
        "",
      // Optional extra fields if you have them
      priority: req?.priority ?? req?.fiix?.priority ?? "",
      cellId: req?.cellId ?? end?.cellId ?? "",
      cellName: req?.cellName ?? end?.cellName ?? "",
    });

  }

  bars.sort((a, b) => (a.startMs - b.startMs) || ((b.endMs - b.startMs) - (a.endMs - a.startMs)));
  return bars;
}



// --------------------
// Oven APIs
// --------------------
function parseRange(req) {
  const startLocal = String(req.query.startLocal ?? "").trim();
  const endLocal   = String(req.query.endLocal ?? "").trim();

  // Treat empty strings as missing, fall back to start/end if needed
  const startRaw = startLocal || String(req.query.start ?? "").trim();
  const endRaw   = endLocal   || String(req.query.end ?? "").trim();

  const start = startRaw ? new Date(startRaw) : null;
  const end   = endRaw ? new Date(endRaw) : null;

  if (!start || Number.isNaN(start.getTime())) throw new Error("Invalid start");
  if (!end || Number.isNaN(end.getTime())) throw new Error("Invalid end");
  if (end <= start) throw new Error("end must be after start");

  // Guardrail (31 days)
  const maxMs = 31 * 24 * 60 * 60 * 1000;
  if (end - start > maxMs) throw new Error("Range too large (max 31 days)");

  return { start, end };
}

// Hourly chart (date range)
// 5-minute bucket chart with continuous timeline + zero-filled gaps.
// Adds KPIs: efficiency + time loss from empty molds + cure time KPIs.
// Also returns cure time series (AvgBakeMinutes) aligned to the same bucket timeline.

// Adaptive bucket sizing based on range duration
function computeAdaptiveBucketMinutes(rangeMs) {
  const hours = rangeMs / (60 * 60 * 1000);
  if (hours <= 24) return 5;      // < 1 day: 5 min
  if (hours <= 72) return 15;     // 1-3 days: 15 min
  if (hours <= 168) return 30;    // 3-7 days: 30 min
  if (hours <= 336) return 60;    // 7-14 days: 1 hour
  return 120;                     // 14+ days: 2 hours
}

app.get("/api/oven/plug-performance", async (req, res) => {
  try {
    const { start, end } = parseRange(req);

    const rangeMs = end - start;
    const bucketMinutes = computeAdaptiveBucketMinutes(rangeMs);
    const bucketMs = bucketMinutes * 60 * 1000;

    // Floor timestamps to bucket boundaries in LOCAL time
    const floorToBucketLocal = (d) => {
      const x = new Date(d);
      const mins = x.getMinutes();
      const floored = Math.floor(mins / bucketMinutes) * bucketMinutes;
      x.setMinutes(floored, 0, 0);
      return x;
    };

    const startB = floorToBucketLocal(start);
    const endB = floorToBucketLocal(end);

    // Continuous numeric buckets (ms)
    const buckets = [];
    for (let t = startB.getTime(); t <= endB.getTime(); t += bucketMs) buckets.push(t);

    // Filled vs empty (sparse SQL rows)
    const rows = await fetchOvenFillStats({
      startDate: startB,
      endDate: new Date(endB.getTime() + bucketMs),
      bucketMinutes
    });

    // Sizes (fallback)
    const sizeSet = new Set();
    for (const r of rows) sizeSet.add(String(r.PlugSize));
    const sizes = (sizeSet.size ? Array.from(sizeSet) : ["1", "2", "3", "4"])
      .sort((a, b) => Number(a) - Number(b));

    const filledMap = new Map(); // `${bucketMs}|${size}` -> count
    let filledTotal = 0;
    let emptyTotal = 0;

    for (const r of rows) {
      const b = floorToBucketLocal(r.BucketTime).getTime();
      const s = String(r.PlugSize);
      const cnt = Number(r.Cnt) || 0;
      const isFilled = Number(r.IsFilled) === 1;

      if (isFilled) {
        filledTotal += cnt;
        filledMap.set(`${b}|${s}`, (filledMap.get(`${b}|${s}`) ?? 0) + cnt);
      } else {
        emptyTotal += cnt;
      }
    }

    // Completions series (zero-filled)
    const series = {};
    for (const s of sizes) series[s] = buckets.map((b) => filledMap.get(`${b}|${s}`) ?? 0);

    // KPIs
    const totalCycles = filledTotal + emptyTotal;
    const efficiencyPct = totalCycles > 0 ? Math.round((filledTotal / totalCycles) * 1000) / 10 : null;
    const lostSeconds = emptyTotal * 15;

    const cureKpis = await fetchOvenCureKpis({
      startDate: startB,
      endDate: new Date(endB.getTime() + bucketMs)
    });

    const kpis = {
      filledTotal,
      emptyTotal,
      totalCycles,
      efficiencyPct,
      lostSeconds,
      lastCureMinutes: cureKpis?.lastCureMinutes ?? null,
      avgCureMinutes: cureKpis?.avgCureMinutes ?? null
    };

    // Cure time series aligned to SAME numeric buckets
    const { rows: cureRows } = await fetchOvenRealtime({
      startDate: startB,
      endDate: new Date(endB.getTime() + bucketMs),
      bucketMinutes
    });

    const cureAvgMap = new Map(); // `${bucketMs}|${size}` -> AvgBakeMinutes
    for (const r of (cureRows || [])) {
      const b = floorToBucketLocal(r.BucketTime).getTime();
      const s = String(r.PlugSize);
      const v = r.AvgBakeMinutes;
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      cureAvgMap.set(`${b}|${s}`, n);
    }

    const cureSeries = {};
    for (const s of sizes) {
      cureSeries[s] = buckets.map((b) => {
        const v = cureAvgMap.get(`${b}|${s}`);
        return (v === undefined) ? null : v;
      });
    }

    // Event bars: use your log-based pairing function (already in your server.js)
    const events = buildOvenEventBars(startB, new Date(endB.getTime() + bucketMs));

    return res.json({
      ok: true,
      start: startB.toISOString(),
      end: endB.toISOString(),
      bucketMinutes,
      buckets,
      sizes,
      series,
      kpis,
      cure: { buckets, sizes, series: cureSeries },
      events
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});


// --------------------
// Mold APIs + page
// --------------------
app.get("/api/molds/snapshot", (req, res) => res.json(moldSnapshot));
app.get("/api/molds/config", (req, res) => res.json(loadMoldConfig()));
app.post("/api/molds/config", (req, res) => {
  const body = req.body ?? {};
  const next = loadMoldConfig();

  const v = Number(body.cleanThresholdCycles);
  if (!Number.isFinite(v) || v < 1 || v > 1000000) return res.status(400).send("Invalid cleanThresholdCycles");

  const ratio = Number(body.dueSoonRatio ?? next.dueSoonRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return res.status(400).send("Invalid dueSoonRatio (0-1)");

  next.mode = "global";
  next.cleanThresholdCycles = v;
  next.dueSoonRatio = ratio;

  saveMoldConfig(next);
  refreshMoldSnapshot();
  res.json(next);
});
app.get("/molds", (req, res) => res.sendFile(path.resolve(__dirname, "public", "molds.html")));

// --------------------
// Maintenance assets endpoints
// --------------------
app.get("/api/maintenance/assets/all", (req, res) => {
  try {
    const all = loadMaintenanceAssetsRaw();
    const seen = new Set();
    const out = [];

    for (const c of CELLS) {
      const rawList = Array.isArray(all[c.id]) ? all[c.id] : [];
      const normalized = normalizeAssetListForApi(rawList);
      for (const a of normalized) {
        const label = String(a.label ?? "").trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label, value: a.value, kind: a.kind });
      }
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    res.json({ ok: true, assets: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/maintenance/assets", (req, res) => {
  const cellId = req.query.cellId;
  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Missing or invalid cellId" });
  const all = loadMaintenanceAssetsRaw();
  const list = Array.isArray(all[cellId]) ? all[cellId] : [];
  const assets = normalizeAssetListForApi(list);
  res.json({ ok: true, assets });
});

// --------------------
// Maintenance request + status
// --------------------
app.post("/api/maintenance/request", async (req, res) => {
  ensureStateShape();
  const { cellId, assetValue, priority, description } = req.body ?? {};

  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Missing or invalid cellId" });

  const desc = (description ?? "").trim();
  if (!desc) return res.status(400).json({ ok: false, error: "Description is required" });

  const cellName = CELLS.find((c) => c.id === cellId)?.name ?? cellId;

  const allAssets = loadMaintenanceAssetsRaw();
  const rawList = Array.isArray(allAssets[cellId]) ? allAssets[cellId] : [];
  const allowed = normalizeAssetListForApi(rawList);

  let chosenAssetId = null;
  let chosenAssetLabel = "";

  if (assetValue) {
    const v = String(assetValue).trim();
    const match = allowed.find((a) => String(a.value) === v);
    if (!match) return res.status(400).json({ ok: false, error: "Selected asset is not allowed for this cell" });

    chosenAssetLabel = match.label;
    if (match.kind === "id") {
      chosenAssetId = Number(match.value);
    } else {
      try {
        chosenAssetId = await resolveAssetIdFromCode(match.value);
        if (!chosenAssetId) {
          return res.status(400).json({ ok: false, error: `Could not resolve asset code ${match.value} to a Fiix asset id.` });
        }
      } catch (e) {
        return res.status(400).json({ ok: false, error: `Fiix asset lookup failed: ${e.message}` });
      }
    }
  }

  const siteMap = loadMaintenanceSiteMap();
  const siteId = siteMap[cellId] ?? null;

  let fiix = null;
  try {
    fiix = await createFiixWorkOrderForMaintenance({
      cellId,
      cellName,
      assetId: chosenAssetId,
      assetLabel: chosenAssetLabel,
      priority: priority ?? "Medium",
      description: desc,
      siteId
    });
  } catch (e) {
    fiix = {
      error: e.message,
      url: FIIX_UI_BASE,
      requestDescription: desc,
      requestPriority: priority ?? "Medium",
      requestAsset: chosenAssetLabel ?? ""
    };
  }

  const ticketId = addMaintTicket(cellId, {
    priority: priority ?? "Medium",
    issue: desc,
    assetLabel: chosenAssetLabel ?? "",
    progressStatus: "",
    fiix
  });

  // Log request so oven chart can show a maintenance bar
  appendLog({
    type: "request",
    ts: nowMs(),
    dept: "maintenance",
    deptName: DEPARTMENTS.find((d) => d.id === "maintenance")?.name,
    cellId,
    cellName,
    ticketId,
    fiix: fiix ?? null,
    note: desc
  });

  // Notify department webhook (if configured)
  notifyDeptWebhook("maintenance", {
    event: "ticket.request",
    ts: Date.now(),
    dept: "maintenance",
    cellId,
    cellName,
    ticketId,
    note: desc,
    fiix
  });

  saveState(state);
  emitDept("maintenance");
  emitCell(cellId);

  res.json({ ok: true, ticketId });
});

app.post("/api/maintenance/ticket/status", (req, res) => {
  ensureStateShape();
  const { cellId, ticketId, progressStatus } = req.body ?? {};

  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Invalid cellId" });
  if (!ticketId) return res.status(400).json({ ok: false, error: "Missing ticketId" });

  const t = findMaintTicket(cellId, ticketId);
  if (!t || t.status !== "OPEN") return res.status(400).json({ ok: false, error: "Ticket not open or not found" });

  t.progressStatus = String(progressStatus ?? "").trim().slice(0, 160);

  saveState(state);
  emitDept("maintenance");
  emitCell(cellId);

  res.json({ ok: true });
});

// Simple webhook test endpoints (GET for quick checks, POST for custom payload)
app.get("/api/webhook-test", (req, res) => {
  const dept = String(req.query.dept || "mfg-eng").toLowerCase();
  const sample = {
    event: "test",
    ts: Date.now(),
    dept,
    cellId: String(req.query.cellId || "test-cell"),
    cellName: String(req.query.cellName || "Test Cell"),
    ticketId: String(req.query.ticketId || "test-ticket"),
    callId: String(req.query.callId || "test-call"),
    note: String(req.query.note || "Webhook test from server (GET)"),
    fiix: null,
    status: "test"
  };
  notifyDeptWebhook(dept, sample).then((result) => {
    res.json({ ok: true, sent: sample, result });
  }).catch((err) => res.json({ ok: false, error: err?.message ?? String(err) }));
});

app.post("/api/webhook-test", (req, res) => {
  const body = req.body ?? {};
  const dept = String(body.dept || "mfg-eng").toLowerCase();
  const sample = {
    event: body.event || "test",
    ts: Date.now(),
    dept,
    cellId: body.cellId || "test-cell",
    cellName: body.cellName || "Test Cell",
    ticketId: body.ticketId || null,
    callId: body.callId || null,
    note: body.note || "Webhook test from server (POST)",
    fiix: body.fiix || null,
    status: body.status || "test"
  };
  notifyDeptWebhook(dept, sample);
  notifyDeptWebhook(dept, sample).then((result) => {
    res.json({ ok: true, sent: sample, result });
  }).catch((err) => res.json({ ok: false, error: err?.message ?? String(err) }));
});

// Debug: show configured webhook mapping (masked)
app.get('/api/debug/webhooks', (req, res) => {
  const masked = Object.fromEntries(Object.entries(WEBHOOK_MAP).map(([k, v]) => {
    if (!v) return [k, null];
    const len = v.length;
    const start = v.slice(0, Math.min(16, len));
    const end = v.slice(Math.max(0, len - 8));
    return [k, `${start}...${end}`];
  }));
  res.json({ ok: true, webhooks: masked });
});

// Allow setting webhook URLs at runtime (persisted to `state.webhooks`)
app.post('/api/debug/webhooks', (req, res) => {
  const body = req.body || {};
  const allowed = Object.keys(WEBHOOK_MAP);
  const updates = {};

  // Accept either { dept: 'mfg-eng', url: 'https://...' } or a map { 'mfg-eng': 'https://...', 'maintenance': null }
  if (body.dept && Object.prototype.hasOwnProperty.call(body, 'url')) {
    const d = String(body.dept).toLowerCase();
    if (!allowed.includes(d)) return res.status(400).json({ ok: false, error: 'invalid dept' });
    WEBHOOK_MAP[d] = body.url || null;
    updates[d] = WEBHOOK_MAP[d];
  } else {
    for (const [k, v] of Object.entries(body)) {
      const key = String(k).toLowerCase();
      if (!allowed.includes(key)) continue;
      WEBHOOK_MAP[key] = v || null;
      updates[key] = WEBHOOK_MAP[key];
    }
  }

  state.webhooks = state.webhooks || {};
  for (const k of Object.keys(WEBHOOK_MAP)) state.webhooks[k] = WEBHOOK_MAP[k];
  try { saveState(state); } catch (e) { console.error('Failed saving webhooks to state:', e?.message ?? e); }

  const mask = (v) => { if (!v) return null; const len = v.length; return `${v.slice(0, Math.min(16, len))}...${v.slice(Math.max(0, len - 8))}`; };
  const maskedUpdated = Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, mask(v)]));
  const maskedAll = Object.fromEntries(Object.entries(WEBHOOK_MAP).map(([k, v]) => [k, mask(v)]));
  res.json({ ok: true, updated: maskedUpdated, webhooks: maskedAll });
});

// --------------------
// Non-maint request/cancel/complete
// --------------------
app.post("/api/request", (req, res) => {
  ensureStateShape();
  const { dept, cellId } = req.body ?? {};

  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Invalid dept" });
  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Invalid cellId" });
  if (dept === "maintenance") return res.status(400).json({ ok: false, error: "Use /api/maintenance/request" });

  const callId = openSingleCall(dept, cellId);

  // Log request so oven chart can show a dept call bar (ex: mfg-eng)
    appendLog({
      type: "request",
      ts: nowMs(),
      dept,
      deptName: DEPARTMENTS.find((d) => d.id === dept)?.name,
      cellId,
      cellName: CELLS.find((c) => c.id === cellId)?.name,
      callId
    });

  // Notify department webhook (if configured)
  notifyDeptWebhook(dept, {
    event: "call.request",
    ts: Date.now(),
    dept,
    cellId,
    cellName: CELLS.find((c) => c.id === cellId)?.name,
    callId
  });

  saveState(state);
  emitDept(dept);
  emitCell(cellId);

  res.json({ ok: true, callId });
});

app.post("/api/cancel", async (req, res) => {
  ensureStateShape();
  const { dept, cellId, callId, ticketId, cancelledBy, reason } = req.body ?? {};

  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Invalid dept" });
  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Invalid cellId" });

  if (dept === "maintenance") {
    const t = ticketId ? findMaintTicket(cellId, ticketId) : findLatestOpenMaintTicket(cellId);
    if (!t || t.status !== "OPEN") return res.status(400).json({ ok: false, error: "No open maintenance ticket found" });

    if (t.fiix?.workOrderId) {
      try {
        await cancelFiixWorkOrder({
          workOrderId: t.fiix.workOrderId,
          cancelledByName: cancelledBy ?? "operator",
          reason: reason ?? "Cancelled from tablet"
        });
      } catch (e) {
        t.fiix = { ...(t.fiix ?? {}), cancelError: e.message };
      }
    }

    cancelMaintTicket(cellId, t.ticketId);

    appendLog({
      type: "cancel",
      ts: nowMs(),
      dept,
      deptName: DEPARTMENTS.find((d) => d.id === dept)?.name,
      cellId,
      cellName: CELLS.find((c) => c.id === cellId)?.name,
      ticketId: t.ticketId,
      fiix: t.fiix ?? null,
      note: reason ?? ""
    });

      // Notify webhook about maintenance ticket cancel
      notifyDeptWebhook("maintenance", {
        event: "ticket.cancel",
        ts: Date.now(),
        dept: "maintenance",
        cellId,
        cellName,
        ticketId: t.ticketId,
        note: reason ?? "",
        fiix: t.fiix ?? null,
        status: "cancelled"
      });

    saveState(state);
    emitDept("maintenance");
    emitCell(cellId);

    return res.json({ ok: true, ticketId: t.ticketId });
  }

  const ok = cancelSingleCall(dept, cellId, callId ?? null);
  if (!ok) return res.status(400).json({ ok: false, error: "No matching open call to cancel" });

  appendLog({
    type: "cancel",
    ts: nowMs(),
    dept,
    deptName: DEPARTMENTS.find((d) => d.id === dept)?.name,
    cellId,
    cellName: CELLS.find((c) => c.id === cellId)?.name,
    callId: callId ?? null
  });

  saveState(state);
  emitDept(dept);
  emitCell(cellId);

  res.json({ ok: true });
});

app.post("/api/complete", async (req, res) => {
  ensureStateShape();
  const { dept, cellId, ticketId, responderName, partNumber, result, note } = req.body ?? {};

  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Invalid dept" });
  if (!cellId || !isValidCell(cellId)) return res.status(400).json({ ok: false, error: "Invalid cellId" });

  const responder = (responderName ?? "").trim();
  const pn = (partNumber ?? "").trim();
  const resu = (result ?? "").trim();
  const n = (note ?? "").trim();

  if (!responder) return res.status(400).json({ ok: false, error: "Responder name required" });
  if (!resu) return res.status(400).json({ ok: false, error: "Result required" });
  if (dept === "quality" && !pn) return res.status(400).json({ ok: false, error: "Part Number required for Quality" });

  if (dept === "maintenance") {
    const t = ticketId ? findMaintTicket(cellId, ticketId) : findOldestOpenMaintTicket(cellId);
    if (!t || t.status !== "OPEN") return res.status(400).json({ ok: false, error: "No open maintenance ticket found" });

    if (t.fiix?.workOrderId) {
      const completionNotes = `${resu}\nCompleted by ${responder}` + (n ? `\n${n}` : "");
      try {
        await closeFiixWorkOrderWithCompletion({
          workOrderId: t.fiix.workOrderId,
          responderName: responder,
          completionNotes
        });
      } catch (e) {
        t.fiix = { ...(t.fiix ?? {}), closeError: e.message };
      }
    }

    const completedAt = nowMs();
    const elapsedMs = completedAt - (t.createdAt ?? completedAt);

    completeMaintTicket(cellId, t.ticketId, { responderName: responder, result: resu, note: n });

    appendLog({
      type: "complete",
      ts: completedAt,
      dept,
      deptName: DEPARTMENTS.find((d) => d.id === dept)?.name,
      cellId,
      cellName: CELLS.find((c) => c.id === cellId)?.name,
      startedAt: t.createdAt ?? null,
      elapsedMs,
      responderName: responder,
      partNumber: "",
      result: resu,
      note: n,
      ticketId: t.ticketId,
      progressStatus: t.progressStatus ?? "",
      fiix: t.fiix ?? null
    });

    // Notify webhook about maintenance ticket completion
    notifyDeptWebhook("maintenance", {
      event: "ticket.complete",
      ts: Date.now(),
      dept: "maintenance",
      cellId,
      cellName,
      ticketId: t.ticketId,
      responderName: responder,
      result: resu,
      note: n,
      elapsedMs,
      fiix: t.fiix ?? null,
      status: "completed"
    });

    saveState(state);
    emitDept("maintenance");
    emitCell(cellId);

    return res.json({ ok: true, ticketId: t.ticketId });
  }

  const slot = state.active[dept][cellId];
  if (slot.status !== "WAITING") return res.status(400).json({ ok: false, error: "No open call to complete" });

  const completedAt = nowMs();
  const elapsedMs = slot.requestedAt ? (completedAt - slot.requestedAt) : null;

  appendLog({
    type: "complete",
    ts: completedAt,
    dept,
    deptName: DEPARTMENTS.find((d) => d.id === dept)?.name,
    cellId,
    cellName: CELLS.find((c) => c.id === cellId)?.name,
    startedAt: slot.requestedAt ?? null,
    elapsedMs,
    responderName: responder,
    partNumber: pn,
    result: resu,
    note: n,
    callId: slot.callId ?? null,
    fiix: slot.fiix ?? null
  });

  // Notify webhook about call completion
  notifyDeptWebhook(dept, {
    event: "call.complete",
    ts: Date.now(),
    dept,
    cellId,
    cellName: CELLS.find((c) => c.id === cellId)?.name,
    callId: slot.callId ?? null,
    responderName: responder,
    result: resu,
    note: n,
    elapsedMs,
    fiix: slot.fiix ?? null,
    status: "completed"
  });

  slot.status = "READY";
  slot.requestedAt = null;
  slot.callId = null;
  slot.fiix = null;

  saveState(state);
  emitDept(dept);
  emitCell(cellId);

  res.json({ ok: true });
});

// History / export / clear
app.get("/api/history", (req, res) => {
  const dept = req.query.dept;
  const n = Number(req.query.n) || 1000;

  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });

  const logs = readLogs(Math.max(n, 2000))
    .filter((l) => l.type === "complete" && l.dept === dept)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, n);

  res.json({ ok: true, dept, logs });
});

app.get("/api/export.csv", (req, res) => {
  const dept = req.query.dept;
  const n = Number(req.query.n) || 5000;

  if (!dept || !isValidDept(dept)) return res.status(400).send("Missing or invalid dept");

  const logs = readLogs(Math.max(n, 5000))
    .filter((l) => l.type === "complete" && l.dept === dept)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, n);

  const header = [
    "CompletedAt","Department","Cell","ResponderName","PartNumber","Result","ElapsedSeconds","Note",
    "FiixWorkOrderId","FiixWorkOrderNumber","FiixUrl","OriginalIssue","TicketId","CallId","ProgressStatus"
  ];

  const rows = logs.map((l) => {
    const completedAt = new Date(l.ts).toISOString();
    const secs = l.elapsedMs ? Math.round(l.elapsedMs / 1000) : "";
    const safeNote = (l.note ?? "").replace(/\\"/g, "\"\"");
    const issue = (l.fiix?.requestDescription ?? "").replace(/\\"/g, "\"\"");
    const fiixId = l.fiix?.workOrderId ?? "";
    const fiixNum = l.fiix?.workOrderNumber ?? "";
    const fiixUrl = l.fiix?.url ?? "";
    const ps = (l.progressStatus ?? "").replace(/\\"/g, "\"\"");

    return [
      completedAt,
      l.deptName ?? l.dept,
      l.cellName ?? l.cellId,
      l.responderName ?? "",
      l.partNumber ?? "",
      l.result ?? "",
      secs,
      `"${safeNote}"`,
      fiixId,
      fiixNum,
      fiixUrl,
      `"${issue}"`,
      l.ticketId ?? "",
      l.callId ?? "",
      `"${ps}"`
    ].join(",");
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${dept}_history.csv`);
  res.send([header.join(","), ...rows].join("\n"));
});

app.delete("/api/history", (req, res) => {
  const dept = req.query.dept;
  if (!dept || !isValidDept(dept)) return res.status(400).json({ ok: false, error: "Missing or invalid dept" });

  try {
    clearLogsByDept(dept);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Pages
app.get("/", (req, res) => res.redirect("/dashboard/quality"));
app.get("/dashboard/:dept", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/history/:dept", (req, res) => res.sendFile(path.join(__dirname, "public", "history.html")));
app.get("/cell/:id", (req, res) => res.sendFile(path.join(__dirname, "public", "cell.html")));
app.get("/oven", (req, res) => res.sendFile(path.join(__dirname, "public", "oven.html")));
app.get("/oven-performance", (req, res) => res.sendFile(path.join(__dirname, "public", "oven.html")));
app.get("/tv/quality", (req, res) => res.sendFile(path.join(__dirname, "public", "tv-quality.html")));
app.get("/tv/maintenance", (req, res) => res.sendFile(path.join(__dirname, "public", "tv-maintenance.html")));
app.get("/embed/oven", (req, res) => res.sendFile(path.join(__dirname, "public", "embed", "oven.html")));
// Embed (TV chart-only)
app.get("/embed/oven", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "embed", "oven.html"))
);




//const PORT = process.env.PORT ?? 3000;
//server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "10.12.1.75";
server.listen(PORT, HOST, () => console.log(`Listening on http://${HOST}:${PORT}`));
