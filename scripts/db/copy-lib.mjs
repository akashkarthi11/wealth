// Core of scripts/db/copy-db.mjs: copy every public.wealth_* table from one Postgres database to another.
// `source` and `target` are clients with query(text, params) -> { rows } (pg / Neon Pool client / PGlite).
// Row data moves as JSON text from Postgres to Postgres and is never parsed in JS, so numerics keep full precision.

const ident = name => '"' + String(name).replace(/"/g, '""') + '"';

export async function describe(db, prefix = 'wealth_') {
  const like = prefix.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const { rows: cols } = await db.query(
    `select c.table_name, c.column_name, c.is_generated, c.identity_generation, c.column_default
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name like $1
      order by c.table_name, c.ordinal_position`, [like]);
  const { rows: fks } = await db.query(
    `select ch.relname as child, pa.relname as parent, k.conname, pg_get_constraintdef(k.oid) as def
       from pg_constraint k
       join pg_class ch on ch.oid = k.conrelid
       join pg_class pa on pa.oid = k.confrelid
      where k.contype = 'f' and k.connamespace = 'public'::regnamespace`);
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, { name: c.table_name, columns: [], parents: new Set(), fks: [] });
    tables.get(c.table_name).columns.push({
      name: c.column_name,
      generated: c.is_generated === 'ALWAYS',
      identity: c.identity_generation || null,
      serial: /nextval\(/i.test(c.column_default || ''),
    });
  }
  for (const { child, parent, conname, def } of fks) {
    if (!tables.has(child)) continue;
    tables.get(child).fks.push({ name: conname, parent, def });
    if (child !== parent) tables.get(child).parents.add(parent);
  }
  return tables;
}

// Parents before children where possible (cycles are broken arbitrarily; foreign keys between
// copied tables are dropped during the load and re-validated afterwards, so order is cosmetic).
export function topoOrder(names, tables) {
  const set = new Set(names), out = [], state = new Map();
  const visit = n => {
    if (state.has(n)) return;
    state.set(n, 1);
    for (const p of [...tables.get(n).parents].sort()) if (set.has(p)) visit(p);
    out.push(n);
  };
  for (const n of [...names].sort()) visit(n);
  return out;
}

export function plan(src, dst) {
  const errors = [], warnings = [], copy = [];
  for (const [name, t] of src) {
    const d = dst.get(name);
    if (!d) { errors.push(`${name}: missing in target (apply the schema there first)`); continue; }
    const dCols = new Map(d.columns.map(c => [c.name, c]));
    const missing = t.columns.filter(c => !dCols.has(c.name)).map(c => c.name);
    if (missing.length) { errors.push(`${name}: target lacks column(s) ${missing.join(', ')}`); continue; }
    const srcNames = new Set(t.columns.map(c => c.name));
    const extra = d.columns.filter(c => !srcNames.has(c.name)).map(c => c.name);
    if (extra.length) warnings.push(`${name}: target-only column(s) ${extra.join(', ')} will get their defaults`);
    const columns = t.columns.filter(c => !dCols.get(c.name).generated).map(c => dCols.get(c.name));
    copy.push({ name, columns, fks: d.fks, overriding: columns.some(c => c.identity === 'ALWAYS') });
  }
  const copied = new Set(copy.map(c => c.name));
  for (const c of copy) c.fks = c.fks.filter(f => copied.has(f.parent));
  const extra = [...dst.keys()].filter(name => !src.has(name));
  for (const name of extra) warnings.push(`${name}: exists only in target (emptied only with --empty-target-only)`);
  if (errors.length) return { errors, warnings, copy: [], extra };
  const order = topoOrder(copy.map(c => c.name), dst);
  const byName = new Map(copy.map(c => [c.name, c]));
  return { errors, warnings, copy: order.map(n => byName.get(n)), extra };
}

export async function count(db, table) {
  const { rows } = await db.query(`select count(*)::int as n from ${ident(table)}`);
  return rows[0].n;
}

// Yields JSON-array text chunks of the given columns.
export async function* readChunks(db, table, columns, chunk = 2000) {
  const list = columns.map(c => ident(c.name)).join(', ');
  for (let offset = 0; ; offset += chunk) {
    const { rows } = await db.query(
      `select json_agg(x)::text as j, count(*)::int as n
         from (select ${list} from ${ident(table)} order by ctid limit $1 offset $2) x`, [chunk, offset]);
    if (!rows[0].n) return;
    yield rows[0].j;
    if (rows[0].n < chunk) return;
  }
}

async function resetSequences(db, t) {
  for (const c of t.columns) {
    if (!c.identity && !c.serial) continue;
    const { rows } = await db.query('select pg_get_serial_sequence($1, $2) as s', [ident(t.name), c.name]);
    if (!rows[0].s) continue;
    await db.query(
      `select case when m is null then setval($1, 1, false) else setval($1, m, true) end
         from (select max(${ident(c.name)})::bigint as m from ${ident(t.name)}) x`, [rows[0].s]);
  }
}

// Replaces the target's rows with the source's for every table in the plan, in one target transaction.
// The caller must already have opened a consistent read transaction on `source`.
// `emptyTables`: extra target-only tables to empty in the same truncate (e.g. ones referencing copied tables).
export async function copyAll(source, target, copyPlan, log = () => {}, emptyTables = []) {
  const expected = {};
  for (const t of copyPlan) expected[t.name] = await count(source, t.name);
  await target.query('begin');
  try {
    for (const t of copyPlan) for (const f of t.fks) await target.query(`alter table ${ident(t.name)} drop constraint ${ident(f.name)}`);
    const wipe = [...copyPlan.map(t => t.name), ...emptyTables];
    if (wipe.length) await target.query(`truncate table ${wipe.map(ident).join(', ')} restart identity`);
    for (const t of copyPlan) {
      const list = t.columns.map(c => ident(c.name)).join(', ');
      const sql = `insert into ${ident(t.name)} (${list}) ${t.overriding ? 'overriding system value ' : ''}` +
        `select ${list} from json_populate_recordset(null::${ident(t.name)}, $1::json)`;
      for await (const json of readChunks(source, t.name, t.columns)) await target.query(sql, [json]);
      await resetSequences(target, t);
      const got = await count(target, t.name);
      if (got !== expected[t.name]) throw new Error(`${t.name}: copied ${got} rows, expected ${expected[t.name]}`);
      log(t.name, got);
    }
    // Re-adding validates every row, so a broken reference aborts the whole copy.
    for (const t of copyPlan) for (const f of t.fks) await target.query(`alter table ${ident(t.name)} add constraint ${ident(f.name)} ${f.def}`);
    await target.query('commit');
  } catch (e) {
    await target.query('rollback').catch(() => {});
    throw e;
  }
  return expected;
}

// JSON backup text of the given tables: {"table": [rows], ...}
export async function backup(db, tables) {
  const parts = [];
  for (const t of tables) {
    const chunks = [];
    for await (const j of readChunks(db, t.name, t.columns)) chunks.push(j.slice(1, -1));
    parts.push(`${JSON.stringify(t.name)}: [${chunks.filter(Boolean).join(',')}]`);
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}
