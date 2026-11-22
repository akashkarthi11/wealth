import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCHEDULE_TIMEZONE, DEFAULT_SCHEDULE_TIME, DAILY_POLL_WINDOW,
  isValidScheduleTime, nextScheduledAt, zonedDateTimeToUtc,
  getLocalDateTime, dueScheduleDates
} from '../../api/_lib/stock-advisor-schedule-time.js';

test('schedule defaults to the existing 09:48 IST target and documents the daily polling window',()=>{
  assert.equal(DEFAULT_SCHEDULE_TIME,'09:48');
  assert.equal(SCHEDULE_TIMEZONE,'Asia/Kolkata');
  assert.equal(DAILY_POLL_WINDOW,'09:48–10:47 IST');
});
test('validates time format and enforces the daily-Cron-supported due-time cutoff',()=>{
  assert.equal(isValidScheduleTime('09:48'),true);
  assert.equal(isValidScheduleTime('00:00'),true);
  assert.equal(isValidScheduleTime('09:49'),false);
  assert.equal(isValidScheduleTime('24:00'),false);
  assert.equal(isValidScheduleTime('9:48'),false);
  assert.equal(isValidScheduleTime('noon'),false);
});
test('converts IST scheduled time to UTC correctly',()=>{
  const at=zonedDateTimeToUtc({year:2026,month:11,day:23,hour:9,minute:48},'Asia/Kolkata');
  assert.equal(at.toISOString(),'2026-11-23T04:18:00.000Z');
});
test('daily schedule selects today when the target has not passed',()=>{
  const now=new Date('2026-11-22T03:00:00.000Z'); // 08:30 IST
  assert.equal(nextScheduledAt(now,'09:48','daily').toISOString(),'2026-11-22T04:18:00.000Z');
});
test('schedule edits take effect without changing deployment cron',()=>{
  const now=new Date('2026-11-22T02:00:00.000Z'); // 07:30 IST
  const early=nextScheduledAt(now,'08:00','daily');
  const later=nextScheduledAt(now,'09:48','daily');
  assert.equal(early.toISOString(),'2026-11-22T02:30:00.000Z');
  assert.equal(later.toISOString(),'2026-11-22T04:18:00.000Z');
});
test('daily frequency includes weekends while weekdays skips Saturday and Sunday',()=>{
  const fridayAfterTarget=new Date('2026-11-20T05:00:00.000Z'); // Friday 10:30 IST
  assert.equal(nextScheduledAt(fridayAfterTarget,'09:48','daily').toISOString(),'2026-11-21T04:18:00.000Z');
  assert.equal(nextScheduledAt(fridayAfterTarget,'09:48','weekdays').toISOString(),'2026-11-23T04:18:00.000Z');
});
test('weekday due-date check skips weekends and respects the local cutoff',()=>{
  const beforeTarget=new Date('2026-11-23T04:00:00.000Z'); // Monday 09:30 IST
  assert.deepEqual(dueScheduleDates(beforeTarget,'2026-11-20','09:48','weekdays'),[]);
  const afterTarget=new Date('2026-11-23T04:30:00.000Z'); // Monday 10:00 IST
  assert.deepEqual(dueScheduleDates(afterTarget,'2026-11-20','09:48','weekdays'),['2026-11-23']);
});
test('missed weekday executions are recovered in bounded batches',()=>{
  const now=new Date('2026-11-23T04:30:00.000Z');
  assert.deepEqual(dueScheduleDates(now,'2026-11-17','09:48','weekdays',SCHEDULE_TIMEZONE,3),['2026-11-18','2026-11-19','2026-11-20']);
});
test('timezone conversion uses IANA rules for future DST-aware zones',()=>{
  const at=zonedDateTimeToUtc({year:2026,month:7,day:1,hour:9,minute:0},'Europe/London');
  assert.equal(at.toISOString(),'2026-07-01T08:00:00.000Z');
  const local=getLocalDateTime(at,'Europe/London');
  assert.equal(local.time,'09:00');
});
test('invalid schedule settings fail closed',()=>{
  assert.throws(()=>nextScheduledAt(new Date(),'10:00','daily'),/between 00:00 and 09:48/);
  assert.throws(()=>nextScheduledAt(new Date(),'09:48','weekly'),/Frequency must be daily or weekdays/);
});
const route=readFileSync(new URL('../../api/_routes/stock-advisor-schedule.js',import.meta.url),'utf8');
const service=readFileSync(new URL('../../api/_lib/stock-advisor-schedule-service.js',import.meta.url),'utf8');
const cron=readFileSync(new URL('../../api/_routes/stock-advisor-scheduled.js',import.meta.url),'utf8');
const router=readFileSync(new URL('../../api/router.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../../app.js',import.meta.url),'utf8');
const migration=readFileSync(new URL('../migrations/0042_stock_advisor_dynamic_schedule.sql',import.meta.url),'utf8');
const vercel=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));

