import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// The speech-recognition runtime (onnxruntime-web WASM, ~26 MB) is loaded from jsDelivr at run time (src/asr.worker.js),
// so the copy Rollup emits is never requested: leave it out. Users then download almost nothing from our host,
// and every file stays under Cloudflare Pages' 25 MiB per-file limit (checked after the build).
const MAX_FILE = 25 * 1024 * 1024;
const dropOrtWasm = () => ({
  name: 'cutdiet-drop-ort-wasm',
  generateBundle(_, bundle) { for (const k of Object.keys(bundle)) if (/ort-wasm[^/]*\.wasm$/.test(k)) delete bundle[k]; },
});
const checkFileSizes = () => ({
  name: 'cutdiet-check-file-sizes', apply: 'build',
  closeBundle() {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const big = fs.existsSync('dist') ? walk('dist').filter(f => fs.statSync(f).size > MAX_FILE) : [];
    if (big.length) throw new Error('25 MiB가 넘는 파일은 Cloudflare Pages에 올라가지 않습니다: ' + big.join(', '));
  },
});

export default defineConfig({
  plugins: [dropOrtWasm(), checkFileSizes()],
  worker: { plugins: () => [dropOrtWasm()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', pro: 'pro.html' } } },
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } },
});
