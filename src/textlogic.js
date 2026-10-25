// Pure text/timing helpers for the AI 자막·NG tab. No DOM access; unit-tested in tests/test_logic.mjs.

const PUNCT_RE = /[\s.,!?…~"'“”‘’()\[\]{}<>:;·\-–—]/g;
export function normKo(s) { return String(s || '').replace(PUNCT_RE, ''); }

export function levenshtein(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = new Array(b.length + 1); for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function similarity(a, b) { const n = Math.max(a.length, b.length); return n ? 1 - levenshtein(a, b) / n : 1; }

// chunks from transformers.js: [{text, timestamp:[s, e|null]}] -> words [{text, s, e}]
export function wordsFromChunks(chunks, duration = Infinity) {
  const words = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]; const text = String(c.text || '').trim(); if (!text) continue;
    let s = Number(c.timestamp && c.timestamp[0]); let e = c.timestamp && c.timestamp[1];
    if (!isFinite(s)) s = words.length ? words[words.length - 1].e : 0;
    if (e == null || !isFinite(Number(e))) { const next = chunks.slice(i + 1).find(x => x.timestamp && isFinite(Number(x.timestamp[0]))); e = next ? Number(next.timestamp[0]) : s + 0.3; }
    e = Number(e); if (e <= s) e = s + 0.05;
    if (s >= duration) continue; // Whisper sometimes emits text past the end of the audio
    if (e > duration) e = duration;
    words.push({ text, s, e });
  }
  return words;
}

// Drop words placed where the loudness analysis found no speech (Whisper hallucinates phrases in silence)
export function dropSilentWords(words, env, hop, threshold) {
  if (!env || !env.length) return words;
  return words.filter(w => {
    const i0 = Math.max(0, Math.floor((w.s - 0.15) / hop)), i1 = Math.min(env.length, Math.ceil((Math.max(w.e, w.s + 0.1) + 0.15) / hop));
    for (let i = i0; i < i1; i++) if (env[i] > threshold) return true;
    return false;
  });
}

const SENT_END_RE = /[.?!…]$|[다요죠까네][.?!]?$/;
// Group words into caption lines: break on sentence end, long gaps, length or duration limits
export function buildCaptionLines(words, opts = {}) {
  const maxChars = opts.maxChars ?? 24, maxDur = opts.maxDur ?? 4.5, maxGap = opts.maxGap ?? 0.8;
  const lines = []; let cur = null;
  const flush = () => { if (cur && cur.text.trim()) lines.push({ s: cur.s, e: cur.e, text: cur.text.trim() }); cur = null; };
  for (const w of words) {
    if (cur) {
      const gap = w.s - cur.e; const nextText = cur.text + (needsSpace(cur.text, w.text) ? ' ' : '') + w.text;
      if (gap > maxGap || nextText.length > maxChars || w.e - cur.s > maxDur) flush();
    }
    if (!cur) cur = { s: w.s, e: w.e, text: w.text };
    else { cur.text += (needsSpace(cur.text, w.text) ? ' ' : '') + w.text; cur.e = w.e; }
    if (SENT_END_RE.test(w.text) && cur.text.length >= 6) flush();
  }
  flush();
  return lines;
}
function needsSpace(prev, next) { return !/\s$/.test(prev) && !/^[.,!?…]/.test(next); }

// Sentences for repeat detection: split on sentence end or gaps > 0.7 s
export function buildSentences(words, maxGap = 0.7) {
  const out = []; let cur = null;
  const flush = () => { if (cur && normKo(cur.text).length) out.push({ s: cur.s, e: cur.e, text: cur.text.trim() }); cur = null; };
  for (const w of words) {
    if (cur && w.s - cur.e > maxGap) flush();
    if (!cur) cur = { s: w.s, e: w.e, text: w.text }; else { cur.text += ' ' + w.text; cur.e = w.e; }
    if (SENT_END_RE.test(w.text) && normKo(cur.text).length >= 4) flush();
  }
  flush();
  return out;
}

