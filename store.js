// store.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.resolve(__dirname, "data.json");
const LOG_FILE  = path.resolve(__dirname, "logs.jsonl");        // NDJSON
const RESP_FILE = path.resolve(__dirname, "responders.json");   // JSON

// ---- Departments ----
export const DEPARTMENTS = [
  { id: "quality",     name: "Quality" },
  { id: "mfg-eng",     name: "Manufacturing Engineering" },
  { id: "supervisor",  name: "Supervisor / Leads" },
  { id: "safety",      name: "Safety" },
  { id: "maintenance", name: "Maintenance" } // ✅ NEW
];

// ---- Cells ----
export const CELLS = [
  { id: "machine-shop",        name: "Machine Shop" },
  { id: "clean-seal",          name: "Clean Seal" },
  { id: "extension-hose",      name: "Extension Hose" },
  { id: "end-element",         name: "End Element" },
  { id: "robot-finishing",     name: "Robot Finishing" },
  { id: "large-ball-testing",  name: "Large Ball Testing" },
  { id: "small-ball-testing",  name: "Small Ball Testing" },
  { id: "small-ball-assembly", name: "Small Ball Assembly" },
  { id: "large-ball-assembly", name: "Large Ball Assembly" },
  { id: "discrete",            name: "Discrete" },
  { id: "tubes-inserts",       name: "Tubes & Inserts" },
  { id: "poly-lift-line",      name: "Poly Lift Line" },
  { id: "taniq-robot-1",       name: "Taniq Robot #1" },
  { id: "taniq-robot-2",       name: "Taniq Robot #2" },
  { id: "autoclave",           name: "Autoclave" },
  { id: "waterjet-rubber",     name: "Waterjet Rubber" },
  { id: "baking",              name: "Baking" },
];

/**
 * State shape:
 * {
 *   active: {
 *     [deptId]: {
 *       [cellId]: { status, requestedAt, fiix }
 *     }
 *   }
 * }
 *
 * fiix: null or { workOrderId, workOrderNumber, url }
 */
export function createDefaultState() {
  const active = {};
  for (const d of DEPARTMENTS) {
    active[d.id] = {};
    for (const c of CELLS) {
      active[d.id][c.id] = {
        status: "READY",
        requestedAt: null,
        fiix: null
      };
    }
  }
  return { active };
}

export function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const base = createDefaultState();
    if (parsed?.active) {
      for (const d of DEPARTMENTS) {
        const incomingDept = parsed.active[d.id] || {};
        for (const c of CELLS) {
          if (incomingDept[c.id]) {
            // Merge fields safely
            base.active[d.id][c.id] = {
              ...base.active[d.id][c.id],
              ...incomingDept[c.id]
            };
          }
        }
      }
    }
    return base;
  } catch {
    return createDefaultState();
  }
}

export function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// ---- Logging (append-only) ----
export function appendLog(entry) {
  const line = JSON.stringify(entry);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

export function readLogs(limit = 5000) {
  try {
    const text = fs.readFileSync(LOG_FILE, "utf-8");
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

// Delete only matching deptId completion logs by rewriting file
export function clearLogsByDept(deptId) {
  const logs = readLogs(9999999);
  const keep = logs.filter(l => !(l.type === "complete" && l.dept === deptId));
  const rebuilt = keep.map(l => JSON.stringify(l)).join("\n");
  fs.writeFileSync(LOG_FILE, rebuilt ? rebuilt + "\n" : "");
}

// ============================
// Responders list (per dept)
// ============================
function normNameKey(name) {
  return (name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function loadResponders() {
  try {
    const raw = fs.readFileSync(RESP_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const base = {};
    for (const d of DEPARTMENTS) base[d.id] = [];

    for (const d of DEPARTMENTS) {
      const arr = Array.isArray(parsed?.[d.id]) ? parsed[d.id] : [];
      const seen = new Set();
      base[d.id] = arr
        .map(s => (s || "").trim().replace(/\s+/g, " "))
        .filter(s => s.length > 0)
        .filter(s => {
          const k = normNameKey(s);
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.localeCompare(b));
    }
    return base;
  } catch {
    const base = {};
    for (const d of DEPARTMENTS) base[d.id] = [];
    return base;
  }
}

export function saveResponders(all) {
  fs.writeFileSync(RESP_FILE, JSON.stringify(all, null, 2));
}

export function addResponder(deptId, name) {
  const clean = (name || "").trim().replace(/\s+/g, " ");
  if (!clean) return { ok: false, error: "Name required" };

  const all = loadResponders();
  if (!all[deptId]) all[deptId] = [];

  const key = normNameKey(clean);
  const exists = all[deptId].some(n => normNameKey(n) === key);
  if (exists) return { ok: true, responders: all[deptId] };

  all[deptId].push(clean);
  all[deptId].sort((a, b) => a.localeCompare(b));
  saveResponders(all);
  return { ok: true, responders: all[deptId] };
}

export function removeResponder(deptId, name) {
  const clean = (name || "").trim().replace(/\s+/g, " ");
  if (!clean) return { ok: false, error: "Name required" };

  const all = loadResponders();
  if (!all[deptId]) all[deptId] = [];

  const key = normNameKey(clean);
  all[deptId] = all[deptId].filter(n => normNameKey(n) !== key);
  saveResponders(all);
  return { ok: true, responders: all[deptId] };
}