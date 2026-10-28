// Removal candidates from the sound alone — no transcript needed:
//   filled pauses ("어~", "음~": a steady voiced sound standing at the start of a phrase or on its own),
//   stutters ("그 그러니까": a short burst whose sound repeats at the start of what follows right after),
//   retakes (a phrase whose opening is said again in the next phrase — the earlier take is the NG).
// Pure functions on 16 kHz mono samples. Runs in src/audioscan.worker.js; unit-tested in tests/test_audio.mjs.
// Less exact than the transcript-based search (textlogic.js), so everything here is offered for review, not applied.

export const SR = 16000;
const HOP = 160, WIN = 400, NFFT = 512, NMEL = 26, NCEP = 13; // 10 ms hop, 25 ms window
export const FRAME = HOP / SR;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
let BANK = null, DCT = null, HANN = null;
function tables() {
  if (BANK) return;
  const mel = f => 2595 * Math.log10(1 + f / 700), inv = m => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(80), hi = mel(7600); const pts = Array.from({ length: NMEL + 2 }, (_, i) => Math.floor((NFFT + 1) * inv(lo + (hi - lo) * i / (NMEL + 1)) / SR));
  BANK = [];
  for (let m = 1; m <= NMEL; m++) { const a = pts[m - 1], b = pts[m], c = pts[m + 1]; const w = []; for (let k = a; k <= c; k++) w.push([k, k < b ? (k - a) / Math.max(1, b - a) : (c - k) / Math.max(1, c - b)]); BANK.push(w); }
  DCT = Array.from({ length: NCEP }, (_, i) => Float64Array.from({ length: NMEL }, (_, j) => Math.cos(Math.PI * i * (j + 0.5) / NMEL)));
  HANN = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)));
}

