// Whisper on the local CPU through transformers.js + onnxruntime-node (same library, options and speech-only windows as the
// browser worker, native speed).
import { parentPort, workerData } from 'node:worker_threads';

const post = m => parentPort.postMessage(m);
try {
  const { audio, model, language, duration, cacheDir, dtype } = workerData;
  const { pipeline, env } = await import('@huggingface/transformers');
  const { planWindows, transcribeWindows, envFromAudio } = await import('../../src/asrplan.js');
  const { suggestThreshold, HOP } = await import('../../src/cutlogic.js');
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
  const samples = new Float32Array(audio); const envDb = envFromAudio(samples, 16000, HOP);
  const windows = planWindows(envDb, HOP, suggestThreshold(envDb), samples.length / 16000);
  const opts = { language: language || 'korean', task: 'transcribe', return_timestamps: 'word' };
  let wordLevel = true;
  const run = async a => { try { return await asr(a, wordLevel ? opts : { ...opts, return_timestamps: true }); } catch (err) { if (!wordLevel) throw err; wordLevel = false; post({ type: 'progress', phase: 'transcribe', pct: 0, note: 'segment' }); return asr(a, { ...opts, return_timestamps: true }); } };
  const chunks = await transcribeWindows(run, samples, 16000, windows, { onWindow: (i, n) => post({ type: 'progress', phase: 'transcribe', pct: Math.min(0.99, i / n) }) });
  const out = { text: chunks.map(c => c.text).join(''), chunks, wordLevel };
  post({ type: 'done', text: out.text || '', chunks: out.chunks || [], wordLevel: out.wordLevel !== false });
} catch (err) { post({ type: 'error', message: (err && err.message) ? err.message : String(err) }); }
