// Pure builder: turns a render request into an ffmpeg argument list + filter graph. Unit-tested in tests/test_engine.mjs.
// Timeline model: video frames are snapped to a CFR grid (fps filter), cut with select() in SOURCE time, then re-timed with
// setpts to output time by subtracting the removed durations before each frame, so audio (cut sample-exact with atrim) never drifts.
import { outTime, keptDuration, audioFormat, JOIN_FADE } from '../../src/cutlogic.js';
import { overlayBox as overlayBoxPx, adjustEq } from '../../src/fxlogic.js';
import { encoderArgs, qualityFor } from './ff.mjs';

const f3 = v => Number(v).toFixed(3);
export function segsFromRanges(ranges, duration) {
  const segs = []; let cur = 0;
  for (const r of ranges) { if (r.s > cur + 1e-6) segs.push({ s: cur, e: r.s, keep: false }); segs.push({ s: r.s, e: r.e, keep: true }); cur = r.e; }
  if (duration > cur + 1e-6) segs.push({ s: cur, e: duration, keep: false });
  return segs;
}

export function selectExpr(ranges) { return ranges.map(r => `between(t,${f3(r.s)},${f3(r.e)})`).join('+'); }
// (T - removed-before-T) / TB : head gap plus every gap between consecutive kept ranges
export function retimeExpr(ranges) {
  const terms = [f3(ranges[0].s)];
  for (let i = 1; i < ranges.length; i++) { const gap = ranges[i].s - ranges[i - 1].e; if (gap > 1e-6) terms.push(`gte(T,${f3(ranges[i].s)})*${f3(gap)}`); }
  return `(T-(${terms.join('+')}))/TB`;
}

// zoompan expressions in input time (it). Returns null when no zoom is configured.
export function zoomExprs(fx, ranges) {
  const zooms = (fx && fx.zooms) || []; const auto = fx && fx.autoZoom && fx.autoZoom.on;
  if (!zooms.length && !auto) return null;
  let z = '1', x = '0.5', y = '0.5';
  const pieces = [];
  for (const zm of zooms) {
    const ease = zm.ease || 0; const k = ease > 0 ? `clip(min((it-${f3(zm.s)})/${f3(ease)},(${f3(zm.e)}-it)/${f3(ease)}),0,1)` : '1';
    pieces.push({ s: zm.s, e: zm.e, z: `(1+${f3((zm.scale || 1.2) - 1)}*${k})`, x: f3(zm.ax ?? 0.5), y: f3(zm.ay ?? 0.5) });
  }
  if (auto) { const sc = f3(fx.autoZoom.scale || 1.12); ranges.forEach((r, i) => { if (i % 2 === 1 && !zooms.some(zm => zm.s < r.e && zm.e > r.s)) pieces.push({ s: r.s, e: r.e, z: sc, x: '0.5', y: '0.45' }); }); }
  // nested if(...) chains, later pieces are fallbacks
  for (let i = pieces.length - 1; i >= 0; i--) { const p = pieces[i]; const c = `between(it,${f3(p.s)},${f3(p.e)})`; z = `if(${c},${p.z},${z})`; x = `if(${c},${p.x},${x})`; y = `if(${c},${p.y},${y})`; }
  return { z, x: `(iw-iw/zoom)*(${x})`, y: `(ih-ih/zoom)*(${y})` };
}

function esc(s) { return String(s).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function concatChain(labels, prefix, lines) { // hierarchical concat so no single concat has >120 inputs
  let level = labels, round = 0;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 120) { const grp = level.slice(i, i + 120); if (grp.length === 1) { next.push(grp[0]); continue; } const out = `[${prefix}${round}_${i}]`; lines.push(`${grp.join('')}concat=n=${grp.length}:v=0:a=1${out}`); next.push(out); }
    level = next; round++;
  }
  return level[0];
}

