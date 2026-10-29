// Captures real UI screenshots for the member manual (PDF).
// Run: npm run build && npx vite preview --port 5175, then
//      node scripts/shots.mjs <video.mp4> [outDir=docs/manual/shots] [base=http://localhost:5175]
// Uses the installed Chrome (playwright-core, no browser download). A persistent profile in the OS temp folder keeps the
// speech model cached between runs, so only the first run downloads it. Pass a short (~1 min) clip with clear speech.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [video, outArg, baseArg] = process.argv.slice(2);
if (!video || !fs.existsSync(video)) { console.error('usage: node scripts/shots.mjs <video.mp4> [outDir] [base]'); process.exit(1); }
const outDir = path.resolve(outArg || 'docs/manual/shots'); const base = baseArg || 'http://localhost:5175';
fs.mkdirSync(outDir, { recursive: true });
const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'cutdiet-shots-profile'), { channel: process.env.CHROME_CHANNEL || 'chrome', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name, opts = {}) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(outDir, name + '.jpg'), type: 'jpeg', quality: 84, ...opts }); console.log('shot', name); };
const box = async sel => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
const tab = async t => { await page.evaluate(t => { window.cutdiet.showTab(t); const sp = document.querySelector('.sidepanel'); if (sp) sp.scrollTop = 0; }, t); await page.waitForTimeout(350); };
const hideToast = () => page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); });
const ready = () => page.waitForFunction(() => window.cutdiet && window.cutdiet.state.mbStatus === 'ready', null, { timeout: 30000 });
try {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); }); await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await page.addStyleTag({ content: '*{caret-color:transparent}' }); await page.waitForTimeout(600);
  await shot('00_onboarding');
  await page.evaluate(() => { localStorage.setItem('cutdiet:onboarded', '1'); document.getElementById('onb').hidden = true; });
  await shot('01_start');
  await page.setInputFiles('#fileInput', { name: '예시_강의영상.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(video) }); // buffer form: non-ASCII paths are not picked up
  await page.waitForFunction(() => !window.cutdiet.state.analyzing && window.cutdiet.state.duration > 0 && window.cutdiet.state.videoPlayable, null, { timeout: 90000 });
  await page.waitForTimeout(2500); await page.evaluate(() => { const n = document.getElementById('notice'); if (n) n.hidden = true; window.cutdiet.seek(9.5); }); await hideToast();
  await shot('02_editor');
  await shot('03_timeline', { clip: await box('section.timeline') });
  await tab('segments'); await shot('04_cut', { clip: await box('.sidepanel') });
  // auto subtitles (the speech model is cached in the profile after the first run)
  await tab('ai'); await page.click('#btnAiRun');
  await page.waitForFunction(() => /^완료|오류|실패/.test(document.getElementById('aiStatus').textContent), null, { timeout: 1200000, polling: 2000 });
  console.log('subtitles:', await page.textContent('#aiStatus'));
  await page.evaluate(() => { document.getElementById('subBurn').checked = true; ['input', 'change'].forEach(t => document.getElementById('subBurn').dispatchEvent(new Event(t, { bubbles: true }))); window.cutdiet.seek(12.3); }); await hideToast();
  await tab('ai'); await shot('05_subtitles');
  // a caption selected: the right-hand inspector
  await page.evaluate(() => { const l = window.cutdiet.captionsOf().find(x => x.s > 11) || window.cutdiet.captionsOf()[0]; window.cutdiet.state.selClip = { kind: 'cap', ref: l }; window.cutdiet.seek(l.s + 0.3); window.cutdiet.refreshAll(); }); await hideToast();
  await shot('06_inspector', { clip: await box('#inspector') });
  await shot('07_monitor_caption', { clip: await box('#monitor') });
  await page.evaluate(() => { window.cutdiet.state.selClip = null; window.cutdiet.refreshAll(); });
  await tab('ai'); await page.evaluate(() => { const el = document.getElementById('subPreset'); el.scrollIntoView({ block: 'start' }); }); await shot('08_caption_style', { clip: await box('.sidepanel') });
  await tab('ng'); await shot('09_ng', { clip: await box('.sidepanel') });
  await tab('text'); await page.evaluate(() => window.cutdiet.seek(30)); await page.fill('#ovText', '5A 스틱 고르는 법'); await page.click('#btnOvText'); await hideToast();
  await shot('10_text');
  await page.evaluate(() => { window.cutdiet.state.selClip = null; window.cutdiet.refreshAll(); });
  await tab('bgm'); await shot('11_audio', { clip: await box('.sidepanel') });
  await tab('decorate'); await shot('12_effects', { clip: await box('.sidepanel') });
  await tab('shorts'); await shot('13_shorts');
  await tab('export'); await shot('14_export', { clip: await box('.sidepanel') });
  await tab('guide'); await shot('15_guide', { clip: await box('.sidepanel') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(700); await page.evaluate(() => window.scrollTo(0, 0)); await shot('16_mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + '/pro.html', { waitUntil: 'domcontentloaded' }); await ready();
  await page.evaluate(() => { localStorage.setItem('cutdiet:onboarded', '1'); const o = document.getElementById('onb'); if (o) o.hidden = true; }); await page.waitForTimeout(500);
  await tab('pro'); await shot('17_pro');
  await tab('log'); await shot('18_pro_log', { clip: await box('.sidepanel') });
  await tab('keys'); await shot('19_pro_keys', { clip: await box('.sidepanel') });
} catch (e) { errors.push('script: ' + e.message); console.error(e); process.exitCode = 1; }
if (errors.length) console.log('page errors:', errors);
await ctx.close();
