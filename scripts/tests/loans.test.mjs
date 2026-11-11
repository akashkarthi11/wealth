// Plan 4 Part B (0020): people (own contacts), bill splits (equal / amounts per person, GST shared), money lent and paid
// back via transfers or cash, what each person owes, suggestions, and safety — transactions never change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers/pglite.mjs';
import { loansOverview, savePerson, addPersonEntry, createSplit, cancelSplit, computeShares, personOf, personFigures, moveEntry, markSharePaid, roundOff, setRecordStatus } from '../../api/_loans.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const J = x => JSON.stringify(x);

async function setup() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [acc] = await a.query(`INSERT INTO wealth_accounts(user_id,account_key,bank_name,account_name,account_type,subtype_code,currency)
    VALUES($1,'hdfc','HDFC Bank','HDFC Bank Savings','savings','savings','INR') RETURNING id`, [u.id]);
  const tx = (kind, category, description, amount, day) => a.query(`INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,account_id,occurred_on)
    VALUES($1,$2,$3,$4,$5,'',$6,$7) RETURNING id`, [u.id, kind, category, description, amount, acc.id, day]).then(r => r[0].id);
  const ids = {
    dinner: await tx('expense', 'Food & dining', 'Sangeetha dinner', 1180, '2026-11-10'),
    taxi: await tx('expense', 'Travel', 'Uber', 600, '2026-11-09'),
    dinoOut: await tx('transfer', 'Transfer sent', 'Dinoraj P · UPI · ref 1', 5000, '2026-03-01'),
    dinoIn: await tx('transfer', 'Transfer received', 'Dinoraj P · UPI · ref 2', 5000, '2026-04-01'),
    anOut: await tx('transfer', 'Transfer sent', 'Mr Anantha Raj Maria · UPI · ref 3', 12000, '2026-05-01'),
    anIn: await tx('transfer', 'Transfer received', 'Anantha Raj Maria · UPI · ref 4', 7000, '2026-06-01'),
    ndx: await tx('transfer', 'Transfer sent', 'NDX P2P Pvt Ltd · UPI', 15000, '2023-11-20'),
    arun: await tx('transfer', 'Transfer sent', 'UPI transfer to Arun S', 5000, '2026-11-11'),
    arunBack: await tx('transfer', 'Transfer received', 'Arun S · UPI', 300, '2026-11-11'),
  };
  return { a, uid: u.id, ids };
}

test('split maths: equal, amounts per person with GST shared by part, exact paise', () => {
  const eq = computeShares({ total: 1000, tax: 0, mode: 'equal', includeMe: true, people: [{ key: 'a' }, { key: 'b' }] });
  assert.equal(J(eq.map(s => s.amount)), J([333.34, 333.33, 333.33]));
  // ₹1,180 bill incl. ₹180 GST; A had ₹300, B ₹200 of food; you the rest (₹500)
  const am = computeShares({ total: 1180, tax: 180, mode: 'amounts', includeMe: true, people: [{ key: 'a', base: 300 }, { key: 'b', base: 200 }] });
  assert.equal(J(am.map(s => [s.key, s.base, s.tax, s.amount])), J([['me', 500, 90, 590], ['a', 300, 54, 354], ['b', 200, 36, 236]]));
  assert.throws(() => computeShares({ total: 100, mode: 'amounts', people: [{ key: 'a', base: 150 }] }), /more than the bill/);
  assert.throws(() => computeShares({ total: 100, mode: 'amounts', includeMe: false, people: [{ key: 'a', base: 50 }] }), /add up/);
  assert.throws(() => computeShares({ total: 100, mode: 'equal', people: [] }), /at least one person/);
  assert.equal(personOf('Mr Arun S · UPI · HDFC statement · ref 3933'), 'Arun S');
});

