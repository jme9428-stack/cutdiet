// Transcription job: ffmpeg -> 16 kHz mono float samples -> Whisper worker thread -> word chunks (browser-compatible shape).
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './ff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ASR_MODELS = {
  base: { id: 'Xenova/whisper-base', label: '빠름 · base (~80MB)', dtype: 'q8' },
  small: { id: 'Xenova/whisper-small', label: '기본 · small (~250MB)', dtype: 'q8' },
  medium: { id: 'Xenova/whisper-medium', label: '정확 · medium (~800MB, 느림)', dtype: 'q8' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', label: '최고 · large-v3-turbo (~1.6GB, 가장 느림)', dtype: 'q8' },
};
export function resolveModel(key) { if (ASR_MODELS[key]) return ASR_MODELS[key]; const hit = Object.values(ASR_MODELS).find(m => m.id === key); return hit || ASR_MODELS.small; }

export async function extractAudio16k(bin, file, { signal } = {}) {
  const chunks = [];
  const r = await run(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { onStdout: d => chunks.push(d), signal });
  if (r.code !== 0) throw new Error('오디오 추출 실패: ' + r.stderr.slice(-200));
  const buf = Buffer.concat(chunks); const usable = buf.length - (buf.length % 4);
  const f32 = new Float32Array(usable / 4); Buffer.from(f32.buffer).set(buf.subarray(0, usable));
  return f32;
}

export function transcribeAudio(audio, { model = 'small', cacheDir, duration, onProgress, signal, workerFactory } = {}) {
  const m = resolveModel(model); fs.mkdirSync(cacheDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const data = { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength), model: m.id, dtype: m.dtype, language: 'korean', duration, cacheDir };
    const w = workerFactory ? workerFactory(data) : new Worker(path.join(here, 'asr.worker.mjs'), { workerData: data, transferList: [data.audio] });
    const done = fn => { try { w.terminate(); } catch {} fn(); };
    w.on('message', msg => { if (msg.type === 'progress') onProgress && onProgress(msg); else if (msg.type === 'done') done(() => resolve({ chunks: msg.chunks, text: msg.text, wordLevel: msg.wordLevel, model: m.id })); else if (msg.type === 'error') done(() => reject(new Error(msg.message))); });
    w.on('error', e => done(() => reject(e)));
    w.on('exit', code => { if (code !== 0) reject(new Error('인식 작업이 비정상 종료됐습니다 (code ' + code + ')')); });
    if (signal) signal.addEventListener('abort', () => done(() => reject(new Error('canceled'))), { once: true });
  });
}
