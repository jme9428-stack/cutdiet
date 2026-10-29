#!/usr/bin/env node
// 컷다이어트 Pro 로컬 엔진 — serves the built app on http://127.0.0.1:7797 and adds FFmpeg rendering, native file dialogs,
// a watch folder for hands-off processing and native-speed Whisper. Loopback only; no account, no cloud, no cost.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, probe, detectEncoders, hasLibass, run, ENCODER_LABELS } from './lib/ff.mjs';
import { analyzeFile, envToArray } from './lib/analyze.mjs';
import { buildArgs, mapOverlaysAndCaptions, segsFromRanges } from './lib/graph.mjs';
import { buildASS } from './lib/ass.mjs';
import { writeWav, nativePick, openFolder, openBrowser, defaultOutDir, uniquePath, baseName, loadJSON, saveJSON, randomToken, MEDIA_RE } from './lib/util.mjs';
import { ensureFonts, BASE_FAMILIES } from './lib/fonts.mjs';
import { extractAudio16k, transcribeAudio, ASR_MODELS, resolveModel } from './lib/asr.mjs';
import { synthSfx } from '../src/fxlogic.js';
import { HOP, PRESETS, detectSegments, suggestThreshold, keepRanges, keptDuration, countRemoveRuns, clamp } from '../src/cutlogic.js';

export const VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = process.env.CUTDIET_DIST || path.join(ROOT, 'dist');
const DATA = process.env.CUTDIET_DATA || path.join(here, 'data');
const TMP = path.join(DATA, 'tmp'), FONTS = path.join(here, 'fonts'), MODELS = path.join(DATA, 'models');
const PORT = Number(process.env.CUTDIET_PORT) || 7797;
const HOST = '127.0.0.1';
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ---------- state ----------
const settingsFile = path.join(DATA, 'settings.json');
const settings = Object.assign({ outDir: defaultOutDir(), encoder: 'auto', preset: 'lecture', quality: 'high', asrModel: 'turbo', watch: { dir: '', on: false, tasks: { render: true, project: true } }, recent: [] }, loadJSON(settingsFile, {}));
const saveSettings = () => saveJSON(settingsFile, settings);
const media = new Map(); // token -> { token, path, name, size, info, env? }
const jobs = new Map(); let jobSeq = 0;
const history = loadJSON(path.join(DATA, 'log.json'), []);
const ff = { bin: null, version: '', config: '', encoders: { working: [], available: [] }, libass: false, fonts: { have: [], failed: [] } };
for (const d of [DATA, TMP, MODELS]) fs.mkdirSync(d, { recursive: true });

