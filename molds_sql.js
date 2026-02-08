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
export async function fetchLatestMolds() {
  const pool = await getPool();
  const result = await pool.request().query(`
    WITH ranked AS (
       SELECT
        MoldNumber,
        MoldSize,
        MoldClose_DateTime,
+       Extract_DateTime,
        Plug_Present_In_Mold,
        ROW_NUMBER() OVER (
          PARTITION BY MoldNumber, MoldClose_DateTime
          ORDER BY Extract_DateTime DESC
        ) AS rn
      FROM dbo.MoldData
...
      WHERE MoldNumber IS NOT NULL
    )
    SELECT
      MoldNumber,
      MoldSize,
      CyclesSinceLastCleaning,
      TTDCycles,
      Extract_DateTime
    FROM ranked
    WHERE rn = 1;
  `);

  return Array.isArray(result.recordset) ? result.recordset : [];
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
        DATEADD(hour, DATEDIFF(hour, 0, MoldClose_DateTime), 0) AS HourBucket,
        MoldSize AS PlugSize,
        COUNT(*) AS CompletedCount
      FROM dbo.MoldData
      WHERE
        MoldClose_DateTime IS NOT NULL
        AND MoldClose_DateTime >= @start
        AND MoldClose_DateTime < @end
        AND Plug_Present_In_Mold = 1
      GROUP BY
        DATEADD(hour, DATEDIFF(hour, 0, MoldClose_DateTime), 0),
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

  // Main time-series aggregation
  const result = await pool
    .request()
    .input("start", sql.DateTime2, startDate)
    .input("end", sql.DateTime2, endDate)
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
            PARTITION BY MoldNumber, MoldClose_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          MoldClose_DateTime IS NOT NULL
          AND MoldClose_DateTime >= @start
          AND MoldClose_DateTime < @end
          AND Plug_Present_In_Mold = 1
      ),
      events AS (
        SELECT
          MoldNumber,
          MoldSize,
          MoldClose_DateTime,
          Extract_DateTime,
          DATEADD(minute, (DATEDIFF(minute, 0, MoldClose_DateTime) / @bucket) * @bucket, 0) AS BucketTime,
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

  // Meta: most recent close and its bake time in the same window
  const meta = await pool
    .request()
    .input("start", sql.DateTime2, startDate)
    .input("end", sql.DateTime2, endDate)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldClose_DateTime,
          Extract_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, MoldClose_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          MoldClose_DateTime IS NOT NULL
          AND MoldClose_DateTime >= @start
          AND MoldClose_DateTime < @end
          AND Plug_Present_In_Mold = 1
      ),
      events AS (
        SELECT
          MoldClose_DateTime,
          CASE
            WHEN Extract_DateTime IS NOT NULL AND Extract_DateTime >= MoldClose_DateTime
              THEN DATEDIFF(minute, MoldClose_DateTime, Extract_DateTime)
            ELSE NULL
          END AS BakeMinutes
        FROM base
        WHERE rn = 1
      )
      SELECT TOP 1
        MoldClose_DateTime AS LastClose,
        BakeMinutes AS LastBakeMinutes
      FROM events
      ORDER BY MoldClose_DateTime DESC;
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
    .input("end", sql.DateTime2, endDate)
    .input("bucket", sql.Int, bucket)
    .query(`
      ;WITH base AS (
        SELECT
          MoldNumber,
          MoldSize,
          MoldClose_DateTime,
          Plug_Present_In_Mold,
          ROW_NUMBER() OVER (
            PARTITION BY MoldNumber, MoldClose_DateTime
            ORDER BY Extract_DateTime DESC
          ) AS rn
        FROM dbo.MoldData
        WHERE
          MoldClose_DateTime IS NOT NULL
          AND MoldClose_DateTime >= @start
          AND MoldClose_DateTime < @end
      ),
      events AS (
        SELECT
          DATEADD(minute, (DATEDIFF(minute, 0, MoldClose_DateTime) / @bucket) * @bucket, 0) AS BucketTime,
          MoldSize AS PlugSize,
          CASE WHEN Plug_Present_In_Mold = 1 THEN 1 ELSE 0 END AS IsFilled
        FROM base
        WHERE rn = 1
      )
      SELECT
        BucketTime,
        PlugSize,
        IsFilled,
        COUNT(*) AS Cnt
      FROM events
      GROUP BY BucketTime, PlugSize, IsFilled
      ORDER BY BucketTime ASC, PlugSize ASC, IsFilled ASC;
    `);

  return Array.isArray(result.recordset) ? result.recordset : [];
}
