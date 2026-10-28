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

// Stutters (말 버벅임): "그 그러니까", "저 저는", "그 그", a cut-off "그러-", or a 2–3 word phrase said twice in a row.
// The FIRST attempt is the candidate; the clean retry stays.
export function findStutters(words, maxGap = 0.6) {
  const out = []; let skipTo = -1;
  const push = (i0, i1, pair, confident) => { out.push({ kind: 'stutter', s: words[i0].s, e: words[i1].e, text: words.slice(i0, i1 + 1).map(w => w.text.trim()).join(' '), pair, confident }); skipTo = i1; };
  for (let i = 0; i < words.length - 1; i++) {
    if (i <= skipTo) continue;
    const a = words[i], b = words[i + 1]; if (b.s - a.e > maxGap) continue;
    const na = normKo(a.text), nb = normKo(b.text); if (!na || !nb) continue;
    // 2–3 word phrase repeated right away: "그래서 제가 그래서 제가"
    let phrase = false;
    for (let k = 3; k >= 2 && !phrase; k--) {
      if (i + 2 * k > words.length) continue;
      const A = words.slice(i, i + k), B = words.slice(i + k, i + 2 * k);
      if (B[0].s - A[k - 1].e > maxGap) continue;
      const ja = A.map(w => normKo(w.text)).join(''), jb = B.map(w => normKo(w.text)).join('');
      if (ja.length >= 3 && ja === jb) { push(i, i + k - 1, B.map(w => w.text.trim()).join(' '), true); phrase = true; }
    }
    if (phrase) continue;
    if (/[-–—~]$/.test(a.text.trim()) && na.length <= 4) { push(i, i, b.text.trim(), true); continue; } // cut-off fragment "그러-"
    if (na === nb && na.length <= 3) { push(i, i, b.text.trim(), na.length === 1); continue; } // "그 그", "제가 제가" ("많이 많이" can be on purpose)
    if (na.length <= 2 && nb.length > na.length && nb.startsWith(na)) { push(i, i, b.text.trim(), na.length === 1 || b.s - a.e < 0.3); continue; } // "그 그러니까", "저 저는"
  }
  return out;
}

// Loud stretches between recognized words: Whisper usually drops "어…", "음…" and mumbles, leaving a voiced gap.
export function findMumbles(words, env, hop, threshold, opts = {}) {
  if (!env || !env.length || words.length < 2) return [];
  const minGap = opts.minGap ?? 0.35, minVoiced = opts.minVoiced ?? 0.22; const out = [];
  for (let i = 0; i < words.length - 1; i++) {
    const s = words[i].e + 0.04, e = words[i + 1].s - 0.04; if (e - s < minGap) continue;
    const i0 = Math.max(0, Math.floor(s / hop)), i1 = Math.min(env.length, Math.ceil(e / hop)); let loud = 0;
    for (let k = i0; k < i1; k++) if (env[k] > threshold) loud++;
    const voiced = loud * hop; if (voiced >= minVoiced && loud / Math.max(1, i1 - i0) >= 0.45) out.push({ kind: 'mumble', s, e, text: '(인식되지 않은 소리 · 어/음 추정)', pair: words[i + 1].text.trim(), confident: false });
  }
  return out;
}

// Take removed words out of the caption text too, so a burned-in caption doesn't show "어" or "그 그러니까" after the cut.
// Line-sized removals (repeat NG, mumble) drop lines that lie entirely inside the span.
export function stripFromLines(lines, cands) {
  let out = lines.map(l => ({ ...l }));
  for (const c of cands) {
    if (c.kind === 'filler' || c.kind === 'stutter') {
      const l = out.find(l => l.s <= c.s + 0.08 && l.e >= c.e - 0.08); if (!l) continue;
      const toks = l.text.split(/\s+/), want = c.text.split(/\s+/).map(normKo).filter(Boolean); if (!want.length) continue;
      for (let i = 0; i + want.length <= toks.length; i++) {
        if (want.every((w, k) => normKo(toks[i + k]) === w)) { toks.splice(i, want.length); l.text = toks.join(' ').trim(); break; }
      }
    } else out = out.filter(l => !(l.s >= c.s - 0.1 && l.e <= c.e + 0.1));
  }
  return out.filter(l => normKo(l.text).length);
}

// SRT / WebVTT -> [{s, e, text}]
export function parseSRT(text) {
  const toSec = t => { const m = String(t).trim().match(/^(?:(\d+):)?(\d+):(\d+)[,.](\d{1,3})$/); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000 : NaN; };
  const out = [];
  for (const block of String(text || '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const rows = block.split('\n').map(r => r.trim()).filter(Boolean); const ti = rows.findIndex(r => r.includes('-->')); if (ti < 0) continue;
    const [a, b] = rows[ti].split('-->'); const s = toSec(a), e = toSec(String(b).trim().split(/\s+/)[0]);
    const body = rows.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (isFinite(s) && isFinite(e) && e > s && body) out.push({ s, e, text: body });
  }
  return out.sort((x, y) => x.s - y.s);
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
