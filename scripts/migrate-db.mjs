import { neon } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';

if(process.env.VERCEL&&process.env.VERCEL_ENV!=='production'){
 console.log('[db-migrate] Preview deployment; production database migrations skipped.');
 process.exit(0);
}
const databaseUrl=process.env.POSTGRES_URL||process.env.WEALTH_DATABASE_URL||process.env.DATABASE_URL;
if(!databaseUrl){
 if(process.env.VERCEL)throw new Error('Database URL is required to run production schema migrations');
 console.log('[db-migrate] No database URL; skipped outside Vercel.');
 process.exit(0);
}
const sql=neon(databaseUrl);

async function runRecurringObligationsMigration(){
 const url=new URL('./migrations/2026-11-10-recurring-obligations.sql',import.meta.url);
 const source=await readFile(url,'utf8');
 // The migration contains only ordinary SQL statements; execute one statement per Neon request.
 // It is additive and idempotent, so a partial deployment can safely retry it.
 const statements=source
  .replace(/^\s*--.*$/gm,'')
  .replace(/^\s*BEGIN;\s*$/im,'')
  .replace(/^\s*COMMIT;\s*$/im,'')
  .split(';')
  .map(statement=>statement.trim())
  .filter(Boolean);
 for(const statement of statements) await sql.query(statement);
 console.log('[db-migrate] Recurring obligations migration applied:',statements.length,'statements');
}

async function runMandateDuplicateCleanupMigration(){
 const url=new URL('./migrations/2026-11-10-reconcile-mandate-bill-duplicates.sql',import.meta.url);
 const source=await readFile(url,'utf8');
 const statements=source
  .replace(/^\\s*--.*$/gm,'')
  .replace(/^\\s*BEGIN;\\s*$/im,'')
  .replace(/^\\s*COMMIT;\\s*$/im,'')
  .split(';')
  .map(statement=>statement.trim())
  .filter(Boolean);
 for(const statement of statements) await sql.query(statement);
 console.log('[db-migrate] Mandate/planned-bill duplicate cleanup applied:',statements.length,'statements');
}

async function runAngelOnePriceHistoryMigration(){
 const url=new URL('./migrations/2026-11-10-angelone-ltp-price-history.sql',import.meta.url);
 const source=await readFile(url,'utf8');
 const statements=source
  .replace(/^\\s*--.*$/gm,'')
  .split(';')
  .map(statement=>statement.trim())
  .filter(Boolean);
 for(const statement of statements) await sql.query(statement);
 const counts=await sql.query(`SELECT
  (SELECT count(*)::int FROM wealth_investment_assets WHERE user_id=(SELECT id FROM wealth_users WHERE role='admin' ORDER BY created_at LIMIT 1) AND position_id IS NULL) AS history_only_assets,
  (SELECT count(*)::int FROM wealth_price_history WHERE source='Angel One historical snapshot') AS angelone_history_rows`);
 console.log('[db-migrate] Angel One historical LTP backfill ready:',JSON.stringify(counts[0]||{}));
}

