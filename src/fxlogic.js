// Pure logic for the 꾸미기 layer: subtitle styles, zoom/fade/dissolve schedules, overlays, sound effects.

// Caption looks after the common styles of Korean YouTube genres. Every caption is one line at the bottom unless noted.
export const SUB_PRESETS = {
  outline: { label: '정보·강의형 · 흰 글씨 + 검정 외곽선 (기본)', font: 'Noto Sans KR', weight: 700, size: 0.055, color: '#FFFFFF', stroke: '#000000', strokeW: 0.16, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: true },
  box: { label: '토크·인터뷰형 · 반투명 검정 박스', font: 'Noto Sans KR', weight: 700, size: 0.05, color: '#FFFFFF', stroke: '', strokeW: 0, box: true, boxColor: '#000000', boxAlpha: 0.65, pos: 'bottom', shadow: false },
  variety: { label: '예능형 · 노란 굵은 글씨 + 두꺼운 외곽선', font: 'Black Han Sans', weight: 400, size: 0.065, color: '#FFE14D', stroke: '#1A1A1A', strokeW: 0.2, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: true },
  shorts: { label: '숏츠형 · 가운데 큰 글씨 + 톡 튀어나오기', font: 'Black Han Sans', weight: 400, size: 0.075, color: '#FFFFFF', stroke: '#000000', strokeW: 0.22, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'center', shadow: true, anim: 'pop' },
  news: { label: '리뷰·뉴스형 · 흰 글씨 + 남색 박스', font: 'Pretendard', weight: 700, size: 0.05, color: '#FFFFFF', stroke: '', strokeW: 0, box: true, boxColor: '#14213D', boxAlpha: 0.88, pos: 'bottom', shadow: false },
  game: { label: '게임·리액션형 · 흰 글씨 + 보라 외곽선', font: 'Do Hyeon', weight: 400, size: 0.065, color: '#FFFFFF', stroke: '#5B21B6', strokeW: 0.22, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: true, anim: 'pop' },
  round: { label: '브이로그형 · 주아체 + 남색 외곽선', font: 'Jua', weight: 400, size: 0.06, color: '#FFFFFF', stroke: '#1F2A5C', strokeW: 0.18, box: false, boxColor: '#000000', boxAlpha: 0.6, pos: 'bottom', shadow: false },
  clean: { label: '감성·다큐형 · 얇은 흰 글씨 + 그림자', font: 'Noto Sans KR', weight: 500, size: 0.048, color: '#FFFFFF', stroke: '', strokeW: 0, box: false, boxColor: '#000000', boxAlpha: 0, pos: 'bottom', shadow: true },
};
// Free-for-commercial-use Korean fonts. g = Google Fonts (CSS loaded on demand), url = jsDelivr webfont (FontFace),
// ttf = file the Pro engine downloads for burned-in subtitles (libass). w = the weight the font is drawn with.
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/';
const NOON = 'https://cdn.jsdelivr.net/gh/projectnoonnu/';
export const FONT_CATALOG = [
  { f: 'Noto Sans KR', k: '노토 산스', cat: '고딕', w: 700, g: true, ttf: GF + 'notosanskr/NotoSansKR%5Bwght%5D.ttf' },
  { f: 'Pretendard', k: '프리텐다드', cat: '고딕', w: 700, url: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff2/Pretendard-Bold.woff2', ttf: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/public/static/Pretendard-Bold.otf' },
  { f: 'SUIT', k: '수트', cat: '고딕', w: 700, url: 'https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/static/woff2/SUIT-Bold.woff2', ttf: 'https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/static/ttf/SUIT-Bold.ttf' },
  { f: 'Nanum Gothic', k: '나눔고딕', cat: '고딕', w: 700, g: true, ttf: GF + 'nanumgothic/NanumGothic-Bold.ttf' },
  { f: 'Gothic A1', k: '고딕 A1', cat: '고딕', w: 700, g: true, ttf: GF + 'gothica1/GothicA1-Bold.ttf' },
  { f: 'IBM Plex Sans KR', k: 'IBM 플렉스', cat: '고딕', w: 700, g: true, ttf: GF + 'ibmplexsanskr/IBMPlexSansKR-Bold.ttf' },
  { f: 'GmarketSans', k: 'G마켓 산스', cat: '고딕', w: 700, url: NOON + 'noonfonts_2001@1.1/GmarketSansBold.woff', ttf: NOON + 'noonfonts_2001@1.1/GmarketSansBold.woff' },
  { f: 'LINE Seed KR', k: 'LINE Seed', cat: '고딕', w: 700, url: NOON + 'noonfonts_11-01@1.0/LINESeedKR-Bd.woff2' },
  { f: 'Paperlogy', k: '페이퍼로지', cat: '고딕', w: 800, url: NOON + '2408-3@1.0/Paperlogy-8ExtraBold.woff2' },
  { f: 'Sunflower', k: '해바라기', cat: '고딕', w: 700, g: true, ttf: GF + 'sunflower/Sunflower-Bold.ttf' },
  { f: 'Gowun Dodum', k: '고운돋움', cat: '고딕', w: 400, g: true, ttf: GF + 'gowundodum/GowunDodum-Regular.ttf' },
  { f: 'Orbit', k: '오르빗', cat: '고딕', w: 400, g: true, ttf: GF + 'orbit/Orbit-Regular.ttf' },
  { f: 'Black Han Sans', k: '검은고딕', cat: '제목·예능', w: 400, g: true, ttf: GF + 'blackhansans/BlackHanSans-Regular.ttf' },
  { f: 'Do Hyeon', k: '도현', cat: '제목·예능', w: 400, g: true, ttf: GF + 'dohyeon/DoHyeon-Regular.ttf' },
  { f: 'Jua', k: '주아', cat: '제목·예능', w: 400, g: true, ttf: GF + 'jua/Jua-Regular.ttf' },
  { f: 'Jalnan', k: '여기어때 잘난체', cat: '제목·예능', w: 400, url: NOON + 'noonfonts_four@1.2/JalnanOTF00.woff', ttf: NOON + 'noonfonts_four@1.2/JalnanOTF00.woff' },
  { f: 'Cafe24Ssurround', k: '카페24 써라운드', cat: '제목·예능', w: 400, url: NOON + 'noonfonts_2105_2@1.0/Cafe24Ssurround.woff', ttf: NOON + 'noonfonts_2105_2@1.0/Cafe24Ssurround.woff' },
  { f: 'SBAggroB', k: '어그로체', cat: '제목·예능', w: 400, url: NOON + 'noonfonts_2108@1.1/SBAggroB.woff', ttf: NOON + 'noonfonts_2108@1.1/SBAggroB.woff' },
  { f: 'Bagel Fat One', k: '베이글', cat: '제목·예능', w: 400, g: true, ttf: GF + 'bagelfatone/BagelFatOne-Regular.ttf' },
  { f: 'Gugi', k: '구기', cat: '제목·예능', w: 400, g: true, ttf: GF + 'gugi/Gugi-Regular.ttf' },
  { f: 'Dongle', k: '동글', cat: '제목·예능', w: 700, g: true, ttf: GF + 'dongle/Dongle-Bold.ttf' },
  { f: 'Nanum Pen Script', k: '나눔손글씨 펜', cat: '손글씨', w: 400, g: true, ttf: GF + 'nanumpenscript/NanumPenScript-Regular.ttf' },
  { f: 'Nanum Brush Script', k: '나눔손글씨 붓', cat: '손글씨', w: 400, g: true, ttf: GF + 'nanumbrushscript/NanumBrushScript-Regular.ttf' },
  { f: 'Gaegu', k: '개구', cat: '손글씨', w: 700, g: true, ttf: GF + 'gaegu/Gaegu-Bold.ttf' },
  { f: 'Gamja Flower', k: '감자꽃', cat: '손글씨', w: 400, g: true, ttf: GF + 'gamjaflower/GamjaFlower-Regular.ttf' },
  { f: 'Hi Melody', k: '하이멜로디', cat: '손글씨', w: 400, g: true, ttf: GF + 'himelody/HiMelody-Regular.ttf' },
  { f: 'Poor Story', k: '서툰이야기', cat: '손글씨', w: 400, g: true, ttf: GF + 'poorstory/PoorStory-Regular.ttf' },
  { f: 'Single Day', k: '싱글데이', cat: '손글씨', w: 400, g: true, ttf: GF + 'singleday/SingleDay-Regular.ttf' },
  { f: 'Yeon Sung', k: '연성', cat: '손글씨', w: 400, g: true, ttf: GF + 'yeonsung/YeonSung-Regular.ttf' },
  { f: 'East Sea Dokdo', k: '동해독도', cat: '손글씨', w: 400, g: true, ttf: GF + 'eastseadokdo/EastSeaDokdo-Regular.ttf' },
  { f: 'Noto Serif KR', k: '노토 세리프', cat: '명조', w: 700, g: true, ttf: GF + 'notoserifkr/NotoSerifKR%5Bwght%5D.ttf' },
  { f: 'Nanum Myeongjo', k: '나눔명조', cat: '명조', w: 700, g: true, ttf: GF + 'nanummyeongjo/NanumMyeongjo-Bold.ttf' },
  { f: 'Gowun Batang', k: '고운바탕', cat: '명조', w: 700, g: true, ttf: GF + 'gowunbatang/GowunBatang-Bold.ttf' },
  { f: 'Hahmlet', k: '함렛', cat: '명조', w: 700, g: true, ttf: GF + 'hahmlet/Hahmlet%5Bwght%5D.ttf' },
  { f: 'Song Myung', k: '송명', cat: '명조', w: 400, g: true, ttf: GF + 'songmyung/SongMyung-Regular.ttf' },
];
export const SUB_FONTS = FONT_CATALOG.map(x => x.f);
export const fontInfo = family => FONT_CATALOG.find(x => x.f === family) || null;
export const CAPTION_ANIMS = { none: '없음', fade: '페이드', pop: '톡 튀어나오기', up: '아래에서 올라오기' };
export const SFX_KINDS = { ding: '띵 (알림)', pop: '뿅 (등장)', whoosh: '휙 (전환)', thud: '쿵 (강조)', click: '딸깍 (클릭)' };
export const POS_LABELS = { tl: '왼쪽 위', tc: '가운데 위', tr: '오른쪽 위', ml: '왼쪽 중간', mc: '정중앙', mr: '오른쪽 중간', bl: '왼쪽 아래', bc: '가운데 아래', br: '오른쪽 아래' };