test('split a bill from its transaction, adding new people on the way; each person owes their share; transaction unchanged', async () => {
  const { a, uid, ids } = await setup();
  const r = await createSplit(uid, { transactionId: ids.dinner, taxPercent: 18, mode: 'amounts', people: [{ name: 'Arun S', base: 300 }, { name: 'Priya', base: 200 }] }, { db: a, now: NOW });
  assert.deepEqual([r.stored, r.total, r.tax, r.myShare, r.othersOwe, r.title], [true, 1180, 180, 590, 590, 'Sangeetha dinner']);
  await createSplit(uid, { transactionId: ids.taxi, mode: 'equal', people: [{ name: 'priya' }] }, { db: a, now: NOW });   // same person, any case
  const o = await loansOverview(uid, { db: a, now: NOW });
  const by = Object.fromEntries(o.people.map(p => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['Arun S', 'Priya']);
  assert.deepEqual([by.Priya.owed, by.Priya.bills, by['Arun S'].owed], [536, 2, 354]);
  assert.deepEqual([o.totals.owed, o.totals.people, o.totals.splits], [890, 2, 2]);
  const s = o.splits.find(x => x.transactionId === ids.dinner);
  assert.equal(J(s.shares.map(x => [x.name, x.amount])), J([['You', 590], ['Arun S', 354], ['Priya', 236]]));
  const [t] = await a.query(`SELECT kind, amount::float8 AS amount FROM wealth_transactions WHERE id = $1`, [ids.dinner]);
  assert.deepEqual({ ...t }, { kind: 'expense', amount: 1180 });
  await assert.rejects(createSplit(uid, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'X' }] }, { db: a, now: NOW }), /already split/);
  // cancel → no longer counted, can split again
  await cancelSplit(uid, { splitId: s.id }, { db: a, now: NOW });
  const o2 = await loansOverview(uid, { db: a, now: NOW });
  assert.equal(o2.people.find(p => p.name === 'Arun S').owed, 0);
  await createSplit(uid, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'Arun S' }] }, { db: a, now: NOW });
});

test('money lent and paid back via transfers and cash; paying back reduces what is owed; settle', async () => {
  const { a, uid, ids } = await setup();
  await createSplit(uid, { title: 'Movie', total: 600, mode: 'equal', people: [{ name: 'Arun S' }] }, { db: a, now: NOW });   // no transaction
  await addPersonEntry(uid, { name: 'Arun S', transactionIds: [ids.arun] }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'arun s', transactionId: ids.arunBack }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'Arun S', direction: 'in', amount: 1000, occurredOn: '2026-11-11', note: 'cash' }, { db: a, now: NOW });
  let p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.deepEqual([p.lent, p.repaid, p.owed, p.items.length], [5300, 1300, 4000, 4]);
  await assert.rejects(addPersonEntry(uid, { name: 'Other', transactionIds: [ids.arun] }, { db: a, now: NOW }), /already linked/);
  await assert.rejects(addPersonEntry(uid, { name: 'Other', transactionIds: [ids.dinner] }, { db: a, now: NOW }), /Only transfers/);
  await savePerson(uid, { personId: p.id, status: 'settled' }, { db: a, now: NOW });
  p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.deepEqual([p.status, p.owed], ['settled', 0]);
  const f = personFigures([{ direction: 'out', amount: 10000, on: '2025-11-11' }], { annualRate: 0.12, status: 'open', today: '2026-11-11' });
  assert.deepEqual([f.interest, f.owed], [1200, 11200]);
});

test('suggestions: people with sent and received transfers and P2P; gone once linked; never created automatically', async () => {
  const { a, uid } = await setup();
  let o = await loansOverview(uid, { db: a, now: NOW });
  assert.equal(o.people.length, 0);
  assert.equal(o.countedInNetWorth, false);
  assert.deepEqual(o.suggestions.map(s => s.person).sort(), ['Anantha Raj Maria', 'Arun S', 'Dinoraj P', 'NDX P2P Pvt Ltd']);
  const an = o.suggestions.find(s => s.person === 'Anantha Raj Maria');
  await addPersonEntry(uid, { name: an.person, transactionIds: an.transactions.map(t => t.id) }, { db: a, now: NOW });
  o = await loansOverview(uid, { db: a, now: NOW });
  assert.ok(!o.suggestions.some(s => s.person === 'Anantha Raj Maria'));
  assert.equal(o.people[0].owed, 5000);
});

