// Pure cut logic shared by the browser app (src/main.js), the local Pro engine (engine/) and the tests.
// No DOM access here. Blob is available in browsers and Node 18+.
export const HOP = 0.02; // 20 ms analysis window
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function pad2(n) { return String(n).padStart(2, '0'); }
export function pad3(n) { return String(n).padStart(3, '0'); }

export const PRESETS = {
  lecture: { label: '강의형', note: '토킹헤드·화면 녹화용. 0.6초 넘는 쉼을 자르고 말 앞뒤 0.15초를 남깁니다.', minSilence: 0.6, pad: 0.15, thrOffset: 0 },
  talk: { label: '토크·인터뷰', note: '대화의 자연스러운 간격(1초 미만)은 남기고 긴 침묵만 자릅니다.', minSilence: 1.0, pad: 0.2, thrOffset: 0 },
  vlog: { label: '브이로그', note: '현장음이 있어 기준을 조금 낮추고 여백을 넉넉히 둡니다.', minSilence: 0.9, pad: 0.25, thrOffset: -3 },
};

export function getRuns(mask) {
  const runs = []; const n = mask.length; let i = 0;
  while (i < n) { let j = i; const v = mask[i]; while (j < n && mask[j] === v) j++; runs.push({ v, i0: i, i1: j }); i = j; }
  return runs;
}

export function detectSegments(env, hop, duration, p) {
  const n = env ? env.length : 0;
  if (!n || duration <= 0) return [{ s: 0, e: Math.max(duration, 0), keep: true }];
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = env[i] > p.threshold ? 1 : 0;
  for (const r of getRuns(mask)) if (r.v === 0 && (r.i1 - r.i0) * hop < p.minSilence) mask.fill(1, r.i0, r.i1);
  for (const r of getRuns(mask)) if (r.v === 1 && (r.i1 - r.i0) * hop < p.minKeep) mask.fill(0, r.i0, r.i1);
  const padN = Math.round(p.pad / hop);
  const intervals = [];
  for (const r of getRuns(mask)) {
    if (r.v !== 1) continue;
    const a = Math.max(0, r.i0 - padN) * hop, b = Math.min(n, r.i1 + padN) * hop;
    const last = intervals[intervals.length - 1];
    if (last && a <= last.e + 1e-9) last.e = Math.max(last.e, b); else intervals.push({ s: a, e: b });
  }
  const segs = []; let cur = 0;
  for (const iv of intervals) {
    const s = Math.min(iv.s, duration), e = Math.min(iv.e, duration);
    if (s > cur + 1e-6) segs.push({ s: cur, e: s, keep: false });
    if (e > s + 1e-6) segs.push({ s, e, keep: true });
    cur = Math.max(cur, e);
  }
  if (cur < duration - 1e-6) segs.push({ s: cur, e: duration, keep: false });
  if (!segs.some(g => g.keep)) return [{ s: 0, e: duration, keep: true }];
  return segs;
}

export function suggestThreshold(env) {
  if (!env || env.length < 50) return -40;
  const vals = [];
  for (let i = 0; i < env.length; i++) if (env[i] > -95) vals.push(env[i]);
  if (vals.length < 50) return -40;
  vals.sort((a, b) => a - b);
  const q = f => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
  const floor = q(0.10), speech = q(0.90);
  if (speech - floor < 8) return -40;
  return Math.round(clamp(floor + 0.35 * (speech - floor), -65, -25));
}

