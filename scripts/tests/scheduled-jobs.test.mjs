import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextJobRun } from '../../api/_lib/scheduled-job-time.js';

test('the nightly route owns interest and backup at 01:30 IST; dispatcher excludes legacy duplicates',()=>{
  const vercel=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
  assert.ok(vercel.crons.some(c=>c.path==='/api/nightly'&&c.schedule==='0 20 * * *'));
  const jobs=readFileSync(new URL('../../api/_lib/scheduled-jobs.js',import.meta.url),'utf8');
  assert.match(jobs,/handler_key NOT IN \('interest-accrual','backup'\)/);
  assert.match(jobs,/job.handler_key==='interest-accrual'.*status:'blocked'/);
  const nightly=readFileSync(new URL('../../api/_routes/nightly.js',import.meta.url),'utf8');
  const migration=readFileSync(new URL('../migrations/0049_scheduled_job_skipped_status.sql',import.meta.url),'utf8');
  assert.match(migration,/CHECK \(status IN \('running','succeeded','partial','failed','skipped'\)\)/);
  const router=readFileSync(new URL('../../api/router.js',import.meta.url),'utf8');
  const retired=readFileSync(new URL('../../api/_routes/interest-accrual.js',import.meta.url),'utf8');
  assert.match(router,/'nightly':/);
  assert.match(retired,/json\(res,410/);
  assert.match(nightly,/runAccrual/);
  assert.match(nightly,/runBackup/);
});

test('daily schedule is calculated in Asia/Kolkata, not UTC',()=>{
  const next=nextJobRun(new Date('2026-11-22T11:00:00.000Z'),'18:30','daily');
  assert.equal(next.toISOString(),'2026-11-22T13:00:00.000Z');
});

test('a passed due time moves to the next local day',()=>{
  const next=nextJobRun(new Date('2026-11-22T14:00:00.000Z'),'18:30','daily');
  assert.equal(next.toISOString(),'2026-11-23T13:00:00.000Z');
});

test('weekday schedules skip Saturday and Sunday in the configured timezone',()=>{
  const next=nextJobRun(new Date('2026-11-21T12:00:00.000Z'),'09:45','weekdays');
  assert.equal(next.toISOString(),'2026-11-23T04:15:00.000Z');
});

test('a run at the exact scheduled minute advances to the next occurrence',()=>{
  const next=nextJobRun(new Date('2026-11-22T13:00:00.000Z'),'18:30','daily');
  assert.equal(next.toISOString(),'2026-11-23T13:00:00.000Z');
});
