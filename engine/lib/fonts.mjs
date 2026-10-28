// Korean fonts for burned-in subtitles: the same catalog the browser uses (src/fxlogic.js FONT_CATALOG).
// The six classic families are fetched at startup; every other font is fetched the first time a render uses it.
// libass matches the family name stored INSIDE the file, so we read it and hand buildASS a {catalog name -> file name} map.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FONT_CATALOG } from '../../src/fxlogic.js';

export const BASE_FAMILIES = ['Noto Sans KR', 'Black Han Sans', 'Jua', 'Do Hyeon', 'Gothic A1', 'IBM Plex Sans KR'];
const fileFor = info => info.f.replace(/[^A-Za-z0-9]+/g, '') + (/\.otf$/i.test(info.ttf) ? '.otf' : '.ttf');

// libass only scans plain TTF/OTF in fontsdir, so WOFF1 downloads are unpacked into a regular sfnt file
export function woffToSfnt(buf) {
  if (buf.readUInt32BE(0) !== 0x774F4646) return buf;
  const flavor = buf.readUInt32BE(4), n = buf.readUInt16BE(12); const entries = [];
  for (let i = 0; i < n; i++) { const o = 44 + i * 20; const off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12); const raw = buf.subarray(off, off + comp); entries.push({ tag: buf.subarray(o, o + 4), sum: buf.readUInt32BE(o + 16), data: comp < orig ? zlib.inflateSync(raw) : raw }); }
  let pow = 1, log2 = 0; while (pow * 2 <= n) { pow *= 2; log2++; }
  const head = Buffer.alloc(12 + n * 16); head.writeUInt32BE(flavor, 0); head.writeUInt16BE(n, 4); head.writeUInt16BE(pow * 16, 6); head.writeUInt16BE(log2, 8); head.writeUInt16BE(n * 16 - pow * 16, 10);
  const parts = [head]; let off = head.length;
  entries.forEach((e, i) => { const o = 12 + i * 16; e.tag.copy(head, o); head.writeUInt32BE(e.sum, o + 4); head.writeUInt32BE(off, o + 8); head.writeUInt32BE(e.data.length, o + 12); const pad = (4 - (e.data.length % 4)) % 4; parts.push(e.data, Buffer.alloc(pad)); off += e.data.length + pad; });
  return Buffer.concat(parts);
}

// Family name (name ID 1, else 16) from a TTF/OTF or WOFF1 buffer
export function fontFamilyName(buf) {
  try {
    let tables; const sig = buf.readUInt32BE(0);
    if (sig === 0x774F4646) { // 'wOFF'
      const n = buf.readUInt16BE(12); tables = new Map();
      for (let i = 0; i < n; i++) { const o = 44 + i * 20; const tag = buf.toString('latin1', o, o + 4); const off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12); tables.set(tag, () => { const raw = buf.subarray(off, off + comp); return comp < orig ? zlib.inflateSync(raw) : raw; }); }
    } else {
      const n = buf.readUInt16BE(4); tables = new Map();
      for (let i = 0; i < n; i++) { const o = 12 + i * 16; const tag = buf.toString('latin1', o, o + 4); const off = buf.readUInt32BE(o + 8), len = buf.readUInt32BE(o + 12); tables.set(tag, () => buf.subarray(off, off + len)); }
    }
    const get = tables.get('name'); if (!get) return null; const t = get();
    const count = t.readUInt16BE(2), strOff = t.readUInt16BE(4); const found = {};
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 12; const plat = t.readUInt16BE(o), lang = t.readUInt16BE(o + 4), id = t.readUInt16BE(o + 6), len = t.readUInt16BE(o + 8), off = t.readUInt16BE(o + 10);
      if (id !== 1 && id !== 16) continue; const raw = t.subarray(strOff + off, strOff + off + len);
      let s; if (plat === 3 || plat === 0) { s = ''; for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k)); } else s = raw.toString('latin1');
      const score = (plat === 3 ? 2 : 1) + (lang === 0x409 || lang === 0 ? 2 : 0); if (!found[id] || found[id].score < score) found[id] = { s, score };
    }
    return (found[1] || found[16] || {}).s || null;
  } catch { return null; }
}

// families: catalog names to make sure of (default: the six classic ones). Returns { dir, have, failed, map }
export async function ensureFonts(dir, log = () => {}, families = BASE_FAMILIES) {
  fs.mkdirSync(dir, { recursive: true });
  const have = [], failed = [], map = {};
  for (const fam of new Set(families)) {
    const info = FONT_CATALOG.find(x => x.f === fam); if (!info || !info.ttf) { if (info) failed.push(fam); continue; }
    const p = path.join(dir, fileFor(info));
    if (!(fs.existsSync(p) && fs.statSync(p).size > 10000)) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 90000);
        const r = await fetch(info.ttf, { signal: ctrl.signal }); clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = woffToSfnt(Buffer.from(await r.arrayBuffer())); if (buf.length < 10000) throw new Error('too small');
        fs.writeFileSync(p, buf); log(`글꼴 내려받음: ${fam} (${(buf.length / 1e6).toFixed(1)}MB)`);
      } catch (e) { failed.push(fam); log(`글꼴 내려받기 실패: ${fam} — ${e.message}. 시스템 글꼴로 대체됩니다`); continue; }
    }
    have.push(fam); map[fam] = fontFamilyName(fs.readFileSync(p)) || fam;
  }
  return { dir, have, failed, map };
}