export function keepRanges(segs) {
  const out = [];
  for (const g of segs) {
    if (!g.keep) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.e - g.s) < 1e-6) last.e = g.e; else out.push({ s: g.s, e: g.e });
  }
  return out.filter(r => r.e - r.s > 0.001);
}
export function intersectRanges(ranges, a, b) { const out = []; for (const r of ranges) { const s = Math.max(r.s, a), e = Math.min(r.e, b); if (e - s > 0.001) out.push({ s, e }); } return out; }
export function rangesDuration(ranges) { return ranges.reduce((t, r) => t + (r.e - r.s), 0); }
export function keptDuration(segs) { let t = 0; for (const g of segs) if (g.keep) t += g.e - g.s; return t; }
// Returns a new segment list where [s,e] is forced to `keep` (splitting as needed)
export function applySpan(segs, s, e, keep) {
  const out = [];
  for (const g of segs) {
    if (g.e <= s || g.s >= e) { out.push(g); continue; }
    if (g.s < s) out.push({ s: g.s, e: s, keep: g.keep });
    out.push({ s: Math.max(g.s, s), e: Math.min(g.e, e), keep });
    if (g.e > e) out.push({ s: e, e: g.e, keep: g.keep });
  }
  const merged = [];
  for (const g of out) { if (g.e - g.s < 0.005) { if (merged.length) merged[merged.length - 1].e = g.e; continue; } const last = merged[merged.length - 1]; if (last && last.keep === g.keep && !keep && !last.keep && Math.abs(last.e - g.s) < 1e-9) last.e = g.e; else merged.push({ ...g }); }
  return merged;
}
export function countRemoveRuns(segs) { let n = 0, prevKeep = true; for (const g of segs) { if (!g.keep && g.e - g.s > 0.001) { if (prevKeep) n++; prevKeep = false; } else prevKeep = true; } return n; }

export function outTime(segs, t) {
  let acc = 0;
  for (const g of segs) {
    if (t >= g.e) { if (g.keep) acc += g.e - g.s; continue; }
    if (g.keep) return acc + Math.max(0, t - g.s);
    return acc;
  }
  return acc;
}
// Source time at which the output reaches `outSec` (walks kept segments)
export function sourceTimeAtOutput(segs, outSec) {
  let acc = 0;
  for (const g of segs) { if (!g.keep) continue; const d = g.e - g.s; if (acc + d >= outSec) return g.s + (outSec - acc); acc += d; }
  return segs.length ? segs[segs.length - 1].e : 0;
}
export function segIndexAt(segs, t) {
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const g = segs[mid]; if (t < g.s) hi = mid - 1; else if (t >= g.e) lo = mid + 1; else return mid; }
  return clamp(lo, 0, segs.length - 1);
}

