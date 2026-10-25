// FFmpeg access for the local engine: binary lookup, probing (parsed from ffmpeg's own input dump), encoder detection.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Candidate binaries: ffmpeg-static (installed by engine/package.json), then whatever is on PATH.
export function findFfmpeg() {
  const cands = [];
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) cands.push(p); } catch {}
  for (const dir of [path.join(here, '..', 'node_modules', 'ffmpeg-static'), path.join(here, '..', '..', 'node_modules', 'ffmpeg-static')]) {
    for (const n of ['ffmpeg', 'ffmpeg.exe']) { const p = path.join(dir, n); if (fs.existsSync(p)) cands.push(p); }
  }
  if (process.env.CUTDIET_FFMPEG && fs.existsSync(process.env.CUTDIET_FFMPEG)) cands.unshift(process.env.CUTDIET_FFMPEG);
  cands.push('ffmpeg');
  for (const c of cands) {
    try { const r = spawnSync(c, ['-version'], { encoding: 'utf8', timeout: 8000 }); if (r.status === 0 && /ffmpeg version/.test(r.stdout)) return { path: c, version: (r.stdout.match(/ffmpeg version (\S+)/) || [])[1] || '?', config: r.stdout }; } catch {}
  }
  return null;
}

export function run(bin, args, { onStderr, onStdout, signal, maxStdout = 64e6 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = []; let outLen = 0, errLen = 0;
    child.stdout.on('data', d => { if (onStdout) onStdout(d); else if (outLen < maxStdout) { out.push(d); outLen += d.length; } });
    child.stderr.on('data', d => { if (errLen < 4e6) { err.push(d); errLen += d.length; } if (onStderr) onStderr(d.toString('utf8')); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), killed: child.killed }));
    if (signal) signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
  });
}