// Per 10 ms frame: level (dB), zero-crossing rate, MFCC (13, mean-normalized over speech), spectral change (flux).
export function analyzeFrames(x) {
  tables();
  const n = Math.max(0, Math.floor((x.length - WIN) / HOP) + 1);
  const logE = new Float32Array(n), zcr = new Float32Array(n), cep = new Float32Array(n * NCEP);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), mel = new Float64Array(NMEL);
  for (let f = 0; f < n; f++) {
    const o = f * HOP; let e = 0, z = 0; re.fill(0); im.fill(0);
    for (let i = 0; i < WIN; i++) { const v = x[o + i]; e += v * v; if (i && (v >= 0) !== (x[o + i - 1] >= 0)) z++; re[i] = (v - 0.97 * (i ? x[o + i - 1] : v)) * HANN[i]; }
    logE[f] = 10 * Math.log10(e / WIN + 1e-10); zcr[f] = z / WIN;
    fft(re, im);
    for (let m = 0; m < NMEL; m++) { let s = 0; for (const [k, w] of BANK[m]) s += w * (re[k] * re[k] + im[k] * im[k]); mel[m] = Math.log(s + 1e-8); }
    for (let c = 0; c < NCEP; c++) { let s = 0; const d = DCT[c]; for (let m = 0; m < NMEL; m++) s += d[m] * mel[m]; cep[f * NCEP + c] = s; }
  }
  const thr = speechThreshold(logE); const speech = speechMask(logE, thr);
  // cepstral mean normalization over speech frames (removes the mic/room colour so takes can be compared)
  const mean = new Float64Array(NCEP); let cnt = 0;
  for (let f = 0; f < n; f++) if (speech[f]) { cnt++; for (let c = 0; c < NCEP; c++) mean[c] += cep[f * NCEP + c]; }
  if (cnt) for (let c = 0; c < NCEP; c++) mean[c] /= cnt;
  for (let f = 0; f < n; f++) for (let c = 0; c < NCEP; c++) cep[f * NCEP + c] -= mean[c];
  const flux = new Float32Array(n);
  for (let f = 2; f < n; f++) { let s = 0; for (let c = 1; c < NCEP; c++) { const d = cep[f * NCEP + c] - cep[(f - 2) * NCEP + c]; s += d * d; } flux[f] = Math.sqrt(s); }
  const fluxS = smooth(flux, 3);
  const { f0, clar } = pitchTrack(x, n, logE, thr);
  // typical level of the speaker's voice: quiet sounds well below it are breaths, rustles, murmurs or a hum
  const sp = []; for (let f = 0; f < n; f++) if (speech[f]) sp.push(logE[f]);
  const level = sp.length ? pct(sp, 0.75) : thr + 20;
  // the speaker's typical pitch: "어~/음~" hesitations sit on a low, flat note below it
  const vp = []; for (let f = 0; f < n; f++) if (speech[f] && clar[f] >= 0.8 && f0[f] > 0) vp.push(f0[f]);
  const pitch = vp.length ? pct(vp, 0.5) : 0;
  return { n, logE, zcr, cep, flux: fluxS, speech, thr, f0, clar, level, pitch };
}
// Pitch per frame (Hz, 0 = unvoiced) and how periodic the sound is (0..1), from a 40 ms window at 8 kHz.
// Only frames near or above the speech level are measured; every other frame is computed and the gaps copied.
export function pitchTrack(x, n, logE, thr) {
  const m = x.length >> 1; const y = new Float32Array(m); for (let i = 0; i < m; i++) y[i] = (x[2 * i] + x[2 * i + 1]) * 0.5;
  const sq = new Float64Array(m + 1); for (let i = 0; i < m; i++) sq[i + 1] = sq[i] + y[i] * y[i];
  const W = 320, L0 = 20, L1 = 115; // 70..400 Hz
  const f0 = new Float32Array(n), clar = new Float32Array(n); const r = new Float64Array(L1 + 1);
  for (let f = 0; f < n; f += 2) {
    if (logE[f] < thr - 6) continue;
    const s = (f * HOP) >> 1; if (s + W + L1 >= m) break;
    const e0 = sq[s + W] - sq[s]; if (e0 <= 1e-9) continue;
    let best = 0;
    for (let lag = L0; lag <= L1; lag++) { let c = 0; for (let k = 0; k < W; k++) c += y[s + k] * y[s + k + lag]; const e1 = sq[s + lag + W] - sq[s + lag]; r[lag] = c / Math.sqrt(e0 * e1 + 1e-12); if (r[lag] > best) best = r[lag]; }
    // the first clear peak (shortest period) close to the best one avoids picking a multiple of the true period
    let pick = 0; for (let lag = L0 + 1; lag < L1; lag++) if (r[lag] >= 0.88 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { pick = lag; break; }
    if (!pick) continue;
    f0[f] = 8000 / pick; clar[f] = r[pick]; if (f + 1 < n) { f0[f + 1] = f0[f]; clar[f + 1] = clar[f]; }
  }
  return { f0, clar };
}
const near = (a, b, tol) => a > 0 && b > 0 && Math.abs(a - b) <= tol * b;
function smooth(a, r) { const out = new Float32Array(a.length); let s = 0; const w = 2 * r + 1; for (let i = 0; i < a.length + r; i++) { if (i < a.length) s += a[i]; if (i - w >= 0) s -= a[i - w]; const c = i - r; if (c >= 0 && c < a.length) out[c] = s / Math.min(w, i + 1, a.length - c + r); } return out; }
function pct(arr, p) { const a = Float32Array.from(arr).sort(); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; }
export function speechThreshold(logE) { const floor = pct(logE, 0.1), peak = pct(logE, 0.98); return Math.max(floor + 12, peak - 38); }
// speech frames, with dips under 60 ms filled and blips under 50 ms dropped
export function speechMask(logE, thr) {
  const n = logE.length; const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = logE[i] > thr ? 1 : 0;
  fillRuns(m, 0, 6); fillRuns(m, 1, 5); return m;
}
function fillRuns(m, val, maxLen) { let i = 0; while (i < m.length) { if (m[i] !== val) { i++; continue; } let j = i; while (j < m.length && m[j] === val) j++; if (j - i < maxLen && i > 0 && j < m.length) m.fill(1 - val, i, j); i = j; } }
// runs of speech separated by pauses of at least minGap seconds -> [{a, b}] frame ranges (b exclusive)
export function speechRuns(speech, minGap) {
  const out = []; const g = Math.round(minGap / FRAME); let i = 0; const n = speech.length;
  while (i < n) { if (!speech[i]) { i++; continue; } let j = i, last = i; while (j < n) { if (speech[j]) { last = j; j++; } else { let k = j; while (k < n && !speech[k]) k++; if (k - j >= g || k >= n) break; j = k; } } out.push({ a: i, b: last + 1 }); i = last + 1; }
  return out;
}

// Distance between two frames' timbre (MFCC 1..12)
function fdist(cep, i, j) { let s = 0; for (let c = 1; c < NCEP; c++) { const d = cep[i * NCEP + c] - cep[j * NCEP + c]; s += d * d; } return Math.sqrt(s); }
// Does sequence A (frames a0..a1) match the START of sequence B (b0..)? Start-anchored DTW with a free end in B.
// Returns the mean frame distance along the best path (lower = more alike).
export function prefixMatch(cep, a0, a1, b0, bMax, step = 2) {
  const A = [], B = []; for (let i = a0; i < a1; i += step) A.push(i); const n = A.length; if (n < 3) return Infinity;
  const lenB = Math.min(bMax - b0, Math.round((a1 - a0) * 1.6)); for (let j = b0; j < b0 + lenB; j += step) B.push(j); const m = B.length; if (m < 3) return Infinity;
  let prev = new Float64Array(m).fill(Infinity), prevL = new Float64Array(m), cur = new Float64Array(m), curL = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = fdist(cep, A[i], B[j]); let best = Infinity, bl = 0;
      if (i === 0 && j === 0) { best = 0; bl = 0; }
      else {
        if (i > 0 && prev[j] < best) { best = prev[j]; bl = prevL[j]; }
        if (j > 0 && cur[j - 1] < best) { best = cur[j - 1]; bl = curL[j - 1]; }
        if (i > 0 && j > 0 && prev[j - 1] <= best) { best = prev[j - 1]; bl = prevL[j - 1]; }
      }
      cur[j] = best + d; curL[j] = bl + 1;
    }
    [prev, cur] = [cur, prev]; [prevL, curL] = [curL, prevL];
  }
  let res = Infinity; const jMin = Math.floor(m * 0.4);
  for (let j = Math.max(jMin, Math.floor(n * 0.6)); j < m; j++) res = Math.min(res, prev[j] / prevL[j]);
  return res;
}

