// Scheduling decisions use PostgreSQL's clock as the single source of truth.
// The application clock is intentionally used only for elapsed execution budgets.
export async function nextJobRunFromDb(db,time,frequency='daily',timezone='Asia/Kolkata') {
  const rows=await db.query(`WITH clock AS (
      SELECT now() AS now_at, $1::time AS local_time, $2::text AS frequency, $3::text AS timezone
    ), dates AS (
      SELECT c.*, d::date AS local_date
      FROM clock c
      CROSS JOIN LATERAL generate_series(
        (c.now_at AT TIME ZONE c.timezone)::date,
        (c.now_at AT TIME ZONE c.timezone)::date + 8,
        interval '1 day'
      ) AS d
    ), candidates AS (
      SELECT ((local_date + local_time) AT TIME ZONE timezone) AS run_at,
        frequency, local_date
      FROM dates
    )
    SELECT run_at
    FROM candidates
    WHERE run_at > (SELECT now_at FROM clock)
      AND (frequency <> 'weekdays' OR EXTRACT(ISODOW FROM local_date) < 6)
    ORDER BY run_at
    LIMIT 1`,[String(time).slice(0,5),frequency,timezone]);
  if(!rows.length||!rows[0].run_at)throw new Error('Could not calculate the next scheduled run from database time.');
  return rows[0].run_at;
}