export function srtTime(sec) { sec = Math.max(0, sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), ms = Math.round((sec - Math.floor(sec)) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }
// mapT maps source seconds -> output seconds (identity for source-time SRT). Lines that collapse (cut away) are dropped.
export function buildSRT(lines, mapT = t => t, minDur = 0.15) {
  const out = []; let n = 0; let lastEnd = 0;
  for (const l of lines) {
    let s = mapT(l.s), e = mapT(l.e); if (e - s < minDur) continue;
    if (s < lastEnd) s = lastEnd; if (e - s < minDur) continue;
    n++; out.push(`${n}\n${srtTime(s)} --> ${srtTime(e)}\n${l.text}\n`); lastEnd = e;
  }
  return out.join('\n');
}

const FILLER_HIGH = new Set(['어', '음', '으음', '어어', '음음', '에', '흠', '어음', '응', '엄', '어우']);
const FILLER_LOW = new Set(['그', '저', '뭐', '이제', '약간', '막', '좀', '자']);
export function findFillers(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]; const t = normKo(w.text); if (!t || t.length > 2) continue;
    const prevGap = i > 0 ? w.s - words[i - 1].e : 0, nextGap = i < words.length - 1 ? words[i + 1].s - w.e : 1;
    if (FILLER_HIGH.has(t)) out.push({ kind: 'filler', s: w.s, e: w.e, text: w.text.trim(), confident: true });
    else if (FILLER_LOW.has(t) && (prevGap > 0.25 || nextGap > 0.25) && (w.e - w.s) > 0.12) out.push({ kind: 'filler', s: w.s, e: w.e, text: w.text.trim(), confident: false });
  }
  return out;
}

// Repeated sentence = retake: the EARLIER one is the NG candidate
export function findRepeats(words, opts = {}) {
  const sents = buildSentences(words); const out = []; const minLen = opts.minLen ?? 4;
  for (let i = 0; i < sents.length; i++) {
    const a = sents[i]; const na = normKo(a.text); if (na.length < minLen || a.e - a.s < 0.8) continue;
    for (let k = 1; k <= 2 && i + k < sents.length; k++) {
      const b = sents[i + k]; const nb = normKo(b.text); if (nb.length < minLen) continue;
      const sim = similarity(na, nb);
      const head = na.slice(0, Math.min(6, na.length)); const prefix = na.length >= 6 && nb.startsWith(head);
      if (sim >= 0.6 || (prefix && sim >= 0.4)) { out.push({ kind: 'repeat', s: a.s, e: Math.min(a.e, b.s), text: a.text, pair: b.text, confident: sim >= 0.75, sim: Math.round(sim * 100) / 100 }); break; }
    }
  }
  return out;
}

// Merge overlapping/adjacent candidate spans with padding
export function mergeSpans(cands, pad = 0.04) {
  const spans = cands.map(c => ({ s: Math.max(0, c.s - pad), e: c.e + pad })).sort((a, b) => a.s - b.s); const out = [];
  for (const sp of spans) { const last = out[out.length - 1]; if (last && sp.s <= last.e + 0.01) last.e = Math.max(last.e, sp.e); else out.push({ ...sp }); }
  return out;
}

// Linear-interpolation resampler accumulating mono audio into a 16 kHz Float32Array
export function resampleInto(target, targetSr, chans, srcSr, t0) {
  const len = chans[0].length; const start = Math.max(0, Math.ceil(t0 * targetSr)); const end = Math.min(target.length, Math.floor((t0 + (len - 1) / srcSr) * targetSr));
  const nch = chans.length;
  for (let i = start; i <= end; i++) {
    const pos = (i / targetSr - t0) * srcSr; const j = Math.floor(pos); const f = pos - j; if (j < 0 || j + 1 >= len) { if (j >= 0 && j < len) { let v = 0; for (let c = 0; c < nch; c++) v += chans[c][j]; target[i] = v / nch; } continue; }
    let v = 0; for (let c = 0; c < nch; c++) v += chans[c][j] + (chans[c][j + 1] - chans[c][j]) * f; target[i] = v / nch;
  }
  return end;
}
