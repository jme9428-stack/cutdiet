import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as A from '../src/cutlogic.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normKo, similarity, wordsFromChunks, dropSilentWords, buildCaptionLines, buildSentences, buildSRT, srtTime, findFillers, findRepeats, findStutters, findMumbles, stripFromLines, parseSRT, mergeSpans, resampleInto } from '../src/textlogic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// every els.X in main.js has an element; every id in the AI tab exists for transcribe.js
const idList = main.match(/const ids = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
assert.deepEqual(idList.filter(id => !html.includes(`id="${id}"`)), []);
for (const id of ['aiChip', 'aiModel', 'aiGpu', 'btnAiRun', 'btnAiCancel', 'aiProgress', 'aiStatus', 'btnSrtOut', 'btnSrtSrc', 'btnTxtCopy', 'aiText', 'aiCandChip', 'btnAiApply', 'btnAiCheckAll', 'btnAiUncheckAll', 'aiCandBody', 'tab-ai']) assert.ok(html.includes(`id="${id}"`), 'missing ' + id);
console.log('ids ok');

// pure logic now lives in src/cutlogic.js (imported above as A)
// applySpan splits and marks
let segs = [{ s: 0, e: 10, keep: true }];
segs = A.applySpan(segs, 2, 3, false);
assert.equal(JSON.stringify(segs), JSON.stringify([{ s: 0, e: 2, keep: true }, { s: 2, e: 3, keep: false }, { s: 3, e: 10, keep: true }]));
segs = A.applySpan(segs, 2.5, 4, false); // overlaps existing removed span -> merged removed run
assert.equal(JSON.stringify(segs), JSON.stringify([{ s: 0, e: 2, keep: true }, { s: 2, e: 4, keep: false }, { s: 4, e: 10, keep: true }]));
segs = A.applySpan(segs, 9.998, 12, false); // tiny fragment absorbed
assert.ok(segs.every(g => g.e - g.s >= 0.005));
assert.equal(segs[segs.length - 1].e, 10);
console.log('applySpan ok');

// text logic
assert.equal(normKo(' 안녕하세요, 여러분! '), '안녕하세요여러분');
assert.ok(similarity('오늘은날씨가좋네요', '오늘은날씨가좋아요') > 0.85);
const chunks = [{ text: ' 어', timestamp: [0, 0.3] }, { text: ' 오늘은', timestamp: [0.5, 0.9] }, { text: ' 날씨가', timestamp: [0.9, 1.3] }, { text: ' 좋네요.', timestamp: [1.3, 1.9] },
  { text: ' 음', timestamp: [2.4, 2.7] }, { text: ' 오늘은', timestamp: [3.2, 3.6] }, { text: ' 날씨가', timestamp: [3.6, 4.0] }, { text: ' 좋네요.', timestamp: [4.0, 4.6] }, { text: ' 그래서', timestamp: [5.0, 5.4] }, { text: ' 나갔습니다.', timestamp: [5.4, 6.2] }, { text: ' 끝', timestamp: [7, null] }];
const words = wordsFromChunks(chunks);
assert.equal(words.length, 11); assert.equal(words[10].e, 7.3);
const fill = findFillers(words); assert.equal(fill.length, 2); assert.ok(fill.every(f => f.confident));
const sents = buildSentences(words); assert.ok(sents.length >= 3, JSON.stringify(sents));
const reps = findRepeats(words); assert.equal(reps.length, 1); assert.ok(reps[0].confident); assert.ok(reps[0].s >= 0 && reps[0].e <= 2.4 && reps[0].e >= 1.9, JSON.stringify(reps[0]));
const lines = buildCaptionLines(words); assert.ok(lines.length >= 3); assert.ok(lines.every(l => l.text.length <= 24));
const srt = buildSRT(lines); assert.ok(srt.startsWith('1\n00:00:00,000 --> ')); assert.equal(srtTime(3725.5), '01:02:05,500');
// SRT in output time: a line fully inside a cut disappears
const srtCut = buildSRT([{ s: 1, e: 2, text: 'A' }, { s: 3, e: 4, text: 'B' }], t => (t <= 2 ? 0 : t - 2));
assert.ok(!srtCut.includes('\nA\n') && srtCut.includes('\nB\n'));
const spans = mergeSpans([{ s: 1, e: 1.2 }, { s: 1.21, e: 1.5 }, { s: 4, e: 5 }], 0.04); assert.equal(spans.length, 2);
// low-confidence filler needs a pause around it
const w2 = wordsFromChunks([{ text: ' 그', timestamp: [0, 0.3] }, { text: ' 사람이', timestamp: [0.3, 0.7] }, { text: ' 그', timestamp: [1.5, 1.8] }, { text: ' 왔어요', timestamp: [2.4, 2.9] }]);
const f2 = findFillers(w2); assert.equal(f2.length, 1); assert.equal(f2[0].confident, false); assert.equal(f2[0].s, 1.5);
// resampler: 1 s of 48k constant 0.5 -> 16k
const tgt = new Float32Array(16000 * 2); const src = [new Float32Array(48000).fill(0.5)]; const end = resampleInto(tgt, 16000, src, 48000, 0.5);
assert.ok(Math.abs(tgt[8000 + 100] - 0.5) < 1e-6 && tgt[100] === 0 && end >= 23990, 'resample end ' + end);
// clamp + hallucination filter
const wc = wordsFromChunks([{ text: ' 구독과', timestamp: [17.8, 25.4] }, { text: ' 안녕', timestamp: [1.0, 7.9] }, { text: ' 끝', timestamp: [7.5, 9.0] }], 8);
assert.equal(wc.length, 2); assert.equal(wc[1].e, 8);
const envS = new Float32Array(400).fill(-80); for (let i = 50; i < 100; i++) envS[i] = -20; // speech only 1.0-2.0 s
const kept = dropSilentWords([{ text: 'a', s: 1.1, e: 1.5 }, { text: 'b', s: 5.0, e: 5.4 }], envS, 0.02, -45);
assert.equal(kept.length, 1); assert.equal(kept[0].text, 'a');
assert.equal(dropSilentWords([{ text: 'x', s: 5, e: 5.2 }], null, 0.02, -45).length, 1);
// stutters: the first attempt is the candidate; ordinary speech is left alone
{
  const W = arr => { let t = 0; return arr.map(x => { const w = { text: x, s: t, e: t + 0.3 }; t += 0.35; return w; }); };
  const st = findStutters(W(['그', '그', '그러니까', '오늘은']));
  assert.deepEqual(st.map(c => c.text), ['그', '그']); assert.ok(st.every(c => c.kind === 'stutter' && c.confident));
  assert.deepEqual(findStutters(W(['그래서', '제가', '그래서', '제가', '말했죠'])).map(c => [c.text, c.confident]), [['그래서 제가', true]]);
  const mix = findStutters(W(['저', '저는', '많이', '많이', '그러-', '그러니까']));
  assert.deepEqual(mix.map(c => [c.text, c.confident]), [['저', true], ['많이', false], ['그러-', true]]);
  assert.equal(findStutters(W(['오늘은', '날씨가', '정말', '좋네요'])).length, 0);
  const far = W(['그', '그러니까']); far[1].s += 1; far[1].e += 1; assert.equal(findStutters(far).length, 0, 'a long pause is not a stutter');
  // mumble: voiced gap between recognized words
  const env = new Float32Array(100).fill(-80); for (let i = 20; i < 40; i++) env[i] = -20;
  const mm = findMumbles([{ text: 'a', s: 0, e: 0.9 }, { text: 'b', s: 2.1, e: 2.5 }], env, 0.05, -42); assert.equal(mm.length, 1); assert.equal(mm[0].confident, false);
  assert.equal(findMumbles([{ text: 'a', s: 0, e: 0.9 }, { text: 'b', s: 2.1, e: 2.5 }], new Float32Array(100).fill(-80), 0.05, -42).length, 0);
  // removed words leave the caption text; whole NG lines go
  const lines = stripFromLines([{ s: 0, e: 3, text: '그 그 그러니까 오늘은' }, { s: 3, e: 5, text: '다시 할게요' }, { s: 5, e: 7, text: '어 좋아요' }], [{ kind: 'stutter', s: 0, e: 0.3, text: '그' }, { kind: 'stutter', s: 0.35, e: 0.65, text: '그' }, { kind: 'repeat', s: 2.95, e: 5.05, text: 'x' }, { kind: 'filler', s: 5, e: 5.3, text: '어' }]);
  assert.deepEqual(lines.map(l => l.text), ['그러니까 오늘은', '좋아요']);
  // SRT / VTT import
  const srt = parseSRT('1\r\n00:00:01,000 --> 00:00:02,500\r\n안녕\r\n하세요\r\n\r\n2\r\n00:00:03.2 --> 00:00:04.000 align:start\r\n<i>둘</i>\r\n\r\n3\r\nbroken\r\n');
  assert.deepEqual(srt, [{ s: 1, e: 2.5, text: '안녕 하세요' }, { s: 3.2, e: 4, text: '둘' }]);
  assert.equal(parseSRT('WEBVTT\n\n01:02:03.500 --> 01:02:04.000\nx')[0].s, 3723.5);
  assert.deepEqual(parseSRT(buildSRT([{ s: 0.5, e: 1.25, text: '하나' }, { s: 2, e: 3, text: '둘' }])), [{ s: 0.5, e: 1.25, text: '하나' }, { s: 2, e: 3, text: '둘' }]);
}
for (const id of ['capList', 'capChip', 'btnCapAdd', 'btnCapImport', 'capFile', 'capFind', 'capReplace', 'btnCapReplace', 'capFollow', 'aiOptFiller', 'aiOptStutter', 'aiOptRepeat', 'aiOptMumble', 'aiOptStrip']) assert.ok(html.includes(`id="${id}"`), 'missing ' + id);
console.log('text logic ok');
console.log('ALL SITE TESTS PASSED');
