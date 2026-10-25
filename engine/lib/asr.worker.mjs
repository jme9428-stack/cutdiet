// Whisper on the local CPU through transformers.js + onnxruntime-node (same library and options as the browser worker, native speed).
import { parentPort, workerData } from 'node:worker_threads';

const post = m => parentPort.postMessage(m);
try {
  const { audio, model, language, duration, cacheDir, dtype } = workerData;
  const { pipeline, env, WhisperTextStreamer } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir; env.allowLocalModels = true; env.allowRemoteModels = true;
  post({ type: 'progress', phase: 'load', pct: 0 });
  const files = new Map();
  const asr = await pipeline('automatic-speech-recognition', model, {
    device: 'cpu', dtype: dtype || 'q8',
    progress_callback: info => {
      if (info.status === 'progress' && info.file) { files.set(info.file, { loaded: info.loaded || 0, total: info.total || 0 }); let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.loaded; total += f.total; } post({ type: 'progress', phase: 'download', pct: total ? loaded / total : 0, loaded, total }); }
      else if (info.status === 'ready') post({ type: 'progress', phase: 'ready' });
    },
  });
  post({ type: 'progress', phase: 'transcribe', pct: 0 });
  let streamer = null;
  try {
    const chunkLength = asr.processor.feature_extractor.config.chunk_length; const timePrecision = chunkLength / asr.model.config.max_source_positions; let lastT = 0;
    streamer = new WhisperTextStreamer(asr.tokenizer, { time_precision: timePrecision, skip_prompt: true, skip_special_tokens: true, on_chunk_start: t => { lastT = Math.max(lastT, t || 0); post({ type: 'progress', phase: 'transcribe', pct: duration ? Math.min(0.99, lastT / duration) : 0 }); }, callback_function: () => {}, on_finalize: () => {} });
  } catch { streamer = null; }
  const opts = { language: language || 'korean', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, force_full_sequences: false };
  if (streamer) opts.streamer = streamer;
  let out;
  try { out = await asr(new Float32Array(audio), opts); }
  catch (err) { post({ type: 'progress', phase: 'transcribe', pct: 0, note: 'segment' }); out = await asr(new Float32Array(audio), { ...opts, return_timestamps: true, streamer: undefined }); out.wordLevel = false; }
  post({ type: 'done', text: out.text || '', chunks: out.chunks || [], wordLevel: out.wordLevel !== false });
} catch (err) { post({ type: 'error', message: (err && err.message) ? err.message : String(err) }); }
