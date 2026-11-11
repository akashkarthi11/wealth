// Day change (2026-11-11): previous close = last stored price before the latest price's IST trading day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migratedDb } from './helpers/pglite.mjs';
import { legacyPositionRows } from '../../api/_queries.js';

async function seed() {
  const { a } = await migratedDb();
  const [u] = await a.query(`INSERT INTO wealth_users(email,password_hash,role) VALUES('o@example.test','x','admin') RETURNING id`);
  const [p] = await a.query(`INSERT INTO wealth_positions(user_id,category,platform_name,record_type,name,ticker,currency,quantity,current_value,invested_value,balance_as_of)
    VALUES($1,'INVESTMENT','Angel One','EQUITY','ITC','ITC','INR',160,44608,50123.2,'2026-11-09T10:00:00Z') RETURNING id`, [u.id]);
  const [as] = await a.query(`INSERT INTO wealth_investment_assets(user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
    VALUES($1,$2,'indian_equity','ITC','ITC','share','INR','Yahoo Finance','ITC.NS','active') RETURNING id`, [u.id, p.id]);
  const write = (price, ts, source = 'Yahoo Finance') => a.query(`INSERT INTO wealth_market_prices(asset_id,user_id,unit_price,currency,source,source_timestamp,fetched_at,status,metadata)
    VALUES($1,$2,$3,'INR',$4,$5,now(),'fresh','{}'::jsonb)
    ON CONFLICT(asset_id) DO UPDATE SET unit_price=EXCLUDED.unit_price,source=EXCLUDED.source,source_timestamp=EXCLUDED.source_timestamp,fetched_at=now(),status='fresh'`,
    [as.id, u.id, price, source, ts]);
  const row = async () => (await legacyPositionRows(u.id, a)).find(r => r.ticker === 'ITC');
  return { a, write, row };
}

test('after a market holiday the previous close is the last trading day (10 Nov 2026 NSE holiday)', async () => {
  const { write, row } = await seed();
  await write(279.0, '2026-11-09T06:30:00Z');      // Mon 12:00 IST
  await write(278.8, '2026-11-09T09:58:26Z');      // Mon 15:28 IST (close)
  await write(281.0, '2026-11-11T04:00:00Z');      // Wed 09:30 IST
  await write(282.2, '2026-11-11T04:56:59Z');      // Wed 10:26 IST (latest)
  const r = await row();
  assert.equal(Number(r.market_unit_price), 282.2);
  assert.equal(Number(r.market_previous_close), 278.8, 'Monday close, not an earlier Wednesday quote');
  assert.equal((160 * (Number(r.market_unit_price) - Number(r.market_previous_close))).toFixed(2), '544.00', 'ITC day change');
});

test('no earlier trading day stored → no previous close (day change shown as —)', async () => {
  const { write, row } = await seed();
  await write(282.2, '2026-11-11T04:56:59Z');
  const r = await row();
  assert.equal(r.market_previous_close, null);
});

test('a quote just before IST midnight belongs to the previous day', async () => {
  const { write, row } = await seed();
  await write(270, '2026-11-10T18:20:00Z');        // 23:50 IST on 10 Nov
  await write(275, '2026-11-10T18:40:00Z');        // 00:10 IST on 11 Nov (latest)
  assert.equal(Number((await row()).market_previous_close), 270);
});

// Client: the dashboard card and the Investments page use the same calculation.
const src = readFileSync(new URL('../../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const fn = name => { const s = src.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = src.indexOf('{', s), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };
const consts = src.slice(src.indexOf('const INV_INR='), src.indexOf('function invTime('));
function client(positions) {
  const ctx = { positions, Number, String, Date, Math };
  vm.runInNewContext(consts + ['dayChangeOf', 'istDayKey', 'dayChangeLabel', 'equityLive'].map(fn).join('\n') + ';globalThis.api={dayChangeOf,dayChangeLabel,equityLive};', ctx);
  return ctx.api;
}
const fresh = new Date(Date.now() - 3600e3).toISOString();
const eq = (o) => ({ category: 'INVESTMENT', record_type: 'EQUITY', currency: 'INR', market_price_status: 'fresh', market_price_updated_at: fresh, market_price_as_of: fresh, ...o });

test('client: Angel One day change = sum of quantity × (price − previous close); stale or missing prices are left out', () => {
  const api = client([
    eq({ ticker: 'ITC', quantity: '160', current_value: '45152', invested_value: '50123.2', market_unit_price: '282.2', market_previous_close: '278.8' }),
    eq({ ticker: 'TATAGOLD', quantity: '501', current_value: '6798.57', invested_value: '7630.23', market_unit_price: '13.57', market_previous_close: '13.74' }),
    eq({ ticker: 'NEW', quantity: '1', current_value: '100', invested_value: '90', market_unit_price: '100', market_previous_close: null }),
    eq({ ticker: 'OLD', quantity: '1', current_value: '50', invested_value: '40', market_unit_price: '50', market_previous_close: '45', market_price_updated_at: '2026-01-01T00:00:00Z' }),
    eq({ ticker: 'AAPL', record_type: 'US_EQUITY', currency: 'USD', quantity: '1', current_value: '230', market_unit_price: '230', market_previous_close: '225' }),
  ]);
  const live = api.equityLive();
  assert.equal(live.rows.length, 4, 'Indian stocks only');
  assert.equal(live.dayCount, 2);
  assert.equal(live.day.toFixed(2), (160 * (282.2 - 278.8) + 501 * (13.57 - 13.74)).toFixed(2));
  assert.equal(live.invested.toFixed(2), (50123.2 + 7630.23 + 90 + 40).toFixed(2));
  assert.equal(live.pnl.toFixed(2), (45152 + 6798.57 + 100 + 50 - (50123.2 + 7630.23 + 90 + 40)).toFixed(2));
  assert.equal(api.dayChangeOf({ ...live.rows[0], record_type: 'US_EQUITY', currency: 'USD' }), null);
});

test('client: label is "Today’s gain" for today, otherwise the trading date', () => {
  const api = client([]);
  assert.equal(api.dayChangeLabel(new Date().toISOString()), 'Today’s gain');
  assert.match(api.dayChangeLabel('2026-11-09T09:58:26Z'), /^Day change · 9 Nov$/);
});

test('dashboard Angel One card uses live holdings, not the snapshot, when holdings exist', () => {
  assert.match(src, /const equityDay=eqFromDb\?eqLive\.day:sectionMetric/);
  assert.match(src, /esc\(eqFromDb\?dayChangeLabel\(eqLive\.asOf\):'Today’s gain \(snapshot\)'\)/);
  assert.match(src, /equityDay==null\?'—'/, 'unknown day change shows —, never ₹0');
});
