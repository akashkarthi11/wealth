import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PROVIDER = 'fincrux';
const clean = value => String(value ?? '').trim();

function encryptionKey() {
  const secret = clean(process.env.WEALTH_SESSION_SECRET);
  if (secret.length < 32) throw new Error('WEALTH_SESSION_SECRET must be configured before database provider keys can be used.');
  return createHash('sha256').update('wealth-provider-api-keys:v1:').update(secret).digest();
}

export function encryptProviderKey(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(clean(value), 'utf8'), cipher.final()]);
  return { encrypted_key: encrypted.toString('base64url'), key_iv: iv.toString('base64url'), key_tag: cipher.getAuthTag().toString('base64url') };
}

export function decryptProviderKey(row) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.key_iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(row.key_tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_key, 'base64url')), decipher.final()]).toString('utf8');
}

const fingerprint = value => createHash('sha256').update(clean(value)).digest('hex');
const mask = value => '••••' + clean(value).slice(-4);

export async function listFincruxKeyMetadata(db, userId) {
  const rows = await db.query("SELECT id,label,encrypted_key,key_iv,key_tag,priority,enabled,user_agent,assigned_tickers,created_at,updated_at FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2 ORDER BY priority,id", [userId, PROVIDER]);
  const database = rows.map(row => {
    try {
      const value = decryptProviderKey(row);
      return { id: row.id, label: row.label, masked: mask(value), priority: row.priority, enabled: row.enabled, source: 'database', last4: value.slice(-4), user_agent: row.user_agent || 'WealthPersonalStockResearch/1.0', assigned_tickers: Array.isArray(row.assigned_tickers) ? row.assigned_tickers : [] };
    } catch {
      return { id: row.id, label: row.label, masked: 'Unavailable', priority: row.priority, enabled: false, source: 'database', error: 'Cannot decrypt; check the session secret has not changed.' };
    }
  });
  const environment = [];
  for (let i = 1; i <= 10; i++) {
    const name = i === 1 ? 'FINCRUX_API_KEY' : 'FINCRUX_API_KEY_' + i;
    const value = clean(process.env[name]);
    if (value) environment.push({ id: 'env:' + name, label: name, masked: mask(value), priority: i, enabled: true, source: 'environment', last4: value.slice(-4) });
  }
  return { database, environment, total_enabled: database.filter(x => x.enabled && !x.error).length + environment.length };
}

export function selectFincruxKeysForTicker(keys, ticker) {
  const available = Array.isArray(keys) ? keys : [];
  if (!available.length) return [];
  // Stable automatic sharding: the same ticker starts with the same key, while
  // different tickers are spread across active keys. Remaining keys stay in
  // rotation order as fallbacks if the preferred key is unavailable or limited.
  const symbol = clean(ticker).toUpperCase();
  const hash = createHash('sha256').update(symbol).digest();
  const start = hash.readUInt32BE(0) % available.length;
  return available.slice(start).concat(available.slice(0, start));
}

export async function loadFincruxApiKeys(db) {
  const owners = await db.query("SELECT id FROM wealth_users WHERE role='admin' ORDER BY created_at LIMIT 1");
  const userId = owners[0]?.id;
  const databaseRows = userId ? await db.query("SELECT id,label,encrypted_key,key_iv,key_tag,priority,enabled,user_agent,assigned_tickers FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2 AND enabled=true ORDER BY priority,id", [userId, PROVIDER]) : [];
  const output = [], seen = new Set();
  for (const row of databaseRows) {
    try {
      const value = decryptProviderKey(row), fp = fingerprint(value);
      if (!value || seen.has(fp)) continue;
      seen.add(fp);
      output.push({ id: row.id, label: row.label, value, source: 'database', user_agent: row.user_agent || 'WealthPersonalStockResearch/1.0', assigned_tickers: Array.isArray(row.assigned_tickers) ? row.assigned_tickers : [] });
    } catch (error) {
      console.warn('[fincrux-keys] encrypted key unavailable', row.id, error?.message || error);
    }
  }
  for (let i = 1; i <= 10; i++) {
    const name = i === 1 ? 'FINCRUX_API_KEY' : 'FINCRUX_API_KEY_' + i;
    const value = clean(process.env[name]);
    if (!value) continue;
    const fp = fingerprint(value);
    if (seen.has(fp)) continue;
    seen.add(fp);
    output.push({ id: 'env:' + name, label: name, value, source: 'environment', user_agent: 'WealthPersonalStockResearch/1.0', assigned_tickers: [] });
  }
  return output;
}

