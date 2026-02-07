import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

if (!base || !appKey || !accessKey || !secretKey) {
  console.error("Missing env vars: FIIX_BASE, FIIX_APP_KEY, FIIX_ACCESS_KEY, FIIX_SECRET_KEY");
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

// Try to list work order statuses. Some tenants use className "WorkOrderStatus".
const body = {
  _maCn: "FindRequest",
  clientVersion: { major: 2, minor: 8, patch: 1 },
  className: "WorkOrderStatus",
  fields: "id,strName,strCode",
  maxObjects: 200
};

const resp = await fetch(fullUrl, {
  method: "POST",
  headers: {
    "Content-Type": "text/plain",
    "Authorization": auth
  },
  body: JSON.stringify(body)
});

const text = await resp.text();
const data = JSON.parse(text);

if (data?.error) {
  console.error("Fiix error:", data.error);
  process.exit(1);
}

console.log("Total objects:", data.totalObjects ?? data.objects?.length ?? 0);
console.log("Statuses:");
for (const s of (data.objects || [])) {
  console.log(`id=${s.id}  name=${s.strName}  code=${s.strCode}`);
}