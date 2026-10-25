// Small helpers: WAV writing, native file dialogs, settings persistence, output naming, folder opening.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export function writeWav(file, samples, sr = 48000) { // mono float32 -> 16-bit PCM WAV
  const n = samples.length; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, samples[i])); buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2); }
  fs.writeFileSync(file, buf);
}

// ---- native dialogs (run on the user's desktop since the engine is local) ----
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mts', 'm2ts', 'm4a', 'mp3', 'wav', 'aac', 'flac'];
export const MEDIA_RE = new RegExp('\\.(' + VIDEO_EXT.join('|') + ')$', 'i');
export async function nativePick({ kind = 'files', title = '파일 선택' } = {}) {
  const plat = os.platform();
  const runCmd = (cmd, args, input) => new Promise(resolve => { const p = spawn(cmd, args, { windowsHide: true }); let out = ''; p.stdout.on('data', d => { out += d.toString('utf8'); }); p.on('error', () => resolve('')); p.on('close', () => resolve(out)); if (input != null) { p.stdin.end(input); } });
  let out = '';
  if (plat === 'darwin') {
    const t = title.replace(/"/g, '');
    const script = kind === 'dir' ? `set f to choose folder with prompt "${t}"\nreturn POSIX path of f`
      : kind === 'save' ? `set f to choose file name with prompt "${t}"\nreturn POSIX path of f`
      : `set fs to choose file with prompt "${t}" with multiple selections allowed\nset o to ""\nrepeat with f in fs\nset o to o & POSIX path of f & linefeed\nend repeat\nreturn o`;
    out = await runCmd('osascript', ['-e', script]);
  } else if (plat === 'win32') {
    const t = title.replace(/'/g, '');
    const ps = kind === 'dir'
      ? `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='${t}'; $d.ShowNewFolderButton=$true; if($d.ShowDialog() -eq 'OK'){ $d.SelectedPath }`
      : `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='${t}'; $d.Multiselect=$true; $d.Filter='영상·음성|*.${VIDEO_EXT.join(';*.')}|모든 파일|*.*'; if($d.ShowDialog() -eq 'OK'){ $d.FileNames -join \"\`n\" }`;
    out = await runCmd('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  } else {
    const hasZenity = spawnSync('which', ['zenity']).status === 0;
    if (!hasZenity) throw new Error('이 시스템에는 파일 선택 창을 띄울 도구(zenity)가 없습니다. 경로를 직접 입력하세요');
    out = await runCmd('zenity', kind === 'dir' ? ['--file-selection', '--directory', `--title=${title}`] : ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`]);
  }
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => { try { return fs.existsSync(p); } catch { return false; } });
}

export function openFolder(dir) {
  const plat = os.platform(); try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const cmd = plat === 'darwin' ? ['open', [dir]] : plat === 'win32' ? ['explorer', [dir]] : ['xdg-open', [dir]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}
export function openBrowser(url) {
  const plat = os.platform();
  const cmd = plat === 'darwin' ? ['open', [url]] : plat === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

export function defaultOutDir() {
  const home = os.homedir(); const plat = os.platform();
  const base = plat === 'darwin' ? path.join(home, 'Movies') : plat === 'win32' ? path.join(home, 'Videos') : home;
  return path.join(fs.existsSync(base) ? base : home, '컷다이어트');
}
// file.mp4 -> file_cut.mp4, file_cut (2).mp4 ... never overwrite
export function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext); let k = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${k++})${ext}`);
  return p;
}
export function baseName(name) { return String(name || 'video').replace(/\.[^.]+$/, ''); }

// ---- settings ----
export function loadJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function saveJSON(file, data) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); } catch {} }
export function randomToken() { return [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join(''); }
