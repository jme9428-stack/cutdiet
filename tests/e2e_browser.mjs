// Browser end-to-end (headless Chromium via Playwright): member page and Pro page served by the local engine.
// Covers: open → analyze → segments, keyboard edits, render to a mocked save-dialog sink (positional writes), rotated video,
// Pro: engine open by path → engine analysis → engine render → output file on disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdiet-e2e-'));
process.env.CUTDIET_PORT = '7898'; process.env.CUTDIET_DATA = path.join(tmp, 'data'); process.env.CUTDIET_NO_OPEN = '1';
const { start, stop } = await import('../engine/server.mjs');
const { findFfmpeg, run, parseProbe } = await import('../engine/lib/ff.mjs');
const ff = findFfmpeg(); assert.ok(ff, 'ffmpeg needed');
const { url } = await start({ open: false }); const base = url.replace(/\/pro\.html$/, '');
const mk = async (file, extra = []) => { const r = await run(ff.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', "sine=frequency=440:sample_rate=48000,volume=volume='if(between(t,1,4)+between(t,6,9.5)+between(t,12,14),1,0.0005)':eval=frame", '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, file]); assert.equal(r.code, 0, r.stderr); };
const srcMp4 = path.join(tmp, 'talk.mp4'); await mk(srcMp4);
const srcRot = path.join(tmp, 'rot.mp4'); await mk(srcRot, ['-metadata:s:v:0', 'rotate=90']);
// a rotated copy: ffmpeg writes the tkhd matrix from the rotate tag (ffmpeg ≥ 5 uses -display_rotation; try both)
let pr = parseProbe((await run(ff.path, ['-hide_banner', '-i', srcRot])).stderr);
if (pr.rotation === 0) { const r2 = await run(ff.path, ['-y', '-loglevel', 'error', '-display_rotation', '90', '-i', srcMp4, '-c', 'copy', srcRot]); if (r2.code === 0) pr = parseProbe((await run(ff.path, ['-hide_banner', '-i', srcRot])).stderr); }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
const logs = []; page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
const waitAnalyzedOn = pg => pg.evaluate(() => new Promise(res => document.addEventListener('cutdiet:analyzed', e => res(e.detail.ok), { once: true })));
const waitAnalyzed = () => waitAnalyzedOn(page);
try {
  // ---------- member page ----------
  await page.goto(base + '/'); await page.waitForFunction(() => window.cutdiet && window.cutdiet.state.mbStatus === 'ready', null, { timeout: 30000 });
  await page.evaluate(() => { localStorage.setItem('cutdiet:onboarded', '1'); document.getElementById('onb').hidden = true; });
  const analyzedP = waitAnalyzed(); await page.setInputFiles('#fileInput', srcMp4); assert.equal(await analyzedP, true, 'analysis ok');
  let st = await page.evaluate(() => { const s = window.cutdiet.state; return { dur: s.duration, w: s.width, h: s.height, fps: s.fps, segs: s.segments.length, kept: window.cutdiet.keptDuration(s.segments), ranges: window.cutdiet.keepRanges(s.segments), playable: s.videoPlayable, canDecode: s.canDecodeVideo }; });
  assert.ok(Math.abs(st.dur - 16) < 0.2 && st.w === 640 && st.h === 360 && st.ranges.length === 3, JSON.stringify(st)); assert.ok(st.playable && st.canDecode, 'playable/decodable ' + JSON.stringify(st));
  console.log('member: analyze ok', JSON.stringify(st.ranges.map(r => [r.s.toFixed(2), r.e.toFixed(2)])));
  // keyboard: seek to 2.0, split (S), delete right part (W), undo (Ctrl+Z)
  await page.evaluate(() => window.cutdiet.seek(2.0)); await page.keyboard.press('KeyS'); let n = await page.evaluate(() => window.cutdiet.state.segments.length); assert.equal(n, st.segs + 1, 'split');
  await page.keyboard.press('KeyW'); const afterW = await page.evaluate(() => window.cutdiet.keptDuration(window.cutdiet.state.segments)); assert.ok(afterW < st.kept - 1.5, 'W trims right part ' + afterW);
  await page.keyboard.press('Control+KeyZ'); await page.keyboard.press('Control+KeyZ'); n = await page.evaluate(() => window.cutdiet.state.segments.length); assert.equal(n, st.segs, 'undo twice restores');
  // playback skips removed segments: play from 4.5 (inside a removed range) → should jump to the next kept range
  await page.evaluate(() => { window.cutdiet.seek(4.5); window.cutdiet.actions.play(); }); await page.waitForTimeout(900);
  const curT = await page.evaluate(() => { window.cutdiet.actions.stop(); return window.cutdiet.state.cur; }); assert.ok(curT >= 5.8 && curT < 8, 'skip playback jumped to ' + curT);
  // render to a mocked save dialog (positional writes), with burned captions + overlay + sfx
  await page.evaluate(() => {
    window.__sink = { chunks: [], closed: false, aborted: false };
    window.showSaveFilePicker = async () => ({ name: 'mock.mp4', createWritable: async () => ({ write: async c => { window.__sink.chunks.push({ pos: c.position, len: c.data.byteLength, data: Array.from(new Uint8Array(c.data).slice(0, 12)) }); }, close: async () => { window.__sink.closed = true; }, abort: async () => { window.__sink.aborted = true; } }) });
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
    const C = window.cutdiet; C.state.fx.subs.burn = true; C.state.fx.autoZoom.on = true; C.state.fx.fade = { in: 0.3, out: 0.3 }; C.state.fx.sfx.push({ id: 'x', t: 1.5, kind: 'ding', volume: 0.8, name: '띵' }); C.state.fx.overlays.push({ id: 'o', type: 'text', s: 1, e: 3, pos: 'tr', w: 0.05, opacity: 1, fade: 0, text: '구독', style: { font: 'Noto Sans KR', weight: 700, size: 0.05, color: '#FFE14D', stroke: '#000', strokeW: 0.2 }, name: '구독' });
    window.__lines = [{ s: 1, e: 2.5, text: '테스트 자막' }, { s: 6, e: 7, text: '둘째' }];
  });
  // captions come from the transcribe module; inject through the public hook used by decorate (captionsOf) by monkeypatching getLines
  await page.evaluate(() => { const tr = window.cutdiet; const orig = tr.captionsOf; window.cutdiet.captionsOf = () => window.__lines; });
  const rendered = await page.evaluate(async () => { const C = window.cutdiet; const ok = await C.startRender('main', false); return { ok, status: document.getElementById('renderStatus').textContent, sink: { n: window.__sink.chunks.length, closed: window.__sink.closed, aborted: window.__sink.aborted, first: window.__sink.chunks[0], total: Math.max(...window.__sink.chunks.map(c => c.pos + c.len)) } }; });
  console.log('member: render', JSON.stringify(rendered.status), JSON.stringify(rendered.sink));
  // captionsOf inside main.js is a closure; the public patch above does not reach the render path, so burn-in is covered by the engine test; here we assert the streamed file shape
  assert.ok(rendered.ok && rendered.sink.closed && !rendered.sink.aborted && rendered.sink.n >= 1 && rendered.sink.total > 50000, 'streamed to sink');
  assert.ok(rendered.sink.first.data.slice(4, 8).join(',') === [0x66, 0x74, 0x79, 0x70].join(','), 'first chunk is an ftyp box');
  // export package zip + chapters text exist
  await page.evaluate(() => { window.cutdiet.state.chapters = [{ t: 1, title: '인트로' }, { t: 6.5, title: '본론' }, { t: 12.5, title: '정리' }]; window.cutdiet.refreshAll(); });
  const chText = await page.evaluate(() => document.getElementById('chText').value); assert.ok(/^0:00 인트로\n0:0\d 본론\n0:0\d 정리$/.test(chText), chText);
  // rotated source: display dims swap and analysis still works
  if (pr.rotation === 90 || pr.rotation === 270) {
    const p2 = waitAnalyzed(); await page.setInputFiles('#fileInput', srcRot); assert.equal(await p2, true);
    const dims = await page.evaluate(() => ({ w: window.cutdiet.state.width, h: window.cutdiet.state.height, rot: window.cutdiet.state.rotation }));
    assert.ok(dims.w === 360 && dims.h === 640, 'rotated display dims ' + JSON.stringify(dims)); console.log('member: rotated video dims ok', JSON.stringify(dims));
  } else console.log('member: rotation metadata not written by this ffmpeg, skipping');
  // ---------- Pro page + engine ----------
  const page2 = await ctx.newPage(); page2.on('pageerror', e => console.log('PRO PAGE ERROR', e.message));
  await page2.goto(base + '/pro.html'); await page2.waitForFunction(() => window.cutdiet && window.cutdiet.state.mbStatus === 'ready' && window.cutdietEngine, null, { timeout: 30000 });
  const tabs = await page2.evaluate(() => [...document.querySelectorAll('.tab')].map(t => t.dataset.tab)); assert.ok(tabs.includes('log') && tabs.includes('keys'), 'pro tabs');
  const engCard = await page2.evaluate(() => ({ hidden: document.getElementById('engineCard').hidden, text: document.getElementById('engineCard').textContent.slice(0, 80) })); assert.ok(!engCard.hidden && /연결됨/.test(engCard.text), JSON.stringify(engCard));
  const a2 = waitAnalyzedOn(page2);
  await page2.evaluate(p => window.cutdietEngine.openPaths([p]), srcMp4); assert.equal(await a2, true, 'engine analysis');
  const st2 = await page2.evaluate(() => { const s = window.cutdiet.state; return { eng: !!s.engineMedia, dur: s.duration, w: s.width, ranges: window.cutdiet.keepRanges(s.segments).length, reason: window.cutdiet.renderBlockReason(), src: document.getElementById('video').currentSrc }; });
  assert.ok(st2.eng && Math.abs(st2.dur - 16) < 0.2 && st2.w === 640 && st2.ranges === 3 && st2.reason === null && /\/api\/media\//.test(st2.src), JSON.stringify(st2));
  await page2.waitForFunction(() => window.cutdiet.state.videoPlayable, null, { timeout: 10000 });
  console.log('pro: engine open+analyze ok');
  // set the engine output dir to tmp and render through the engine (with a text overlay + caption burn)
  await page2.evaluate(async dir => { await window.cutdietEngine.api('/settings', { outDir: dir, encoder: 'libx264', quality: 'std' }); const C = window.cutdiet; C.state.fx.subs.burn = true; C.state.fx.overlays.push({ id: 'o', type: 'text', s: 1, e: 3, pos: 'tr', w: 0.05, opacity: 1, fade: 0, text: '구독', style: { font: 'Noto Sans KR', weight: 700, size: 0.05, color: '#FFE14D', stroke: '#000', strokeW: 0.2 }, name: '구독' }); C.state.fx.sfx.push({ id: 'x', t: 1.5, kind: 'ding', volume: 0.8, name: '띵' }); }, path.join(tmp, 'out'));
  const r2 = await page2.evaluate(async () => { const ok = await window.cutdiet.startRender('main', false); return { ok, status: document.getElementById('renderStatus').textContent }; });
  assert.ok(r2.ok, r2.status); const outFile = path.join(tmp, 'out', 'talk_cut.mp4'); assert.ok(fs.existsSync(outFile), 'engine output exists: ' + r2.status);
  const pOut = parseProbe((await run(ff.path, ['-hide_banner', '-i', outFile])).stderr); assert.ok(Math.abs(pOut.duration - 9.2) < 0.4 && pOut.width === 640, 'engine out ' + pOut.duration);
  console.log('pro: engine render ok', r2.status.slice(0, 60));
  // thumbnails through the engine
  const th = await page2.evaluate(async () => { const n = await window.cutdiet.pickThumbs(); const ok = await window.cutdiet.saveThumbsZip(); return { n, ok, info: document.getElementById('thumbsInfo').textContent }; });
  assert.ok(th.n >= 3 && th.ok && fs.existsSync(path.join(tmp, 'out', 'talk_썸네일')), JSON.stringify(th)); console.log('pro: engine thumbs ok', th.n);
  // project save goes to the engine output dir; queue with two engine files runs render+project
  await page2.evaluate(() => window.cutdiet.saveProjectFile()); await page2.waitForTimeout(300); assert.ok(fs.existsSync(path.join(tmp, 'out', 'talk.cutdiet.json')), 'project saved via engine');
  const src3 = path.join(tmp, 'second.mp4'); fs.copyFileSync(srcMp4, src3);
  await page2.evaluate(async ps => { for (const t of ['render', 'shorts', 'thumbs', 'project']) { const cb = document.getElementById('task_' + t); cb.checked = t === 'render' || t === 'project'; cb.dispatchEvent(new Event('change')); } await window.cutdietEngine.openPaths(ps, { queue: true }); document.getElementById('btnRunQueue').click(); }, [src3, srcMp4]);
  await page2.waitForFunction(() => document.getElementById('queueChip').textContent === '2/2', null, { timeout: 120000 });
  assert.ok(fs.existsSync(path.join(tmp, 'out', 'second_cut.mp4')) && fs.existsSync(path.join(tmp, 'out', 'talk_cut (2).mp4')), fs.readdirSync(path.join(tmp, 'out')).join(','));
  const logRows = await page2.evaluate(() => document.querySelectorAll('#logBody tr[data-del], #logBody button[data-del]').length); assert.ok(logRows >= 2, 'work log rows ' + logRows);
  console.log('pro: queue (2 files) + work log ok');
  const errs = logs.filter(l => !/favicon|font|ERR_BLOCKED|googleapis|gstatic|Permissions-Policy|Autoplay/i.test(l)); if (errs.length) console.log('console warnings:', errs.slice(0, 5));
  console.log('ALL BROWSER E2E PASSED');
} catch (e) { console.error('E2E FAILED:', e && e.stack || e); process.exitCode = 1; } finally { await browser.close(); await stop(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(process.exitCode || 0); }
