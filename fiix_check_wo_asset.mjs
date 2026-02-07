import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

const code = process.argv[2]; // e.g. 97460
if (!base || !appKey || !accessKey || !secretKey || !code) {
  console.error("Usage: set FIIX_* env vars, then: node fiix_check_wo_asset.mjs <WorkOrderCode>");
  process.exit(1);
}

const ts = Date.now();
const u = new URL("/api/", base);
u.searchParams.set("service", "cmms");
u.searchParams.set("timestamp", String(ts));
u.searchParams.set("appKey", appKey);
u.searchParams.set("accessKey", accessKey);
u.searchParams.set("signatureMethod", "HmacSHA256");
u.searchParams.set("signatureVersion", "1");

const fullUrl = u.toString();
const urlNoProto = fullUrl.replace(/^https?:\/\//, "");
const auth = crypto.createHmac("sha256", Buffer.from(secretKey, "utf8"))
  .update(Buffer.from(urlNoProto, "utf8"))
  .digest("hex")
  .toLowerCase();

const body = {
  _maCn: "FindRequest",
  clientVersion: { major: 2, minor: 8, patch: 1 },
  className: "WorkOrder",
  fields: "id,strCode,strDescription,intAssetID,intLocationID,intSiteID,intWorkOrderStatusID",
  filters: [{ ql: "strCode = ?", parameters: [String(code)] }],
  maxObjects: 5
};

const resp = await fetch(fullUrl, {
  method: "POST",
  headers: { "Content-Type": "text/plain", "Authorization": auth },
  body: JSON.stringify(body)
});

const data = JSON.parse(await resp.text());
if (data?.error) {
  console.error("Fiix error:", data.error);
  process.exit(1);
}

console.log(data.objects?.[0]);