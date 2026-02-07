import crypto from "crypto";

(async () => {
  const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
  const appKey = process.env.FIIX_APP_KEY || "";
  const accessKey = process.env.FIIX_ACCESS_KEY || "";
  const secretKey = process.env.FIIX_SECRET_KEY || "";

  if (!base || !appKey || !accessKey || !secretKey) {
    console.error("Missing env vars. Set: FIIX_BASE, FIIX_APP_KEY, FIIX_ACCESS_KEY, FIIX_SECRET_KEY");
    process.exitCode = 1;
    return;
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

  const text = await resp.text();

  // Fiix sometimes omits Content-Type; detect JSON by payload shape
  const trimmed = text.trim();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");

  if (!looksJson) {
    console.log("---- Non-JSON response ----");
    console.log("HTTP:", resp.status, resp.statusText);
    console.log("Body (first 300 chars):");
    console.log(trimmed.slice(0, 300));
    console.log("--------------------------");
    return { error: { message: "Non-JSON response (see output above)" } };
  }

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    console.log("---- JSON parse failed ----");
    console.log("HTTP:", resp.status, resp.statusText);
    console.log("Body (first 300 chars):");
    console.log(trimmed.slice(0, 300));
    console.log("---------------------------");
    return { error: { message: "JSON parse failed (see output above)" } };
  }
}

  const candidates = [
    "Task",
    "WorkOrderTask",
    "WorkOrderTaskItem",
    "WorkOrderLaborTask",
    "LaborTask",
    "WorkOrderTaskGroup"
  ];

  console.log("Probing task classNames...");
  for (const cn of candidates) {
    const res = await fiixCall({
      _maCn: "FindRequest",
      clientVersion: { major: 2, minor: 8, patch: 1 },
      className: cn,
      fields: "id",
      maxObjects: 1
    });

    if (res?.error) {
      console.log(`${cn}: ERROR -> ${res.error.message}`);
    } else {
      console.log(`${cn}: OK (exists)`);
    }
  }
})();