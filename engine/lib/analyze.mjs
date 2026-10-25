// Loudness envelope (20 ms RMS in dB) computed from ffmpeg's decoded mono audio — same numbers the browser produces.
import { run, parseProbe } from './ff.mjs';
import { HOP, energyToDb } from '../../src/cutlogic.js';

const SR = 16000;

export async function analyzeFile(bin, file, { onProgress, signal } = {}) {
  const hopN = Math.round(HOP * SR);
  let sumSq = new Float64Array(1024), cnt = new Float64Array(1024); let n = 0; // n = samples consumed
  let carry = Buffer.alloc(0); let duration = 0; let stderrText = '';
  const grow = idx => { if (idx < sumSq.length) return; let len = sumSq.length; while (len <= idx) len *= 2; const s2 = new Float64Array(len), c2 = new Float64Array(len); s2.set(sumSq); c2.set(cnt); sumSq = s2; cnt = c2; };
  const feed = buf => {
    if (carry.length) { buf = Buffer.concat([carry, buf]); carry = Buffer.alloc(0); }
    const usable = buf.length - (buf.length % 4);
    if (usable < buf.length) { carry = buf.subarray(usable); buf = buf.subarray(0, usable); }
    const f = new Float32Array(buf.buffer, buf.byteOffset, usable / 4);
    for (let i = 0; i < f.length; i++) { const idx = Math.floor(n / hopN); grow(idx); const v = f[i]; sumSq[idx] += v * v; cnt[idx] += 1; n++; }
    if (onProgress && duration) onProgress(Math.min(0.99, (n / SR) / duration));
  };
  const r = await run(bin, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-loglevel', 'info', 'pipe:1'],
    { onStdout: feed, onStderr: s => { stderrText += s; if (!duration) { const p = parseProbe(stderrText); if (p.duration) duration = p.duration; } }, signal });
  const info = parseProbe(stderrText);
  if (!info.hasAudio) { const err = new Error('noaudio'); err.info = info; throw err; }
  if (r.code !== 0 && n === 0) throw new Error('오디오를 디코딩하지 못했습니다: ' + stderrText.split('\n').filter(Boolean).pop());
  const len = Math.ceil(Math.max(info.duration, n / SR) / HOP) + 1; grow(len);
  const env = energyToDb(sumSq.subarray(0, len), cnt.subarray(0, len));
  if (!info.duration) info.duration = n / SR;
  return { info, env, duration: info.duration };
}

// Float32 env -> compact JSON-friendly array (1 decimal is plenty for -100..0 dB)
export function envToArray(env) { const out = new Array(env.length); for (let i = 0; i < env.length; i++) out[i] = Math.round(env[i] * 10) / 10; return out; }
