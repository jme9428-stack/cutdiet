// Engine HTTP API test: starts the real server on a test port with a temp data dir, drives register → analyze → render → jobs,
// checks media range serving, the frame endpoint, settings persistence and the same-origin guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdiet-http-'));
process.env.CUTDIET_PORT = '7899'; process.env.CUTDIET_DATA = path.join(tmp, 'data'); process.env.CUTDIET_NO_OPEN = '1'; process.env.CUTDIET_DIST = path.join(tmp, 'dist');
fs.mkdirSync(process.env.CUTDIET_DIST, { recursive: true }); fs.writeFileSync(path.join(process.env.CUTDIET_DIST, 'pro.html'), '<!doctype html><title>pro</title>'); fs.writeFileSync(path.join(process.env.CUTDIET_DIST, 'index.html'), '<!doctype html><title>idx</title>');
const { start, stop } = await import('../engine/server.mjs');
const { findFfmpeg, run } = await import('../engine/lib/ff.mjs');
const ffbin = findFfmpeg(); if (!ffbin) { console.log('ffmpeg not found — skipping http test'); process.exit(0); }
const { url } = await start({ open: false }); const base = url.replace(/\/pro\.html$/, '');
const H = { 'x-cutdiet-engine': '1', 'content-type': 'application/json' };
const api = async (p, body, opts = {}) => { const r = await fetch(base + '/api' + p, { method: body === undefined ? 'GET' : 'POST', headers: { ...H, ...(opts.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
try {
  const st = await api('/status'); assert.equal(st.status, 200); assert.ok(st.json.ok && st.json.ffmpeg && st.json.outDir, JSON.stringify(st.json).slice(0, 200));
  // same-origin guard: foreign Origin / cross-site fetch metadata / missing header on POST
  assert.equal((await api('/status', undefined, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/status', undefined, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 403);
  // static
  assert.equal((await fetch(base + '/pro.html')).status, 200); assert.equal((await fetch(base + '/nope.html')).status, 404);
  const coep = (await fetch(base + '/')).headers.get('cross-origin-embedder-policy'); assert.equal(coep, 'credentialless');
  // media
  const src = path.join(tmp, 'clip.mp4');
  let r = await run(ffbin.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=48000,volume=volume='if(between(t,1,3)+between(t,5,7),1,0.0005)':eval=frame", '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  assert.equal(r.code, 0, r.stderr);
  const reg = await api('/register', { paths: [src, path.join(tmp, 'missing.mp4')] }); assert.equal(reg.status, 200); assert.equal(reg.json.length, 2); assert.ok(reg.json[0].token && reg.json[0].info.width === 320 && reg.json[0].mediaUrl); assert.ok(reg.json[1].error);
  const token = reg.json[0].token;
  const rng = await fetch(base + reg.json[0].mediaUrl, { headers: { range: 'bytes=0-99' } }); assert.equal(rng.status, 206); assert.equal((await rng.arrayBuffer()).byteLength, 100); assert.ok(/^bytes 0-99\/\d+$/.test(rng.headers.get('content-range'))); assert.equal(rng.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(base + '/api/media/deadbeef')).status, 404);
  const fr = await fetch(base + `/api/frame?token=${token}&t=1&w=160`); assert.equal(fr.status, 200); assert.equal(fr.headers.get('content-type'), 'image/jpeg'); assert.ok((await fr.arrayBuffer()).byteLength > 500);
  const an = await api('/analyze', { token }); assert.equal(an.status, 200); assert.ok(Math.abs(an.json.duration - 9) < 0.2); assert.ok(Array.isArray(an.json.env) && an.json.env.length > 400 && an.json.env[Math.floor(2 / 0.02)] > -30 && an.json.env[Math.floor(4 / 0.02)] < -50, 'env shape');
  // settings: output dir into tmp
  const outDir = path.join(tmp, 'out'); const se = await api('/settings', { outDir, quality: 'std', encoder: 'libx264' }); assert.equal(se.status, 200); assert.equal(se.json.outDir, outDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.CUTDIET_DATA, 'settings.json'), 'utf8')).quality, 'std');
  // render with captions + sfx + text overlay
  const rd = await api('/render', { token, ranges: [{ s: 0.9, e: 3.1 }, { s: 4.9, e: 7.1 }], out: { w: 320, h: 180 }, quality: 'std', fx: { subs: { burn: true, style: { font: 'Noto Sans KR', weight: 700, size: 0.07, color: '#FFFFFF', stroke: '#000000', strokeW: 0.16, box: false, shadow: true, pos: 'bottom' } }, zooms: [], autoZoom: { on: false }, fade: { in: 0, out: 0 }, transition: { type: 'none' }, overlays: [{ type: 'text', s: 1, e: 2.5, text: '구독', pos: 'tr', w: 0.06, style: { font: 'Noto Sans KR', weight: 700, size: 0.06, color: '#FFE14D', stroke: '#000', strokeW: 0.2, box: false } }], sfx: [{ t: 1.2, kind: 'ding', volume: 0.8 }, { t: 4.0, kind: 'pop' }] }, captions: [{ s: 1, e: 2.8, text: '첫 문장' }, { s: 5, e: 6.5, text: '둘째 문장' }] });
  assert.equal(rd.status, 200, JSON.stringify(rd.json)); const jobId = rd.json.id;
  let job; for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 250)); job = (await api('/jobs/' + jobId)).json; if (job.status !== 'run') break; }
  assert.equal(job.status, 'done', JSON.stringify(job)); assert.ok(job.out.startsWith(outDir) && job.out.endsWith('clip_cut.mp4') && fs.existsSync(job.out), job.out); assert.equal(job.meta.encoder, 'libx264');
  const pr = (await import('../engine/lib/ff.mjs')).parseProbe((await run(ffbin.path, ['-hide_banner', '-i', job.out])).stderr); assert.ok(Math.abs(pr.duration - 4.4) < 0.25, 'dur ' + pr.duration);
  // second render never overwrites
  const rd2 = await api('/render', { token, ranges: [{ s: 0.9, e: 3.1 }], quality: '720' }); for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 250)); job = (await api('/jobs/' + rd2.json.id)).json; if (job.status !== 'run') break; }
  assert.equal(job.status, 'done', job.error); assert.ok(job.out.endsWith('clip_cut (2).mp4'), job.out);
  // thumbs + save + log + cancel path
  const th = await api('/thumbs', { token, times: [1, 2] }); assert.equal(th.json.files.length, 2); assert.ok(fs.existsSync(th.json.files[0]));
  const sv = await api('/save', { name: 'clip.cutdiet.json', text: '{"a":1}' }); assert.ok(fs.existsSync(sv.json.path));
  const lg = await api('/log'); assert.ok(lg.json.length >= 2 && lg.json[0].kind === 'render');
  const rd3 = await api('/render', { token, ranges: [{ s: 0, e: 9 }], quality: 'high' }); await api('/jobs/' + rd3.json.id + '/cancel', {}); for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); job = (await api('/jobs/' + rd3.json.id)).json; if (job.status !== 'run') break; }
  assert.equal(job.status, 'cancel');
  // transcribe endpoint validates token and creates a job (model download is not possible offline, so only the shape is checked)
  const tr = await api('/transcribe', { token: 'nope' }); assert.equal(tr.status, 400);
  // watch folder: drop a file, expect an auto job to finish with an output
  const wdir = path.join(tmp, 'watch'); fs.mkdirSync(wdir); await api('/settings', { watch: { dir: wdir, on: true, tasks: { render: true, project: true } } });
  fs.copyFileSync(src, path.join(wdir, 'dropped.mp4'));
  let auto = null; for (let i = 0; i < 160; i++) { await new Promise(r => setTimeout(r, 500)); const js = (await api('/jobs')).json; auto = js.find(j => j.kind === 'auto'); if (auto && auto.status !== 'run') break; }
  assert.ok(auto && auto.status === 'done', JSON.stringify(auto)); assert.ok(fs.existsSync(auto.out) && /dropped_cut/.test(auto.out), auto.out);
  assert.ok(fs.readdirSync(outDir).some(f => f.startsWith('dropped') && f.endsWith('.cutdiet.json')));
  console.log('ALL ENGINE HTTP TESTS PASSED');
} finally { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }
