// Renders docs/manual/manual.html to a PDF with headless Chromium. Run: node scripts/manual-pdf.mjs [out.pdf]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = path.join(root, 'docs/manual/manual.html');
const out = path.resolve(process.argv[2] || path.join(root, 'public/manual.pdf'));
// playwright-core drives the installed Chrome (set CHROME_CHANNEL=msedge for Edge); nothing extra is downloaded
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' });
const page = await browser.newPage();
await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; }))); });
fs.mkdirSync(path.dirname(out), { recursive: true });
await page.pdf({
  path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<div style="width:100%;font-size:8px;color:#8a90a0;padding:0 16mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>컷다이어트 사용 설명서</span><span>cutdiet.vercel.app</span></div>',
  footerTemplate: '<div style="width:100%;font-size:8px;color:#8a90a0;padding:0 16mm;text-align:right;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '16mm', bottom: '16mm', left: '0', right: '0' },
});
await browser.close();
console.log('pdf:', out, (fs.statSync(out).size / 1e6).toFixed(2), 'MB');
