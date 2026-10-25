// Engine tests: pure builders (always) + an end-to-end run against a real ffmpeg with synthetic media (when ffmpeg is available).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProbe, findFfmpeg, run, qualityFor } from '../engine/lib/ff.mjs';
import { buildArgs, selectExpr, retimeExpr, zoomExprs, segsFromRanges, mapOverlaysAndCaptions } from '../engine/lib/graph.mjs';
import { buildASS, assTime, assText, styleLine } from '../engine/lib/ass.mjs';
import { analyzeFile } from '../engine/lib/analyze.mjs';
import { transcribeAudio } from '../engine/lib/asr.mjs';
import { uniquePath, writeWav } from '../engine/lib/util.mjs';
import { SUB_PRESETS } from '../src/fxlogic.js';
import { detectSegments, keepRanges, HOP, outTime } from '../src/cutlogic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- probe parser ----
const dump = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':\n  Duration: 00:01:35.04, start: 0.000000, bitrate: 5114 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4978 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)\n    Metadata:\n      handler_name    : VideoHandler\n    Side data:\n      displaymatrix: rotation of -90.00 degrees\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6D703461), 48000 Hz, stereo, fltp, 128 kb/s (default)\n`;
const pi = parseProbe(dump);
assert.ok(Math.abs(pi.duration - 95.04) < 1e-6); assert.equal(pi.fps, 29.97); assert.equal(pi.rotation, 270); assert.equal(pi.width, 1080); assert.equal(pi.height, 1920); assert.ok(pi.hasAudio && pi.hasVideo); assert.equal(pi.channels, 2);
const pa = parseProbe(`Input #0, wav, from 'a.wav':\n  Duration: 00:00:10.00, bitrate: 1536 kb/s\n  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, mono, s16, 768 kb/s\n`);
assert.equal(pa.hasVideo, false); assert.equal(pa.channels, 1); assert.equal(pa.duration, 10);
console.log('probe parser ok');

// ---- graph builder ----
const ranges = [{ s: 1, e: 4 }, { s: 6, e: 9.5 }, { s: 12, e: 14 }];
assert.equal(selectExpr(ranges), 'between(t,1.000,4.000)+between(t,6.000,9.500)+between(t,12.000,14.000)');
assert.equal(retimeExpr(ranges), '(T-(1.000+gte(T,6.000)*2.000+gte(T,12.000)*2.500))/TB');
const segs = segsFromRanges(ranges, 20); assert.equal(segs.length, 7); assert.equal(outTime(segs, 12), 6.5);
assert.equal(zoomExprs({ zooms: [], autoZoom: { on: false } }, ranges), null);
const zx = zoomExprs({ zooms: [{ s: 1, e: 4, scale: 1.3, ax: 0.2, ay: 0.3, ease: 0.5 }], autoZoom: { on: true, scale: 1.12 } }, ranges);
assert.ok(zx.z.includes('between(it,1.000,4.000)') && zx.z.includes('between(it,6.000,9.500)') && zx.z.includes('1.120') && zx.z.includes('clip(min('), zx.z);
assert.ok(zx.x.startsWith('(iw-iw/zoom)*('));
const req = { src: 'in.mp4', ranges, duration: 20, fps: 30, width: 1280, height: 720, hasAudio: true, out: { w: 1280, h: 720 }, crop: null, quality: 'high', encoder: 'libx264', fx: { fade: { in: 0.5, out: 1 }, transition: { type: 'dissolve' }, zooms: [], autoZoom: { on: false } }, outPath: 'out.mp4' };
const plan = buildArgs(req, { ass: 'subs.ass', bgm: { path: 'bgm.mp3', volume: 0.2, duck: true, fade: 1, loop: true }, images: [{ path: 'logo.png', s: 0, e: 5, box: { x: 10, y: 10, w: 200, h: 100 }, opacity: 0.8 }], sfx: [{ path: 's.wav', outT: 2.5, volume: 0.7 }] }, { fontsDir: '/f', hasLibass: true });
assert.ok(plan.graph.includes('fps=30.000'), 'cfr grid'); assert.ok(plan.graph.includes("subtitles=filename='subs.ass':fontsdir='/f'")); assert.ok(plan.graph.includes('sidechaincompress')); assert.ok(plan.graph.includes('adelay=2500:all=1')); assert.ok(plan.graph.includes('fade=t=out:st=7.500:d=1.000'));
assert.ok(plan.graph.includes('asplit=3') && plan.graph.includes('concat=n=3:v=0:a=1')); assert.ok(plan.graph.includes("overlay=x=10:y=10:enable='between(t,0.000,5.000)'"));
assert.ok(plan.args.includes('-filter_complex_script') && plan.args.includes('libx264') && plan.args.at(-1) === 'out.mp4'); assert.ok(plan.warnings.some(w => /디졸브/.test(w)));
assert.equal(plan.total, 8.5);
const big = buildArgs({ ...req, ranges: Array.from({ length: 300 }, (_, i) => ({ s: i * 2, e: i * 2 + 1 })), duration: 600, fx: null }, { images: [], sfx: [] }, {});
assert.ok(big.graph.includes('asplit=300') && (big.graph.match(/concat=n=/g) || []).length >= 3, 'hierarchical concat');
const noA = buildArgs({ ...req, hasAudio: false, fx: null }, { images: [], sfx: [] }, {}); assert.ok(noA.graph.includes('anullsrc'));
const mapped = mapOverlaysAndCaptions({ ...req, captions: [{ s: 1.5, e: 2.5, text: 'a' }, { s: 4.5, e: 5.5, text: 'cut away' }, { s: 6, e: 7, text: 'b' }], fx: { overlays: [{ type: 'text', s: 1, e: 3, text: 'T', pos: 'tr', w: 0.05 }, { type: 'image', s: 12, e: 14, path: 'x.png', pos: 'tl', w: 0.2, ratio: 2 }], sfx: [{ t: 2, kind: 'ding' }, { t: 5, kind: 'pop' }] } });
assert.equal(mapped.captions.length, 2); assert.equal(mapped.captions[1].s, 3); assert.equal(mapped.textOverlays.length, 1); assert.equal(mapped.images[0].s, 6.5); assert.equal(mapped.sfx.length, 1); assert.equal(mapped.sfx[0].outT, 1);
assert.ok(qualityFor('high', 1920, 1080, 30).bitrate === 10e6 && qualityFor('720', 1280, 720, 30).bitrate < 3e6);
console.log('graph builder ok');