export function fmtClock(sec, tenths = true) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const sStr = tenths ? (s < 10 ? '0' : '') + s.toFixed(1) : pad2(Math.floor(s));
  return (h ? h + ':' : '') + pad2(m) + ':' + sStr;
}
export function ytStamp(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
export function tcFromSeconds(sec, fps) {
  const nominal = Math.max(1, Math.round(fps));
  const f = Math.round(Math.max(0, sec) * fps);
  const ff = f % nominal; const tot = Math.floor(f / nominal);
  return `${pad2(Math.floor(tot / 3600))}:${pad2(Math.floor((tot % 3600) / 60))}:${pad2(tot % 60)}:${pad2(ff)}`;
}

export function buildEDL(title, ranges, fps, clipName) {
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  ranges.forEach((r, i) => {
    const dur = r.e - r.s;
    lines.push(`${pad3(i + 1)}  AX       AA/V  C        ${tcFromSeconds(r.s, fps)} ${tcFromSeconds(r.e, fps)} ${tcFromSeconds(rec, fps)} ${tcFromSeconds(rec + dur, fps)}`);
    lines.push(`* FROM CLIP NAME: ${clipName}`);
    lines.push('');
    rec += dur;
  });
  return lines.join('\n');
}

const FCP_FRAMES = [[23.976, 1001, 24000], [24, 100, 2400], [25, 100, 2500], [29.97, 1001, 30000], [30, 100, 3000], [50, 100, 5000], [59.94, 1001, 60000], [60, 100, 6000]];
export function fcpFrame(fps) { let best = FCP_FRAMES[0]; for (const f of FCP_FRAMES) if (Math.abs(f[0] - fps) < Math.abs(best[0] - fps)) best = f; return best; }
export function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function buildFCPXML(title, ranges, fps, clipName, width, height, srcDuration, hasAudio) {
  const fd = fcpFrame(fps); const [ffps, num, den] = fd; const T = frames => `${frames * num}/${den}s`;
  let offF = 0; const clips = [];
  for (const r of ranges) {
    const startF = Math.round(r.s * ffps), durF = Math.max(1, Math.round((r.e - r.s) * ffps));
    clips.push(`          <asset-clip ref="r2" offset="${T(offF)}" name="${xmlEsc(clipName)}" start="${T(startF)}" duration="${T(durF)}" format="r1" tcFormat="NDF"${hasAudio ? ' audioRole="dialogue"' : ''}/>`);
    offF += durF;
  }
  const srcF = Math.max(offF, Math.round(srcDuration * ffps));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE fcpxml>', '<fcpxml version="1.10">', '  <resources>',
    `    <format id="r1" frameDuration="${num}/${den}s" width="${width || 1920}" height="${height || 1080}"/>`,
    `    <asset id="r2" name="${xmlEsc(clipName)}" uid="${xmlEsc(clipName)}" start="0s" duration="${T(srcF)}" hasVideo="1"${hasAudio ? ' hasAudio="1" audioSources="1" audioChannels="2"' : ''} format="r1">`,
    `      <media-rep kind="original-media" src="file:///${encodeURIComponent(clipName)}"/>`,
    '    </asset>', '  </resources>', '  <library>', '    <event name="컷다이어트">', `      <project name="${xmlEsc(title)}">`,
    `        <sequence format="r1" duration="${T(offF)}" tcStart="0s" tcFormat="NDF"${hasAudio ? ' audioLayout="stereo" audioRate="48k"' : ''}>`,
    '          <spine>', ...clips, '          </spine>', '        </sequence>', '      </project>', '    </event>', '  </library>', '</fcpxml>', ''].join('\n');
}

// opts: { bgm: {name, volume(0-1), duck, fade, loop} | null, hasVoice, kept }
export function buildFFmpeg(ranges, inName, outName, opts = {}) {
  const expr = ranges.map(r => `between(t,${r.s.toFixed(3)},${r.e.toFixed(3)})`).join('+');
  const filterV = `select='${expr}',setpts=N/FRAME_RATE/TB`;
  const filterA = `aselect='${expr}',asetpts=N/SR/TB`;
  const enc = `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart`;
  const bgm = opts.bgm;
  if (!bgm) {
    const inline = `ffmpeg -i "${inName}" -vf "${filterV}" -af "${filterA}" ${enc} "${outName}"`;
    const scriptCmd = `ffmpeg -i "${inName}" -filter_script:v cut_video_filter.txt -filter_script:a cut_audio_filter.txt ${enc} "${outName}"`;
    return { inline, filterV, filterA, scriptCmd, complex: null, useScript: inline.length > 7000 };
  }
  const kept = opts.kept || rangesDuration(ranges); const F = bgm.fade || 0;
  const bg = [`volume=${bgm.volume.toFixed(3)}`];
  if (F > 0) bg.push(`afade=t=in:st=0:d=${F}`, `afade=t=out:st=${Math.max(0, kept - F).toFixed(3)}:d=${F}`);
  bg.push(`atrim=0:${kept.toFixed(3)}`, 'asetpts=N/SR/TB');
  const mix = 'amix=inputs=2:duration=first:dropout_transition=0:normalize=0';
  const lines = [`[0:v]${filterV}[v]`];
  if (opts.hasVoice && bgm.duck) lines.push(`[0:a]${filterA},asplit=2[voiceA][voiceB]`, `[1:a]${bg.join(',')}[bg]`, `[bg][voiceB]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=400[bgd]`, `[voiceA][bgd]${mix}[a]`);
  else if (opts.hasVoice) lines.push(`[0:a]${filterA}[voice]`, `[1:a]${bg.join(',')}[bg]`, `[voice][bg]${mix}[a]`);
  else lines.push(`[1:a]${bg.join(',')}[a]`);
  const complex = lines.join(';\n');
  const scriptCmd = `ffmpeg -i "${inName}" ${bgm.loop ? '-stream_loop -1 ' : ''}-i "${bgm.name}" -filter_complex_script cut_filter_complex.txt -map "[v]" -map "[a]" ${enc} -shortest "${outName}"`;
  return { inline: scriptCmd, filterV, filterA, scriptCmd, complex, useScript: true };
}

