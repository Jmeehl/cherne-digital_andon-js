import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

const code = process.argv[2]; // e.g. 97461
if (!base || !appKey || !accessKey || !secretKey || !code) {
  console.error("Usage: set FIIX_* env vars, then: node fiix_probe_wo_asset_fields.mjs <WorkOrderCode>");
  process.exit(1);
}

function fiixUrl() {
  const ts = Date.now();
  const u = new URL("/api/", base);
  u.searchParams.set("service", "cmms");
  u.searchParams.set("timestamp", String(ts));
  u.searchParams.set("appKey", appKey);
  u.searchParams.set("accessKey", accessKey);
  u.searchParams.set("signatureMethod", "HmacSHA256");
  u.searchParams.set("signatureVersion", "1");
  return u.toString();
}

function authHeader(fullUrl) {
  const trimmed = fullUrl.replace(/^https?:\/\//, "");
  return crypto.createHmac("sha256", Buffer.from(secretKey, "utf8"))
    .update(Buffer.from(trimmed, "utf8"))
    .digest("hex")
    .toLowerCase();
}

async function fiixCall(body) {
  const url = fiixUrl();
  const auth = authHeader(url);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "Authorization": auth },
    body: JSON.stringify(body)
  });
  const data = JSON.parse(await resp.text());
  return data;
}

// Candidate fields to test for asset relationship on WorkOrder
const candidates = [
  "intAssetID",
  "intAssetId",
  "intEquipmentID",
  "intEquipmentId",
  "intPrimaryAssetID",
  "intPrimaryAssetId",
  "intParentAssetID",
  "intLocationID"
];

for (const f of candidates) {
  const body = {
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: "WorkOrder",
    fields: `id,strCode,${f}`,
    filters: [{ ql: "strCode = ?", parameters: [String(code)] }],
    maxObjects: 1
  };

  const data = await fiixCall(body);

  if (data?.error) {
    console.log(`${f}: ERROR -> ${data.error.message}`);
    continue;
  }

  const obj = (data.objects || [])[0];
  console.log(`${f}: OK ->`, obj?.[f]);
}