import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normKo, similarity, wordsFromChunks, buildCaptionLines, buildSentences, buildSRT, srtTime, findFillers, findRepeats, mergeSpans, resampleInto } from '../src/textlogic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// every els.X in main.js has an element; every id in the AI tab exists for transcribe.js
const idList = main.match(/const ids = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
assert.deepEqual(idList.filter(id => !html.includes(`id="${id}"`)), []);
for (const id of ['aiChip', 'aiModel', 'aiGpu', 'btnAiRun', 'btnAiCancel', 'aiProgress', 'aiStatus', 'btnSrtOut', 'btnSrtSrc', 'btnTxtCopy', 'aiText', 'aiCandChip', 'btnAiApply', 'btnAiCheckAll', 'btnAiUncheckAll', 'aiCandBody', 'tab-ai']) assert.ok(html.includes(`id="${id}"`), 'missing ' + id);
console.log('ids ok');

// pure block from main.js
const pure = main.slice(main.indexOf('// ==PURE-START=='), main.indexOf('// ==PURE-END=='));
const ctx = { HOP: 0.02, TextEncoder, Blob, console, Math, Number, String, Array, Uint8Array, Int32Array, Float32Array, Float64Array, DataView, ArrayBuffer, Date, encodeURIComponent };
vm.createContext(ctx);
vm.runInContext(pure + '\n;globalThis.__api = { applySpan, keepRanges, outTime, detectSegments, demoEnvelope, suggestThreshold, buildFFmpeg, buildFCPXML };', ctx);
const A = ctx.__api;
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
console.log('text logic ok');
console.log('ALL SITE TESTS PASSED');
