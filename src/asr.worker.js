// Runs Whisper entirely in the browser (transformers.js + onnxruntime-web). No server, no API key.
import { pipeline, env, WhisperTextStreamer } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// The ONNX runtime WASM (~6 MB) always comes from jsDelivr, never from our host: the build leaves the local copy out
// (vite.config.js) to keep hosting traffic near zero. transformers.js sets this by default; pin it in case a future version stops.
const ort = env.backends && env.backends.onnx;
if (ort && ort.wasm && !ort.wasm.wasmPaths && ort.versions && ort.versions.web) {
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.versions.web}/dist/`;
  ort.wasm.wasmPaths = { mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm' };
}

const cache = new Map();
let current = null;

async function getPipeline(model, device, onProgress) {
  const key = `${model}|${device}`;
  if (cache.has(key)) return cache.get(key);
  const dtype = device === 'webgpu' ? 'fp32' : 'q8';
  const files = new Map();
  const p = await pipeline('automatic-speech-recognition', model, {
    device, dtype,
    progress_callback: info => {
      if (info.status === 'progress' && info.file) {
        files.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 });
        let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        onProgress({ phase: 'download', pct: total ? loaded / total : 0, loaded, total });
      } else if (info.status === 'ready') onProgress({ phase: 'ready' });
    },
  });
  cache.set(key, p);
  return p;
}

self.onmessage = async (e) => {
  const msg = e.data; if (msg.type !== 'run') return;
  const post = m => self.postMessage(m);
  try {
    const { audio, model, device, language, duration } = msg;
    post({ type: 'progress', phase: 'load', pct: 0 });
    const asr = await getPipeline(model, device, p => post({ type: 'progress', ...p }));
    post({ type: 'progress', phase: 'transcribe', pct: 0 });
    let streamer = null;
    try {
      const chunkLength = asr.processor.feature_extractor.config.chunk_length;
      const timePrecision = chunkLength / asr.model.config.max_source_positions;
      let lastT = 0, partial = '';
      streamer = new WhisperTextStreamer(asr.tokenizer, {
        time_precision: timePrecision, skip_prompt: true, skip_special_tokens: true,
        on_chunk_start: t => { lastT = Math.max(lastT, t || 0); post({ type: 'progress', phase: 'transcribe', pct: duration ? Math.min(0.99, lastT / duration) : 0 }); },
        callback_function: txt => { partial += txt; if (partial.length > 4000) partial = partial.slice(-4000); post({ type: 'partial', text: partial }); },
        on_finalize: () => { partial = ''; },
      });
    } catch (err) { streamer = null; }
    const opts = { language: language || 'korean', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, force_full_sequences: false };
    if (streamer) opts.streamer = streamer;
    let out;
    try { out = await asr(audio, opts); }
    catch (err) {
      // word-level alignment not available for this model: fall back to segment timestamps
      post({ type: 'progress', phase: 'transcribe', pct: 0, note: 'segment' });
      out = await asr(audio, { ...opts, return_timestamps: true, streamer: undefined });
      out.wordLevel = false;
    }
    post({ type: 'done', text: out.text || '', chunks: out.chunks || [], wordLevel: out.wordLevel !== false });
  } catch (err) {
    post({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
