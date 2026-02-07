import crypto from "crypto";

const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
const appKey = process.env.FIIX_APP_KEY || "";
const accessKey = process.env.FIIX_ACCESS_KEY || "";
const secretKey = process.env.FIIX_SECRET_KEY || "";

const code = process.argv[2]; // e.g. 97447
if (!base || !appKey || !accessKey || !secretKey) {
  console.error("Missing env vars. Set FIIX_BASE, FIIX_APP_KEY, FIIX_ACCESS_KEY, FIIX_SECRET_KEY.");
  process.exit(1);
}
if (!code) {
  console.error("Usage: node fiix_find_wo_by_code.mjs <WorkOrderCode>");
  process.exit(1);
}

// Build Fiix API URL (per Fiix no-SDK doc)
const ts = Date.now();
const u = new URL("/api/", base);
u.searchParams.set("service", "cmms");
u.searchParams.set("timestamp", String(ts));
u.searchParams.set("appKey", appKey);
u.searchParams.set("accessKey", accessKey);
u.searchParams.set("signatureMethod", "HmacSHA256");
u.searchParams.set("signatureVersion", "1");

const fullUrl = u.toString();

// Authorization = HMACSHA256(secretKey, urlWithoutProtocol) hex lower
const urlNoProto = fullUrl.replace(/^https?:\/\//, "");
const auth = crypto
  .createHmac("sha256", Buffer.from(secretKey, "utf8"))
  .update(Buffer.from(urlNoProto, "utf8"))
  .digest("hex")
  .toLowerCase();

// FindRequest (Fiix supports FindRequest with fields + filters using ql + parameters)
const body = {
  _maCn: "FindRequest",
  clientVersion: { major: 2, minor: 8, patch: 1 },
  className: "WorkOrder",
  fields: "id,strCode,strDescription",
  filters: [
    { ql: "strCode = ?", parameters: [String(code)] }
  ],
  maxObjects: 5
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
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error("Non-JSON response:", text.slice(0, 300));
  process.exit(1);
}

// Fiix returns errors inside the JSON body (even when HTTP 200)
if (data?.error) {
  console.error("Fiix error:", data.error);
  process.exit(1);
}

console.log("FindResponse _maCn:", data._maCn);
console.log("Total objects:", data.totalObjects ?? data.objects?.length ?? 0);
console.log("Objects:", data.objects);