const t = f => Math.round(f * FRAME * 1000) / 1000;
// Filled pause ("어~", "음~", "이~"): a clearly voiced sound held on a steady pitch for 0.3 s+, starting right after a pause.
// Ordinary syllables last ~0.15 s and the pitch keeps moving; a drawn-out ending ("…요~") doesn't start after a pause.
export function findFilledPauses(F, opts = {}) {
  const minDur = Math.round((opts.minDur ?? 0.3) / FRAME), tol = opts.tol ?? 0.07; const out = [];
  const loud = F.level - 16; const sf = []; for (let i = 0; i < F.n; i++) if (F.speech[i]) sf.push(F.flux[i]); const fluxCap = 1.4 * pct(sf, 0.5);
  const voiced = i => F.clar[i] >= 0.78 && F.f0[i] > 0 && F.logE[i] >= loud && F.zcr[i] < 0.25;
  for (const u of speechRuns(F.speech, 0.07)) {
    let i = u.a;
    while (i < u.b) {
      if (!voiced(i)) { i++; continue; }
      // grow a run whose pitch stays within ±tol of its running median; allow 3-frame dropouts (octave slips, noise)
      // a short wobble (<= 100 ms) is allowed when the voice comes back on the same note: "이~ (흔들림) 이~"
      const ps = [F.f0[i]]; let j = i + 1, miss = 0, last = i, seg = 1, longest = 1;
      while (j < u.b) {
        const med = ps.slice().sort((x, y) => x - y)[ps.length >> 1];
        if (voiced(j) && (near(F.f0[j], med, tol) || near(F.f0[j] * 2, med, tol) || near(F.f0[j] / 2, med, tol)) && F.flux[j] < fluxCap) { ps.push(near(F.f0[j], med, tol) ? F.f0[j] : med); seg = miss > 3 ? 1 : seg + 1; longest = Math.max(longest, seg); last = j; miss = 0; }
        else if (++miss > 10) break;
        j++;
      }
      const len = last + 1 - i;
      if (len >= minDur && longest >= Math.round(0.2 / FRAME)) {
        const atStart = i - u.a <= 12, alone = len >= 0.7 * (u.b - u.a);
        // a filler stands apart: the voice drops off right after it ("이~ | 시그니처"), unlike a stretched first syllable
        // that runs straight into its word ("그~리고") — cutting that would chop the word
        let mean = 0; for (let k = i; k <= last; k++) mean += F.logE[k]; mean /= len;
        let low = Infinity; for (let k = last + 1; k <= last + 20 && k < F.n; k++) low = Math.min(low, F.logE[k]);
        const apart = !(last + 1 < F.n) || mean - low >= (opts.dip ?? 10);
        const sorted = ps.slice().sort((x, y) => x - y); const note = sorted[sorted.length >> 1]; const rel = F.pitch ? note / F.pitch : 1;
        // low note: a stressed first syllable of a word ("폭~넓게", "소~프트") is usually at or above the normal pitch
        if ((atStart || alone) && apart && rel <= (opts.relPitch ?? 0.92)) {
          const spread = (sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)]) / note;
          const confident = len >= Math.round(0.4 / FRAME) && spread < 0.1 && rel <= 0.9 && mean >= F.level - 10;
          out.push({ kind: 'filler', s: t(Math.max(u.a, i - 3)), e: t(Math.min(u.b, last + 4)), text: alone ? '(어·음처럼 길게 끈 소리 · 소리로 추정)' : '(말 사이에 낮게 길게 끈 어·음 · 소리로 추정)', confident, audio: true, score: +rel.toFixed(2) });
        }
      }
      i = last + 1;
    }
  }
  return out;
}
// Quiet sounds between phrases — breaths, rustles, a murmured "음…" — far below the speaker's normal level
export function findQuietMurmurs(F, opts = {}) {
  const quiet = F.level - (opts.below ?? 12); const out = [];
  for (const u of speechRuns(F.speech, 0.07)) {
    const len = u.b - u.a; if (len < 8 || len > 150) continue;
    let sum = 0; for (let i = u.a; i < u.b; i++) sum += F.logE[i]; if (sum / len >= quiet) continue;
    const prev = out[out.length - 1];
    if (prev && u.a * FRAME - prev.e < 0.35) prev.e = t(u.b + 2); else out.push({ kind: 'mumble', s: t(Math.max(0, u.a - 2)), e: t(u.b + 2), text: '(말소리보다 훨씬 작은 소리 · 숨소리·웅얼거림 추정)', confident: false, audio: true });
  }
  return out;
}

