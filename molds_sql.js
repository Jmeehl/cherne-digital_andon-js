// molds_sql.js (server-side)
// Read-only SQL Server access for mold + oven dashboards.

import sql from "mssql";

let poolPromise = null;

function assertSqlEnv() {
  const needed = ["MSSQL_HOST", "MSSQL_DB", "MSSQL_USER", "MSSQL_PASSWORD"];
  const missing = needed.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing SQL env vars: ${missing.join(", ")}`);
  }
}

export function getSqlConfigFromEnv() {
  // Optional: enforce env presence early (recommended)
  assertSqlEnv();

  return {
    server: process.env.MSSQL_HOST,
    database: process.env.MSSQL_DB,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: {
      encrypt: String(process.env.MSSQL_ENCRYPT ?? "false") === "true",
      trustServerCertificate: String(process.env.MSSQL_TRUST_CERT ?? "true") === "true",
      useUTC: false   // ✅ IMPORTANT: treat SQL datetime as local time
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 20000,
  };
}

export async function getPool() {
  // Single, resilient pool initializer
  if (!poolPromise) {
    const cfg = getSqlConfigFromEnv();
    poolPromise = new sql.ConnectionPool(cfg)
      .connect()
      .catch((err) => {
        poolPromise = null; // allow retry next time
        throw err;
      });
  }
  return poolPromise;
}

// Latest mold status per MoldNumber (your existing logic)
// molds_sql.js
export async function fetchLatestMolds() {
  const pool = await getPool();
  const result = await pool.request().query(`
    WITH ranked AS (
      SELECT
        MoldNumber,
        MoldSize,
        CyclesSinceLastCleaning,
        TTDCycles,
        Extract_DateTime,
        MoldClose_DateTime,
        ROW_NUMBER() OVER (
          PARTITION BY MoldSize, MoldNumber
          ORDER BY Extract_DateTime DESC, MoldClose_DateTime DESC
        ) AS rn
      FROM dbo.MoldData
      WHERE MoldNumber IS NOT NULL
        AND MoldSize IS NOT NULL
    )
    SELECT
      MoldNumber,
      MoldSize,
      CyclesSinceLastCleaning,
      TTDCycles,
      Extract_DateTime,
      MoldClose_DateTime
    FROM ranked
    WHERE rn = 1;
  `);
  return Array.isArray(result.recordset) ? result.recordset : [];
}

// Cure KPIs for a range (filled only):
// - last cure minutes (most recent extract in range)
// - average cure minutes across range
export async function fetchOvenCureKpis({ startDate, endDate }) {
  const pool = await getPool();

  const result = await pool.request()
    .input("start", sql.DateTime2, startDate)
    .input("end",   sql.DateTime2, endDate)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldClose_DateTime,
          Extract_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, Extract_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          Extract_DateTime IS NOT NULL
          AND Extract_DateTime >= @start
          AND Extract_DateTime <  @end
          AND Plug_Present_In_Mold = 1
      ),
      events AS (
        SELECT
          Extract_DateTime,
          CASE
            WHEN MoldClose_DateTime IS NOT NULL
             AND Extract_DateTime >= MoldClose_DateTime
            THEN DATEDIFF(second, MoldClose_DateTime, Extract_DateTime) / 60.0
            ELSE NULL
          END AS CureMinutes
        FROM base
        WHERE rn = 1
      )
      SELECT
        (SELECT TOP 1 CureMinutes
         FROM events
         WHERE CureMinutes IS NOT NULL
         ORDER BY Extract_DateTime DESC) AS LastCureMinutes,
        AVG(CureMinutes) AS AvgCureMinutes
      FROM events;
    `);

  const row = Array.isArray(result.recordset) ? result.recordset[0] : null;
  return {
    lastCureMinutes: row?.LastCureMinutes ?? null,
    avgCureMinutes: row?.AvgCureMinutes ?? null
  };
}

// Counts completed molds per hour by MoldSize where Plug_Present_In_Mold = 1
export async function fetchPlugPerformanceByHour(startDate, endDate) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("start", sql.DateTime2, startDate)
    .input("end", sql.DateTime2, endDate)
    .query(`
      SELECT
        DATEADD(hour, DATEDIFF(hour, 0, Extract_DateTime), 0) AS HourBucket,
        MoldSize AS PlugSize,
        COUNT(*) AS CompletedCount
      FROM dbo.MoldData
      WHERE
        Extract_DateTime IS NOT NULL
        AND Extract_DateTime >= @start
        AND Extract_DateTime <  @end
        AND Plug_Present_In_Mold = 1
      GROUP BY
        DATEADD(hour, DATEDIFF(hour, 0, Extract_DateTime), 0),
        MoldSize
      ORDER BY
        HourBucket ASC,
        PlugSize ASC;
    `);

  return Array.isArray(result.recordset) ? result.recordset : [];
}

