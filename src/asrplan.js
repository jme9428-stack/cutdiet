// Speech-only windows for Whisper. Instead of sliding 30 s windows with 5 s overlaps over the whole file (every stretch
// processed ~1.5x, pauses included), pack only the stretches with speech into windows of up to ~28 s, cut at pauses, with
// no overlap; afterwards map each word's time back to the original video. Pure functions; used by both ASR workers.

// env: loudness in dB per hop (cutlogic.js), threshold: the cut threshold in dB.
// Returns windows [{ parts: [{s, e}], keep: {s, e} }] in seconds; each window's audio = its parts joined with `joinGap`
// of silence. Where a window had to be cut in the middle of talking (no pause), the NEXT window starts `ctx` seconds
// before the cut so the word at the cut is heard whole; the earlier window never hears past the cut (given audio past
// it, Whisper tends to finish the next sentence on its own and the text came out twice). `keep` = the stretch it owns.
export function planWindows(env, hop, threshold, duration, opts = {}) {
  const maxLen = opts.maxLen ?? 27, ctx = opts.ctx ?? 2, pad = opts.pad ?? 0.25, merge = opts.merge ?? 0.5, joinGap = opts.joinGap ?? 0.12, soft = opts.soft ?? 8;
  const n = env ? env.length : 0; const loud = threshold - soft; // a little below the cut level so soft word endings stay in
  if (!n) { const out = []; for (let s = 0; s < duration; s += maxLen) { const e = Math.min(duration, s + maxLen); out.push({ parts: [{ s: Math.max(0, s - (s ? ctx : 0)), e }], keep: { s, e } }); } return out; }
  // speech regions, padded, gaps under `merge` joined
  const regions = []; let i = 0;
  while (i < n) {
    if (env[i] <= loud) { i++; continue; }
    let j = i; while (j < n && env[j] > loud) j++;
    const s = Math.max(0, i * hop - pad), e = Math.min(duration, j * hop + pad); const last = regions[regions.length - 1];
    if (last && s - last.e < merge) last.e = Math.max(last.e, e); else regions.push({ s, e });
    i = j;
  }
  // a region longer than a window is split at its quietest moment near the window's end
  const pieces = [];
  for (const r of regions) {
    let s = r.s;
    while (r.e - s > maxLen) {
      const lo = Math.floor((s + maxLen - 6) / hop), hi = Math.min(n - 1, Math.floor((s + maxLen) / hop)); let cut = hi, min = Infinity;
      for (let k = lo; k <= hi; k++) { let v = 0, c = 0; for (let q = k - 2; q <= k + 2; q++) if (q >= 0 && q < n) { v += env[q]; c++; } v /= c; if (v < min) { min = v; cut = k; } }
      const t = Math.max(s + 1, cut * hop); const prev = pieces[pieces.length - 1]; pieces.push({ s, e: t, cutAfter: true, cutBefore: !!(prev && prev.cutAfter && prev.e === s) }); s = t;
    }
    pieces.push({ s, e: r.e, cutBefore: pieces.length && pieces[pieces.length - 1].cutAfter && pieces[pieces.length - 1].e === s });
  }
  // pack pieces in order into windows
  const windows = []; let cur = null, len = 0;
  for (const p of pieces) {
    const d = p.e - p.s;
    if (cur && len + joinGap + d <= maxLen && !p.cutBefore) { cur.parts.push(p); len += joinGap + d; }
    else { cur = { parts: [p] }; len = d; windows.push(cur); }
  }
  for (const w of windows) {
    const first = w.parts[0], last = w.parts[w.parts.length - 1];
    w.keep = { s: first.s, e: last.e };
    w.parts = w.parts.map(p => ({ s: p.s, e: p.e }));
    if (first.cutBefore) w.parts[0].s = Math.max(0, first.s - ctx);
  }
  return windows;
}
export const windowLength = (w, joinGap = 0.12) => w.parts.reduce((t, p) => t + p.e - p.s, 0) + joinGap * (w.parts.length - 1);
export const speechSeconds = windows => windows.reduce((t, w) => t + windowLength(w, 0) , 0);

