// Runs Whisper entirely in the browser (transformers.js + onnxruntime-web). No server, no API key.
// Speed: the page plans speech-only windows (asrplan.js) and hands them out one at a time to a small pool of these
// workers (see transcribe.js), so several windows are recognized at once. Each window is transcribed exactly as a
// single worker would, so accuracy is unchanged. A fast GPU (WebGPU, fp16) is used when present; otherwise the CPU.
//   {type:'init', model, device, threads} -> {type:'ready', device}
//   {type:'win', id, w, audio}            -> {type:'win', id, chunks, wordLevel}   (times relative to `audio`)
import { pipeline, env } from '@huggingface/transformers';
import { transcribeWindows, fastGpu } from './asrplan.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
// The ONNX runtime WASM (~6 MB) always comes from jsDelivr, never from our host: the build leaves the local copy out
// (vite.config.js) to keep hosting traffic near zero. transformers.js sets this by default; pin it in case a future version stops.
const ort = env.backends && env.backends.onnx;
if (ort && ort.wasm && !ort.wasm.wasmPaths && ort.versions && ort.versions.web) {
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.versions.web}/dist/`;
  ort.wasm.wasmPaths = { mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm' };
}

const post = m => self.postMessage(m);
// WebGPU in fp16 when the adapter supports it (same accuracy as fp32, half the download); q8 on the CPU.
async function gpuDtype() {
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!a || !fastGpu(a.info)) return null;
    return a.features.has('shader-f16') ? 'fp16' : 'fp32';
  } catch { return null; }
}
async function load(model, device) {
  const dtype = device === 'webgpu' ? await gpuDtype() : 'q8';
  if (device === 'webgpu' && !dtype) throw new Error('webgpu adapter unavailable');
  const files = new Map();
  return pipeline('automatic-speech-recognition', model, {
    device, dtype: device === 'webgpu' ? { encoder_model: dtype, decoder_model_merged: dtype } : dtype,
    progress_callback: info => {
      if (info.status === 'progress' && info.file) {
        files.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
        let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: 'progress', phase: 'download', pct: total ? loaded / total : 0, loaded, total });
      }
    },
  });
}

let asr = null, model = '', device = 'wasm', wordLevel = true;
const OPTS = { language: 'korean', task: 'transcribe', return_timestamps: 'word' };
async function run(a) {
  try { return await asr(a, wordLevel ? OPTS : { ...OPTS, return_timestamps: true }); }
  catch (err) {
    // the GPU can fail mid-way on some drivers: finish on the CPU instead of losing the work
    if (device === 'webgpu') { device = 'wasm'; post({ type: 'device', device, reason: 'error' }); asr = await load(model, device); return run(a); }
    // word-level alignment not available for this model: fall back to segment timestamps
    if (wordLevel) { wordLevel = false; post({ type: 'progress', phase: 'transcribe', note: 'segment' }); return asr(a, { ...OPTS, return_timestamps: true }); }
    throw err;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      model = msg.model; device = msg.device; if (msg.language) OPTS.language = msg.language;
      if (msg.threads && ort && ort.wasm) ort.wasm.numThreads = msg.threads; // manual override (localStorage 'cutdiet:aiThreads')
      post({ type: 'progress', phase: 'load', pct: 0 });
      try { asr = await load(model, device); }
      catch (err) { if (device !== 'webgpu') throw err; device = 'wasm'; post({ type: 'device', device, reason: /adapter unavailable/.test(err.message) ? 'slow' : 'error' }); asr = await load(model, device); }
      post({ type: 'ready', device });
    } else if (msg.type === 'win') {
      const chunks = await transcribeWindows(run, msg.audio, 16000, [msg.w]);
      post({ type: 'win', id: msg.id, chunks, wordLevel, device });
    }
  } catch (err) {
    post({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