/**
 * Realtime oven performance:
 * - buckets close events by MoldClose_DateTime in N-minute buckets
 * - filters Plug_Present_In_Mold = 1
 * - groups by bucket + MoldSize
 * - includes AvgBakeMinutes where bake = Extract_DateTime - MoldClose_DateTime
 * - meta: last close + bake minutes for most recent close within range
 */
export async function fetchOvenRealtime({ startDate, endDate, bucketMinutes = 5 }) {
  const pool = await getPool();
  const bucket = Math.max(1, Math.min(60, Number(bucketMinutes) || 5));

  const result = await pool.request()
    .input("start", sql.DateTime2, startDate)
    .input("end",   sql.DateTime2, endDate)
    .input("bucket", sql.Int, bucket)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldSize,
          MoldClose_DateTime,
          Extract_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, Extract_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          Extract_DateTime IS NOT NULL
          AND Extract_DateTime >= @start
          AND Extract_DateTime <  @end
          AND Plug_Present_In_Mold = 1
      ),
      events AS (
        SELECT
          MoldNumber,
          MoldSize,
          MoldClose_DateTime,
          Extract_DateTime,
          DATEADD(minute, (DATEDIFF(minute, 0, Extract_DateTime) / @bucket) * @bucket, 0) AS BucketTime,
          CASE
            WHEN Extract_DateTime IS NOT NULL AND Extract_DateTime >= MoldClose_DateTime
              THEN DATEDIFF(minute, MoldClose_DateTime, Extract_DateTime)
            ELSE NULL
          END AS BakeMinutes
        FROM base
        WHERE rn = 1
      )
      SELECT
        BucketTime,
        MoldSize AS PlugSize,
        COUNT(*) AS CloseCount,
        AVG(CAST(BakeMinutes AS float)) AS AvgBakeMinutes
      FROM events
      GROUP BY BucketTime, MoldSize
      ORDER BY BucketTime ASC, MoldSize ASC;
    `);

  const meta = await pool.request()
    .input("start", sql.DateTime2, startDate)
    .input("end",   sql.DateTime2, endDate)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldClose_DateTime,
          Extract_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, Extract_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          Extract_DateTime IS NOT NULL
          AND Extract_DateTime >= @start
          AND Extract_DateTime <  @end
          AND Plug_Present_In_Mold = 1
      ),
      events AS (
        SELECT
          Extract_DateTime,
          CASE
            WHEN Extract_DateTime IS NOT NULL AND Extract_DateTime >= MoldClose_DateTime
              THEN DATEDIFF(minute, MoldClose_DateTime, Extract_DateTime)
            ELSE NULL
          END AS BakeMinutes
        FROM base
        WHERE rn = 1
      )
      SELECT TOP 1
        Extract_DateTime AS LastExtract,
        BakeMinutes      AS LastBakeMinutes
      FROM events
      ORDER BY Extract_DateTime DESC;
    `);

  const rows = Array.isArray(result.recordset) ? result.recordset : [];
  const metaRow = Array.isArray(meta.recordset) ? meta.recordset[0] : null;
  return { rows, meta: metaRow ?? null };
}

// molds_sql.js
// Counts filled vs empty molds per bucket (Plug_Present_In_Mold 1/0) and totals for a range.

export async function fetchOvenFillStats({ startDate, endDate, bucketMinutes = 5 }) {
  const pool = await getPool();
  const bucket = Math.max(1, Math.min(60, Number(bucketMinutes) || 5));

  const result = await pool.request()
    .input("start", sql.DateTime2, startDate)
    .input("end",   sql.DateTime2, endDate)
    .input("bucket", sql.Int, bucket)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldSize,
          MoldClose_DateTime,
          Extract_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, Extract_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          Extract_DateTime IS NOT NULL
          AND Extract_DateTime >= @start
          AND Extract_DateTime <  @end
      ),
      events AS (
        SELECT
          DATEADD(minute, (DATEDIFF(minute, 0, Extract_DateTime) / @bucket) * @bucket, 0) AS BucketTime,
          MoldSize AS PlugSize,
          CASE WHEN Plug_Present_In_Mold = 1 THEN 1 ELSE 0 END AS IsFilled
        FROM base
        WHERE rn = 1
      )
      SELECT BucketTime, PlugSize, IsFilled, COUNT(*) AS Cnt
      FROM events
      GROUP BY BucketTime, PlugSize, IsFilled
      ORDER BY BucketTime ASC, PlugSize ASC, IsFilled ASC;
    `);

  return Array.isArray(result.recordset) ? result.recordset : [];
}