export function chapterLines(chapters, segs) {
  const items = chapters.map(c => ({ t: outTime(segs, c.t), title: (c.title || '').trim() || '챕터' }));
  items.sort((a, b) => a.t - b.t);
  return items.map(c => `${ytStamp(c.t)} ${c.title}`);
}
export function validateChapters(chapters, segs) {
  if (!chapters.length) return '';
  const ts = chapters.map(c => outTime(segs, c.t)).sort((a, b) => a - b);
  const msgs = [];
  if (Math.floor(ts[0]) !== 0) msgs.push('첫 챕터는 0:00에서 시작해야 유튜브가 인식합니다');
  if (ts.length < 3) msgs.push('챕터는 3개 이상이어야 합니다');
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < 10) { msgs.push('챕터 간격은 10초 이상이어야 합니다'); break; }
  return msgs.length ? msgs.join(' · ') : '유튜브 챕터 조건을 모두 충족합니다';
}

// Candidate thumbnail moments: loudest 0.5 s windows inside kept ranges, spaced apart
export function pickThumbnailTimes(env, hop, segs, count = 12) {
  const ranges = keepRanges(segs); if (!ranges.length) return [];
  const total = rangesDuration(ranges); const minGap = Math.max(3, total / (count * 1.5));
  const cands = [];
  for (const r of ranges) {
    for (let t = r.s + 0.3; t < r.e - 0.3; t += 0.5) {
      let m = -100;
      if (env) { const i0 = Math.floor(t / hop), i1 = Math.floor((t + 0.5) / hop); for (let i = i0; i < i1 && i < env.length; i++) if (env[i] > m) m = env[i]; }
      cands.push({ t: t + 0.25, e: m });
    }
  }
  if (!cands.length) return ranges.map(r => (r.s + r.e) / 2).slice(0, count);
  cands.sort((a, b) => b.e - a.e);
  const picked = [];
  for (const c of cands) { if (picked.length >= count) break; if (picked.every(p => Math.abs(p.t - c.t) >= minGap)) picked.push(c); }
  const first = ranges[0].s + Math.min(0.8, (ranges[0].e - ranges[0].s) / 2);
  if (!picked.some(p => Math.abs(p.t - first) < minGap)) picked.push({ t: first, e: 0 });
  picked.sort((a, b) => a.t - b.t);
  return picked.map(p => Math.round(p.t * 100) / 100);
}

// Mix mono bgm into channel arrays in place. bgm: {data, sr, duration, volume, duck, fade, loop}
// bgm.offset: output second where the music starts (dragged on the music track); before it nothing is mixed
export function mixBgmInto(chans, sr, outStart, srcStart, bgm, env, hop, threshold, total, duckState) {
  const n = chans[0].length; const duckRatio = 0.3;
  const atk = 1 - Math.exp(-1 / (0.04 * sr)), rel = 1 - Math.exp(-1 / (0.35 * sr));
  let g = duckState.g; const d = bgm.data, bsr = bgm.sr, bdur = bgm.duration; const off = bgm.offset || 0;
  for (let j = 0; j < n; j++) {
    const outT = outStart + j / sr;
    let target = 1;
    if (bgm.duck && env) { const idx = (srcStart + j / sr) / hop | 0; if (idx < env.length && env[idx] > threshold) target = duckRatio; }
    g += (target - g) * (target < g ? atk : rel);
    const mt = outT - off; if (mt < 0) continue;
    let bt = mt; if (bgm.loop) bt = mt % bdur; else if (bt >= bdur) continue;
    const pos = bt * bsr; const i = pos | 0; if (i + 1 >= d.length) continue;
    let s = d[i] + (d[i + 1] - d[i]) * (pos - i);
    let fade = 1;
    if (bgm.fade > 0) { if (mt < bgm.fade) fade = mt / bgm.fade; const rem = total - outT; if (rem < bgm.fade) fade = Math.min(fade, Math.max(0, rem / bgm.fade)); }
    s *= bgm.volume * g * fade;
    for (let c = 0; c < chans.length; c++) { const v = chans[c][j] + s; chans[c][j] = v > 1 ? 1 : v < -1 ? -1 : v; }
  }
  duckState.g = g;
}