test('authenticated GET, PUT and Run Now endpoints are registered',()=>{
  assert.match(router,/'stock-advisor\/schedule':/);
  assert.match(router,/'stock-advisor\/schedule\/run-now':/);
  assert.match(route,/18:45 Asia\\/Kolkata/);
  assert.match(route,/req\.method==='PUT'/);
  assert.match(route,/req\.method==='POST'/);
  assert.match(route,/sessionUser\(req\)/);
});
test('Run Now has a database lock and a recent-run duplicate guard',()=>{
  assert.match(route,/pg_advisory_xact_lock/);
  assert.match(route,/created_at>now\(\)-interval '15 minutes'/);
  assert.match(route,/reused:true/);
});
test('scheduled executions use per-user per-date idempotency and retry failed runs',()=>{
  assert.match(service,/executionKey='scheduled:'\+dateKey/);
  assert.match(service,/ON CONFLICT \(user_id,execution_key\)/);
  assert.match(service,/attempt_count<3/);
  assert.match(service,/dueScheduleDates/);
});
test('saving or disabling a schedule resets the catch-up cursor so intentional downtime is not replayed',()=>{
  assert.match(route,/last_scheduled_date=EXCLUDED\.last_scheduled_date/);
  assert.match(service,/last_scheduled_date/);
  assert.match(route,/local\.time<time\?prior:local\.date/);
});
test('enabling a manual schedule requires at least one saved ticker',()=>{
  assert.match(route,/Select at least one saved investment before enabling the schedule/);
  assert.match(ui,/await api\('\/api\/stock-advisor\/settings'/);
});
test('manual Run Now releases stale leases and prevents concurrent duplicates',()=>{
  assert.match(route,/Manual execution lease expired before completion/);
  assert.match(route,/pg_advisory_xact_lock/);
  assert.match(route,/r\.status IN \('queued','running'\)/);
});
test('scheduled failures retry at most three times, then advance the missed-date cursor',()=>{
  assert.match(service,/attempt_count<3/);
  assert.match(service,/attempt_count\|\|0\)>=3/);
  assert.match(service,/Scheduled run reached its retry limit/);
});
test('scheduler checks saved frequency and never changes portfolio records',()=>{
  assert.match(service,/schedule_frequency/);
  assert.match(service,/record_type IN \('EQUITY','ETF'\)/);
  assert.doesNotMatch(service,/UPDATE wealth_positions|DELETE FROM wealth_positions|INSERT INTO wealth_positions/);
});
test('daily Cron and Preview limitation are explicit in backend and UI',()=>{
  assert.match(route,/18:45 Asia\\/Kolkata/);
  assert.match(cron,/Preview deployments do not receive Vercel Cron events/);
  assert.match(ui,/central dispatcher runs once daily at 18:45 IST/);
  assert.match(ui,/Preview only · Run Now available/);
});
test('schedule migration is additive and stores execution history',()=>{
  assert.match(migration,/ADD COLUMN IF NOT EXISTS schedule_frequency/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS wealth_stock_advisor_schedule_runs/);
  assert.match(migration,/UNIQUE\(user_id,execution_key\)/);
  assert.doesNotMatch(migration,/DROP TABLE|DELETE FROM|TRUNCATE/);
});
test('one central Vercel Cron dispatches the database-driven jobs once daily',()=>{
  assert.deepEqual(vercel.crons,[{path:'/api/jobs/dispatch',schedule:'15 13 * * *'}]);
});
test('frontend saves preferences via PUT and Run Now via POST',()=>{
  assert.match(ui,/api\('\/api\/stock-advisor\/schedule',\{method:'PUT'/);
  assert.match(ui,/api\('\/api\/stock-advisor\/schedule\/run-now',\{method:'POST'/);
  assert.match(ui,/type="time" min="00:00" max="09:48"/);
  assert.match(ui,/advisorScheduleFrequency/);
});
