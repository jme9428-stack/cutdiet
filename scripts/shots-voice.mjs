// Captures the "음성 파일 컷편집" screenshots for the manual from a real voice recording.
// Run: npm run build && npx vite preview --port 5175, then
//      node scripts/shots-voice.mjs <recording.m4a> [outDir=docs/manual/shots] [base=http://localhost:5175]
// Uses the installed Chrome through playwright-core (CHROME_CHANNEL=msedge for Edge; PLAYWRIGHT_PATH for another playwright).
// Pass a long, quiet recording with long pauses (a phone voice memo) so the cut is easy to see.
import fs from 'node:fs';
import path from 'node:path';

const [audio, outArg, baseArg] = process.argv.slice(2);
if (!audio || !fs.existsSync(audio)) { console.error('usage: node scripts/shots-voice.mjs <recording.m4a> [outDir] [base]'); process.exit(1); }
const outDir = path.resolve(outArg || 'docs/manual/shots'); const base = baseArg || 'http://localhost:5175';
fs.mkdirSync(outDir, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch(process.env.PLAYWRIGHT_PATH ? {} : { channel: process.env.CHROME_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name, opts = {}) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(outDir, name + '.jpg'), type: 'jpeg', quality: 84, ...opts }); console.log('shot', name); };
const box = async (sel, pad = 0) => { const b = await page.locator(sel).first().boundingBox(); return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 }; };
const hideToast = () => page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); });
try {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('cutdiet:onboarded', '1'); }); await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.cutdiet && window.cutdiet.state.mbStatus === 'ready', null, { timeout: 30000 });
  await page.addStyleTag({ content: '*{caret-color:transparent}' });
  const analyzed = page.evaluate(() => new Promise(r => document.addEventListener('cutdiet:analyzed', e => r(e.detail.ok), { once: true })));
  // passed as a buffer: setInputFiles drops paths with non-ASCII (e.g. Korean) names, and the name shows in the editor
  const mimeType = /\.mp3$/i.test(audio) ? 'audio/mpeg' : /\.wav$/i.test(audio) ? 'audio/wav' : 'audio/mp4';
  await page.setInputFiles('#fileInput', { name: path.basename(audio), mimeType, buffer: fs.readFileSync(audio) }); if (!(await analyzed)) throw new Error('analysis failed');
  // park the playhead inside the longest kept stretch so the monitor meter has something to show
  await page.evaluate(() => { const C = window.cutdiet; const r = C.keepRanges(C.state.segments).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0]; C.seek(r.s + Math.min(5, (r.e - r.s) / 2)); });
  await hideToast(); await shot('20_voice_editor');
  // auto-cut panel with the detail settings open: the threshold chosen for a quiet recording
  await page.evaluate(() => { document.getElementById('adv').open = true; });
  await shot('21_voice_cut', { clip: await box('.sidepanel') });
  // timeline zoomed onto the part where the sound is: green = kept, red = removed
  await page.evaluate(() => { const C = window.cutdiet, s = C.state; const rs = C.keepRanges(s.segments); const r = rs.sort((a, b) => (b.e - b.s) - (a.e - a.s))[0]; s.zoom = Math.max(1, s.duration / 300); s.scroll = Math.max(0, r.s - 60); C.refreshAll(); });
  await shot('22_voice_timeline', { clip: await box('.tlwrap') });
  // export dialog for a voice file: format + loudness
  await page.click('#btnTopExport'); await page.waitForTimeout(300); await shot('23_voice_export', { clip: await box('.xcard', 6) });
  await page.keyboard.press('Escape');
} finally {
  if (errors.length) console.warn('page errors:', errors);
  await browser.close();
}
