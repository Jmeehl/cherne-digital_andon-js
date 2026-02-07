import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

if (!base || !appKey || !accessKey || !secretKey) {
  console.error("Set FIIX_BASE, FIIX_APP_KEY, FIIX_ACCESS_KEY, FIIX_SECRET_KEY");
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
  return JSON.parse(await resp.text());
}

// Try likely association objects (names vary by tenant/version)
const candidates = [
  "WorkOrderAsset",
  "WorkOrderAssets",
  "WorkOrderAssetLink",
  "WorkOrderAssetAssociation",
  "WorkOrderAssetXref",
  "WorkOrderAssetXRef",
  "WorkOrderEquipment",
  "WorkOrderEquipmentLink",
  "WorkOrderMultiAsset",
  "WorkOrderAssetItem"
];

for (const cn of candidates) {
  const req = {
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: cn,
    // just ask for minimal fields
    fields: "id",
    maxObjects: 1
  };

  const data = await fiixCall(req);

  if (data?.error) {
    console.log(`${cn}: ERROR -> ${data.error.message}`);
  } else {
    console.log(`${cn}: OK (found class)`);
    process.exit(0);
  }
}

console.log("No candidate association class found with this list.");