// Sound-only candidate search (src/audiologic.js) on synthetic speech: syllables = consonant noise burst + voiced vowel
// with formants. Checks that a filled pause, a stutter and a retake are found, and that varied speech raises no alarm.
import assert from 'node:assert/strict';
import { SR, analyzeFrames, speechRuns, prefixMatch, scanSound, FRAME } from '../src/audiologic.js';

let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const VOWELS = [[730, 1090], [270, 2290], [300, 870], [530, 1840], [570, 840], [440, 1020], [660, 1720]];
// one syllable: c = consonant noise colour (0..4, or -1 for none), v = vowel index; dur seconds; f0 Hz
function syllable(c, v, dur, f0, out, glide = 0.08) {
  const n = Math.round(dur * SR); const [F1, F2] = VOWELS[v]; const cn = c >= 0 ? Math.round(0.035 * SR) : 0; let lp = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR; let s = 0;
    if (i < cn) { const w = rnd() * 2 - 1; lp += (w - lp) * (0.15 + c * 0.18); s = (c % 2 ? w - lp : lp) * 0.25; }
    else { const f = f0 * (1 - glide * (i / n)); for (let h = 1; h * f < 4000; h++) { const hf = h * f; const a = Math.exp(-((hf - F1) ** 2) / (2 * 90 ** 2)) + 0.6 * Math.exp(-((hf - F2) ** 2) / (2 * 120 ** 2)) + 0.02; s += a * Math.sin(2 * Math.PI * hf * tt) / h ** 0.3; } s *= 0.12; }
    const env = Math.min(1, i / (0.01 * SR), (n - i) / (0.015 * SR)); out.push(s * env);
  }
}
const pause = (sec, out) => { for (let i = 0; i < Math.round(sec * SR); i++) out.push((rnd() - 0.5) * 0.002); };
const word = (sylls, out, stretch = 1, f0 = 150) => { for (const [c, v] of sylls) syllable(c, v, 0.15 * stretch, f0, out); };
const randomWord = len => Array.from({ length: len }, () => [Math.floor(rnd() * 5), Math.floor(rnd() * VOWELS.length)]);

// ---- build a recording with known problems ----
const x = []; const truth = []; const mark = (kind, fn) => { const s = x.length / SR; fn(); truth.push({ kind, s, e: x.length / SR }); };
pause(0.5, x);
for (let k = 0; k < 6; k++) { word(randomWord(5 + (k % 3)), x); pause(0.12, x); word(randomWord(4), x); pause(0.6, x); }
mark('filler', () => syllable(-1, 5, 0.65, 130, x)); pause(0.35, x); word(randomWord(6), x); pause(0.6, x); // "어~" then a sentence
const target = randomWord(5); mark('stutter', () => word([target[0]], x, 1.3)); pause(0.15, x); word(target, x); pause(0.6, x); // "그 그러니까"
const take = [...randomWord(6), ...randomWord(6)]; mark('repeat', () => word(take.slice(0, 8), x)); pause(0.5, x); word(take, x, 1.08, 160); pause(0.6, x); // retake
for (let k = 0; k < 6; k++) { word(randomWord(6), x); pause(0.12, x); word(randomWord(3), x); pause(0.55, x); }
const audio = Float32Array.from(x);

const F = analyzeFrames(audio);
assert.ok(F.n > 1000 && F.speech.some(v => v) && F.speech.some(v => !v));
const runs = speechRuns(F.speech, 0.3); assert.ok(runs.length >= 15, 'phrases ' + runs.length);
assert.equal(prefixMatch(F.cep, 10, 12, 50, 60), Infinity, 'too short to compare');
const c = scanSound(audio);
const hit = tr => c.some(k => k.kind === tr.kind && Math.min(k.e, tr.e) - Math.max(k.s, tr.s) > 0.05);
for (const tr of truth) assert.ok(hit(tr), `missed ${tr.kind} at ${tr.s.toFixed(2)}s: ` + JSON.stringify(c));
const falses = c.filter(k => !truth.some(tr => Math.min(k.e, tr.e) - Math.max(k.s, tr.s) > 0.05));
assert.ok(falses.length <= 1, 'false alarms: ' + JSON.stringify(falses));
assert.ok(c.every(k => k.audio && k.e > k.s && typeof k.confident === 'boolean' && k.text));
// real-recording pattern (1:26 in a user's video): "이~" held on one note with a short wobble, a break, then the sentence.
// Its look-alike — the same held note running straight into the next syllable ("그~리고") — must not be offered for deletion.
{
  const held = (out, gapInside) => { syllable(-1, 1, 0.25, 108, out, 0.02); if (gapInside) for (let i = 0; i < Math.round(0.08 * SR); i++) out.push((rnd() - 0.5) * 0.01); syllable(-1, 1, 0.25, 110, out, 0.02); };
  const y = []; pause(0.6, y); for (let k = 0; k < 8; k++) { word(randomWord(6), y); pause(0.5, y); }
  const fs = y.length / SR; held(y, true); const fe = y.length / SR; pause(0.12, y); word(randomWord(5), y); pause(0.6, y);
  const ws = y.length / SR; held(y, false); word(randomWord(3), y); const we = y.length / SR; pause(0.6, y);
  for (let k = 0; k < 6; k++) { word(randomWord(5), y); pause(0.5, y); }
  const got = scanSound(Float32Array.from(y)).filter(k => k.kind === 'filler');
  assert.ok(got.some(k => k.s < fe && k.e > fs), 'held "이~" with a wobble should be found: ' + JSON.stringify(got));
  assert.ok(!got.some(k => k.s < we && k.e > ws), 'a held syllable flowing into its word must not be cut: ' + JSON.stringify(got));
}
// silence or a pure tone gives nothing
assert.deepEqual(scanSound(new Float32Array(SR * 3)), []);
const tone = new Float32Array(SR * 3).map((_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / SR)); assert.ok(scanSound(tone).length <= 1);
// speed: 10 minutes of audio must stay well under a few seconds
const t0 = performance.now(); analyzeFrames(new Float32Array(SR * 60).map(() => (rnd() - 0.5) * 0.1)); const ms = performance.now() - t0;
assert.ok(ms < 3000, `1 min analysis took ${ms.toFixed(0)}ms`);
console.log(`audio scan ok · ${c.length} candidates (${falses.length} extra) · 1 min analysis ${ms.toFixed(0)}ms · frame ${FRAME}s`);
console.log('ALL AUDIO TESTS PASSED');
