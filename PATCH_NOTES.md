# Mold Cleaning Dashboard Bundle

This bundle adds a new Mold Cleaning dashboard to your Floor Alerts / Cherne Assist app.

## What you get
- `public/molds.html` and `public/molds.js` – dashboard UI
- `mold_config.json` – adjustable global cleaning threshold (default 250)
- `molds_sql.js` – SQL Server read-only query (latest row per mold)

## Required server changes (server.js)

### 1) Install dependency
```bash
npm i mssql
```

### 2) Add environment variables (.env)
```env
MSSQL_HOST=200.1.1.100
MSSQL_DB=Cherne_Baking
MSSQL_USER=UserReadOnly
MSSQL_PASSWORD=ReadOnly
MSSQL_ENCRYPT=false
MSSQL_TRUST_CERT=true
```

### 3) Import new module
At top of `server.js`:
```js
import fs from 'fs';
import path from 'path';
import { fetchLatestMolds } from './molds_sql.js';
```
(Use your existing `__dirname` / ESM helpers in server.js as needed.)

### 4) Add config helpers
Place near other JSON persistence helpers:
```js
const MOLD_CONFIG_FILE = path.resolve(__dirname, 'mold_config.json');

function loadMoldConfig() {
  try {
    return JSON.parse(fs.readFileSync(MOLD_CONFIG_FILE, 'utf-8'));
  } catch {
    return { mode: 'global', cleanThresholdCycles: 250, dueSoonRatio: 0.85, perSizeThresholds: { '1':250,'2':250,'3':250,'4':250 } };
  }
}

function saveMoldConfig(cfg) {
  fs.writeFileSync(MOLD_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
```

### 5) Build snapshot + poller (every 60s)
```js
let moldSnapshot = { now: Date.now(), updatedAt: Date.now(), config: loadMoldConfig(), counts: { total: 0, overdue: 0, dueSoon: 0, ok: 0 }, molds: [], worst: null };

function computeMoldSnapshot(rows, cfg) {
  const threshold = Number(cfg.cleanThresholdCycles || 250);
  const dueSoonAt = Math.round(threshold * Number(cfg.dueSoonRatio || 0.85));

  const molds = rows
    .map(r => {
      const moldNumber = Number(r.MoldNumber);
      const moldSize = Number(r.MoldSize);
      const cyclesSince = Number(r.CyclesSinceLastCleaning || 0);
      const ttdCycles = Number(r.TTDCycles || 0);
      const lastExtractTs = r.Extract_DateTime ? new Date(r.Extract_DateTime).getTime() : null;

      let status = 'OK';
      if (cyclesSince >= threshold) status = 'OVERDUE';
      else if (cyclesSince >= dueSoonAt) status = 'DUE_SOON';

      const overBy = Math.max(0, cyclesSince - threshold);

      return { moldNumber, moldSize, cyclesSince, ttdCycles, lastExtractTs, threshold, overBy, status };
    })
    .filter(m => Number.isFinite(m.moldNumber) && m.moldNumber > 0)
    // prioritize overdue first, then most over, then highest cycles
    .sort((a, b) => {
      const rank = (x) => (x.status === 'OVERDUE' ? 2 : x.status === 'DUE_SOON' ? 1 : 0);
      const dr = rank(b) - rank(a);
      if (dr !== 0) return dr;
      const ob = (b.overBy || 0) - (a.overBy || 0);
      if (ob !== 0) return ob;
      return (b.cyclesSince || 0) - (a.cyclesSince || 0);
    });

  const counts = { total: molds.length, overdue: 0, dueSoon: 0, ok: 0 };
  for (const m of molds) {
    if (m.status === 'OVERDUE') counts.overdue++;
    else if (m.status === 'DUE_SOON') counts.dueSoon++;
    else counts.ok++;
  }

  const worst = molds.length ? molds[0] : null;

  return { now: Date.now(), updatedAt: Date.now(), config: cfg, counts, molds, worst };
}

async function refreshMoldSnapshot() {
  const cfg = loadMoldConfig();
  try {
    const rows = await fetchLatestMolds();
    moldSnapshot = computeMoldSnapshot(rows, cfg);
    io.to('molds').emit('moldsSnapshot', moldSnapshot);
  } catch (e) {
    // keep last snapshot; optionally log
    console.error('Mold snapshot refresh failed:', e?.message || e);
  }
}

setInterval(refreshMoldSnapshot, 60000);
refreshMoldSnapshot();
```

### 6) API endpoints
```js
app.get('/api/molds/snapshot', (req, res) => res.json(moldSnapshot));

app.get('/api/molds/config', (req, res) => res.json(loadMoldConfig()));

app.post('/api/molds/config', (req, res) => {
  const body = req.body || {};
  const next = loadMoldConfig();

  const v = Number(body.cleanThresholdCycles);
  if (!Number.isFinite(v) || v < 1 || v > 1000000) {
    return res.status(400).send('Invalid cleanThresholdCycles');
  }

  const ratio = Number(body.dueSoonRatio ?? next.dueSoonRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    return res.status(400).send('Invalid dueSoonRatio (0-1)');
  }

  next.mode = 'global';
  next.cleanThresholdCycles = v;
  next.dueSoonRatio = ratio;

  saveMoldConfig(next);
  // force refresh
  refreshMoldSnapshot();
  res.json(next);
});
```

### 7) Route to serve the page
```js
app.get('/molds', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'molds.html'));
});
```

### 8) Socket room join
In your existing `io.on('connection', (socket) => { ... })` add:
```js
if (socket.handshake?.query?.room === 'molds') {
  socket.join('molds');
  socket.emit('moldsSnapshot', moldSnapshot);
}
```

## Maintenance history link
Add a button/link on `/history/maintenance` to `href="/molds"`.

---

If you want, we can provide a follow-up patch for `history.html`/`history.js` to show the button only for maintenance.