// req: { src, ranges, duration, fps, width, height, hasAudio, out:{w,h}, crop, quality, encoder, fx, captionsOut:boolean, total }
// assets: { ass: path|null, bgm: {path, volume, duck, fade, loop}|null, images: [{path, s, e(out), box:{x,y,w,h}, opacity}], sfx: [{path, outT, volume}] }
// ffmpeg 7 replaced -filter_complex_script with -/filter_complex (and 8+ dropped the old flag); ffmpeg-static still ships 6.x
export function scriptFlag(version) { const m = String(version || '').match(/^n?(\d+)\./); return m && Number(m[1]) >= 7 ? '-/filter_complex' : '-filter_complex_script'; }
export function buildArgs(req, assets, { fontsDir, hasLibass, ffVersion } = {}) {
  const warnings = []; const ranges = req.ranges; const total = req.total ?? ranges.reduce((a, r) => a + r.e - r.s, 0);
  const fps = req.fps || 30; const out = req.out; const inputs = ['-i', req.src]; let idx = 1;
  const lines = [];
  // ---- video ---- (skipped for voice files: req.audioOnly)
  if (!req.audioOnly) {
  let v = `[0:v]fps=${f3(fps)}`;
  if (req.crop) v += `,crop=${req.crop.width}:${req.crop.height}:${req.crop.left}:${req.crop.top}`;
  const zx = zoomExprs(req.fx, ranges);
  if (zx) v += `,zoompan=z='${zx.z}':x='${zx.x}':y='${zx.y}':d=1:s=${out.w}x${out.h}:fps=${f3(fps)}`;
  else if ((req.crop ? req.crop.width : req.width) !== out.w || (req.crop ? req.crop.height : req.height) !== out.h) v += `,scale=${out.w}:${out.h}:flags=lanczos`;
  const eq = adjustEq(req.fx && req.fx.adjust); if (eq) v += `,eq=brightness=${eq.brightness}:contrast=${eq.contrast}:saturation=${eq.saturation}`;
  v += `,select='${selectExpr(ranges)}',setpts='${retimeExpr(ranges)}'`;
  lines.push(`${v}[v0]`); let vl = '[v0]'; let vn = 1;
  for (const im of assets.images || []) {
    inputs.push('-loop', '1', '-framerate', '2', '-i', im.path); const b = im.box;
    lines.push(`[${idx}:v]scale=${Math.max(2, Math.round(b.w))}:${Math.max(2, Math.round(b.h))},format=rgba,colorchannelmixer=aa=${f3(im.opacity ?? 1)}[ov${idx}]`);
    lines.push(`${vl}[ov${idx}]overlay=x=${Math.round(b.x)}:y=${Math.round(b.y)}:enable='between(t,${f3(im.s)},${f3(im.e)})':eof_action=pass[v${vn}]`); vl = `[v${vn}]`; vn++; idx++;
  }
  if (assets.ass) {
    if (hasLibass === false) warnings.push('이 ffmpeg는 자막 굽기(libass)를 지원하지 않아 자막·텍스트는 생략했습니다');
    else { lines.push(`${vl}subtitles=filename='${esc(assets.ass)}'${fontsDir ? `:fontsdir='${esc(fontsDir)}'` : ''}[v${vn}]`); vl = `[v${vn}]`; vn++; }
  }
  const fade = (req.fx && req.fx.fade) || { in: 0, out: 0 }; const fades = [];
  if (fade.in > 0) fades.push(`fade=t=in:st=0:d=${f3(fade.in)}`);
  if (fade.out > 0) fades.push(`fade=t=out:st=${f3(Math.max(0, total - fade.out))}:d=${f3(fade.out)}`);
  lines.push(`${vl}${fades.length ? fades.join(',') + ',' : ''}format=yuv420p[vout]`);
  if (req.fx && req.fx.transition && req.fx.transition.type === 'dissolve') warnings.push('디졸브 전환은 엔진 렌더에서 지원하지 않아 생략했습니다 (브라우저 렌더에서만 가능)');
  }
  // ---- audio ----
  const AF = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  let voice = null;
  // 영상 track muted on the timeline: keep the music/effects, drop the original sound
  const voiceOn = req.hasAudio && !(req.fx && req.fx.tracks && req.fx.tracks.origMuted);
  const gainDb = req.gainDb ?? (req.audio && req.audio.gainDb) ?? 0; // loudness matching: voice lifted/lowered before mixing, the limiter below catches peaks
  if (voiceOn) {
    const n = ranges.length; const labels = ranges.map((_, i) => `[c${i}]`);
    // 잡음 제거: ffmpeg's FFT denoiser. It needs the real noise level (nf), measured in the cut pauses (noiseDb); its own
    // tracking (tn) barely reacts. Strength = how many dB of noise it takes out.
    const nr = { low: 8, mid: 14, high: 22 }[req.denoise]; const nf = Math.round(Math.max(-80, Math.min(-20, req.noiseDb ?? -50)));
    lines.push(`[0:a]${AF}${nr ? `,afftdn=nr=${nr}:nf=${nf}${req.noiseDb == null ? ':tn=1' : ''}` : ''}${gainDb ? `,volume=${f3(gainDb)}dB` : ''},asplit=${n}${ranges.map((_, i) => `[a${i}]`).join('')}`);
    // short fades at every join (not at the very start/end): without them each cut is an audible tick
    ranges.forEach((r, i) => { const fx = []; const len = r.e - r.s; if (i > 0 && len > 4 * JOIN_FADE) fx.push(`afade=t=in:st=0:d=${f3(JOIN_FADE)}`); if (i < n - 1 && len > 4 * JOIN_FADE) fx.push(`afade=t=out:st=${f3(len - JOIN_FADE)}:d=${f3(JOIN_FADE)}`); lines.push(`[a${i}]atrim=${f3(r.s)}:${f3(r.e)},asetpts=PTS-STARTPTS${fx.length ? ',' + fx.join(',') : ''}[c${i}]`); });
    voice = n === 1 ? '[c0]' : concatChain(labels, 'cc', lines);
  } else { lines.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${f3(total)}[sil]`); voice = '[sil]'; }
  let mix = voice;
  const bgm = assets.bgm;
  if (bgm) {
    inputs.push(...(bgm.loop ? ['-stream_loop', '-1'] : []), '-i', bgm.path); const F = bgm.fade || 0;
    const off = Math.max(0, Math.min(total - 0.05, bgm.offset || 0)); const len = total - off; // music dragged to start later on the timeline
    const bg = [AF, `volume=${f3(bgm.volume)}`]; if (F > 0) bg.push(`afade=t=in:st=0:d=${f3(F)}`, `afade=t=out:st=${f3(Math.max(0, len - F))}:d=${f3(F)}`); bg.push(`atrim=0:${f3(len)}`, 'asetpts=PTS-STARTPTS'); if (off > 0) bg.push(`adelay=${Math.round(off * 1000)}:all=1`, `apad=whole_len=${Math.round(total * 48000)}`);
    lines.push(`[${idx}:a]${bg.join(',')}[bg]`); idx++;
    const amix = 'amix=inputs=2:duration=first:dropout_transition=0:normalize=0';
    if (bgm.duck && voiceOn) { lines.push(`${voice}asplit=2[vA][vB]`, `[bg][vB]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=400[bgd]`, `[vA][bgd]${amix}[m1]`); }
    else lines.push(`${voice}[bg]${amix}[m1]`);
    mix = '[m1]';
  }
  const sfx = (assets.sfx || []).filter(s => s.outT >= 0 && s.outT < total);
  if (sfx.length) {
    const labels = [];
    for (const s of sfx) { inputs.push('-i', s.path); lines.push(`[${idx}:a]${AF},adelay=${Math.round(s.outT * 1000)}:all=1,volume=${f3(s.volume ?? 0.8)}[sx${idx}]`); labels.push(`[sx${idx}]`); idx++; }
    lines.push(`${mix}${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0[m2]`); mix = '[m2]';
  }
  lines.push(`${mix}alimiter=limit=0.98:level=false[aout]`);
  if (req.audioOnly) {
    const f = audioFormat(req.audio && req.audio.format);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y', ...inputs, scriptFlag(ffVersion), '__GRAPH__', '-map', '[aout]', '-vn', '-ac', String(req.audio && req.audio.channels === 1 ? 1 : 2), ...f.ff, '-metadata', 'comment=cutdiet', req.outPath];
    return { args, graph: lines.join(';\n') + '\n', warnings, total, encoder: f.ff[1], bitrate: f.bitrate };
  }
  const q = qualityFor(req.quality || 'high', out.w, out.h, fps);
  const enc = encoderArgs(req.encoder || 'libx264', q);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y', ...inputs, scriptFlag(ffVersion), '__GRAPH__', '-map', '[vout]', '-map', '[aout]', ...enc,
    '-r', f3(fps), '-fps_mode:v', 'cfr', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-metadata', 'comment=cutdiet', req.outPath];
  return { args, graph: lines.join(';\n') + '\n', warnings, total, encoder: req.encoder || 'libx264', bitrate: q.bitrate };
}

// Map browser fx/captions (source time) to output time for the assets
export function mapOverlaysAndCaptions(req) {
  const segs = segsFromRanges(req.ranges, req.duration); const ot = t => outTime(segs, t); const total = keptDuration(segs);
  const captions = (req.captions || []).map(c => ({ s: ot(c.s), e: ot(c.e), text: c.text })).filter(c => c.e - c.s >= 0.12);
  const textOverlays = [], images = [];
  for (const o of (req.fx && req.fx.overlays) || []) {
    const s = ot(o.s), e = ot(o.e); if (e - s < 0.05) continue;
    if (o.type === 'text') textOverlays.push({ s, e, layer: o.layer || 0, text: o.text, style: o.style, pos: o.pos, x: o.x, y: o.y, sizeFrac: o.w || 0.06, opacity: o.opacity, fade: o.fade });
    else if (o.type === 'image' && o.path) images.push({ path: o.path, layer: o.layer || 0, s, e, opacity: o.opacity ?? 1, box: overlayBoxPx(o, req.out.w, req.out.h), fade: o.fade });
  }
  const sfx = ((req.fx && req.fx.sfx) || []).map(s => ({ ...s, outT: ot(s.t), inKept: segs.some(g => g.keep && s.t >= g.s && s.t < g.e) })).filter(s => s.inKept);
  images.sort((x, y) => x.layer - y.layer); // bottom layer is composited first
  return { captions, textOverlays, images, sfx, total };
}

// Join clips end to end (클립 이어 붙이기): every clip scaled/padded to the first video's size and frame rate, sound
// conformed to 48 kHz stereo and padded to the clip's length; a clip without picture shows black, without sound is silent.
// clips: [{ path, info: { duration, hasVideo, hasAudio, width, height, fps } }]
export function buildJoinArgs(clips, outPath, { encoder = 'libx264', ffVersion } = {}) {
  const video = clips.some(c => c.info.hasVideo); const first = clips.find(c => c.info.hasVideo);
  const W = first ? Math.round(first.info.width / 2) * 2 : 0, H = first ? Math.round(first.info.height / 2) * 2 : 0, F = first ? (first.info.fps || 30) : 30;
  const inputs = []; const lines = []; const labels = []; let total = 0;
  const AF = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  clips.forEach((c, i) => {
    inputs.push('-i', c.path); const d = f3(c.info.duration); total += c.info.duration;
    if (video) {
      if (c.info.hasVideo) lines.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${f3(F)},tpad=stop_mode=clone:stop_duration=${d},trim=0:${d},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`); // video shorter than its sound: hold the last frame so later clips stay in sync
      else lines.push(`color=c=black:s=${W}x${H}:r=${f3(F)}:d=${d},format=yuv420p[v${i}]`);
    }
    if (c.info.hasAudio) lines.push(`[${i}:a]${AF},atrim=0:${d},asetpts=PTS-STARTPTS,apad=whole_dur=${d}[a${i}]`);
    else lines.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${d}[a${i}]`);
    labels.push(video ? `[v${i}][a${i}]` : `[a${i}]`);
  });
  lines.push(`${labels.join('')}concat=n=${clips.length}:v=${video ? 1 : 0}:a=1${video ? '[vout]' : ''}[aout]`);
  const enc = video ? [...encoderArgs(encoder, qualityFor('high', W, H, F)), '-r', f3(F), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] : ['-c:a', 'pcm_s16le'];
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y', ...inputs, scriptFlag(ffVersion), '__GRAPH__', ...(video ? ['-map', '[vout]'] : []), '-map', '[aout]', ...enc, outPath];
  return { args, graph: lines.join(';\n') + '\n', total, video, ext: video ? '.mp4' : '.wav' };
}