function newJob(kind, meta = {}) { const id = String(++jobSeq).padStart(3, '0') + '-' + randomToken().slice(0, 4); const j = { id, kind, status: 'run', progress: 0, startedAt: Date.now(), endedAt: 0, out: '', error: '', warnings: [], meta, abort: new AbortController(), result: null, step: '' }; jobs.set(id, j); return j; }
function publicJob(j) { const { abort, result, ...rest } = j; return { ...rest, hasResult: !!result, seconds: ((j.endedAt || Date.now()) - j.startedAt) / 1000 }; }
function finishJob(j, patch) { Object.assign(j, patch, { endedAt: Date.now() }); if (j.kind !== 'transcribe') { history.push({ at: new Date().toISOString(), kind: j.kind, status: j.status, file: j.meta.name || '', duration: j.meta.duration || 0, kept: j.meta.kept || 0, cuts: j.meta.cuts || 0, encoder: j.meta.encoder || '', seconds: (j.endedAt - j.startedAt) / 1000, out: j.out, error: j.error }); if (history.length > 2000) history.splice(0, history.length - 2000); saveJSON(path.join(DATA, 'log.json'), history); } }
function resolveEncoder() { if (settings.encoder !== 'auto' && ff.encoders.working.includes(settings.encoder)) return settings.encoder; return ff.encoders.working[0] || 'libx264'; }
function registerPath(p) {
  p = path.resolve(p); const st = fs.statSync(p); if (!st.isFile()) throw new Error('파일이 아닙니다: ' + p);
  for (const m of media.values()) if (m.path === p) { m.size = st.size; return m; }
  const m = { token: randomToken(), path: p, name: path.basename(p), size: st.size, info: null, env: null }; media.set(m.token, m);
  settings.recent = [p, ...settings.recent.filter(x => x !== p)].slice(0, 30); saveSettings();
  return m;
}
async function ensureInfo(m) { if (!m.info) m.info = await probe(ff.bin, m.path); return m.info; }

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac' };
function send(res, code, body, headers = {}) { const isObj = body != null && typeof body === 'object' && !Buffer.isBuffer(body); const data = isObj ? JSON.stringify(body) : body; res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(data); }
function readBody(req, limit = 64e6) { return new Promise((resolve, reject) => { const chunks = []; let len = 0; req.on('data', d => { len += d.length; if (len > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
async function readJSON(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
function trusted(req) { // same-origin page only: custom header + no foreign Origin / Sec-Fetch-Site
  const o = req.headers.origin; const sfs = req.headers['sec-fetch-site'];
  if (o && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return false;
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  return true;
}
function serveFile(req, res, file, { range = false } = {}) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cache-Control': range ? 'no-cache' : 'no-cache' };
  const r = range && req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (r) {
    let start = r[1] ? Number(r[1]) : 0, end = r[2] ? Number(r[2]) : st.size - 1; if (!r[1] && r[2]) { start = Math.max(0, st.size - Number(r[2])); end = st.size - 1; }
    if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size }); if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------- render ----------
function sfxWav(kind, dir) { const f = path.join(dir, `sfx_${kind}.wav`); if (!fs.existsSync(f)) writeWav(f, synthSfx(kind, 48000), 48000); return f; }
function dataUrlToFile(dataUrl, dir, name) { const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || ''); if (!m) return null; const ext = /png/.test(m[1]) ? '.png' : /jpe?g/.test(m[1]) ? '.jpg' : /webp/.test(m[1]) ? '.webp' : /gif/.test(m[1]) ? '.gif' : '.img'; const f = path.join(dir, name + ext); fs.writeFileSync(f, Buffer.from(m[2], 'base64')); return f; }

async function startRender(body) {
  const m = media.get(body.token); if (!m) throw new Error('먼저 파일을 등록하세요 (token)');
  const info = await ensureInfo(m);
  const ranges = (body.ranges || []).map(r => ({ s: Math.max(0, +r.s), e: Math.min(info.duration || +r.e, +r.e) })).filter(r => r.e - r.s > 0.01);
  if (!ranges.length) throw new Error('유지 구간이 없습니다');
  const kind = body.kind === 'shorts' ? 'shorts' : 'render';
  const j = newJob(kind, { name: m.name, duration: info.duration, kept: ranges.reduce((a, r) => a + r.e - r.s, 0), cuts: Math.max(0, ranges.length - 1) });
  const dir = path.join(TMP, 'job-' + j.id); fs.mkdirSync(dir, { recursive: true });
  const out = body.out && body.out.w ? { w: Math.round(body.out.w / 2) * 2, h: Math.round(body.out.h / 2) * 2 } : { w: info.width, h: info.height };
  const fx = body.fx || null;
  // assets: images (uploaded path or data url), sfx (built-in synth or uploaded), bgm (uploaded), captions/text -> ASS
  const fxCopy = fx ? JSON.parse(JSON.stringify(fx)) : null;
  if (fxCopy) {
    (fxCopy.overlays || []).forEach((o, i) => { if (o.type === 'image') { if (!o.path && o.dataUrl) o.path = dataUrlToFile(o.dataUrl, dir, 'img' + i); delete o.dataUrl; if (o.path && !fs.existsSync(o.path)) o.path = null; } });
    fxCopy.overlays = (fxCopy.overlays || []).filter(o => o.type === 'text' ? !!o.text : !!o.path);
  }
  const req = { src: m.path, ranges, duration: info.duration, fps: body.fps || info.fps || 30, width: info.width, height: info.height, hasAudio: !!info.hasAudio, out, crop: body.crop || null, quality: body.quality || settings.quality, encoder: resolveEncoder(), fx: fxCopy, captions: body.captions || [], outPath: '' };
  const mapped = mapOverlaysAndCaptions(req);
  const assets = { ass: null, bgm: null, images: mapped.images, sfx: [] };
  const burn = fxCopy && fxCopy.subs && fxCopy.subs.burn && mapped.captions.length;
  if (burn || mapped.textOverlays.length) {
    // fetch any newly chosen font before burning (first use only), and map catalog names to the names libass sees in the files
    const used = [burn ? fxCopy.subs.style.font : null, ...mapped.textOverlays.map(o => o.style && o.style.font)].filter(Boolean);
    try { j.step = '글꼴 준비'; const fr = await ensureFonts(FONTS, log, [...BASE_FAMILIES, ...used]); ff.fonts = fr; } catch {}
    const ass = buildASS({ W: out.w, H: out.h, style: fxCopy && fxCopy.subs ? fxCopy.subs.style : null, captions: burn ? mapped.captions : [], textOverlays: mapped.textOverlays, fontMap: ff.fonts.map }); assets.ass = path.join(dir, 'subs.ass'); fs.writeFileSync(assets.ass, ass); if (!ff.libass) j.warnings.push('이 ffmpeg는 libass가 없어 자막·텍스트 굽기를 건너뜁니다'); }
  for (const s of mapped.sfx) { const p = s.kind === 'custom' ? (s.path && fs.existsSync(s.path) ? s.path : null) : sfxWav(s.kind, dir); if (p) assets.sfx.push({ path: p, outT: s.outT, volume: s.volume ?? 0.8 }); }
  if (body.bgm && body.bgm.path && fs.existsSync(body.bgm.path)) assets.bgm = { path: body.bgm.path, volume: +body.bgm.volume || 0.18, duck: body.bgm.duck !== false, fade: +body.bgm.fade || 0, loop: body.bgm.loop !== false, offset: Math.max(0, +body.bgm.offset || 0) };
  fs.mkdirSync(settings.outDir, { recursive: true });
  const base = body.filename ? baseName(body.filename) : baseName(m.name) + (kind === 'shorts' ? '_shorts' : '_cut');
  req.outPath = uniquePath(settings.outDir, base, '.mp4');
  const plan = buildArgs(req, assets, { fontsDir: ff.fonts.have.length ? FONTS : null, hasLibass: ff.libass, ffVersion: ff.version });
  const graphFile = path.join(dir, 'graph.txt'); fs.writeFileSync(graphFile, plan.graph);
  const args = plan.args.map(a => a === '__GRAPH__' ? graphFile : a);
  j.warnings.push(...plan.warnings); j.meta.encoder = plan.encoder; j.meta.out = req.outPath; j.meta.total = plan.total; j.step = '렌더링';
  fs.writeFileSync(path.join(dir, 'cmd.txt'), JSON.stringify(args, null, 1));
  const total = plan.total; let errTail = '';
  run(ff.bin, args, { signal: j.abort.signal, onStdout: d => { const s = d.toString(); const mt = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g.exec(s) ? s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g).pop().match(/(\d+):(\d+):(\d+(?:\.\d+)?)/) : null; if (mt) { const t = +mt[1] * 3600 + +mt[2] * 60 + +mt[3]; j.progress = Math.min(0.99, t / Math.max(0.1, total)); } }, onStderr: s => { errTail = (errTail + s).slice(-1500); } })
    .then(r => {
      if (j.abort.signal.aborted) { finishJob(j, { status: 'cancel', error: '중단됨' }); try { fs.rmSync(req.outPath, { force: true }); } catch {} }
      else if (r.code === 0 && fs.existsSync(req.outPath)) { j.progress = 1; j.meta.size = fs.statSync(req.outPath).size; finishJob(j, { status: 'done', out: req.outPath, result: { size: j.meta.size } }); log(`렌더 완료 ${path.basename(req.outPath)} (${plan.encoder})`); }
      else finishJob(j, { status: 'err', error: (errTail.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${r.code}`).slice(0, 400) });
      cleanupLater(dir);
    }).catch(e => { finishJob(j, { status: 'err', error: e.message }); cleanupLater(dir); });
  return j;
}
function cleanupLater(dir) { setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 60000).unref(); }

async function startTranscribe(body) {
  const m = media.get(body.token); if (!m) throw new Error('먼저 파일을 등록하세요');
  const info = await ensureInfo(m); if (!info.hasAudio) throw new Error('오디오 트랙이 없습니다');
  const j = newJob('transcribe', { name: m.name, duration: info.duration, model: body.model || settings.asrModel });
  (async () => {
    try {
      j.step = '오디오 추출'; const audio = await extractAudio16k(ff.bin, m.path, { signal: j.abort.signal });
      j.step = '모델 준비';
      const result = await transcribeAudio(audio, { model: body.model || settings.asrModel, cacheDir: MODELS, duration: info.duration, signal: j.abort.signal, onProgress: p => { if (p.phase === 'download') { j.step = `모델 내려받기 ${Math.round(p.pct * 100)}%`; j.progress = 0.05 + p.pct * 0.25; } else if (p.phase === 'ready') { j.step = '인식 시작'; j.progress = 0.3; } else if (p.phase === 'transcribe') { j.step = '음성 인식' + (p.note === 'segment' ? ' (문장 단위)' : ''); j.progress = 0.3 + p.pct * 0.7; } } });
      j.progress = 1; finishJob(j, { status: 'done', result });
    } catch (e) { finishJob(j, { status: j.abort.signal.aborted ? 'cancel' : 'err', error: e.message }); }
  })();
  return j;
}

async function grabFrame(m, t, w) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', m.path, '-frames:v', '1', '-an', ...(w ? ['-vf', `scale=${w}:-2`] : []), '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'];
  const r = await run(ff.bin, args); if (r.code !== 0 || !r.stdout.length) throw new Error('프레임을 꺼내지 못했습니다'); return r.stdout;
}

// ---------- watch folder ----------
const seen = new Map(); let watchTimer = null;
function watchTick() {
  const w = settings.watch; if (!w.on || !w.dir || !fs.existsSync(w.dir)) return;
  let names = []; try { names = fs.readdirSync(w.dir); } catch { return; }
  for (const n of names) {
    if (!MEDIA_RE.test(n) || /_cut\.|_shorts\./.test(n) || n.startsWith('.')) continue;
    const p = path.join(w.dir, n); let st; try { st = fs.statSync(p); } catch { continue; } if (!st.isFile()) continue;
    const key = p; const prev = seen.get(key);
    if (!prev) { seen.set(key, { size: st.size, mtime: st.mtimeMs, stable: 0, done: false }); continue; }
    if (prev.done) continue;
    if (prev.size !== st.size || prev.mtime !== st.mtimeMs) { prev.size = st.size; prev.mtime = st.mtimeMs; prev.stable = 0; continue; }
    prev.stable++;
    if (prev.stable >= 2 && Date.now() - st.mtimeMs > 3000 && !isBusy()) { prev.done = true; autoProcess(p).catch(e => log('자동 처리 실패', n, e.message)); }
  }
}
function isBusy() { for (const j of jobs.values()) if (j.status === 'run' && j.kind !== 'transcribe') return true; return false; }
async function autoProcess(p) {
  const m = registerPath(p); const j = newJob('auto', { name: m.name }); j.step = '분석';
  try {
    const a = await analyzeFile(ff.bin, p, { signal: j.abort.signal, onProgress: f => { j.progress = f * 0.2; } });
    m.info = a.info; m.env = a.env; j.meta.duration = a.duration;
    const pr = PRESETS[settings.preset] || PRESETS.lecture; const params = { threshold: clamp(suggestThreshold(a.env) + pr.thrOffset, -70, -20), minSilence: pr.minSilence, pad: pr.pad, minKeep: 0.25 };
    const segs = detectSegments(a.env, HOP, a.duration, params); const ranges = keepRanges(segs);
    j.meta.kept = keptDuration(segs); j.meta.cuts = countRemoveRuns(segs);
    if (settings.watch.tasks.project !== false) { const pj = { app: 'cutdiet', version: 2, savedAt: new Date().toISOString(), file: { name: m.name, size: m.size }, duration: a.duration, fps: a.info.fps, preset: settings.preset, params, dirty: false, segments: segs.map(g => [Math.round(g.s * 1000) / 1000, Math.round(g.e * 1000) / 1000, g.keep ? 1 : 0]), chapters: [], bgm: { name: '', volume: 0.18, duck: true, fade: 1.5, loop: true }, shorts: { in: 0, out: 0, pos: 0.5, upscale: true }, fx: null, engine: { source: p } }; fs.mkdirSync(settings.outDir, { recursive: true }); fs.writeFileSync(uniquePath(settings.outDir, baseName(m.name), '.cutdiet.json'), JSON.stringify(pj, null, 1)); }
    if (settings.watch.tasks.render !== false) {
      j.step = '렌더링'; const r = await startRender({ token: m.token, ranges, quality: settings.quality });
      await new Promise(res => { const t = setInterval(() => { j.progress = 0.2 + 0.8 * r.progress; if (r.status !== 'run') { clearInterval(t); res(); } }, 500); });
      if (r.status !== 'done') throw new Error(r.error || '렌더 실패');
      j.out = r.out; j.meta.encoder = r.meta.encoder;
    }
    j.progress = 1; finishJob(j, { status: 'done' }); log('자동 처리 완료', m.name);
  } catch (e) { finishJob(j, { status: j.abort.signal.aborted ? 'cancel' : 'err', error: e.message }); }
}
function syncWatcher() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } if (settings.watch.on && settings.watch.dir) { seen.clear(); try { for (const n of fs.readdirSync(settings.watch.dir)) { const p = path.join(settings.watch.dir, n); try { const st = fs.statSync(p); if (st.isFile()) seen.set(p, { size: st.size, mtime: st.mtimeMs, stable: 9, done: true }); } catch {} } } catch {} watchTimer = setInterval(watchTick, 2500); log('워치 폴더 켜짐:', settings.watch.dir); } }

// ---------- HTTP ----------
function statusPayload() {
  return { ok: true, version: VERSION, port: PORT, platform: os.platform(), ffmpeg: ff.bin ? { path: ff.bin, version: ff.version, libass: ff.libass, encoders: ff.encoders, labels: ENCODER_LABELS } : null, encoder: resolveEncoder(), fonts: ff.fonts, outDir: settings.outDir, settings: { encoder: settings.encoder, preset: settings.preset, quality: settings.quality, asrModel: resolveModel(settings.asrModel).id, watch: settings.watch }, asrModels: Object.fromEntries(Object.values(ASR_MODELS).map(v => [v.id, v.label])), recent: settings.recent.filter(p => fs.existsSync(p)).slice(0, 12), jobs: [...jobs.values()].slice(-30).map(publicJob), cpu: os.cpus().length, mem: Math.round(os.totalmem() / 1e9) };
}
async function api(req, res, u) {
  const p = u.pathname.replace(/^\/api/, ''); const q = u.searchParams;
  if (p.startsWith('/media/')) { const m = media.get(p.slice(7)); if (!m) return send(res, 404, 'unknown media'); return serveFile(req, res, m.path, { range: true }); }
  if (p === '/frame') { const m = media.get(q.get('token')); if (!m) return send(res, 404, 'unknown media'); try { const jpg = await grabFrame(m, Number(q.get('t')) || 0, Number(q.get('w')) || 0); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(jpg); } catch (e) { return send(res, 500, e.message); } }
  if (!trusted(req) || (req.method !== 'GET' && !req.headers['x-cutdiet-engine'])) return send(res, 403, 'forbidden');
  if (!ff.bin && p !== '/status') return send(res, 503, { error: 'ffmpeg를 찾지 못했습니다. engine 폴더에서 npm install 을 다시 실행하세요' });
  if (p === '/status') return send(res, 200, statusPayload());
  if (p === '/jobs' && req.method === 'GET') return send(res, 200, [...jobs.values()].map(publicJob));
  const jm = /^\/jobs\/([^/]+)(?:\/(cancel|result))?$/.exec(p);
  if (jm) { const j = jobs.get(jm[1]); if (!j) return send(res, 404, { error: 'no job' }); if (jm[2] === 'cancel') { j.abort.abort(); return send(res, 200, { ok: true }); } if (jm[2] === 'result') return send(res, 200, j.result || {}); return send(res, 200, publicJob(j)); }
  if (p === '/log') return send(res, 200, history);
  if (req.method !== 'POST') return send(res, 405, 'method');
  if (p === '/asset') { // raw upload: bgm, custom sfx, overlay images
    const name = (q.get('name') || 'asset').replace(/[\\/:*?"<>|]/g, '_'); const dir = path.join(TMP, 'assets'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, randomToken().slice(0, 8) + '-' + name); const ws = fs.createWriteStream(file); let len = 0;
    await new Promise((resolve, reject) => { req.on('data', d => { len += d.length; if (len > 600e6) { reject(new Error('too large')); req.destroy(); } }); req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); });
    return send(res, 200, { path: file, size: len });
  }
  const body = await readJSON(req);
  switch (p) {
    case '/pick': { const paths = await nativePick({ kind: body.kind || 'files', title: body.title || (body.kind === 'dir' ? '폴더 선택' : '영상 파일 선택') }); return send(res, 200, { paths }); }
    case '/register': { const out = []; for (const pth of body.paths || []) { try { const m = registerPath(pth); await ensureInfo(m); out.push({ token: m.token, path: m.path, name: m.name, size: m.size, info: m.info, mediaUrl: `/api/media/${m.token}` }); } catch (e) { out.push({ path: pth, error: e.message }); } } return send(res, 200, out); }
    case '/analyze': { const m = media.get(body.token); if (!m) return send(res, 404, { error: 'unknown media' }); try { const a = await analyzeFile(ff.bin, m.path); m.info = a.info; m.env = a.env; return send(res, 200, { token: m.token, info: a.info, duration: a.duration, env: envToArray(a.env) }); } catch (e) { if (/noaudio/.test(e.message)) { m.info = e.info || m.info; return send(res, 200, { token: m.token, info: m.info, duration: m.info ? m.info.duration : 0, env: null, noAudio: true }); } return send(res, 500, { error: e.message }); } }
    case '/render': { try { const j = await startRender(body); return send(res, 200, publicJob(j)); } catch (e) { return send(res, 400, { error: e.message }); } }
    case '/transcribe': { try { const j = await startTranscribe(body); return send(res, 200, publicJob(j)); } catch (e) { return send(res, 400, { error: e.message }); } }
    case '/thumbs': { const m = media.get(body.token); if (!m) return send(res, 404, { error: 'unknown media' }); const dir = path.join(settings.outDir, baseName(m.name) + '_썸네일'); fs.mkdirSync(dir, { recursive: true }); const files = []; for (const t of (body.times || []).slice(0, 40)) { try { const jpg = await grabFrame(m, t, 0); const f = path.join(dir, `${baseName(m.name)}_${String(Math.floor(t / 60)).padStart(2, '0')}-${String(Math.floor(t % 60)).padStart(2, '0')}.jpg`); fs.writeFileSync(f, jpg); files.push(f); } catch {} } return send(res, 200, { dir, files }); }
    case '/save': { fs.mkdirSync(settings.outDir, { recursive: true }); const name = String(body.name || 'file.txt').replace(/[\\/:*?"<>|]/g, '_'); const f = uniquePath(settings.outDir, baseName(name), path.extname(name) || '.txt'); fs.writeFileSync(f, body.base64 ? Buffer.from(body.base64, 'base64') : String(body.text || '')); return send(res, 200, { path: f }); }
    case '/settings': { for (const k of ['encoder', 'preset', 'quality', 'asrModel']) if (body[k] != null) settings[k] = String(body[k]); if (body.outDir) { settings.outDir = path.resolve(String(body.outDir)); fs.mkdirSync(settings.outDir, { recursive: true }); } if (body.watch) { settings.watch = { ...settings.watch, ...body.watch, tasks: { ...settings.watch.tasks, ...(body.watch.tasks || {}) } }; if (settings.watch.dir) settings.watch.dir = path.resolve(settings.watch.dir); syncWatcher(); } saveSettings(); return send(res, 200, statusPayload()); }
    case '/open-folder': { openFolder(body.dir || settings.outDir); return send(res, 200, { ok: true }); }
    case '/shutdown': { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
    default: return send(res, 404, { error: 'unknown api' });
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    let file = path.normalize(path.join(DIST, decodeURIComponent(u.pathname)));
    if (!file.startsWith(DIST)) return send(res, 403, 'no');
    if (u.pathname === '/' || u.pathname === '/index.html') file = path.join(DIST, 'index.html');
    if (u.pathname === '/pro' || u.pathname === '/pro.html') file = path.join(DIST, 'pro.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found. dist/ 가 없으면 npm run build 를 먼저 실행하세요');
    return serveFile(req, res, file);
  } catch (e) { log('오류', e.message); try { send(res, 500, { error: e.message }); } catch {} }
});

export async function start({ open = true } = {}) {
  const found = findFfmpeg();
  if (found) { ff.bin = found.path; ff.version = found.version; ff.config = found.config; ff.libass = hasLibass(found.config); log(`ffmpeg ${ff.version} (${ff.bin})${ff.libass ? '' : ' — libass 없음: 자막 굽기 불가'}`); }
  else log('ffmpeg를 찾지 못했습니다. engine 폴더에서 "npm install"을 실행하면 자동으로 받아집니다.');
  if (!fs.existsSync(path.join(DIST, 'pro.html'))) log('dist/pro.html 이 없습니다. 프로젝트 루트에서 "npm run build"를 먼저 실행하세요.');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve); });
  const url = `http://${HOST}:${PORT}/pro.html`;
  log(`컷다이어트 엔진 v${VERSION} 실행 중 → ${url}`); log(`출력 폴더: ${settings.outDir}`);
  if (open && !process.env.CUTDIET_NO_OPEN) openBrowser(url);
  if (ff.bin) { detectEncoders(ff.bin).then(e => { ff.encoders = e; log('사용 가능한 인코더:', e.working.join(', ') || '없음'); }).catch(() => {}); ensureFonts(FONTS, log).then(r => { ff.fonts = r; }).catch(() => {}); }
  syncWatcher();
  return { server, url, port: PORT };
}
export function stop() { return new Promise(r => server.close(r)); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(e => { if (e.code === 'EADDRINUSE') { log(`포트 ${PORT}가 이미 사용 중입니다. 엔진이 이미 켜져 있다면 브라우저에서 http://127.0.0.1:${PORT}/pro.html 을 여세요.`); openBrowser(`http://${HOST}:${PORT}/pro.html`); } else { log('시작 실패:', e.message); } process.exit(1); });
}