async function migrate(){
 // Idempotent schema migration: safe to run on every deployment and on both preview/production DBs.
 await sql.query(`CREATE TABLE IF NOT EXISTS wealth_category_symbols (
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  category_key text NOT NULL,
  display_symbol text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,category_key),
  CONSTRAINT wealth_category_symbols_nonempty CHECK (length(trim(display_symbol)) BETWEEN 1 AND 16)
 )`);
 await sql.query(`CREATE TABLE IF NOT EXISTS wealth_investment_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL UNIQUE REFERENCES wealth_positions(id) ON DELETE CASCADE,
  asset_class text NOT NULL,
  symbol text,
  display_name text NOT NULL,
  quantity_unit text NOT NULL,
  price_currency char(3) NOT NULL,
  price_source text,
  price_source_symbol text,
  pricing_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wealth_investment_assets_status_check CHECK (pricing_status IN ('active','pending','manual','unsupported','stale'))
 )`);
 await sql.query(`CREATE TABLE IF NOT EXISTS wealth_market_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL UNIQUE REFERENCES wealth_investment_assets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  unit_price numeric(24,10) NOT NULL,
  currency char(3) NOT NULL,
  source text NOT NULL,
  source_timestamp timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'fresh',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT wealth_market_prices_status_check CHECK (status IN ('fresh','stale','error','manual'))
 )`);
 await sql.query(`CREATE TABLE IF NOT EXISTS wealth_price_history (
  id bigserial PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES wealth_investment_assets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,
  unit_price numeric(24,10) NOT NULL,
  currency char(3) NOT NULL,
  source text NOT NULL,
  source_timestamp timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
 )`);
 // Existing deployments may have these tables without their original unique constraints.
 // Add the exact conflict-target indexes required by the idempotent upserts below.
 await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS wealth_investment_assets_position_id_uidx ON wealth_investment_assets(position_id)');
 await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS wealth_category_symbols_user_category_uidx ON wealth_category_symbols(user_id,category_key)');
 // Backfill defaults on legacy versions of these tables that were created before defaults existed.
 await sql.query('ALTER TABLE wealth_investment_assets ALTER COLUMN id SET DEFAULT gen_random_uuid()');
 await sql.query("ALTER TABLE wealth_investment_assets ALTER COLUMN created_at SET DEFAULT now()");
 await sql.query("ALTER TABLE wealth_investment_assets ALTER COLUMN updated_at SET DEFAULT now()");
 await sql.query("ALTER TABLE wealth_category_symbols ALTER COLUMN updated_at SET DEFAULT now()");
 await sql.query('CREATE INDEX IF NOT EXISTS wealth_investment_assets_user_class_idx ON wealth_investment_assets(user_id,asset_class)');
 await sql.query('CREATE INDEX IF NOT EXISTS wealth_price_history_asset_time_idx ON wealth_price_history(asset_id,recorded_at DESC)');

 // Restore metal quantities from the original metadata field without changing saved valuation/cost.
 await sql.query(`UPDATE wealth_positions
  SET quantity=(metadata->>'quantity')::numeric,updated_at=now()
  WHERE record_type IN ('GOLD','SILVER') AND quantity IS NULL
    AND metadata ? 'quantity'
    AND (metadata->>'quantity') ~ '^[0-9]+(\\.[0-9]+)?$'`);

 // Create price-tracked asset definitions for supported quantity-based positions.
 await sql.query(`INSERT INTO wealth_investment_assets
  (user_id,position_id,asset_class,symbol,display_name,quantity_unit,price_currency,price_source,price_source_symbol,pricing_status)
  SELECT p.user_id,p.id,
   CASE WHEN p.record_type IN ('GOLD','SILVER') THEN 'precious_metal'
        WHEN p.record_type='ETF' THEN 'us_etf' ELSE 'us_equity' END,
   COALESCE(p.ticker,CASE p.record_type WHEN 'GOLD' THEN 'GOLD' WHEN 'SILVER' THEN 'SILVER' END),
   p.name,CASE WHEN p.record_type IN ('GOLD','SILVER') THEN 'g' ELSE 'share' END,
   p.currency::char(3),'Yahoo Finance',
   CASE p.record_type WHEN 'GOLD' THEN 'GC=F' WHEN 'SILVER' THEN 'SI=F' ELSE p.ticker END,
   'pending'
  FROM wealth_positions p
  WHERE p.record_type IN ('GOLD','SILVER','ETF','US_EQUITY')
    AND p.quantity IS NOT NULL AND p.quantity>0
  ON CONFLICT(position_id) DO UPDATE SET
   asset_class=EXCLUDED.asset_class,symbol=EXCLUDED.symbol,display_name=EXCLUDED.display_name,
   quantity_unit=EXCLUDED.quantity_unit,price_currency=EXCLUDED.price_currency,
   price_source=EXCLUDED.price_source,price_source_symbol=EXCLUDED.price_source_symbol,
   updated_at=now()`);

 // Provision the unified recurring-obligation model after the legacy source tables exist.
 await runRecurringObligationsMigration();
 await runAngelOnePriceHistoryMigration();

 // Reconcile duplicate planned-bill reminders against active bank mandates.
 await runMandateDuplicateCleanupMigration();

 // Ensure each account has its default category icon. User-customized symbols are preserved.
 await sql.query(`INSERT INTO wealth_category_symbols(user_id,category_key,display_symbol)
  SELECT u.id,v.category_key,v.display_symbol
  FROM wealth_users u CROSS JOIN (VALUES
   ('fixed_deposit','▤'),('provident_fund','◎'),('equity','↗'),('indmoney_us','＄'),
   ('mutual_fund','◫'),('gold','◆'),('silver','◇')
  ) AS v(category_key,display_symbol)
  ON CONFLICT(user_id,category_key) DO NOTHING`);

 const counts=await sql.query(`SELECT
  (SELECT count(*)::int FROM wealth_investment_assets) AS assets,
  (SELECT count(*)::int FROM wealth_category_symbols) AS category_symbols,
  (SELECT count(*)::int FROM wealth_positions WHERE record_type IN ('GOLD','SILVER') AND quantity IS NOT NULL) AS metal_quantities`);
 console.log('[db-migrate] Wealth schema ready:',JSON.stringify(counts[0]||{}));
}
migrate().catch(error=>{console.error('[db-migrate] Failed:',error?.message||error);process.exit(1)});
