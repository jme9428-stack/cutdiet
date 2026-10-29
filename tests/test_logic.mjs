import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as A from '../src/cutlogic.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { captionWidth, finishLines, normKo, similarity, wordsFromChunks, dropSilentWords, buildCaptionLines, buildSentences, buildSRT, srtTime, findFillers, findRepeats, findStutters, findMumbles, findShortBursts, stripFromLines, parseSRT, breakScore, resplitLines, splitLineAt, wordsOfLines, mergeSpans, resampleInto } from '../src/textlogic.js';

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
// audio-only: a short sound standing alone between two removed pauses
{
  const segs = [{ s: 0, e: 3, keep: true }, { s: 3, e: 4, keep: false }, { s: 4, e: 4.4, keep: true }, { s: 4.4, e: 5.2, keep: false }, { s: 5.2, e: 9, keep: true }, { s: 9, e: 9.1, keep: false }, { s: 9.1, e: 9.5, keep: true }, { s: 9.5, e: 11, keep: false }];
  const sb = findShortBursts(segs); assert.equal(sb.length, 1); assert.deepEqual([sb[0].s, sb[0].e, sb[0].kind, sb[0].confident], [4, 4.4, 'short', false]);
}
// music dragged to start later: nothing mixed before the offset, fade-in counts from the music start
{
  const sr = 1000; const bgm = { data: new Float32Array(5000).fill(0.5), sr, duration: 5, volume: 1, loop: false, fade: 0, duck: false, offset: 1 };
  const ch = [new Float32Array(2000)]; A.mixBgmInto(ch, sr, 0, 0, bgm, null, A.HOP, -40, 10, { g: 1 });
  assert.equal(ch[0][500], 0); assert.ok(Math.abs(ch[0][1500] - 0.5) < 1e-6);
}
// natural caption lines: break at sentence ends / connectives / pauses, never between a modifier and its noun
{
  const mk = (txt, t0 = 0, gaps = {}) => { let t = t0; return txt.split(' ').map((x, i) => { const w = { text: ' ' + x, s: t, e: t + 0.32 }; t += 0.36 + (gaps[i] || 0); return w; }); };
  const words = mk('그리고 이거는 이제 오에이보다 조금 더 얇고 가벼운 칠에이입니다. 이렇게 이런 스틱을 쓰면 연습하다 보면 손이 좀 덜 아프거든요.');
  const lines = buildCaptionLines(words, { maxChars: 18 }); const texts = lines.map(l => l.text);
  assert.ok(lines.every(l => normKo(l.text).length <= 22), JSON.stringify(texts));
  assert.ok(texts.some(t => t.endsWith('칠에이입니다')), 'sentence ends a line: ' + JSON.stringify(texts));
  assert.ok(!texts.some(t => /[.,]$/.test(t)), 'no period or comma at a line end: ' + JSON.stringify(texts));
  assert.ok(!texts.some(t => /이런$/.test(t)), 'no break after a modifier: ' + JSON.stringify(texts));
  assert.ok(!texts.some(t => /연습하다$/.test(t)), '"연습하다 보면" stays together: ' + JSON.stringify(texts));
  assert.equal(normKo(texts.join('')).replace(/\s+/g, ''), normKo(words.map(w => w.text.trim()).join('')).replace(/\s+/g, ''), 'no words lost');
  assert.ok(breakScore({ text: '얇고', e: 1 }, { s: 1.05 }) > breakScore({ text: '이런', e: 1 }, { s: 1.05 }));
  // a long pause always ends a line
  const pw = mk('첫 문장 하나 그리고 둘째', 0, { 2: 1.5 }); assert.ok(buildCaptionLines(pw).length >= 2);
  // re-split hand-edited lines: one long edited line becomes natural lines with times spread over it
  const re = resplitLines([{ s: 10, e: 20, text: '오늘은 편집 방법을 알려 드릴게요. 먼저 무음 구간을 자동으로 찾아서 잘라 냅니다.', edited: true }], [], { maxChars: 18 });
  assert.ok(re.length >= 2 && re[0].s === 10 && Math.abs(re[re.length - 1].e - 20) < 0.9 && re.every(l => l.e > l.s), JSON.stringify(re));
  assert.ok(re.some(l => l.text.endsWith('드릴게요')) && !re.some(l => /드릴게요. /.test(l.text)), 'the sentence end closes a line: ' + JSON.stringify(re.map(l => l.text)));
  // Netflix Korean counting: Hangul 1, Latin/digits/spaces/punctuation 0.5; default lines stay within 16 (one line)
  assert.equal(captionWidth('5A 스틱'), 3.5); assert.equal(captionWidth('가나다'), 3);
  const long = mk('안녕하세요 오늘 영상은 스틱 종류에 대해서 가이드를 해보려고 합니다 스틱 종류가 뭐가 있는지 그리고 우리가 사용하는 일반 스틱에서도 어떤 종류가 있는지 같이 이야기 해보려고 영상을 제작하게 되었습니다');
  const ll = buildCaptionLines(long); assert.ok(ll.length >= 5 && ll.every(l => captionWidth(l.text) <= 20), JSON.stringify(ll.map(l => l.text)));
  // a conjunction opens the next line, a dependent noun never starts one, a polite ending closes a line without a period
  assert.ok(breakScore({ text: '그리고', e: 1 }, { s: 1.05, text: '우리가' }) < 0 && breakScore({ text: '있는지', e: 1 }, { s: 1.05, text: '그리고' }) > breakScore({ text: '있는지', e: 1 }, { s: 1.05, text: '우리가' }));
  assert.ok(breakScore({ text: '작은', e: 1 }, { s: 1.05, text: '것을' }) < 0 && breakScore({ text: '느껴질', e: 1 }, { s: 1.05, text: '때가' }) < 0);
  assert.ok(breakScore({ text: '있습니다', e: 1 }, { s: 1.05, text: '그런' }) >= 5);
  const dn = buildCaptionLines(mk('그래서 일반 스틱 보다 소리 볼륨이 많이 작은 것을 알 수가 있어요'));
  assert.ok(!dn.some(l => /작은$|알$/.test(l.text)), JSON.stringify(dn.map(l => l.text)));
  // a retake line stretched to the next caption is still removed with its deleted span
  const rt = stripFromLines([{ s: 0, e: 1.45, text: '이건 정말 중요합니다' }, { s: 1.45, e: 3, text: '이건 정말 중요합니다' }], [{ kind: 'repeat', s: 0, e: 1.2 }]);
  assert.equal(rt.length, 1); assert.equal(rt[0].s, 1.45);
  // re-splitting untouched lines keeps them untouched
  assert.ok(resplitLines([{ s: 0, e: 4, text: '오늘은 편집 방법을 알려 드릴게요' }], [], {}).every(l => !l.edited));
  // each line stays up long enough to read at 12 characters a second, without running into the next one
  const fl = finishLines([{ s: 0, e: 0.3, text: '가나다라마바사아자차카타' }, { s: 0.6, e: 2, text: '다음 줄입니다.' }, { s: 2.1, e: 3, text: '끝' }]);
  assert.equal(fl[0].e, 0.6); assert.equal(fl[1].text, '다음 줄입니다'); assert.equal(fl[1].e, 2.1); assert.ok(fl[2].e >= 2.9);
  // untouched lines keep the recognized word times
  const rw = mk('안녕하세요 반갑습니다', 5); const wl = wordsOfLines([{ s: 5, e: 5.7, text: '안녕하세요 반갑습니다' }], rw); assert.equal(wl[1].s, rw[1].s);
  // splitting one caption at the playhead picks the nearest natural word boundary
  const sp = splitLineAt({ s: 0, e: 4, text: '조금 더 얇고 가벼운 스틱입니다' }, 1.7);
  assert.ok(sp && sp[0].e === 1.7 && sp[1].s === 1.7, JSON.stringify(sp)); assert.equal(sp[0].text + ' ' + sp[1].text, '조금 더 얇고 가벼운 스틱입니다');
  assert.ok(!/가벼운$/.test(sp[0].text), 'not between "가벼운" and its noun: ' + JSON.stringify(sp));
  assert.equal(splitLineAt({ s: 0, e: 1, text: '하나' }, 0.5), null);
}
for (const id of ['tlHeads', 'hudCand', 'btnMiniClose', 'aiCandNote', 'btnAiRescan']) assert.ok(html.includes(`id="${id}"`), 'missing ' + id);
// the candidates card sits right under ② and before the caption editor
// editor layout: every rail tab has its panel; NG candidates live in their own panel; the caption tools are in 자막
{
  const tabs = [...html.matchAll(/class="tab" role="tab" data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['segments', 'ai', 'ng', 'text', 'bgm', 'decorate', 'shorts', 'export', 'guide']);
  for (const t of tabs) assert.ok(html.includes(`id="tab-${t}"`), 'panel for ' + t);
  const sect = id => html.slice(html.indexOf(`id="tab-${id}"`), html.indexOf('</section>', html.indexOf(`id="tab-${id}"`)));
  assert.ok(sect('ng').includes('id="aiCandBody"') && sect('ai').includes('id="btnCapResplit"') && sect('ai').includes('id="subPreset"') && sect('export').includes('id="thumbGrid"') && sect('export').includes('id="chBody"'));
  assert.ok(html.includes('id="inspector"') && html.includes('id="btnTopExport"'));
}
for (const id of ['capList', 'capChip', 'btnCapAdd', 'btnCapImport', 'capFile', 'capFind', 'capReplace', 'btnCapReplace', 'capFollow', 'aiOptFiller', 'aiOptStutter', 'aiOptRepeat', 'aiOptMumble', 'aiOptStrip']) assert.ok(html.includes(`id="${id}"`), 'missing ' + id);
console.log('text logic ok');
console.log('ALL SITE TESTS PASSED');