test('safety: names required, no duplicates, no future dates, other users refused, dry run writes nothing', async () => {
  const { a, uid, ids } = await setup();
  await assert.rejects(createSplit(uid, { title: 'X', total: 100, mode: 'equal', people: [{ name: ' ' }] }, { db: a, now: NOW }), /needs a name/);
  await assert.rejects(createSplit(uid, { title: 'X', total: 100, mode: 'equal', people: [{ name: 'A' }, { name: 'a' }] }, { db: a, now: NOW }), /twice/);
  await assert.rejects(createSplit(uid, { total: 100, mode: 'equal', people: [{ name: 'A' }] }, { db: a, now: NOW }), /name/);
  await assert.rejects(addPersonEntry(uid, { name: 'A', direction: 'out', amount: 5, occurredOn: '2027-01-01' }, { db: a, now: NOW }), /future/);
  await assert.rejects(savePerson(uid, { name: 'A', annualRate: 500 }, { db: a, now: NOW }), /annualRate/);
  const [v] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('v@example.test','x','user') RETURNING id`);
  await assert.rejects(createSplit(v.id, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'A' }] }, { db: a, now: NOW }), /Transaction not found/);
  const dry = await createSplit(uid, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'New Friend' }] }, { db: a, now: NOW, dryRun: true });
  assert.deepEqual([dry.myShare, dry.othersOwe], [590, 590]);
  const [n] = await a.query(`SELECT (SELECT count(*) FROM wealth_people)::int p, (SELECT count(*) FROM wealth_bill_splits)::int s`);
  assert.deepEqual({ ...n }, { p: 0, s: 0 });
  await savePerson(uid, { name: 'Ravi' }, { db: a, now: NOW });
  await assert.rejects(savePerson(uid, { name: 'ravi' }, { db: a, now: NOW }), /already in your people/);
});

test('page: split sheet maths match the server (GST by part), people cards, split list, Activity buttons', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Money lent & split bills (Plan 4 Part B'), src.indexOf('// Reward alerts (Plan 4, TR4-A.8)'));
  const ctx = { esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), money: v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    user: { role: 'admin' }, activeView: 'lending', api: async () => ({}), Number, String, Date, Math, JSON, Array, Set, Map, Object };
  vm.runInNewContext(block + ';globalThis.t={splitCompute,lendingPageHtml,lendActivityButtonHtml,lendRowTag,setData:d=>{lendingData=d}};', ctx);
  const c = ctx.t.splitCompute({ total: 1180, taxMode: 'pct', taxVal: 18, includeMe: true, mode: 'amounts', sel: [{ name: 'Arun S', base: 300 }, { name: 'Priya', base: 200 }] });
  const server = computeShares({ total: 1180, tax: 180, mode: 'amounts', includeMe: true, people: [{ key: 'a', base: 300 }, { key: 'b', base: 200 }] });
  assert.equal(J(c.rows.map(r => r.amount)), J(server.map(s => s.amount)));
  assert.equal(c.error, '');
  assert.match(ctx.t.splitCompute({ total: 100, taxMode: 'none', includeMe: true, mode: 'amounts', sel: [{ name: 'A', base: 150 }] }).error, /more than the bill/);
  const { a, uid, ids } = await setup();
  await createSplit(uid, { transactionId: ids.dinner, taxPercent: 18, mode: 'amounts', people: [{ name: 'Arun S', base: 300 }, { name: 'Priya', base: 200 }] }, { db: a, now: NOW });
  const d = await loansOverview(uid, { db: a, now: NOW });
  ctx.t.setData(d);
  const html = ctx.t.lendingPageHtml(d);
  assert.match(html, /Money lent &amp; split bills/);
  assert.match(html, /₹590<\/strong><small>owed to you · 2 people/);
  assert.match(html, /Sangeetha dinner<\/b><small>[^<]*₹1,180 incl\. ₹180 GST · by amount/);
  assert.match(ctx.t.lendActivityButtonHtml({ id: ids.dinner, kind: 'expense', amount: 1180 }), /Split · you ₹590 · Arun S ₹354 · Priya ₹236/);
  assert.match(ctx.t.lendRowTag({ id: ids.dinner }), /act-tag split">Split · 2 people · 2 to pay/);
  assert.match(ctx.t.lendActivityButtonHtml({ id: ids.taxi, kind: 'expense', amount: 600, description: 'Uber', occurred_on: '2026-11-09' }), /data-split-tx="[^"]+"[^>]*>Split bill</);
  assert.match(ctx.t.lendActivityButtonHtml({ id: ids.arun, kind: 'transfer', category: 'Transfer sent', description: 'UPI transfer to Arun S', amount: 5000 }), /data-lend-quick[^>]*data-lend-guess="Arun S">Lent to Arun S<\/button>/);
  assert.match(ctx.t.lendActivityButtonHtml({ id: ids.arun, kind: 'transfer', category: 'Transfer sent', description: 'UPI transfer to Arun S', amount: 5000 }), /data-lend-choose[^>]*>Someone else \/ several people</);
});

test('mark a bill share paid, move a transfer to another person, links for Activity', async () => {
  const { a, uid, ids } = await setup();
  const sp = await createSplit(uid, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'Priya' }] }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'Arun', transactionIds: [ids.arun] }, { db: a, now: NOW });
  let o = await loansOverview(uid, { db: a, now: NOW });
  const priya = o.people.find(p => p.name === 'Priya'), arun = o.people.find(p => p.name === 'Arun');
  assert.deepEqual([priya.owed, priya.unpaidShares], [590, 1]);
  assert.deepEqual(o.links[ids.arun], { type: 'lent', personId: arun.id, name: 'Arun', entryId: arun.items[0].entryId, writtenOff: false });
  assert.equal(o.links[ids.dinner].type, 'split');
  await markSharePaid(uid, { splitId: sp.splitId, personId: priya.id }, { db: a, now: NOW });
  assert.equal((await markSharePaid(uid, { splitId: sp.splitId, personId: priya.id }, { db: a, now: NOW })).already, 'paid');
  // move the ₹5,000 transfer from "Arun" to "Arun S"
  await moveEntry(uid, { entryId: arun.items[0].entryId, name: 'Arun S' }, { db: a, now: NOW });
  o = await loansOverview(uid, { db: a, now: NOW });
  const by = Object.fromEntries(o.people.map(p => [p.name, p]));
  assert.deepEqual([by.Priya.owed, by.Priya.unpaidShares, by.Arun.owed, by['Arun S'].owed], [0, 0, 0, 5000]);
  assert.equal(o.splits[0].shares.find(x => x.name === 'Priya').paid, true);
  assert.equal(o.links[ids.arun].name, 'Arun S');
  // a transfer sent for several people can be split; but not when already linked to one person
  const sp2 = await createSplit(uid, { transactionId: ids.anOut, mode: 'equal', includeMe: false, people: [{ name: 'A1' }, { name: 'A2' }] }, { db: a, now: NOW });
  assert.equal(sp2.othersOwe, 12000);
  await assert.rejects(createSplit(uid, { transactionId: ids.arun, mode: 'equal', people: [{ name: 'X' }] }, { db: a, now: NOW }), /already linked/);
  await assert.rejects(addPersonEntry(uid, { name: 'X', transactionIds: [ids.anOut] }, { db: a, now: NOW }), /split among people/);
});

test('round off: closes every open entry and share, owner decides what is already back, one new amount carried with reference', async () => {
  const { a, uid, ids } = await setup();
  await createSplit(uid, { transactionId: ids.dinner, taxPercent: 18, mode: 'amounts', people: [{ name: 'Arun S', base: 300 }] }, { db: a, now: NOW });   // share ₹354
  await addPersonEntry(uid, { name: 'Arun S', transactionIds: [ids.arun, ids.arunBack] }, { db: a, now: NOW });                                        // +5000 −300
  let p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.equal(p.owed, 5054);
  const dry = await roundOff(uid, { personId: p.id, alreadyBack: 54, newAmount: 4900 }, { db: a, now: NOW, dryRun: true });
  assert.deepEqual([dry.closedItems, dry.totalOwed, dry.alreadyBack, dry.newAmount, dry.roundedBy], [3, 5054, 54, 4900, 100]);
  const r = await roundOff(uid, { personId: p.id, alreadyBack: 54, newAmount: 4900 }, { db: a, now: NOW });
  assert.deepEqual([r.stored, r.closed], [true, 3]);
  p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.deepEqual([p.owed, p.items.length, p.items[0].type, p.items[0].label], [4900, 1, 'carried', 'Carried from round-off']);
  assert.deepEqual([p.rollups.length, p.rollups[0].items.length, p.rollups[0].totalOwed, p.rollups[0].alreadyBack], [1, 3, 5054, 54]);
  // closed entries cannot be moved; the transactions stay linked (no double linking)
  await assert.rejects(moveEntry(uid, { entryId: p.rollups[0].items.find(i => i.entryId).entryId, name: 'Z' }, { db: a, now: NOW }), /round-off/);
  await assert.rejects(addPersonEntry(uid, { name: 'Z', transactionIds: [ids.arun] }, { db: a, now: NOW }), /already linked/);
  // default new amount = total − already back; zero closes everything
  await addPersonEntry(uid, { personId: p.id, direction: 'in', amount: 900, occurredOn: '2026-11-11' }, { db: a, now: NOW });
  const z = await roundOff(uid, { personId: p.id, alreadyBack: 4000 }, { db: a, now: NOW });
  assert.equal(z.newAmount, 0);
  p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.deepEqual([p.owed, p.items.length, p.rollups.length], [0, 0, 2]);
  await assert.rejects(roundOff(uid, { personId: p.id }, { db: a, now: NOW }), /Nothing open/);
});

test('one record at a time: write off (shown, not counted), undo, remove a mistaken link (transaction can be linked again); history with ₹0', async () => {
  const { a, uid, ids } = await setup();
  await addPersonEntry(uid, { name: 'Arun S', transactionIds: [ids.arun] }, { db: a, now: NOW });                          // lent 5,000
  await addPersonEntry(uid, { name: 'Arun S', direction: 'out', amount: 1000, occurredOn: '2026-07-09' }, { db: a, now: NOW }); // lent 1,000
  const sp = await createSplit(uid, { transactionId: ids.dinner, mode: 'equal', people: [{ name: 'Arun S' }] }, { db: a, now: NOW }); // share 590
  let p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.equal(p.owed, 6590);
  const thousand = p.items.find(i => i.amount === 1000), five = p.items.find(i => i.amount === 5000);
  await setRecordStatus(uid, { entryId: thousand.entryId, status: 'written_off' }, { db: a, now: NOW });
  await setRecordStatus(uid, { splitId: sp.splitId, personId: p.id, status: 'written_off' }, { db: a, now: NOW });
  p = (await loansOverview(uid, { db: a, now: NOW })).people[0];
  assert.deepEqual([p.owed, p.writtenOff, p.items.filter(i => i.writtenOff).length, p.unpaidShares, p.history], [5000, 1590, 2, 0, false]);
  await setRecordStatus(uid, { entryId: thousand.entryId, status: 'active' }, { db: a, now: NOW });   // undo
  assert.equal((await loansOverview(uid, { db: a, now: NOW })).people[0].owed, 6000);
  // the ₹5,000 was linked by mistake → remove: hidden, not counted, the transfer is free again and shows in suggestions
  await setRecordStatus(uid, { entryId: five.entryId, status: 'removed' }, { db: a, now: NOW });
  let o = await loansOverview(uid, { db: a, now: NOW });
  assert.deepEqual([o.people[0].owed, o.people[0].items.length, o.links[ids.arun]], [1000, 2, undefined]);
  assert.ok(o.suggestions.some(s => s.person === 'Arun S'));
  await addPersonEntry(uid, { name: 'Ravi', transactionIds: [ids.arun] }, { db: a, now: NOW });           // can be linked again, correctly
  const [tx] = await a.query(`SELECT kind, amount::float8 AS amount FROM wealth_transactions WHERE id = $1`, [ids.arun]);
  assert.deepEqual({ ...tx }, { kind: 'transfer', amount: 5000 });
  await assert.rejects(setRecordStatus(uid, { entryId: five.entryId, status: 'active' }, { db: a, now: NOW }), /not found/);
  // paid back in full → History with ₹0, still listing the entries
  await addPersonEntry(uid, { name: 'Arun S', direction: 'in', amount: 1000, occurredOn: '2026-11-11' }, { db: a, now: NOW });
  o = await loansOverview(uid, { db: a, now: NOW });
  const arun = o.people.find(x => x.name === 'Arun S');
  assert.deepEqual([arun.owed, arun.history, arun.items.length], [0, true, 3]);
  // a person can be removed only when nothing is left on them
  await assert.rejects(savePerson(uid, { personId: arun.id, status: 'removed' }, { db: a, now: NOW }), /entries first/);
  const ghost = await savePerson(uid, { name: 'Typo Name' }, { db: a, now: NOW });
  await savePerson(uid, { personId: ghost.personId, status: 'removed' }, { db: a, now: NOW });
  o = await loansOverview(uid, { db: a, now: NOW });
  assert.ok(!o.people.some(x => x.name === 'Typo Name'));
  const [rows] = await a.query(`SELECT (SELECT count(*) FROM wealth_person_entries)::int e, (SELECT count(*) FROM wealth_people)::int p`);
  assert.deepEqual({ ...rows }, { e: 4, p: 3 }, 'nothing deleted');
});

test('page: write off / undo / remove buttons per record; people who owe nothing are in History with ₹0', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const block = src.slice(src.indexOf('// Money lent & split bills (Plan 4 Part B'), src.indexOf('// Reward alerts (Plan 4, TR4-A.8)'));
  const ctx = { esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), money: v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    user: { role: 'admin' }, activeView: 'lending', api: async () => ({}), Number, String, Date, Math, JSON, Array, Set, Map, Object };
  vm.runInNewContext(block + ';globalThis.t={lendingPageHtml,lendRowTag,setData:d=>{lendingData=d}};', ctx);
  const { a, uid, ids } = await setup();
  await addPersonEntry(uid, { name: 'Arun S', transactionIds: [ids.arun] }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'Arun S', direction: 'out', amount: 1000, occurredOn: '2026-07-09' }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'Priya', direction: 'out', amount: 200, occurredOn: '2026-11-01' }, { db: a, now: NOW });
  await addPersonEntry(uid, { name: 'Priya', direction: 'in', amount: 200, occurredOn: '2026-11-05' }, { db: a, now: NOW });
  let d = await loansOverview(uid, { db: a, now: NOW });
  const thousand = d.people.find(p => p.name === 'Arun S').items.find(i => i.amount === 1000);
  await setRecordStatus(uid, { entryId: thousand.entryId, status: 'written_off' }, { db: a, now: NOW });
  d = await loansOverview(uid, { db: a, now: NOW });
  ctx.t.setData(d);
  const html = ctx.t.lendingPageHtml(d);
  const top = html.slice(0, html.indexOf('lend-history'));
  assert.match(top, /Arun S<\/h4>/);
  assert.ok(!top.includes('Priya</h4>'), 'Priya owes nothing → not at the top');
  assert.match(html, /History · 1 · owe ₹0<\/summary>[\s\S]*Priya<\/h4><span class="bank-chip ok">All paid<\/span>[\s\S]*<b class="">₹0<\/b>/);
  assert.match(html, /written off ₹1,000/);
  assert.match(html, /lend-pay out is-off[\s\S]*?Written off<\/span><button type="button" class="link-btn" data-rec-entry="[^"]+" data-rec-status="active">Undo<\/button>/);
  assert.match(html, /data-rec-status="written_off">Write off<\/button><button type="button" class="link-btn danger" data-rec-entry="[^"]+" data-rec-status="removed">Remove \(mistake\)<\/button>/);
  assert.match(ctx.t.lendRowTag({ id: ids.arun }), /act-tag lent">Lent · Arun S</);
});
