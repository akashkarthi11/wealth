import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { describe, plan, copyAll } from '../db/copy-lib.mjs';

const schema = `
  create table wealth_users (id uuid primary key, email text not null);
  create table wealth_accounts (id serial primary key, user_id uuid not null references wealth_users(id),
    parent_id int references wealth_accounts(id), balance numeric(30,10) not null);
  create table wealth_snapshots (id bigint generated always as identity primary key, account_id int references wealth_accounts(id),
    total numeric, doubled numeric generated always as (total * 2) stored);
  create table other_table (x int);`;

async function dbs() {
  const src = new PGlite(), dst = new PGlite();
  await src.exec(schema); await dst.exec(schema);
  await src.exec(`
    insert into wealth_users values ('00000000-0000-0000-0000-000000000001', 'a@x');
    insert into wealth_accounts (user_id, parent_id, balance) values
      ('00000000-0000-0000-0000-000000000001', null, 12345678901234567890.0123456789),
      ('00000000-0000-0000-0000-000000000001', 1, 5);
    insert into wealth_snapshots (account_id, total) values (1, 10), (2, 20);
    insert into other_table values (1);`);
  await dst.exec(`insert into wealth_users values ('00000000-0000-0000-0000-000000000009', 'old@x');
    insert into other_table values (7);`);
  return { src, dst };
}

test('copies wealth_* tables exactly, keeps precision, resets sequences, ignores other tables', async () => {
  const { src, dst } = await dbs();
  const p = plan(await describe(src), await describe(dst));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.copy.map(t => t.name), ['wealth_users', 'wealth_accounts', 'wealth_snapshots']);
  await copyAll(src, dst, p.copy);
  const bal = (await dst.query('select balance::text b from wealth_accounts order by id')).rows.map(r => r.b);
  assert.deepEqual(bal, ['12345678901234567890.0123456789', '5.0000000000']);
  assert.deepEqual((await dst.query('select email from wealth_users')).rows, [{ email: 'a@x' }]);
  assert.deepEqual((await dst.query('select doubled::int d from wealth_snapshots order by id')).rows, [{ d: 20 }, { d: 40 }]);
  await dst.exec(`insert into wealth_accounts (user_id, balance) values ('00000000-0000-0000-0000-000000000001', 1);
    insert into wealth_snapshots (total) values (1);`);
  assert.equal((await dst.query('select max(id)::int m from wealth_accounts')).rows[0].m, 3);
  assert.equal((await dst.query('select max(id)::int m from wealth_snapshots')).rows[0].m, 3);
  assert.deepEqual((await dst.query('select x from other_table')).rows, [{ x: 7 }]);
});

test('handles foreign-key cycles and keeps the constraints', async () => {
  const { src, dst } = await dbs();
  const cyc = `create table wealth_obl (id int primary key, sub_id int);
    create table wealth_subs (id int primary key, obl_id int references wealth_obl(id));
    alter table wealth_obl add constraint obl_sub foreign key (sub_id) references wealth_subs(id);`;
  await src.exec(cyc); await dst.exec(cyc);
  await src.exec(`insert into wealth_obl values (1, null); insert into wealth_subs values (1, 1); update wealth_obl set sub_id = 1;`);
  const p = plan(await describe(src), await describe(dst));
  await copyAll(src, dst, p.copy);
  assert.deepEqual((await dst.query('select sub_id from wealth_obl')).rows, [{ sub_id: 1 }]);
  const { rows } = await dst.query(`select count(*)::int n from pg_constraint where contype = 'f'`);
  assert.equal(rows[0].n, 5);
  await assert.rejects(dst.query('insert into wealth_subs values (2, 99)'));
});

test('empties target-only tables that reference copied tables when asked', async () => {
  const { src, dst } = await dbs();
  await dst.exec(`create table wealth_extra (user_id uuid references wealth_users(id));
    insert into wealth_extra values ('00000000-0000-0000-0000-000000000009');`);
  const p = plan(await describe(src), await describe(dst));
  assert.deepEqual(p.extra, ['wealth_extra']);
  await assert.rejects(copyAll(src, dst, p.copy));
  await copyAll(src, dst, p.copy, undefined, p.extra);
  assert.equal((await dst.query('select count(*)::int n from wealth_extra')).rows[0].n, 0);
  assert.deepEqual((await dst.query('select email from wealth_users')).rows, [{ email: 'a@x' }]);
});

test('refuses when target lacks a table or column', async () => {
  const { src, dst } = await dbs();
  await src.exec('create table wealth_extra (id int); alter table wealth_users add column phone text;');
  const p = plan(await describe(src), await describe(dst));
  assert.equal(p.copy.length, 0);
  assert.equal(p.errors.length, 2);
});

test('rolls back the target when an insert fails', async () => {
  const { src, dst } = await dbs();
  await dst.exec('alter table wealth_accounts add constraint small check (balance < 100)');
  const p = plan(await describe(src), await describe(dst));
  await assert.rejects(copyAll(src, dst, p.copy));
  assert.deepEqual((await dst.query('select email from wealth_users')).rows, [{ email: 'old@x' }]);
});
