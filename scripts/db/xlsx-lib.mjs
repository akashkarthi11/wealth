// Minimal .xlsx reader (no dependency): unzips with node:zlib and reads cell values as strings.
// Enough for broker statements: shared strings, inline strings, numbers. Formulas give their cached value.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip / xlsx file');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28),
      extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => method === 8 ? inflateRawSync(raw) : method === 0 ? raw : (() => { throw new Error('unsupported zip method ' + method); })());
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// Returns { [sheetName]: string[][] } (empty cells are '').
export function readXlsx(path) {
  const files = unzip(readFileSync(path));
  const text = name => { const f = files.get(name); return f ? f().toString('utf8') : ''; };
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const rels = Object.fromEntries([...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
  const out = {};
  for (const m of text('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = rels[m[2]] || ''; const xml = text('xl/' + target.replace(/^\/?xl\//, ''));
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = (c[2].match(/t="(\w+)"/) || [])[1];
        let v = ((c[3] || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v == null) { const is = (c[3] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/); v = is ? dec(is[1]) : ''; }
        else v = type === 's' ? shared[+v] : dec(v);
        cells[colIndex(c[1])] = String(v ?? '').replace(/\s+/g, ' ').trim();
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, x => x || ''));
    }
    out[dec(m[1])] = rows;
  }
  return out;
}