// Generic single-key providers (owner's request 2026-11-24: "every card need edit option"). Fincrux keeps its own
// multi-key, ticker-sharded functions above; these are for the AI Gateway, Groq and Tavily keys, which need only one
// active value each. Reuses the same table and encryption — "one row per provider" is enforced here, in the
// application, rather than by a schema change, since wealth_provider_api_keys already allows any provider.
// A provider with no key at all (TejHQ, MFAPI, NSE, Agent web, Period match) can still have a row saved here; nothing
// reads it today, and the UI says so, but saving one is harmless — there is nothing to invent, only an unused value.
const SINGLE_KEY_LABEL = provider => provider + ' key';

export async function getStoredProviderKey(db, userId, provider) {
  const [row] = await db.query('SELECT id,label,encrypted_key,key_iv,key_tag,created_at,updated_at FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2 ORDER BY created_at DESC LIMIT 1', [userId, String(provider)]);
  if (!row) return null;
  try {
    const value = decryptProviderKey(row);
    return { id: row.id, label: row.label, masked: mask(value), last4: value.slice(-4), source: 'database', updated_at: row.updated_at };
  } catch {
    return { id: row.id, label: row.label, masked: 'Unavailable', source: 'database', error: 'Cannot decrypt; check the session secret has not changed.' };
  }
}

// For a runtime call site: the decrypted value if one is stored, else null (env var is the caller's own fallback).
export async function loadStoredProviderKeyValue(db, provider) {
  const owners = await db.query("SELECT id FROM wealth_users WHERE role='admin' ORDER BY created_at LIMIT 1");
  const userId = owners[0]?.id;
  if (!userId) return null;
  const [row] = await db.query('SELECT encrypted_key,key_iv,key_tag FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2 ORDER BY created_at DESC LIMIT 1', [userId, String(provider)]);
  if (!row) return null;
  try { const value = decryptProviderKey(row); return value || null; } catch { return null; }
}

// Replaces any previously saved key for this provider: single-key providers have exactly one row, not a list.
export async function saveStoredProviderKey(db, userId, provider, key) {
  const value = clean(key);
  if (value.length < 4 || value.length > 500) throw Object.assign(new Error('Enter a key (4–500 characters).'), { status: 400 });
  const encrypted = encryptProviderKey(value);
  const fp = fingerprint(value);
  await db.query('DELETE FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2', [userId, String(provider)]);
  const [saved] = await db.query("INSERT INTO wealth_provider_api_keys (user_id,provider,label,encrypted_key,key_iv,key_tag,key_fingerprint,priority,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,1,true) RETURNING id", [userId, String(provider), SINGLE_KEY_LABEL(provider), encrypted.encrypted_key, encrypted.key_iv, encrypted.key_tag, fp]);
  return saved;
}

export async function deleteStoredProviderKey(db, userId, provider, id) {
  const deleted = await db.query('DELETE FROM wealth_provider_api_keys WHERE id=$1 AND user_id=$2 AND provider=$3 RETURNING id', [id, userId, String(provider)]);
  return deleted.length > 0;
}

export async function addFincruxApiKey(db, userId, { key, label }) {
  const value = clean(key);
  if (value.length < 8 || value.length > 500) throw Object.assign(new Error('Enter a valid Fincrux API key.'), { status: 400 });
  const safeLabel = clean(label).slice(0, 60) || 'Fincrux key';
  const fp = fingerprint(value);
  const [existing] = await db.query('SELECT id FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2 AND key_fingerprint=$3', [userId, PROVIDER, fp]);
  if (existing) throw Object.assign(new Error('This API key is already in your saved list.'), { status: 409 });
  const encrypted = encryptProviderKey(value);
  const [count] = await db.query('SELECT count(*)::int AS total FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2', [userId, PROVIDER]);
  if (Number(count?.total || 0) >= 10) throw Object.assign(new Error('You can save up to 10 database override keys.'), { status: 400 });
  const [position] = await db.query('SELECT COALESCE(max(priority),0)+1 AS next FROM wealth_provider_api_keys WHERE user_id=$1 AND provider=$2', [userId, PROVIDER]);
  const [saved] = await db.query("INSERT INTO wealth_provider_api_keys (user_id,provider,label,encrypted_key,key_iv,key_tag,key_fingerprint,priority,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id,label,priority,enabled", [userId, PROVIDER, safeLabel, encrypted.encrypted_key, encrypted.key_iv, encrypted.key_tag, fp, Number(position?.next || 1)]);
  return saved;
}
