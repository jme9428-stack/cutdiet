// Korean fonts for burned-in subtitles. Same families the browser uses (Google Fonts, OFL). Downloaded once into engine/fonts/.
import fs from 'node:fs';
import path from 'node:path';

const RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl/';
export const FONT_FILES = [
  { file: 'NotoSansKR[wght].ttf', url: RAW + 'notosanskr/NotoSansKR%5Bwght%5D.ttf', family: 'Noto Sans KR' },
  { file: 'BlackHanSans-Regular.ttf', url: RAW + 'blackhansans/BlackHanSans-Regular.ttf', family: 'Black Han Sans' },
  { file: 'Jua-Regular.ttf', url: RAW + 'jua/Jua-Regular.ttf', family: 'Jua' },
  { file: 'DoHyeon-Regular.ttf', url: RAW + 'dohyeon/DoHyeon-Regular.ttf', family: 'Do Hyeon' },
  { file: 'GothicA1-Bold.ttf', url: RAW + 'gothica1/GothicA1-Bold.ttf', family: 'Gothic A1' },
  { file: 'IBMPlexSansKR-Bold.ttf', url: RAW + 'ibmplexsanskr/IBMPlexSansKR-Bold.ttf', family: 'IBM Plex Sans KR' },
];

export async function ensureFonts(dir, log = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const have = [], missing = [];
  for (const f of FONT_FILES) { const p = path.join(dir, f.file); if (fs.existsSync(p) && fs.statSync(p).size > 10000) have.push(f.family); else missing.push(f); }
  if (!missing.length) return { dir, have, failed: [] };
  const failed = [];
  for (const f of missing) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
      const r = await fetch(f.url, { signal: ctrl.signal }); clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 10000) throw new Error('too small');
      fs.writeFileSync(path.join(dir, f.file), buf); have.push(f.family); log(`글꼴 내려받음: ${f.family} (${(buf.length / 1e6).toFixed(1)}MB)`);
    } catch (e) { failed.push(f.family); log(`글꼴 내려받기 실패: ${f.family} — ${e.message}. 시스템 글꼴로 대체됩니다`); }
  }
  return { dir, have, failed };
}
