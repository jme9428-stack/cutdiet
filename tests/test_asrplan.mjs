// Speech-only Whisper windows (src/asrplan.js): skip pauses, pack <= ~27 s, overlap only at cuts made mid-speech,
// map word times back to the video, re-run a window's tail when Whisper stops early.
import assert from 'node:assert/strict';
import { planWindows, windowLength, speechSeconds, windowAudio, windowTimeToSource, mapChunks, transcribeWindows, envFromAudio, fastGpu, dedupeWords } from '../src/asrplan.js';

const hop = 0.02; const env = (dur, speech) => { const e = new Float32Array(Math.round(dur / hop)).fill(-70); for (const [s, t] of speech) for (let i = Math.round(s / hop); i < Math.round(t / hop); i++) e[i] = -20; return e; };

// 60 s with three talks and long pauses: pauses are skipped, everything fits in windows of <= 28 s, no overlap needed
{
  const w = planWindows(env(60, [[1, 9], [20, 30], [45, 52]]), hop, -40, 60);
  assert.ok(w.every(x => windowLength(x) <= 28.01), 'window too long');
  assert.ok(speechSeconds(w) < 30, 'pauses should be skipped: ' + speechSeconds(w));
  const parts = w.flatMap(x => x.parts); assert.ok(parts.some(p => p.s <= 1 && p.e >= 9) && parts.some(p => p.s <= 45 && p.e >= 52));
  assert.ok(!parts.some(p => p.s > 10 && p.e < 19), 'no part inside the long pause');
  assert.ok(w.every(x => x.keep.s === x.parts[0].s && x.keep.e === x.parts[x.parts.length - 1].e), 'no overlap at pause cuts');
}
// 70 s of non-stop talk: after a forced cut the next window starts 2 s early (context); the earlier one never hears past the cut
{
  const e = env(70, [[0, 70]]); for (let i = Math.round(24 / hop); i < Math.round(24.2 / hop); i++) e[i] = -35; // a slight dip to cut at
  const w = planWindows(e, hop, -40, 70);
  assert.ok(w.length >= 3);
  for (let k = 1; k < w.length; k++) { assert.equal(w[k].keep.s, w[k - 1].keep.e, 'keep ranges must tile'); assert.ok(w[k].parts[0].s < w[k].keep.s, 'context before forced cuts'); assert.equal(w[k - 1].parts[w[k - 1].parts.length - 1].e, w[k - 1].keep.e, 'no audio past the cut'); }
  assert.ok(Math.abs(w[0].keep.e - 24.1) < 0.3, 'cut at the quietest moment: ' + w[0].keep.e);
  assert.ok(w.every(x => windowLength(x) <= 30), 'with context still within Whisper\'s 30 s');
}
// no envelope: fixed windows with context
{ const w = planWindows(null, hop, -40, 65); assert.equal(w.length, 3); assert.equal(w[1].keep.s, 27); assert.ok(w[1].parts[0].s < 27); assert.equal(w[0].parts[0].e, 27); }

// time mapping across joined parts
{
  const w = { parts: [{ s: 10, e: 12 }, { s: 20, e: 21 }], keep: { s: 10, e: 21 } };
  assert.equal(windowTimeToSource(w, 0.5), 10.5); assert.equal(windowTimeToSource(w, 2.0), 12);
  assert.ok(Math.abs(windowTimeToSource(w, 2.12 + 0.5) - 20.5) < 1e-9); assert.equal(windowTimeToSource(w, 2.03), 12); assert.equal(windowTimeToSource(w, 2.1), 20);
  const m = mapChunks(w, [{ text: 'a', timestamp: [0.2, 0.6] }, { text: 'b', timestamp: [2.3, null] }]);
  assert.deepEqual(m.map(c => c.timestamp[0].toFixed(2)), ['10.20', '20.18']); assert.equal(m[1].timestamp[1], null);
  const a = windowAudio(Float32Array.from({ length: 16000 * 30 }, (_, i) => i), 16000, w); assert.equal(a.length, 16000 * 3 + Math.round(0.12 * 16000)); assert.equal(a[0], 160000);
}
// running: words outside a window's own stretch are dropped (no duplicates at overlaps); an early stop triggers a tail re-run
{
  const sr = 100; const audio = Float32Array.from({ length: 60 * sr }, (_, i) => i / sr); // sample value = its time
  const windows = [{ parts: [{ s: 0, e: 21 }], keep: { s: 0, e: 20 } }, { parts: [{ s: 19, e: 40 }], keep: { s: 20, e: 40 } }];
  const calls = [];
  // fake Whisper: a word every 2 s of the audio it gets, except it "gives up" after 8 s on the second window's first pass
  const fake = async a => { const t0 = a[0]; calls.push(t0); const len = a.length / sr; const lim = Math.abs(t0 - 19) < 1e-6 ? 8 : len; const chunks = []; for (let t = 0.5; t < lim; t += 2) chunks.push({ text: 'w' + Math.round(t0 + t), timestamp: [t, t + 0.4] }); return { chunks }; };
  const words = await transcribeWindows(fake, audio, sr, windows);
  const starts = words.map(c => c.timestamp[0]); assert.ok(starts.every((t, i) => !i || t > starts[i - 1]), 'in order, no duplicates');
  assert.equal(calls.length, 3, 'one tail re-run'); assert.ok(starts.some(t => t > 30), 'tail words recovered');
  assert.ok(!starts.some(t => t >= 20 && t < 20.4 && starts.filter(u => Math.abs(u - t) < 0.01).length > 1));
  await assert.rejects(transcribeWindows(fake, audio, sr, windows, { isCanceled: () => true }), /canceled/);
}
// the same word from two windows at a cut collapses to the longer reading; different words that touch are kept
{
  const d = dedupeWords([{ text: '가벼운', timestamp: [10, 10.5] }, { text: ' 칠', timestamp: [10.6, 11.0] }, { text: ' 칠A입니다.', timestamp: [10.62, 11.4] }, { text: '스틱', timestamp: [11.5, 11.8] }, { text: '스틱', timestamp: [12.0, 12.3] }]);
  assert.deepEqual(d.map(c => c.text.trim()), ['가벼운', '칠A입니다.', '스틱', '스틱'], 'a repeated word said twice on purpose stays');
}
// envelope from samples
{ const a = new Float32Array(16000); for (let i = 8000; i < 16000; i++) a[i] = 0.5 * Math.sin(i / 5); const e = envFromAudio(a, 16000, 0.02); assert.equal(e.length, 50); assert.ok(e[10] < -100 && e[40] > -15); }
// GPU choice: integrated Intel graphics (slower than the CPU path here) and phone GPUs stay on the CPU
assert.equal(fastGpu({ vendor: 'intel', architecture: 'xe-lpg' }), false); assert.equal(fastGpu({ vendor: 'intel', architecture: 'xe-hpg' }), true);
assert.equal(fastGpu({ vendor: 'nvidia', architecture: 'ada' }), true); assert.equal(fastGpu({ vendor: 'apple', architecture: 'metal-3' }), true); assert.equal(fastGpu({ vendor: 'qualcomm', architecture: 'adreno-7xx' }), false);
console.log('ALL ASR PLAN TESTS PASSED');