export function defaultFx() {
  return { subs: { burn: false, preset: 'outline', style: { ...SUB_PRESETS.outline } }, zooms: [], autoZoom: { on: false, scale: 1.12 }, fade: { in: 0, out: 0 }, transition: { type: 'none', dur: 0.3 }, adjust: { brightness: 0, contrast: 0, saturation: 0 }, overlays: [], sfx: [], tracks: defaultTracks() };
}
// Timeline track switches. hidden/locked hold lane keys: 'cap', 'ov0', 'ov1'…, 'main', 'sfx', 'bgm'
export function defaultTracks() { return { hidden: [], locked: [], origMuted: false, sfxMuted: false, bgmMuted: false }; }
// fx as it should be drawn/mixed: hidden overlay layers and muted effects left out
export function liveFx(fx) {
  const t = fx.tracks; if (!t || (!t.hidden.length && !t.sfxMuted)) return fx;
  return { ...fx, overlays: fx.overlays.filter(o => !t.hidden.includes('ov' + (o.layer || 0))), sfx: t.sfxMuted ? [] : fx.sfx };
}
// First layer (row) where [s, e) does not overlap another overlay — new clips stack upward like CapCut
export function freeLayer(overlays, s, e, skipId) {
  for (let L = 0; L < 50; L++) if (!overlays.some(o => o.id !== skipId && (o.layer || 0) === L && o.s < e && o.e > s)) return L;
  return 0;
}
export const layerCount = overlays => Math.max(1, ...overlays.map(o => (o.layer || 0) + 1));
export function fxActive(fx, hasCaptions) {
  return !!(fx.zooms.length || (fx.autoZoom && fx.autoZoom.on) || fx.fade.in > 0 || fx.fade.out > 0 || (fx.transition && fx.transition.type === 'dissolve') || fx.overlays.length || (fx.subs.burn && hasCaptions) || adjustActive(fx.adjust));
}
// Color adjust: percentages -50..50 (0 = untouched). CSS filter for the canvas, eq= values for ffmpeg.
export function adjustActive(a) { return !!(a && (a.brightness || a.contrast || a.saturation)); }
export function adjustFilter(a) { if (!adjustActive(a)) return 'none'; return `brightness(${1 + (a.brightness || 0) / 100}) contrast(${1 + (a.contrast || 0) / 100}) saturate(${1 + (a.saturation || 0) / 100})`; }
export function adjustEq(a) { if (!adjustActive(a)) return null; const r = v => Math.round(v * 1000) / 1000; return { brightness: r((a.brightness || 0) / 250), contrast: r(1 + (a.contrast || 0) / 100), saturation: r(1 + (a.saturation || 0) / 100) }; }
// Caption entrance animation t seconds into the line: alpha, scale and a downward offset (share of the font size)
export function captionAnim(kind, t, dur = 0.25) {
  const p = Math.max(0, Math.min(1, t / dur)); const ease = 1 - Math.pow(1 - p, 3);
  if (kind === 'fade') return { alpha: ease, scale: 1, dy: 0 };
  if (kind === 'pop') return { alpha: Math.min(1, p * 2.5), scale: p >= 1 ? 1 : 0.7 + 0.3 * ease + Math.sin(Math.PI * p) * 0.08, dy: 0 };
  if (kind === 'up') return { alpha: ease, scale: 1, dy: (1 - ease) * 0.6 };
  return { alpha: 1, scale: 1, dy: 0 };
}
// Caption block center when the user dragged it on the preview (pos 'custom'), else null
export function customXY(style) { return style && style.pos === 'custom' && isFinite(style.x) && isFinite(style.y) ? { x: Math.max(0, Math.min(1, style.x)), y: Math.max(0, Math.min(1, style.y)) } : null; }

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
// active at srcT, bottom layer first (higher layers are drawn on top)
export function activeOverlays(overlays, srcT) { return overlays.filter(o => srcT >= o.s && srcT < o.e).sort((a, b) => (a.layer || 0) - (b.layer || 0)); }
export function overlayAlpha(o, srcT) {
  let a = o.opacity ?? 1; const f = o.fade || 0;
  if (f > 0) a *= Math.max(0, Math.min(1, (srcT - o.s) / f, (o.e - srcT) / f));
  return Math.max(0, Math.min(1, a));
}
// Box for an image overlay: width as a share of the frame width, aspect from the image, 9 position presets
export function overlayBox(o, W, H) {
  const w = W * (o.w || 0.25); const h = o.ratio ? w / o.ratio : w; const m = Math.round(W * 0.03);
  const pos = o.pos || 'tr'; if (pos === 'custom' && isFinite(o.x) && isFinite(o.y)) return { x: o.x * W - w / 2, y: o.y * H - h / 2, w, h };
  const xs = { l: m, c: (W - w) / 2, r: W - w - m }, ys = { t: m, m: (H - h) / 2, b: H - h - m };
  return { x: xs[pos[1]] ?? xs.c, y: ys[pos[0]] ?? ys.t, w, h };
}
// Captions and text overlays are drawn on one line (a line break only where the user typed one); a line wider than
// the frame is shrunk to fit instead of wrapping. textLines splits on typed breaks, textEm estimates a line's width in
// font-size units for the Pro engine, which has no canvas to measure with (Hangul ≈ 1, Latin ≈ 0.6, space ≈ 0.3).
export const LINE_FIT = 0.92;
export function textLines(text) { const ls = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); return ls.length ? ls : ['']; }
export function textEm(line) { let n = 0; for (const ch of String(line || '')) n += /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 1 : ch === ' ' ? 0.3 : /[A-Z0-9MW%]/.test(ch) ? 0.65 : /[.,'!:;|il]/.test(ch) ? 0.3 : 0.55; return n; }
export function fitScale(text, px, W) { const em = Math.max(...textLines(text).map(textEm)); return em * px > W * LINE_FIT ? (W * LINE_FIT) / (em * px) : 1; }
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
  return { subs: { burn: fx.subs.burn, preset: fx.subs.preset, style: { ...fx.subs.style } }, zooms: fx.zooms.map(z => ({ ...z })), autoZoom: { ...fx.autoZoom }, fade: { ...fx.fade }, transition: { ...fx.transition }, adjust: { ...(fx.adjust || {}) }, tracks: JSON.parse(JSON.stringify(fx.tracks || defaultTracks())),
    overlays: fx.overlays.map(o => ({ id: o.id, type: o.type, s: o.s, e: o.e, layer: o.layer || 0, pos: o.pos, x: o.x, y: o.y, w: o.w, opacity: o.opacity, fade: o.fade, text: o.text, style: o.style ? { ...o.style } : undefined, ratio: o.ratio, name: o.name, dataUrl: o.dataUrl && o.dataUrl.length < 1.5e6 ? o.dataUrl : undefined })),
    sfx: fx.sfx.map(s => ({ id: s.id, t: s.t, kind: s.kind, volume: s.volume, name: s.name })) };
}
export function fxFromJSON(j) {
  const fx = defaultFx(); if (!j || typeof j !== 'object') return fx;
  if (j.subs) { fx.subs.burn = !!j.subs.burn; fx.subs.preset = j.subs.preset || 'outline'; fx.subs.style = { ...SUB_PRESETS[fx.subs.preset] || SUB_PRESETS.outline, ...(j.subs.style || {}) }; }
  if (Array.isArray(j.zooms)) fx.zooms = j.zooms.filter(z => z && z.e > z.s).map(z => ({ s: +z.s, e: +z.e, scale: +z.scale || 1.2, ax: z.ax ?? 0.5, ay: z.ay ?? 0.5, ease: +z.ease || 0 }));
  if (j.autoZoom) fx.autoZoom = { on: !!j.autoZoom.on, scale: +j.autoZoom.scale || 1.12 };
  if (j.fade) fx.fade = { in: +j.fade.in || 0, out: +j.fade.out || 0 };
  if (j.transition) fx.transition = { type: j.transition.type === 'dissolve' ? 'dissolve' : 'none', dur: +j.transition.dur || 0.3 };
  if (j.adjust) for (const k of ['brightness', 'contrast', 'saturation']) fx.adjust[k] = Math.max(-50, Math.min(50, +j.adjust[k] || 0));
  if (j.tracks) { const t = j.tracks; fx.tracks = { hidden: Array.isArray(t.hidden) ? t.hidden.filter(x => typeof x === 'string') : [], locked: Array.isArray(t.locked) ? t.locked.filter(x => typeof x === 'string') : [], origMuted: !!t.origMuted, sfxMuted: !!t.sfxMuted, bgmMuted: !!t.bgmMuted }; }
  if (Array.isArray(j.overlays)) fx.overlays = j.overlays.filter(o => o && o.e > o.s && (o.type === 'text' || o.dataUrl)).map(o => ({ id: o.id || String(Math.random()).slice(2), type: o.type, s: +o.s, e: +o.e, layer: Math.max(0, Math.round(+o.layer || 0)), pos: o.pos || 'tr', x: o.x == null ? undefined : +o.x, y: o.y == null ? undefined : +o.y, w: +o.w || 0.25, opacity: o.opacity ?? 1, fade: +o.fade || 0, text: o.text || '', style: o.type === 'text' ? { ...SUB_PRESETS.outline, ...(o.style || {}) } : undefined, ratio: +o.ratio || 1, name: o.name || '', dataUrl: o.dataUrl, bitmap: null }));
  if (Array.isArray(j.sfx)) fx.sfx = j.sfx.filter(s => s && isFinite(+s.t) && s.kind && s.kind !== 'custom').map(s => ({ id: s.id || String(Math.random()).slice(2), t: +s.t, kind: s.kind, volume: s.volume ?? 0.8, name: s.name || '' }));
  return fx;
}
