import crypto from "crypto";

(async () => {
  const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
  const appKey = process.env.FIIX_APP_KEY || "";
  const accessKey = process.env.FIIX_ACCESS_KEY || "";
  const secretKey = process.env.FIIX_SECRET_KEY || "";

  if (!base || !appKey || !accessKey || !secretKey) {
    console.error("Set FIIX_BASE, FIIX_APP_KEY, FIIX_ACCESS_KEY, FIIX_SECRET_KEY");
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
    const text = (await resp.text()).trim();
    if (!(text.startsWith("{") || text.startsWith("["))) {
      return { error: { message: "Non-JSON response", snippet: text.slice(0, 200) } };
    }
    return JSON.parse(text);
  }

  const candidates = [
    "intWorkOrderID",
    "intWorkOrderId",
    "strDescription",
    "strTaskDescription",
    "strName",
    "intAssignedToUserID",
    "intAssignedToUserId",
    "intUserID",
    "intUserId",
    "intUserGroupID",
    "intUserGroupId",
    "intTaskStatusID",
    "intTaskStatusId"
  ];

  console.log("Probing WorkOrderTask fields...");
  for (const f of candidates) {
    const req = {
      _maCn: "FindRequest",
      clientVersion: { major: 2, minor: 8, patch: 1 },
      className: "WorkOrderTask",
      fields: `id,${f}`,
      maxObjects: 1
    };

    const data = await fiixCall(req);
    if (data?.error) {
      console.log(`${f}: ERROR -> ${data.error.message}`);
    } else {
      const obj = (data.objects || [])[0];
      console.log(`${f}: OK -> ${obj ? obj[f] : "(no rows returned)"}`);
    }
  }
})();