// Scores are judged against the recording's own typical score (median), so different voices and mics need no tuning.
const FALLBACK_MEDIAN = 27; // typical score of unrelated neighbours, used when there are too few to measure
function medianOr(vals) { const v = vals.filter(Number.isFinite); return v.length >= 6 ? pct(v, 0.5) : FALLBACK_MEDIAN; }
export function findSoundStutters(F, opts = {}) {
  const bursts = speechRuns(F.speech, opts.gap ?? 0.07); const maxA = Math.round((opts.maxLen ?? 0.45) / FRAME), maxGap = Math.round(0.5 / FRAME), onset = 10;
  // compare only the onset (first 100 ms): "그" said alone and the "그" inside "그러니까" share the start, not the drawn-out vowel
  const pairs = []; for (let k = 0; k + 1 < bursts.length; k++) { const A = bursts[k], B = bursts[k + 1]; pairs.push({ A, B, c: prefixMatch(F.cep, A.a, Math.min(A.b, A.a + onset), B.a, B.b, 1) }); }
  const med = medianOr(pairs.map(p => p.c)); const thr = med * (opts.rel ?? 0.45); const out = [];
  const voice = (a, b) => { let v = 0, e = 0; const ps = []; for (let i = a; i < b; i++) { e += F.logE[i]; if (F.clar[i] >= 0.7 && F.f0[i] > 0) { v++; ps.push(F.f0[i]); } } ps.sort((x, y) => x - y); return { ok: v >= 0.45 * (b - a) && e / (b - a) >= F.level - 12, f0: ps.length ? ps[ps.length >> 1] : 0 }; };
  let chained = false; // "그 그 그러니까": right after a stutter, the next short burst is judged more loosely
  for (const { A, B, c } of pairs) {
    const la = A.b - A.a; let ok = la >= 6 && la <= maxA && B.a - A.b <= maxGap && c < (chained ? med * 0.7 : thr);
    if (ok) { const va = voice(A.a, A.b), vb = voice(B.a, Math.min(B.b, B.a + onset + 5)); ok = va.ok && vb.ok; }
    chained = ok; if (!ok) continue;
    out.push({ kind: 'stutter', s: t(Math.max(0, A.a - 2)), e: t(B.a - 1), text: '(같은 소리로 바로 다시 시작 · 소리로 추정)', confident: c < med * 0.25, audio: true, score: +c.toFixed(2) });
  }
  return out;
}
export function findSoundRepeats(F, opts = {}) {
  const phrases = speechRuns(F.speech, opts.gap ?? 0.3).filter(p => p.b - p.a >= Math.round(0.6 / FRAME));
  const costs = [];
  for (let i = 0; i < phrases.length; i++) for (let k = 1; k <= 2 && i + k < phrases.length; k++) {
    const P = phrases[i], Q = phrases[i + k]; if ((Q.a - P.b) * FRAME > 8) break;
    let e = 0; for (let f = P.a; f < P.b; f++) e += F.logE[f]; if (e / (P.b - P.a) < F.level - 12) continue; // a breath or noise is not a take
    const a1 = Math.min(P.b, P.a + Math.round(2.5 / FRAME));
    costs.push({ i, k, c: prefixMatch(F.cep, P.a, a1, Q.a, Q.b, 2) });
  }
  if (!costs.length) return [];
  const med = medianOr(costs.map(x => x.c)); const thr = med * (opts.rel ?? 0.55);
  const out = []; const used = new Set();
  for (const x of costs) {
    if (!(x.c < thr) || used.has(x.i)) continue; used.add(x.i); const P = phrases[x.i], Q = phrases[x.i + x.k];
    out.push({ kind: 'repeat', s: t(P.a), e: t(Math.min(Q.a - 1, P.b + 5)), text: '(바로 뒤에서 같은 말을 다시 함 · 소리로 추정)', pair: `${t(Q.a).toFixed(1)}초부터 다시 한 부분`, confident: x.c < med * 0.42, audio: true, sim: Math.max(0, Math.min(0.99, 1 - x.c / med)), score: +x.c.toFixed(2) });
  }
  return out;
}
// everything at once: samples (16 kHz mono Float32Array) -> candidates in seconds
export function scanSound(x, kinds = { filler: true, stutter: true, repeat: true, mumble: true }) {
  const F = analyzeFrames(x); const out = [];
  if (kinds.filler) out.push(...findFilledPauses(F));
  if (kinds.mumble) out.push(...findQuietMurmurs(F));
  if (kinds.stutter) out.push(...findSoundStutters(F));
  if (kinds.repeat) out.push(...findSoundRepeats(F));
  return out.sort((a, b) => a.s - b.s);
}
