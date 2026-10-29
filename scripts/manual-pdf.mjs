// Builds the manuals from one source, docs/manual/manual.html, as a PDF and a web page each:
//   site manual (cutdiet.vercel.app)  -> public/manual.pdf + public/manual/       (parts marked data-only="pro" left out)
//   full manual with the Pro chapter  -> public/manual-pro.pdf + public/manual-pro/
// Run: node scripts/manual-pdf.mjs   (uses the installed Chrome through playwright-core; CHROME_CHANNEL=msedge for Edge)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'docs/manual/manual.html'), 'utf8');
const shots = path.join(root, 'docs/manual/shots');

// The site edition: drop the Pro-only chapter and its table-of-contents line, then number the chapters 1, 2, 3… again
export function siteEdition(html) {
  let out = html.replace(/<section data-only="pro">[\s\S]*?<\/section>\s*/g, '').replace(/<div data-only="pro">[\s\S]*?<\/div>\s*/g, '');
  let n = 0; out = out.replace(/<span class="num">(\d+)<\/span>/g, (m, d) => (d === '0' ? m : `<span class="num">${++n}</span>`));
  let k = 0; out = out.replace(/<span class="n">\d+<\/span>/g, () => `<span class="n">${++k}</span>`);
  return out;
}
const editions = [
  { name: 'manual', html: siteEdition(src), pdfLink: '/manual.pdf' },
  { name: 'manual-pro', html: src.replace('href="/manual.pdf"', 'href="/manual-pro.pdf"').replace('href="/"', 'href="/pro.html"'), pdfLink: '/manual-pro.pdf' },
];

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome' });
for (const ed of editions) {
  // web page: public/<name>/index.html + shots (opens everywhere, even where a PDF extension blocks the PDF)
  const web = path.join(root, 'public', ed.name); fs.rmSync(web, { recursive: true, force: true }); fs.mkdirSync(path.join(web, 'shots'), { recursive: true });
  const used = new Set([...ed.html.matchAll(/shots\/([\w.-]+)/g)].map(m => m[1]));
  for (const f of used) fs.copyFileSync(path.join(shots, f), path.join(web, 'shots', f));
  fs.writeFileSync(path.join(web, 'index.html'), ed.html);
  // PDF rendered from that page
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(web, 'index.html')).href, { waitUntil: 'load' });
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; }))); });
  const out = path.join(root, 'public', ed.name + '.pdf');
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<div style="width:100%;font-size:8px;color:#8a90a0;padding:0 16mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>컷다이어트 사용 설명서</span><span>cutdiet.vercel.app</span></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#8a90a0;padding:0 16mm;text-align:right;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '16mm', bottom: '16mm', left: '0', right: '0' },
  });
  await page.close();
  console.log(ed.name, '→', path.relative(root, out), (fs.statSync(out).size / 1e6).toFixed(2), 'MB · web', path.relative(root, web), `(${used.size} images)`);
}
await browser.close();
