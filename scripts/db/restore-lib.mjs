// Load a decrypted backup ({manifest, tables}) into a database (TSD Claude Plan 3, TR3-6.1 restore drill).
// `target` is a client with query(text, params) -> { rows } (Neon Pool client or PGlite). The target's rows in the
// restored tables are REPLACED, so callers must refuse production targets (scripts/db/restore-backup.mjs does).
// One transaction: foreign keys between restored tables are dropped and re-added (re-validating every row), and
// user triggers (sync, audit) are disabled while loading so the restore does not create extra rows.
import { describe, topoOrder } from './copy-lib.mjs';

const ident = n => '"' + String(n).replace(/"/g, '""') + '"';

// `allowMissing`: restore what the target can hold and report the rest (drills only; a real restore is strict so no
// backed-up table is silently left out).
export async function restoreAll(target, data, log = () => {}, { allowMissing = false } = {}) {
  const dst = await describe(target);
  const names = Object.keys(data.tables).filter(n => dst.has(n));
  const missing = Object.keys(data.tables).filter(n => !dst.has(n));
  if (missing.length && !allowMissing) throw new Error(`target lacks table(s) ${missing.join(', ')} — apply migrations first`);
  if (missing.length) log('not in the migrated schema (kept in the backup file only): ' + missing.map(n => `${n} (${data.tables[n].length} rows)`).join(', '), null);
  const order = topoOrder(names, dst), restored = new Set(names);
  // Every foreign key that points at a restored table (including from target-only tables, e.g. a backup taken before
  // a newer migration); re-adding them at the end re-validates all rows.
  const fks = [...dst.values()].flatMap(t => t.fks.filter(f => restored.has(f.parent)).map(f => ({ table: t.name, ...f })));
  const counts = {};
  await target.query('begin');
  try {
    for (const f of fks) await target.query(`alter table ${ident(f.table)} drop constraint ${ident(f.name)}`);
    for (const n of order) await target.query(`alter table ${ident(n)} disable trigger user`);
    await target.query(`truncate table ${order.map(ident).join(', ')} restart identity`);
    for (const n of order) {
      const rows = data.tables[n];
      if (rows.length) {
        const present = new Set(Object.keys(rows[0]));
        const cols = dst.get(n).columns.filter(c => !c.generated && present.has(c.name));
        const list = cols.map(c => ident(c.name)).join(', ');
        const overriding = cols.some(c => c.identity === 'ALWAYS') ? 'overriding system value ' : '';
        for (let i = 0; i < rows.length; i += 1000)
          await target.query(`insert into ${ident(n)} (${list}) ${overriding}select ${list} from json_populate_recordset(null::${ident(n)}, $1::json)`,
            [JSON.stringify(rows.slice(i, i + 1000))]);
        for (const c of cols.filter(c => c.identity || c.serial)) {
          const { rows: s } = await target.query('select pg_get_serial_sequence($1, $2) as s', [ident(n), c.name]);
          if (s[0]?.s) await target.query(`select setval($1, greatest((select max(${ident(c.name)}) from ${ident(n)})::bigint, 1))`, [s[0].s]);
        }
      }
      const { rows: [{ k }] } = await target.query(`select count(*)::int as k from ${ident(n)}`);
      if (k !== rows.length) throw new Error(`${n}: restored ${k} rows, backup has ${rows.length}`);
      counts[n] = k; log(n, k);
    }
    for (const n of order) await target.query(`alter table ${ident(n)} enable trigger user`);
    for (const f of fks) await target.query(`alter table ${ident(f.table)} add constraint ${ident(f.name)} ${f.def}`);
    await target.query('commit');
  } catch (e) {
    await target.query('rollback').catch(() => {});
    throw e;
  }
  return counts;
}
