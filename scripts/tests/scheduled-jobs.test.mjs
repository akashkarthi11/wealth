import test from 'node:test';
import assert from 'node:assert/strict';
import { nextJobRun } from '../../api/_lib/scheduled-jobs.js';

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
