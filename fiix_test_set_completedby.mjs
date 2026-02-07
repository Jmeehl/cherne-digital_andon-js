import crypto from "crypto";

(async () => {
  const base = (process.env.FIIX_BASE || "").replace(/\/2\/?$/, "");
  const appKey = process.env.FIIX_APP_KEY || "";
  const accessKey = process.env.FIIX_ACCESS_KEY || "";
  const secretKey = process.env.FIIX_SECRET_KEY || "";

  const woCode = process.argv[2];          // e.g. 97499
  const completedById = Number(process.argv[3]); // e.g. 375171

  if (!base || !appKey || !accessKey || !secretKey || !woCode || !completedById) {
    console.error("Usage: node fiix_test_set_completedby.mjs <WorkOrderCode> <CompletedByUserId>");
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
    return JSON.parse(await resp.text());
  }

  // 1) Find WO id by strCode
  const find = await fiixCall({
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: "WorkOrder",
    fields: "id,strCode,intCompletedByUserID",
    filters: [{ ql: "strCode = ?", parameters: [String(woCode)] }],
    maxObjects: 1
  });

  if (find?.error) {
    console.error("Find error:", find.error);
    process.exitCode = 1;
    return;
  }

  const wo = (find.objects || [])[0];
  if (!wo) {
    console.log("No WO found for code", woCode);
    return;
  }

  console.log("Before:", { id: wo.id, intCompletedByUserID: wo.intCompletedByUserID });

  // 2) ChangeRequest: set intCompletedByUserID
  const change = await fiixCall({
    _maCn: "ChangeRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: "WorkOrder",
    id: Number(wo.id),
    changeFields: "intCompletedByUserID",
    object: {
      className: "WorkOrder",
      id: Number(wo.id),
      intCompletedByUserID: completedById
    },
    fields: "id"
  });

  if (change?.error) {
    console.error("Change error:", change.error);
    process.exitCode = 1;
    return;
  }

  // 3) Read back
  const after = await fiixCall({
    _maCn: "FindRequest",
    clientVersion: { major: 2, minor: 8, patch: 1 },
    className: "WorkOrder",
    fields: "id,strCode,intCompletedByUserID",
    filters: [{ ql: "id = ?", parameters: [Number(wo.id)] }],
    maxObjects: 1
  });

  if (after?.error) {
    console.error("After Find error:", after.error);
    process.exitCode = 1;
    return;
  }

  const wo2 = (after.objects || [])[0];
  console.log("After:", { id: wo2.id, intCompletedByUserID: wo2.intCompletedByUserID });
})();