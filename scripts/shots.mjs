// Captures real UI screenshots for the member manual (PDF). Run: node scripts/shots.mjs <outDir>
// Uses the local engine's static server + a synthetic "lecture" clip so the screens show real analysis results.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const outDir = path.resolve(process.argv[2] || 'shots'); fs.mkdirSync(outDir, { recursive: true });
const PW = process.env.PLAYWRIGHT_PATH || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdiet-shots-'));
process.env.CUTDIET_PORT = process.env.CUTDIET_PORT || '7812'; process.env.CUTDIET_DATA = path.join(tmp, 'data'); process.env.CUTDIET_NO_OPEN = '1';
const { start, stop } = await import('../engine/server.mjs');
const { findFfmpeg, run } = await import('../engine/lib/ff.mjs');
const ff = findFfmpeg();
const { url } = await start({ open: false }); const base = url.replace(/\/pro\.html$/, '');
// a calm "talking head" stand-in: dark gradient, soft spotlight, Korean title; speech-like bursts with pauses
const font = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find(f => fs.existsSync(f));
const sysFf = (await run('ffmpeg', ['-hide_banner', '-filters']).catch(() => ({ stdout: Buffer.alloc(0) }))).stdout.toString().includes('drawtext') ? 'ffmpeg' : null;
const src = path.join(tmp, 'lecture.mp4');
const bursts = [[1.0, 5.2], [6.4, 11.9], [13.6, 19.1], [20.0, 23.4], [26.2, 33.0], [34.1, 37.8], [39.5, 46.2], [48.0, 52.3], [53.0, 58.9]];
const volExpr = bursts.map(([a, b]) => `between(t,${a},${b})`).join('+');
const bg = path.join(tmp, 'bg.png');
let r = await run(sysFf || ff.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1f2937:size=1280x720:rate=1', '-frames:v', '1', '-vf', "geq=r='40+20*sin(X/600)':g='52+30*(1-hypot(X-640,Y-300)/900)':b='76+40*(1-hypot(X-640,Y-300)/900)'", bg]);
if (r.code !== 0) { console.error(r.stderr); process.exit(1); }
const vf = font && sysFf ? `drawtext=fontfile='${font}':text='예시 강의 영상':fontcolor=white@0.85:fontsize=58:x=(w-text_w)/2:y=(h-text_h)/2-20,drawtext=fontfile='${font}':text='비즈니스 PT · 3회차':fontcolor=white@0.6:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2+50,format=yuv420p` : 'format=yuv420p';
r = await run(sysFf || ff.path, ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', bg, '-f', 'lavfi', '-i', `sine=frequency=180:sample_rate=48000,aeval=val(0)*(0.6+0.4*sin(2*PI*5.3*t))*(0.5+0.5*sin(2*PI*1.7*t+1)),volume=volume='if(${volExpr},1,0.001)':eval=frame`, '-vf', vf, '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
if (r.code !== 0) { console.error(r.stderr); process.exit(1); }
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' }); const page = await ctx.newPage(); page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)); }); page.on('pageerror', e => console.log('[pageerror]', e.message));
const shot = async (name, opts = {}) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(outDir, name + '.png'), ...opts }); console.log('shot', name); };
try {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.cutdiet && window.cutdiet.state.mbStatus === 'ready', null, { timeout: 30000 });
  await page.addStyleTag({ content: '*{caret-color:transparent} .toast{display:none}' });
  await shot('00_onboarding', { fullPage: false });
  await page.evaluate(() => { localStorage.setItem('cutdiet:onboarded', '1'); document.getElementById('onb').hidden = true; });
  await shot('01_start', { clip: { x: 0, y: 0, width: 1280, height: 560 } });
  await page.setInputFiles('#fileInput', { name: '강의_3회차_원본.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(src) }); // buffer form: non-ASCII paths are not picked up by setInputFiles
  await page.waitForFunction(() => !window.cutdiet.state.analyzing && window.cutdiet.state.duration > 0 && window.cutdiet.state.videoPlayable, null, { timeout: 60000 });
  await page.evaluate(() => { document.getElementById('toast').classList.remove('show'); window.cutdiet.seek(7.2); document.getElementById('notice').hidden = true; });
  await page.waitForTimeout(600);
  await shot('02_analyzed', { clip: { x: 0, y: 0, width: 1280, height: 760 } });
  const tl = await page.locator('section.timeline').boundingBox(); await shot('03_timeline', { clip: { x: tl.x, y: tl.y, width: tl.width, height: tl.height } });
  const panel = await page.locator('aside.panel').boundingBox(); await shot('04_settings', { clip: { x: panel.x - 4, y: panel.y - 4, width: panel.width + 8, height: panel.height + 8 } });
  const tabShot = async (tab, name, extra) => { await page.evaluate(t => window.cutdiet.showTab(t), tab); if (extra) await extra(); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(350); const r = await page.evaluate(t => { const n = document.querySelector('nav.tabs').getBoundingClientRect(), s = document.getElementById('tab-' + t).getBoundingClientRect(); return { top: n.top + window.scrollY, bottom: s.bottom + window.scrollY }; }, tab); await shot(name, { fullPage: true, clip: { x: 0, y: r.top, width: 1280, height: Math.min(1150, r.bottom - r.top + 8) } }); };
  await tabShot('segments', '05_segments');
  await page.evaluate(() => { const C = window.cutdiet; C.state.chapters = [{ t: 1.0, title: '인트로' }, { t: 13.6, title: '핵심 개념 3가지' }, { t: 39.5, title: '실습과 정리' }]; C.refreshAll(); });
  await tabShot('chapters', '06_chapters');
  await tabShot('bgm', '07_bgm');
  await tabShot('decorate', '08_decorate', async () => { await page.evaluate(() => { const C = window.cutdiet; document.getElementById('subBurn').checked = true; document.getElementById('subBurn').dispatchEvent(new Event('input')); document.getElementById('subSample').checked = true; document.getElementById('subSample').dispatchEvent(new Event('change')); document.getElementById('fxAutoZoom').checked = true; document.getElementById('fxAutoZoom').dispatchEvent(new Event('change')); }); });
  // monitor with sample caption + decorate on
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
  const mon = await page.locator('#monitor').boundingBox(); await shot('09_monitor_caption', { clip: { x: mon.x, y: mon.y, width: mon.width, height: mon.height } });
  await tabShot('shorts', '10_shorts'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
  const mon2 = await page.locator('#monitor').boundingBox(); await shot('11_monitor_crop', { clip: { x: mon2.x, y: mon2.y, width: mon2.width, height: mon2.height } });
  await tabShot('thumbs', '12_thumbs', async () => { await page.evaluate(() => window.cutdiet.pickThumbs()); await page.waitForTimeout(1500); });
  await tabShot('ai', '13_ai');
  await tabShot('export', '14_export');
  await tabShot('guide', '15_guide');
  console.log('done', outDir);
} catch (e) { console.error(e); process.exitCode = 1; } finally { await browser.close(); await stop(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(process.exitCode || 0); }
