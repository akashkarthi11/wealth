// Daily backup (TSD Claude Plan 3, TR3-6.1). Every public.wealth_* table is exported as JSON from Postgres in one
// consistent read, gzipped and encrypted (AES-256-GCM, key derived from WEALTH_BACKUP_KEY), then stored in the
// private Vercel Blob store (BLOB_READ_WRITE_TOKEN). Backups are never removed by the app (retention is the owner's
// decision, DV3-4). Restore: scripts/db/restore-backup.mjs.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { sql, txBatch } from './_lib.js';

const MAGIC = Buffer.from('WLB1');   // file = MAGIC | iv(12) | tag(16) | ciphertext

export const backupKey = secret => {
  const s = String(secret || '').trim();
  if (s.length < 32) throw Object.assign(new Error('WEALTH_BACKUP_KEY must be at least 32 characters'), { code: 'CONFIG' });
  return createHash('sha256').update(s).digest();
};

export function encryptBackup(obj, secret) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', backupKey(secret), iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(obj)))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(buf, secret) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Wealth Ledger backup file');
  const iv = buf.subarray(4, 16), tag = buf.subarray(16, 32);
  const d = createDecipheriv('aes-256-gcm', backupKey(secret), iv);
  d.setAuthTag(tag);
  return JSON.parse(gunzipSync(Buffer.concat([d.update(buf.subarray(32)), d.final()])).toString('utf8'));
}

// { manifest, tables: { name: [rows…] } } — rows are JSON produced by Postgres (numerics keep their text form).
export async function dumpDatabase(db = sql, now = new Date()) {
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name LIKE 'wealth\\_%' ORDER BY 1`)).map(r => r.table_name);
  const ident = n => '"' + n.replace(/"/g, '""') + '"';
  const results = await txBatch(db, tables.map(t => [`SELECT coalesce(json_agg(x), '[]'::json)::text AS j FROM ${ident(t)} x`, []]));
  const out = { manifest: { format: 'wealth-backup/1', takenAt: now.toISOString(), environment: process.env.VERCEL_ENV || 'local', counts: {} }, tables: {} };
  tables.forEach((t, i) => { const rows = JSON.parse(results[i][0].j); out.tables[t] = rows; out.manifest.counts[t] = rows.length; });
  return out;
}

export async function uploadBackup(buf, { env = process.env, now = new Date() } = {}) {
  const token = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('BLOB_READ_WRITE_TOKEN is not set (connect a private Blob store)'), { code: 'CONFIG' });
  const { put } = await import('@vercel/blob');
  const name = `backups/wealth-${env.VERCEL_ENV || 'local'}-${now.toISOString().replace(/[:.]/g, '-')}.wlb`;
  const r = await put(name, buf, { access: env.WEALTH_BACKUP_BLOB_ACCESS || 'private', token, addRandomSuffix: true, contentType: 'application/octet-stream' });
  return { pathname: r.pathname, size: buf.length };
}

export async function runBackup({ db = sql, env = process.env, now = new Date() } = {}) {
  const dump = await dumpDatabase(db, now);
  const buf = encryptBackup(dump, env.WEALTH_BACKUP_KEY);
  const stored = await uploadBackup(buf, { env, now });
  return { ...stored, tables: Object.keys(dump.tables).length, rows: Object.values(dump.manifest.counts).reduce((a, b) => a + b, 0) };
}