const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
export function crc32(u8) { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
export function buildZip(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const dosDate = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data; const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export function assembleBlob(parts, type) {
  let segs = [];
  for (const p of parts) {
    const start = p.pos, end = p.pos + p.blob.size; if (end <= start) continue;
    const next = [];
    for (const s of segs) {
      if (s.end <= start || s.pos >= end) { next.push(s); continue; }
      if (s.pos < start) next.push({ pos: s.pos, end: start, blob: s.blob.slice(0, start - s.pos) });
      if (s.end > end) next.push({ pos: end, end: s.end, blob: s.blob.slice(end - s.pos) });
    }
    next.push({ pos: start, end, blob: p.blob });
    next.sort((a, b) => a.pos - b.pos);
    segs = next;
  }
  const out = []; let cursor = 0;
  for (const s of segs) { if (s.pos > cursor) out.push(new Uint8Array(s.pos - cursor)); out.push(s.blob); cursor = s.end; }
  return new Blob(out, { type });
}

export function accumulateEnergy(buffer, t0, sumSq, cnt, hop) {
  const sr = buffer.sampleRate, ch = buffer.numberOfChannels, len = buffer.length;
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let i = 0;
  while (i < len) {
    const t = t0 + i / sr; const idx = Math.floor(t / hop + 1e-9);
    let end = Math.min(len, Math.ceil(((idx + 1) * hop - t0) * sr - 1e-6)); if (end <= i) end = i + 1;
    let s = 0;
    for (let j = i; j < end; j++) { let v = 0; for (let c = 0; c < ch; c++) v += chans[c][j]; v /= ch; s += v * v; }
    if (idx >= 0 && idx < sumSq.length) { sumSq[idx] += s; cnt[idx] += end - i; }
    i = end;
  }
}
export function energyToDb(sumSq, cnt) {
  const env = new Float32Array(sumSq.length);
  for (let i = 0; i < env.length; i++) { const ms = cnt[i] ? sumSq[i] / cnt[i] : 0; env[i] = ms > 1e-10 ? 10 * Math.log10(ms) : -100; }
  return env;
}

export function demoEnvelope(HOP = 0.02) {
  let seed = 20261025; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const duration = 95; const n = Math.ceil(duration / HOP); const env = new Float32Array(n).fill(-58);
  const plan = [[1.2, 6.4], [7.6, 13.9], [15.8, 24.1], [25.2, 29.0], [33.6, 41.5], [42.2, 45.0], [45.7, 54.3], [56.0, 61.8], [62.4, 69.9], [73.5, 80.2], [81.0, 88.6], [89.3, 92.7]];
  for (let i = 0; i < n; i++) env[i] = -58 + (rnd() - 0.5) * 5;
  for (const [a, b] of plan) {
    for (let t = a; t < b; t += HOP) {
      const i = Math.floor(t / HOP); if (i >= n) break;
      const syl = 0.5 + 0.5 * Math.sin(t * 9.1) * Math.sin(t * 2.3 + 1);
      const breath = (t - a) < 0.08 || (b - t) < 0.1 ? 0.5 : 1;
      env[i] = -34 + 16 * syl * breath + (rnd() - 0.5) * 6;
    }
  }
  const clap = Math.floor(31.0 / HOP); for (let k = 0; k < 4; k++) env[clap + k] = -12 + k * 3;
  return { env, duration };
}