// Parse the "Input #0 ... Duration ... Stream" dump ffmpeg prints on stderr (works without ffprobe)
export function parseProbe(stderr) {
  const info = { duration: 0, start: 0, width: 0, height: 0, fps: 0, rotation: 0, hasVideo: false, hasAudio: false, vcodec: '', acodec: '', sampleRate: 0, channels: 0 };
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) info.duration = Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) / 1000;
  const st = stderr.match(/start:\s*(-?\d+(?:\.\d+)?)/); if (st) info.start = Number(st[1]);
  const lines = stderr.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const v = ln.match(/Stream #\d+:\d+.*?: Video: (\w+)/);
    if (v && !info.hasVideo && !/attached pic|\(attached pic\)/.test(ln)) {
      info.hasVideo = true; info.vcodec = v[1];
      const wh = ln.match(/,\s*(\d{2,5})x(\d{2,5})(?:\s*\[|,|\s)/); if (wh) { info.width = Number(wh[1]); info.height = Number(wh[2]); }
      const fps = ln.match(/([\d.]+) fps/) || ln.match(/([\d.]+) tbr/); if (fps) info.fps = Number(fps[1]);
      // side data for this stream follows until the next "Stream #"
      for (let k = i + 1; k < lines.length && !/Stream #/.test(lines[k]); k++) {
        const rot = lines[k].match(/rotation of (-?[\d.]+) degrees/) || lines[k].match(/rotate\s*:\s*(-?\d+)/);
        if (rot) info.rotation = ((Math.round(Number(rot[1])) % 360) + 360) % 360;
      }
    }
    const a = ln.match(/Stream #\d+:\d+.*?: Audio: (\w+)/);
    if (a && !info.hasAudio) {
      info.hasAudio = true; info.acodec = a[1];
      const sr = ln.match(/(\d+) Hz/); if (sr) info.sampleRate = Number(sr[1]);
      if (/\bmono\b/.test(ln)) info.channels = 1; else if (/\bstereo\b/.test(ln)) info.channels = 2; else { const ch = ln.match(/(\d+) channels/); info.channels = ch ? Number(ch[1]) : 2; if (/5\.1/.test(ln)) info.channels = 6; }
    }
  }
  if (!info.fps || info.fps > 240) info.fps = 30;
  // ffmpeg auto-rotates on decode, so expose display dimensions
  if (info.rotation === 90 || info.rotation === 270) { const w = info.width; info.width = info.height; info.height = w; }
  return info;
}

export async function probe(bin, file) {
  const r = await run(bin, ['-hide_banner', '-i', file]); // exits 1 (no output) but prints the dump
  const info = parseProbe(r.stderr);
  if (!info.duration && !info.hasVideo && !info.hasAudio) throw new Error('이 파일을 읽을 수 없습니다: ' + (r.stderr.split('\n').filter(Boolean).pop() || '').slice(0, 160));
  return info;
}

// Hardware encoders are listed even when the machine can't use them, so each candidate gets a 3-frame smoke test.
const ENCODERS = {
  h264_videotoolbox: { label: 'Apple VideoToolbox (하드웨어)', args: q => ['-c:v', 'h264_videotoolbox', '-b:v', String(q.bitrate), '-maxrate', String(Math.round(q.bitrate * 1.5)), '-bufsize', String(q.bitrate * 2), '-allow_sw', '1', '-profile:v', 'high'] },
  h264_nvenc: { label: 'NVIDIA NVENC (하드웨어)', args: q => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', String(q.bitrate), '-maxrate', String(Math.round(q.bitrate * 1.5)), '-bufsize', String(q.bitrate * 2), '-profile:v', 'high'] },
  h264_qsv: { label: 'Intel Quick Sync (하드웨어)', args: q => ['-c:v', 'h264_qsv', '-b:v', String(q.bitrate), '-maxrate', String(Math.round(q.bitrate * 1.5)), '-bufsize', String(q.bitrate * 2)] },
  h264_amf: { label: 'AMD AMF (하드웨어)', args: q => ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', String(q.bitrate), '-maxrate', String(Math.round(q.bitrate * 1.5))] },
  libx264: { label: 'x264 (소프트웨어 · 가장 호환성 좋음)', args: q => ['-c:v', 'libx264', '-preset', q.preset || 'fast', '-crf', String(q.crf), '-profile:v', 'high'] },
};
export const ENCODER_LABELS = Object.fromEntries(Object.entries(ENCODERS).map(([k, v]) => [k, v.label]));
export function encoderArgs(name, q) { return (ENCODERS[name] || ENCODERS.libx264).args(q); }

export async function detectEncoders(bin) {
  const list = await run(bin, ['-hide_banner', '-encoders']);
  const avail = new Set((list.stdout.toString('utf8').match(/^\s*V[^\s]*\s+(\w+)/gm) || []).map(s => s.trim().split(/\s+/)[1]));
  const order = os.platform() === 'darwin' ? ['h264_videotoolbox', 'libx264'] : os.platform() === 'win32' ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] : ['h264_nvenc', 'h264_qsv', 'libx264'];
  const working = [];
  for (const name of order) {
    if (!avail.has(name)) continue;
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=30', '-frames:v', '3', '-pix_fmt', 'yuv420p', ...encoderArgs(name, { bitrate: 500000, cq: 23, crf: 23, preset: 'ultrafast' }), '-f', 'null', '-'];
    try { const r = await run(bin, args); if (r.code === 0) working.push(name); } catch {}
  }
  if (!working.length && avail.has('libx264')) working.push('libx264');
  return { available: [...avail].filter(n => n in ENCODERS), working };
}

export function hasLibass(config) { return /enable-libass/.test(config || ''); }

// Quality presets shared with the browser's estimates (bitrate scales with pixels)
export function qualityFor(q, w, h, fps) {
  const pix = w * h; const base = (q === 'high' ? 10e6 : q === 'std' ? 5.5e6 : q === '1080' ? 8e6 : 4e6) * (pix / (1920 * 1080)) * (fps > 40 ? 1.4 : 1);
  const bitrate = Math.round(Math.min(60e6, Math.max(800e3, base)));
  return { bitrate, crf: q === 'high' ? 18 : q === 'std' ? 22 : q === '1080' ? 19 : 21, cq: q === 'high' ? 19 : 23, preset: 'fast' };
}
