// Pure logic for the 꾸미기 layer: subtitle styles, zoom/fade/dissolve schedules, overlays, sound effects.

export const SUB_PRESETS = {
  outline: { label: '기본 · 흰 글씨 + 검정 외곽선', font: 'Noto Sans KR', weight: 700, size: 0.055, color: '#FFFFFF', stroke: '#000000', strokeW: 0.16, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: true },
  box: { label: '박스형 · 검정 반투명 배경', font: 'Noto Sans KR', weight: 700, size: 0.05, color: '#FFFFFF', stroke: '', strokeW: 0, box: true, boxColor: '#000000', boxAlpha: 0.65, pos: 'bottom', shadow: false },
  variety: { label: '예능형 · 노란 글씨 + 두꺼운 외곽선', font: 'Black Han Sans', weight: 400, size: 0.065, color: '#FFE14D', stroke: '#1A1A1A', strokeW: 0.2, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: true },
  round: { label: '둥근 · 주아체 + 남색 외곽선', font: 'Jua', weight: 400, size: 0.06, color: '#FFFFFF', stroke: '#1F2A5C', strokeW: 0.18, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: false },
  clean: { label: '깔끔 · 흰 글씨 + 그림자', font: 'Noto Sans KR', weight: 500, size: 0.048, color: '#FFFFFF', stroke: '', strokeW: 0, box: false, boxColor: '#000000', boxAlpha: 0, pos: 'bottom', shadow: true },
};
export const SUB_FONTS = ['Noto Sans KR', 'Black Han Sans', 'Jua', 'Do Hyeon', 'Gothic A1', 'IBM Plex Sans KR'];
export const SFX_KINDS = { ding: '띵 (알림)', pop: '뿅 (등장)', whoosh: '휙 (전환)', thud: '쿵 (강조)', click: '딸깍 (클릭)' };
export const POS_LABELS = { tl: '왼쪽 위', tc: '가운데 위', tr: '오른쪽 위', ml: '왼쪽 중간', mc: '정중앙', mr: '오른쪽 중간', bl: '왼쪽 아래', bc: '가운데 아래', br: '오른쪽 아래' };

export function defaultFx() {
  return { subs: { burn: false, preset: 'outline', style: { ...SUB_PRESETS.outline } }, zooms: [], autoZoom: { on: false, scale: 1.12 }, fade: { in: 0, out: 0 }, transition: { type: 'none', dur: 0.3 }, overlays: [], sfx: [] };
}
export function fxActive(fx, hasCaptions) {
  return !!(fx.zooms.length || (fx.autoZoom && fx.autoZoom.on) || fx.fade.in > 0 || fx.fade.out > 0 || (fx.transition && fx.transition.type === 'dissolve') || fx.overlays.length || (fx.subs.burn && hasCaptions));
}