// ---- ASS ----
assert.equal(assTime(3725.5), '1:02:05.50'); assert.equal(assText('a {b}\nc'), 'a ｛b｝\\Nc');
const ass = buildASS({ W: 1920, H: 1080, style: SUB_PRESETS.variety, captions: [{ s: 0, e: 2, text: '안녕하세요' }], textOverlays: [{ s: 1, e: 3, text: '구독', style: SUB_PRESETS.box, pos: 'tr', sizeFrac: 0.05, opacity: 0.5, fade: 0.3 }] });
assert.ok(ass.includes('PlayResX: 1920') && ass.includes('Style: Cap,Black Han Sans,70,&H004DE1FF,') && ass.includes('Dialogue: 0,0:00:00.00,0:00:02.00,Cap,,0,0,0,,안녕하세요'), ass);
assert.ok(ass.includes('Style: Ov1,Noto Sans KR,54,') && ass.includes('\\an9\\pos(1862,58)\\fad(300,300)\\alpha&H80&') && ass.includes(',3,') /* opaque box */, ass);
const boxLine = styleLine('B', SUB_PRESETS.box, 1920, 1080); assert.ok(/,3,\d+,0,2,96,96,76,1$/.test(boxLine), boxLine);
console.log('ass ok');

// ---- asr wrapper with a fake worker ----
{
  const fakeWorker = () => { const handlers = {}; const w = { on: (ev, fn) => { handlers[ev] = fn; }, terminate() {} }; setTimeout(() => { handlers.message({ type: 'progress', phase: 'ready' }); handlers.message({ type: 'done', chunks: [{ text: ' 안녕', timestamp: [0, 0.5] }], text: '안녕', wordLevel: true }); }, 5); return w; };
  const prog = []; const r = await transcribeAudio(new Float32Array(16000), { model: 'small', cacheDir: path.join(os.tmpdir(), 'cutdiet-asr-test'), duration: 1, onProgress: p => prog.push(p.phase), workerFactory: fakeWorker });
  assert.equal(r.chunks.length, 1); assert.equal(r.model, 'Xenova/whisper-small'); assert.deepEqual(prog, ['ready']);
  console.log('asr wrapper ok');
}

