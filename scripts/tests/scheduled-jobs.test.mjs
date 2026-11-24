import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextJobRunFromDb } from '../../api/_lib/scheduled-job-time.js';
import { migratedDb } from './helpers/pglite.mjs';

test('the nightly route owns interest and backup at 01:30 IST; dispatcher excludes legacy duplicates',()=>{
  const vercel=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
  assert.ok(vercel.crons.some(c=>c.path==='/api/nightly'&&c.schedule==='0 20 * * *'));
  const jobs=readFileSync(new URL('../../api/_lib/scheduled-jobs.js',import.meta.url),'utf8');
  assert.match(jobs,/handler_key NOT IN \('interest-accrual','backup'\)/);
  assert.match(jobs,/\['interest-accrual','backup'\]\.includes\(job\.handler_key\).*status:'blocked'/);
  const nightly=readFileSync(new URL('../../api/_routes/nightly.js',import.meta.url),'utf8');
  const migration=readFileSync(new URL('../migrations/0052_scheduled_job_skipped_status.sql',import.meta.url),'utf8');
  assert.match(migration,/CHECK \(status IN \('running','succeeded','partial','failed','skipped'\)\)/);
  const router=readFileSync(new URL('../../api/router.js',import.meta.url),'utf8');
  const retired=readFileSync(new URL('../../api/_routes/interest-accrual.js',import.meta.url),'utf8');
  assert.match(router,/'nightly':/);
  assert.match(retired,/json\(res,410/);
  assert.match(nightly,/runAccrual/);
  assert.match(nightly,/runBackup/);
});

// Scheduling moved to PostgreSQL's clock (nextJobRunFromDb), so these can no longer pin an arbitrary "now".
// They assert the same properties the old pure-function tests did, against the real implementation.
test('a scheduled time is interpreted in Asia/Kolkata and always lands in the future', async () => {
  const { a } = await migratedDb();
  for (const time of ['18:30', '02:33', '23:59']) {
    const next = await nextJobRunFromDb(a, time, 'daily');
    assert.ok(next instanceof Date && Number.isFinite(next.getTime()), time + ' returns a date');
    assert.ok(next.getTime() > Date.now() - 1000, time + ' is in the future, never a time already passed');
    const [row] = await a.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS ist`, [next.toISOString()]);
    assert.equal(row.ist, time, 'the hour and minute are the local Indian time, not UTC');
  }
});

test('a due time earlier than now moves to a later day, never today', async () => {
  const { a } = await migratedDb();
  const [{ ist_now }] = await a.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS ist_now`);
  if (ist_now <= '00:05') return;   // nothing has passed yet today; the check has no meaning
  const next = await nextJobRunFromDb(a, '00:01', 'daily');
  const [row] = await a.query(`SELECT ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date > (now() AT TIME ZONE 'Asia/Kolkata')::date AS later`, [next.toISOString()]);
  assert.equal(row.later, true, 'a time already gone today is scheduled for a following day');
});

test('a weekday schedule never lands on a Saturday or Sunday in Asia/Kolkata', async () => {
  const { a } = await migratedDb();
  const next = await nextJobRunFromDb(a, '09:45', 'weekdays');
  const [row] = await a.query(`SELECT extract(isodow FROM ($1::timestamptz AT TIME ZONE 'Asia/Kolkata'))::int AS dow`, [next.toISOString()]);
  assert.ok(row.dow >= 1 && row.dow <= 5, 'got ISO weekday ' + row.dow);
});

test('the Jobs screen shows backup is unconfigured directly, not only after a failed run', () => {
  // The backup cron card said only "Waiting for first recorded invocation" until it had failed once. Backup had never
  // run and the admin had no way to see why from this screen (owner's request 2026-11-24).
  const route = readFileSync(new URL('../../api/_routes/jobs.js', import.meta.url), 'utf8');
  assert.match(route, /import \{ sql, json, sessionUser, configStatus \} from '\.\.\/_lib\.js'/, 'reuses the existing presence-only check');
  assert.match(route, /const backupConfigured=configStatus\(\)\.backup/);
  assert.match(route, /schedulerActivity,backupConfigured/, 'sent to the page');

  const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  assert.match(app, /data\?\.backupConfigured===false\?'Set WEALTH_BACKUP_KEY/);
  assert.match(app, /BLOB_READ_WRITE_TOKEN in the Vercel project/);
  assert.match(app, /never shown here, cannot be set from this screen/, 'still never settable or shown from the app, same rule as every other secret');
  assert.match(app, /notConfigured\?'Needs setup'/);
});