// Window audio from the full 16 kHz recording
export function windowAudio(audio, sr, w, joinGap = 0.12) {
  const g = Math.round(joinGap * sr); const lens = w.parts.map(p => Math.max(0, Math.min(audio.length, Math.round(p.e * sr)) - Math.round(p.s * sr)));
  const out = new Float32Array(lens.reduce((a, b) => a + b, 0) + g * (w.parts.length - 1)); let o = 0;
  w.parts.forEach((p, k) => { const a = Math.round(p.s * sr); out.set(audio.subarray(a, a + lens[k]), o); o += lens[k] + g; });
  return out;
}
// time inside a window's audio -> time in the original recording
export function windowTimeToSource(w, tau, joinGap = 0.12) {
  let c = 0;
  for (let k = 0; k < w.parts.length; k++) {
    const p = w.parts[k], d = p.e - p.s;
    if (tau <= c + d || k === w.parts.length - 1) return Math.min(p.e, p.s + Math.max(0, tau - c));
    c += d;
    if (tau < c + joinGap) return tau - c < joinGap / 2 ? p.e : w.parts[k + 1].s; // inside the inserted pause
    c += joinGap;
  }
  return w.parts[w.parts.length - 1].e;
}
// map a window's word chunks ({text, timestamp:[s, e]}) back to source time
export function mapChunks(w, chunks, joinGap = 0.12) {
  const L = windowLength(w, joinGap);
  return chunks.map(c => {
    const s0 = Number(c.timestamp && c.timestamp[0]), e0 = c.timestamp && c.timestamp[1];
    const s = isFinite(s0) ? windowTimeToSource(w, Math.min(L, s0), joinGap) : null;
    const e = e0 != null && isFinite(Number(e0)) ? windowTimeToSource(w, Math.min(L, Number(e0)), joinGap) : null;
    return { text: c.text, timestamp: [s, e != null && s != null && e < s ? s : e] };
  });
}

// Run Whisper over the planned windows. asr(audio) -> Promise<{ chunks: [{text, timestamp}] }>. Words are kept only inside
// each window's own stretch; if Whisper stops well before the end of a window (it sometimes gives up after loud
// non-speech), the rest is transcribed again on its own. onWindow(i, n, words) reports progress.
export async function transcribeWindows(asr, audio, sr, windows, { onWindow, isCanceled, retryGap = 3 } = {}) {
  const words = [];
  for (let i = 0; i < windows.length; i++) {
    if (isCanceled && isCanceled()) throw new Error('canceled');
    const w = windows[i];
    const out = await asr(windowAudio(audio, sr, w));
    const from = w.parts[0].s < w.keep.s ? w.keep.s - 0.5 : w.keep.s - 0.05; // the word straddling a cut is heard whole here
    let got = mapChunks(w, out.chunks || []).filter(c => c.timestamp[0] != null && c.timestamp[0] >= from && c.timestamp[0] < w.keep.e);
    const lastEnd = got.length ? Math.max(...got.map(c => c.timestamp[1] ?? c.timestamp[0])) : w.keep.s;
    if (w.keep.e - lastEnd > retryGap) {
      const tail = { parts: [{ s: Math.max(w.parts[0].s, lastEnd - 0.3), e: w.parts[w.parts.length - 1].e }] };
      const more = mapChunks(tail, (await asr(windowAudio(audio, sr, tail))).chunks || []).filter(c => c.timestamp[0] != null && c.timestamp[0] >= lastEnd - 0.05 && c.timestamp[0] < w.keep.e);
      got = got.concat(more);
    }
    words.push(...got);
    if (onWindow) onWindow(i + 1, windows.length, got);
  }
  return dedupeWords(words);
}

// Where neighbouring windows meet, the same word can come out of both (one of them often cut short: "칠" / "칠A입니다").
// Two words that overlap in time and read alike are one word: keep the longer reading.
const normW = t => String(t || '').replace(/[\s.,!?…~"'“”‘’()\[\]{}<>:;·\-–—]/g, '');
export function dedupeWords(chunks) {
  const list = chunks.filter(c => c.timestamp && c.timestamp[0] != null).sort((a, b) => a.timestamp[0] - b.timestamp[0]); const out = [];
  for (const c of list) {
    const p = out[out.length - 1];
    if (p) {
      const pe = p.timestamp[1] ?? p.timestamp[0] + 0.3, a = normW(p.text), b = normW(c.text);
      const overlap = c.timestamp[0] < pe - 0.05, alike = a && b && (a.startsWith(b) || b.startsWith(a) || a === b);
      if (overlap && alike) { if (b.length > a.length) out[out.length - 1] = c; continue; }
    }
    out.push(c);
  }
  return out;
}

// Loudness envelope (dB per hop) straight from samples, for callers without the app's analysis (the Pro engine)
export function envFromAudio(audio, sr, hop) {
  const n = Math.floor(audio.length / (hop * sr)); const env = new Float32Array(n); const k = Math.round(hop * sr);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * k; j < (i + 1) * k; j++) s += audio[j] * audio[j]; env[i] = 10 * Math.log10(s / k + 1e-12); }
  return env;
}

// Is this WebGPU adapter worth using for Whisper? Integrated Intel graphics and phone GPUs ran slower than the 8-thread
// CPU path in our measurements, so they stay on the CPU; NVIDIA, AMD, Apple and Intel Arc use the GPU.
export function fastGpu(info) {
  const v = String((info && info.vendor) || '').toLowerCase(), arch = String((info && (info.architecture || info.description)) || '').toLowerCase();
  if (v.includes('intel')) return /hpg|arc|alchemist|battlemage/.test(arch);
  return !/qualcomm|arm|imagination|mali|adreno/.test(v + ' ' + arch);
}