// ---- end to end with real ffmpeg ----
const ffbin = findFfmpeg();
if (!ffbin) { console.log('ffmpeg not found — skipping engine e2e'); console.log('ALL ENGINE TESTS PASSED (unit only)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdiet-e2e-'));
const src = path.join(tmp, 'talk.mp4');
// 20 s clip: speech-like tone bursts at 1-4 s, 6-9.5 s, 12-14 s; silence elsewhere; moving test pattern
let r = await run(ffbin.path, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=48000,volume=volume='if(between(t,1,4)+between(t,6,9.5)+between(t,12,14),1,0.0005)':eval=frame", '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
assert.equal(r.code, 0, r.stderr);
const a = await analyzeFile(ffbin.path, src);
assert.ok(Math.abs(a.duration - 20) < 0.2, 'duration ' + a.duration); assert.equal(a.info.width, 640); assert.equal(a.info.fps, 30);
const segsE = detectSegments(a.env, HOP, a.duration, { threshold: -40, minSilence: 0.6, pad: 0.1, minKeep: 0.25 }); const kr = keepRanges(segsE);
assert.equal(kr.length, 3, JSON.stringify(kr)); assert.ok(Math.abs(kr[0].s - 0.9) < 0.15 && Math.abs(kr[1].e - 9.6) < 0.15, JSON.stringify(kr));
console.log('analyze ok', kr.map(x => `${x.s.toFixed(2)}-${x.e.toFixed(2)}`).join(' '));
// assets: logo png via ffmpeg, sfx wav, bgm
const logo = path.join(tmp, 'logo.png'); await run(ffbin.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=200x100', '-frames:v', '1', logo]);
const sfx = path.join(tmp, 'ding.wav'); const ding = new Float32Array(24000); for (let i = 0; i < ding.length; i++) ding[i] = Math.sin(i / 48000 * 2 * Math.PI * 880) * Math.exp(-5 * i / 48000); writeWav(sfx, ding, 48000);
const bgm = path.join(tmp, 'bgm.wav'); await run(ffbin.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '5', bgm]);
const assFile = path.join(tmp, 'subs.ass'); fs.writeFileSync(assFile, buildASS({ W: 640, H: 360, style: SUB_PRESETS.outline, captions: [{ s: 0.2, e: 2.5, text: '테스트 자막입니다' }], textOverlays: [{ s: 0, e: 8, text: '구독', style: SUB_PRESETS.box, pos: 'tr', sizeFrac: 0.08 }] }));
const outPath = path.join(tmp, 'out.mp4'); const total = kr.reduce((s, x) => s + x.e - x.s, 0);
const plan2 = buildArgs({ src, ranges: kr, duration: a.duration, fps: 30, width: 640, height: 360, hasAudio: true, out: { w: 640, h: 360 }, crop: null, quality: 'std', encoder: 'libx264', fx: { fade: { in: 0.3, out: 0.3 }, zooms: [{ s: kr[0].s, e: kr[0].e, scale: 1.3, ax: 0.5, ay: 0.5, ease: 0.4 }], autoZoom: { on: true, scale: 1.1 } }, outPath },
  { ass: assFile, bgm: { path: bgm, volume: 0.3, duck: true, fade: 0.5, loop: true }, images: [{ path: logo, s: 0.5, e: 3, box: { x: 20, y: 20, w: 100, h: 50 }, opacity: 0.9 }], sfx: [{ path: sfx, outT: 1.0, volume: 0.9 }] }, { fontsDir: null, hasLibass: /enable-libass/.test(ffbin.config) });
const graphFile = path.join(tmp, 'graph.txt'); fs.writeFileSync(graphFile, plan2.graph);
r = await run(ffbin.path, plan2.args.map(x => x === '__GRAPH__' ? graphFile : x));
assert.equal(r.code, 0, r.stderr + '\n' + plan2.graph);
const pr = parseProbe((await run(ffbin.path, ['-hide_banner', '-i', outPath])).stderr);
assert.ok(Math.abs(pr.duration - total) < 0.25, `out ${pr.duration} vs kept ${total}`); assert.ok(pr.hasAudio && pr.hasVideo && pr.width === 640);
// the zoomed first range must differ from an unzoomed render of the same frame; the red logo must appear at (20..120, 20..70) during 0.5-3 s
const frame = async (file, t) => { const rr = await run(ffbin.path, ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']); return rr.stdout; };
const f1 = await frame(outPath, 1.5); const px = (buf, x, y) => [buf[(y * 640 + x) * 3], buf[(y * 640 + x) * 3 + 1], buf[(y * 640 + x) * 3 + 2]];
const logoPx = px(f1, 60, 45); assert.ok(logoPx[0] > 150 && logoPx[1] < 90 && logoPx[2] < 90, 'logo pixel ' + logoPx);
const fLate = await frame(outPath, total - 0.05); const dark = px(fLate, 320, 180); assert.ok(dark[0] + dark[1] + dark[2] < 120, 'fade out ' + dark);
// audio check: sfx present near 1.0 s (energy there vs silence-cut region never exists)
const a2 = await analyzeFile(ffbin.path, outPath); const envDb = t => a2.env[Math.floor(t / HOP)];
assert.ok(envDb(1.0) > -40 && envDb(0.1) > -60, 'audio levels ' + envDb(1.0) + ' ' + envDb(0.1));
console.log('e2e render ok', `${pr.duration.toFixed(2)}s`, path.basename(outPath));
// shorts crop + 720p downscale path (no zoom) and no-audio source
const shorts = path.join(tmp, 'shorts.mp4');
const plan3 = buildArgs({ src, ranges: [kr[0]], duration: a.duration, fps: 30, width: 640, height: 360, hasAudio: true, out: { w: 540, h: 960 }, crop: { left: 219, top: 0, width: 202, height: 360 }, quality: 'high', encoder: 'libx264', fx: null, outPath: shorts }, { images: [], sfx: [] }, {});
fs.writeFileSync(graphFile, plan3.graph); r = await run(ffbin.path, plan3.args.map(x => x === '__GRAPH__' ? graphFile : x)); assert.equal(r.code, 0, r.stderr);
const ps = parseProbe((await run(ffbin.path, ['-hide_banner', '-i', shorts])).stderr); assert.equal(ps.width, 540); assert.equal(ps.height, 960);
console.log('shorts crop ok');
assert.ok(uniquePath(tmp, 'out', '.mp4').endsWith('out (2).mp4'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL ENGINE TESTS PASSED');