// Zoom in effect at a source time. ranges = kept ranges (for the alternating auto zoom that hides jump cuts).
export function zoomAt(fx, srcT, ranges) {
  const z = fx.zooms.find(z => srcT >= z.s && srcT < z.e);
  if (z) {
    const ease = z.ease || 0; let k = 1;
    if (ease > 0) k = Math.max(0, Math.min(1, (srcT - z.s) / ease, (z.e - srcT) / ease));
    return { scale: 1 + (z.scale - 1) * k, ax: z.ax ?? 0.5, ay: z.ay ?? 0.5 };
  }
  if (fx.autoZoom && fx.autoZoom.on && ranges) {
    const i = ranges.findIndex(r => srcT >= r.s && srcT < r.e);
    if (i >= 0 && i % 2 === 1) return { scale: fx.autoZoom.scale || 1.12, ax: 0.5, ay: 0.45 };
  }
  return { scale: 1, ax: 0.5, ay: 0.5 };
}
export function zoomSourceRect(crop, scale, ax, ay) {
  const w = crop.width / scale, h = crop.height / scale;
  return { left: crop.left + (crop.width - w) * ax, top: crop.top + (crop.height - h) * ay, width: w, height: h };
}
export function fadeAlpha(fade, outT, total) {
  let a = 0;
  if (fade.in > 0 && outT < fade.in) a = Math.max(a, 1 - outT / fade.in);
  if (fade.out > 0 && total - outT < fade.out) a = Math.max(a, 1 - Math.max(0, total - outT) / fade.out);
  return Math.min(1, Math.max(0, a));
}
// Alpha of the PREVIOUS range's last frame laid over the current one (cross dissolve at a cut)
export function dissolveAlpha(transition, outT, rangeStartOut, rangeIndex) {
  if (!transition || transition.type !== 'dissolve' || rangeIndex === 0) return 0;
  const p = (outT - rangeStartOut) / (transition.dur || 0.3);
  return p >= 1 ? 0 : 1 - Math.max(0, p);
}
export function activeOverlays(overlays, srcT) { return overlays.filter(o => srcT >= o.s && srcT < o.e); }
export function overlayAlpha(o, srcT) {
  let a = o.opacity ?? 1; const f = o.fade || 0;
  if (f > 0) a *= Math.max(0, Math.min(1, (srcT - o.s) / f, (o.e - srcT) / f));
  return Math.max(0, Math.min(1, a));
}
// Box for an image overlay: width as a share of the frame width, aspect from the image, 9 position presets
export function overlayBox(o, W, H) {
  const w = W * (o.w || 0.25); const h = o.ratio ? w / o.ratio : w; const m = Math.round(W * 0.03);
  const pos = o.pos || 'tr'; const xs = { l: m, c: (W - w) / 2, r: W - w - m }, ys = { t: m, m: (H - h) / 2, b: H - h - m };
  return { x: xs[pos[1]] ?? xs.c, y: ys[pos[0]] ?? ys.t, w, h };
}
export function wrapCaption(text, maxChars = 22) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
    while (cur.length > maxChars) { lines.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
export function captionAt(lines, srcT) { for (const l of lines) { if (srcT >= l.s && srcT < l.e) return l; if (l.s > srcT) break; } return null; }

// Built-in sound effects, synthesized (no files, no licensing)
export function synthSfx(kind, sr = 48000) {
  const mk = (dur, fn) => { const n = Math.round(dur * sr); const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = fn(i / sr, i / n); return out; };
  switch (kind) {
    case 'ding': return mk(0.8, t => (Math.sin(2 * Math.PI * 880 * t) * 0.6 + Math.sin(2 * Math.PI * 1760 * t) * 0.25 + Math.sin(2 * Math.PI * 2640 * t) * 0.1) * Math.exp(-5 * t) * 0.8);
    case 'pop': return mk(0.18, (t, p) => Math.sin(2 * Math.PI * (650 - 420 * p) * t) * Math.exp(-22 * t) * 0.9);
    case 'whoosh': { let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }; let lp = 0; return mk(0.5, (t, p) => { const cut = 0.04 + 0.45 * Math.sin(Math.PI * p); lp += (rnd() - lp) * cut; return lp * Math.pow(Math.sin(Math.PI * p), 1.5) * 1.2; }); }
    case 'thud': return mk(0.45, (t, p) => Math.sin(2 * Math.PI * (75 - 35 * p) * t) * Math.exp(-7 * t));
    case 'click': return mk(0.06, t => Math.sin(2 * Math.PI * 2800 * t) * Math.exp(-150 * t) * 0.8 + Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-70 * t) * 0.4);
    default: return mk(0.1, () => 0);
  }
}
// Mix one-shot effects into channel arrays. srcStart = source time of sample 0. getBuf(sfx) -> {data, sr}
export function mixSfxInto(chans, sr, srcStart, sfxList, getBuf) {
  const n = chans[0].length; const srcEnd = srcStart + n / sr;
  for (const s of sfxList) {
    const buf = getBuf(s); if (!buf || !buf.data || !buf.data.length) continue;
    const bsr = buf.sr || sr; const data = buf.data; const dur = data.length / bsr;
    if (s.t >= srcEnd || s.t + dur <= srcStart) continue;
    const vol = s.volume ?? 0.8; const j0 = Math.max(0, Math.round((s.t - srcStart) * sr));
    for (let j = j0; j < n; j++) {
      const pos = ((srcStart + j / sr) - s.t) * bsr; const i = pos | 0; if (i + 1 >= data.length) break; if (i < 0) continue;
      const v = (data[i] + (data[i + 1] - data[i]) * (pos - i)) * vol;
      for (let c = 0; c < chans.length; c++) { const x = chans[c][j] + v; chans[c][j] = x > 1 ? 1 : x < -1 ? -1 : x; }
    }
  }
}
export function hexA(hex, a) { const h = String(hex || '#000000').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`; }
// Serialize fx for the project file (image pixels only when a small data URL is available)
export function fxToJSON(fx) {
  return { subs: { burn: fx.subs.burn, preset: fx.subs.preset, style: { ...fx.subs.style } }, zooms: fx.zooms.map(z => ({ ...z })), autoZoom: { ...fx.autoZoom }, fade: { ...fx.fade }, transition: { ...fx.transition },
    overlays: fx.overlays.map(o => ({ id: o.id, type: o.type, s: o.s, e: o.e, pos: o.pos, w: o.w, opacity: o.opacity, fade: o.fade, text: o.text, ratio: o.ratio, name: o.name, dataUrl: o.dataUrl && o.dataUrl.length < 1.5e6 ? o.dataUrl : undefined })),
    sfx: fx.sfx.map(s => ({ id: s.id, t: s.t, kind: s.kind, volume: s.volume, name: s.name })) };
}
export function fxFromJSON(j) {
  const fx = defaultFx(); if (!j || typeof j !== 'object') return fx;
  if (j.subs) { fx.subs.burn = !!j.subs.burn; fx.subs.preset = j.subs.preset || 'outline'; fx.subs.style = { ...SUB_PRESETS[fx.subs.preset] || SUB_PRESETS.outline, ...(j.subs.style || {}) }; }
  if (Array.isArray(j.zooms)) fx.zooms = j.zooms.filter(z => z && z.e > z.s).map(z => ({ s: +z.s, e: +z.e, scale: +z.scale || 1.2, ax: z.ax ?? 0.5, ay: z.ay ?? 0.5, ease: +z.ease || 0 }));
  if (j.autoZoom) fx.autoZoom = { on: !!j.autoZoom.on, scale: +j.autoZoom.scale || 1.12 };
  if (j.fade) fx.fade = { in: +j.fade.in || 0, out: +j.fade.out || 0 };
  if (j.transition) fx.transition = { type: j.transition.type === 'dissolve' ? 'dissolve' : 'none', dur: +j.transition.dur || 0.3 };
  if (Array.isArray(j.overlays)) fx.overlays = j.overlays.filter(o => o && o.e > o.s && (o.type === 'text' || o.dataUrl)).map(o => ({ id: o.id || String(Math.random()).slice(2), type: o.type, s: +o.s, e: +o.e, pos: o.pos || 'tr', w: +o.w || 0.25, opacity: o.opacity ?? 1, fade: +o.fade || 0, text: o.text || '', ratio: +o.ratio || 1, name: o.name || '', dataUrl: o.dataUrl, bitmap: null }));
  if (Array.isArray(j.sfx)) fx.sfx = j.sfx.filter(s => s && isFinite(+s.t) && s.kind && s.kind !== 'custom').map(s => ({ id: s.id || String(Math.random()).slice(2), t: +s.t, kind: s.kind, volume: s.volume ?? 0.8, name: s.name || '' }));
  return fx;
}
