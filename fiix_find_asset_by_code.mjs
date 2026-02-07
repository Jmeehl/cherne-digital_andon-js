import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

const code = process.argv[2]; // e.g. CHE-MILLTURN-003
if (!base || !appKey || !accessKey || !secretKey || !code) {
  console.error("Usage: set FIIX_* env vars, then: node fiix_find_asset_by_code.mjs <AssetCode>");
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
  const noProto = fullUrl.replace(/^https?:\/\//, "");
  return crypto.createHmac("sha256", Buffer.from(secretKey, "utf8"))
    .update(Buffer.from(noProto, "utf8"))
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
  if (data?.error) throw data.error;
  return data;
}

// Try likely asset/equipment tables (tenant-dependent)
const classNames = ["Equipment", "Asset", "EquipmentV2", "AssetV2"];

for (const cn of classNames) {
  try {
    const req = {
      _maCn: "FindRequest",
      clientVersion: { major: 2, minor: 8, patch: 1 },
      className: cn,
      fields: "id,strCode,strName",
      filters: [{ ql: "strCode = ?", parameters: [String(code)] }],
      maxObjects: 5
    };

    const res = await fiixCall(req);
    const obj = (res.objects || [])[0];
    if (obj) {
      console.log(`FOUND in ${cn}: id=${obj.id} strCode=${obj.strCode} strName=${obj.strName}`);
      process.exit(0);
    }
  } catch (e) {
    // ignore and try next className
  }
}

console.log("No asset found for code:", code);