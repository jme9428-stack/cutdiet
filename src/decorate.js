// 꾸미기 layer: subtitle burn-in styles, zoom/fade/dissolve, color adjust, sound effects, image/text overlays.
// The same compositor draws the live preview (over the <video>) and the rendered frames.
// On the preview, captions and overlays can be dragged, resized (corner handle) and edited in place (double-click).
import { SUB_PRESETS, FONT_CATALOG, fontInfo, CAPTION_ANIMS, SFX_KINDS, POS_LABELS, liveFx, freeLayer, fxActive, zoomAt, zoomSourceRect, fadeAlpha, dissolveAlpha, activeOverlays, overlayAlpha, overlayBox, textLines, LINE_FIT, captionAnim, customXY, adjustFilter, adjustActive, synthSfx, hexA } from './fxlogic.js';

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
export function fontSpec(style, px) { return `${style.weight || 700} ${px}px "${style.font || 'Noto Sans KR'}", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`; }

// Returns the caption block's box {x, y, w, h} in canvas pixels (used for hit-testing on the preview).
export function drawCaption(ctx, text, style, W, H, animT = Infinity) {
  let fontPx = Math.max(10, Math.round(H * (style.size || 0.055))); ctx.font = fontSpec(style, fontPx); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = textLines(text); fontPx = fitFont(ctx, lines, style, fontPx, W); const lh = fontPx * 1.3; const total = lh * lines.length;
  const c = customXY(style);
  const cx = c ? c.x * W : W / 2;
  const cy = c ? c.y * H : style.pos === 'top' ? H * 0.08 + total / 2 : style.pos === 'center' ? H / 2 : H * 0.93 - total / 2;
  const tw = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
  const box = { x: cx - tw / 2 - fontPx * 0.4, y: cy - total / 2, w: tw + fontPx * 0.8, h: total };
  const an = captionAnim(style.anim, animT); if (an.alpha <= 0) return box;
  ctx.save(); ctx.globalAlpha *= an.alpha; ctx.translate(cx, cy + an.dy * fontPx); if (an.scale !== 1) ctx.scale(an.scale, an.scale);
  lines.forEach((ln, i) => {
    const y = -total / 2 + lh / 2 + i * lh, x = 0;
    if (style.box) { const w = ctx.measureText(ln).width; ctx.fillStyle = hexA(style.boxColor, style.boxAlpha ?? 0.6); roundRect(ctx, x - w / 2 - fontPx * 0.4, y - lh / 2, w + fontPx * 0.8, lh, fontPx * 0.18); ctx.fill(); }
    if (style.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = fontPx * 0.18; ctx.shadowOffsetY = fontPx * 0.05; }
    if ((style.strokeW || 0) > 0 && style.stroke) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = fontPx * style.strokeW; ctx.strokeStyle = style.stroke; ctx.strokeText(ln, x, y); }
    ctx.fillStyle = style.color || '#fff'; ctx.fillText(ln, x, y);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  });
  ctx.restore();
  return box;
}
// One line per typed line: shrink the font until the widest line fits the frame (no automatic wrapping)
function fitFont(ctx, lines, style, px, W) {
  const tw = Math.max(1, ...lines.map(l => ctx.measureText(l).width)); if (tw <= W * LINE_FIT) return px;
  const fp = Math.max(8, Math.floor(px * (W * LINE_FIT) / tw)); ctx.font = fontSpec(style, fp); return fp;
}
function drawTextOverlay(ctx, o, W, H, alpha) {
  let px = Math.max(10, Math.round(H * (o.w || 0.06))); const st = o.style || SUB_PRESETS.outline; ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = fontSpec(st, px); ctx.textBaseline = 'middle'; const lines = textLines(o.text); px = fitFont(ctx, lines, st, px, W); const lh = px * 1.3; const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
  const pos = o.pos || 'mc'; const m = Math.round(W * 0.03); const bw = tw + px * 0.8, bh = lh * lines.length;
  let x, y;
  if (pos === 'custom' && isFinite(o.x) && isFinite(o.y)) { x = o.x * W - bw / 2; y = o.y * H - bh / 2; }
  else { x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - bw - m : (W - bw) / 2; y = pos[0] === 't' ? m : pos[0] === 'b' ? H - bh - m : (H - bh) / 2; }
  if (st.box) { ctx.fillStyle = hexA(st.boxColor, st.boxAlpha ?? 0.6); roundRect(ctx, x, y, bw, bh, px * 0.18); ctx.fill(); }
  ctx.textAlign = 'center';
  lines.forEach((ln, i) => { const cx = x + bw / 2, cy = y + lh / 2 + i * lh; if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = px * 0.18; } if ((st.strokeW || 0) > 0 && st.stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = px * st.strokeW; ctx.strokeStyle = st.stroke; ctx.strokeText(ln, cx, cy); } ctx.fillStyle = st.color || '#fff'; ctx.fillText(ln, cx, cy); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; });
  ctx.restore();
  return { x, y, w: bw, h: bh };
}

// drawSource(ctx, sx, sy, sw, sh, dx, dy, dw, dh) paints the raw frame; everything else is layered here.
// After each draw, comp.boxes lists what was drawn on top: [{kind: 'ov', o, x, y, w, h}, {kind: 'cap', line, x, y, w, h}]
export function makeCompositor({ W, H, crop, fx, captions, ranges, total }) {
  let prev = null, prevCtx = null; let lineIdx = 0;
  const findCaption = srcT => { if (!captions || !captions.length) return null; if (lineIdx >= captions.length || captions[lineIdx].s > srcT) lineIdx = 0; while (lineIdx < captions.length && captions[lineIdx].e <= srcT) lineIdx++; const l = captions[lineIdx]; return l && srcT >= l.s && srcT < l.e ? l : null; };
  const filter = adjustFilter(fx.adjust);
  const comp = {
    boxes: [],
    draw(ctx, drawSource, srcT, outT, rangeIndex, rangeStartOut) {
      const boxes = [];
      const z = zoomAt(fx, srcT, ranges); const r = zoomSourceRect(crop, z.scale, z.ax, z.ay);
      if (filter !== 'none') ctx.filter = filter;
      drawSource(ctx, r.left, r.top, r.width, r.height, 0, 0, W, H);
      if (filter !== 'none') ctx.filter = 'none';
      const da = dissolveAlpha(fx.transition, outT, rangeStartOut, rangeIndex);
      if (da > 0 && prev) { ctx.save(); ctx.globalAlpha = da; ctx.drawImage(prev, 0, 0, W, H); ctx.restore(); }
      for (const o of activeOverlays(fx.overlays, srcT)) {
        const a = overlayAlpha(o, srcT); if (a <= 0) continue;
        if (o.type === 'image' && o.bitmap) { const b = overlayBox(o, W, H); ctx.save(); ctx.globalAlpha = a; ctx.drawImage(o.bitmap, b.x, b.y, b.w, b.h); ctx.restore(); boxes.push({ kind: 'ov', o, ...b }); }
        else if (o.type === 'text' && o.text) boxes.push({ kind: 'ov', o, ...drawTextOverlay(ctx, o, W, H, a) });
      }
      if (fx.subs.burn && captions) { const l = findCaption(srcT); if (l) boxes.push({ kind: 'cap', line: l, ...drawCaption(ctx, l.text, fx.subs.style, W, H, srcT - l.s) }); }
      const fa = fadeAlpha(fx.fade, outT, total); if (fa > 0) { ctx.save(); ctx.globalAlpha = fa; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      comp.boxes = boxes;
    },
    endRange(canvas) { if (fx.transition && fx.transition.type === 'dissolve') { if (!prev) { prev = new OffscreenCanvas(W, H); prevCtx = prev.getContext('2d'); } prevCtx.drawImage(canvas, 0, 0, W, H); } },
  };
  return comp;
}

// ---- fonts: Google Fonts CSS or jsDelivr webfonts, loaded only when a font is used ----
const fontLoads = new Map();
export function ensureFont(family, sample = '가나다ABC') {
  if (!family || typeof document === 'undefined') return Promise.resolve();
  const info = fontInfo(family); const w = info ? info.w : 700;
  let base = fontLoads.get(family);
  if (!base) {
    if (info && info.g) {
      base = new Promise(res => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${w}&display=swap`; l.onload = l.onerror = () => res(); document.head.appendChild(l); });
    } else if (info && info.url) {
      base = (async () => { try { const ff = new FontFace(family, `url(${info.url})`, { weight: String(w), display: 'swap' }); document.fonts.add(ff); await ff.load(); } catch {} })();
    } else base = Promise.resolve();
    fontLoads.set(family, base);
  }
  // Korean Google Fonts are split into many unicode-range files: ask for the exact text so every glyph is ready before drawing
  return base.then(() => document.fonts.load(`${w} 40px "${family}"`, sample || '가').catch(() => {}));
}
export async function preloadFonts(fx, texts = []) {
  const sample = [...new Set(texts.join('').replace(/\s+/g, ''))].join('').slice(0, 4000) || '가나다ABC';
  const fonts = new Map(); fonts.set(fx.subs.style.font, sample);
  for (const o of fx.overlays) if (o.type === 'text' && o.style) fonts.set(o.style.font, (fonts.get(o.style.font) || '') + (o.text || ''));
  try { await Promise.all([...fonts].filter(([f]) => f).map(([f, s]) => ensureFont(f, s))); } catch {}
}
const fontOptions = (selected, extra = []) => {
  const cats = [...new Set(FONT_CATALOG.map(f => f.cat))];
  return cats.map(c => `<optgroup label="${c}">${FONT_CATALOG.filter(f => f.cat === c).map(f => `<option value="${f.f}"${f.f === selected ? ' selected' : ''}>${f.k}</option>`).join('')}</optgroup>`).join('')
    + (extra.length ? `<optgroup label="내 글꼴">${extra.map(f => `<option value="${f}"${f === selected ? ' selected' : ''}>${f}</option>`).join('')}</optgroup>` : '');
};

// ===================== UI =====================
export function initDecorate(api) {
  const { state, els, toast, fmtClock, seek, captionsOf } = api; const fx = () => state.fx;
  const $ = id => document.getElementById(id);
  const sfxCache = new Map(); // key: kind|sr -> {data, sr}
  const customSfx = new Map(); // id -> {data, sr}
  const userFonts = [];
  const getSfxBuf = (s, sr = 48000) => { if (s.kind === 'custom') return customSfx.get(s.id) || null; const key = s.kind + '|' + sr; if (!sfxCache.has(key)) sfxCache.set(key, { data: synthSfx(s.kind, sr), sr }); return sfxCache.get(key); };
  let audioCtx = null; const ac = () => { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); return audioCtx; };
  function playSfx(s) { try { const c = ac(); const b = getSfxBuf(s, c.sampleRate); if (!b) return; const ab = c.createBuffer(1, b.data.length, b.sr); ab.copyToChannel(b.data, 0); const src = c.createBufferSource(); src.buffer = ab; const g = c.createGain(); g.gain.value = s.volume ?? 0.8; src.connect(g).connect(c.destination); src.start(); } catch {} }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const curRange = () => { const i = api.segIndexAt(state.segments, state.cur); const g = state.segments[i]; return g ? { s: g.s, e: g.e } : { s: 0, e: state.duration }; };
  const refresh = () => { api.refreshAll(); renderLists(); };
  const redraw = () => previewTick(false);

  // ---- subtitle style ----
  const subEls = { preset: $('subPreset'), burn: $('subBurn'), font: $('subFont'), fontFile: $('subFontFile'), fontPick: $('btnFontPick'), size: $('subSize'), sizeVal: $('subSizeVal'), color: $('subColor'), stroke: $('subStroke'), strokeW: $('subStrokeW'), box: $('subBox'), boxColor: $('subBoxColor'), pos: $('subPos'), anim: $('subAnim'), shadow: $('subShadow'), sample: $('subSample'), note: $('subNote') };
  subEls.preset.innerHTML = Object.entries(SUB_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('') + '<option value="custom" disabled>직접 꾸밈 (위에서 고른 스타일을 바꿈)</option>';
  subEls.anim.innerHTML = Object.entries(CAPTION_ANIMS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const fillFontSelects = () => { subEls.font.innerHTML = fontOptions(fx().subs.style.font, userFonts); ovEls.font.innerHTML = '<option value="">스타일 기본 글꼴</option>' + fontOptions(ovEls.font.value, userFonts); };
  // show each font name in its own face once the list is opened (loads only the few glyphs of the names)
  let fontPreviewed = false;
  const previewFontNames = () => { if (fontPreviewed) return; fontPreviewed = true; for (const sel of [subEls.font, ovEls.font]) for (const opt of sel.querySelectorAll('option[value]')) { if (!opt.value) continue; const f = opt.value; ensureFont(f, opt.textContent).then(() => { opt.style.fontFamily = `"${f}", sans-serif`; }); } };
  function styleToUI() { const s = fx().subs.style; subEls.preset.value = fx().subs.preset; subEls.burn.checked = fx().subs.burn; if (![...subEls.font.options].some(o => o.value === s.font)) fillFontSelects(); subEls.font.value = s.font; subEls.size.value = Math.round(s.size * 1000); subEls.sizeVal.textContent = `${(s.size * 100).toFixed(1)}%`; subEls.color.value = s.color; subEls.stroke.value = s.stroke || '#000000'; subEls.strokeW.value = Math.round((s.strokeW || 0) * 100); subEls.box.checked = !!s.box; subEls.boxColor.value = s.boxColor || '#000000'; subEls.pos.value = customXY(s) ? 'custom' : (s.pos === 'custom' ? 'bottom' : s.pos); subEls.anim.value = s.anim || 'none'; subEls.shadow.checked = !!s.shadow; }
  function uiToStyle(changed) {
    const s = fx().subs.style;
    if (changed === 'font') { s.font = subEls.font.value; const info = fontInfo(s.font); if (info) s.weight = info.w; }
    s.size = Number(subEls.size.value) / 1000; s.color = subEls.color.value; s.stroke = subEls.stroke.value; s.strokeW = Number(subEls.strokeW.value) / 100; s.box = subEls.box.checked; s.boxColor = subEls.boxColor.value; s.shadow = subEls.shadow.checked; s.anim = subEls.anim.value;
    if (subEls.pos.value !== 'custom') s.pos = subEls.pos.value; else if (!customXY({ ...s, pos: 'custom' })) { s.x = 0.5; s.y = 0.85; s.pos = 'custom'; } else s.pos = 'custom';
    fx().subs.burn = subEls.burn.checked; fx().subs.preset = 'custom'; subEls.sizeVal.textContent = `${(s.size * 100).toFixed(1)}%`;
    ensureFont(s.font).then(redraw); api.autosave(); redraw();
  }
  subEls.preset.addEventListener('change', () => { const p = SUB_PRESETS[subEls.preset.value]; if (!p) return; const old = fx().subs.style; fx().subs.preset = subEls.preset.value; fx().subs.style = { ...p, anim: p.anim || old.anim || 'none', ...(customXY(old) && p.pos !== 'center' ? { pos: 'custom', x: old.x, y: old.y } : {}) }; styleToUI(); ensureFont(p.font).then(redraw); api.autosave(); });
  ['font', 'size', 'color', 'stroke', 'strokeW', 'box', 'boxColor', 'pos', 'anim', 'shadow', 'burn'].forEach(k => subEls[k].addEventListener('input', () => { if (k === 'burn') { fx().subs.burn = subEls.burn.checked; api.autosave(); redraw(); } else uiToStyle(k); if (k === 'burn' && subEls.burn.checked && !(captionsOf() || []).length) subEls.note.textContent = '아직 자막이 없습니다. 왼쪽 자막에서 자막을 만들거나 SRT를 불러오면 영상에 구워집니다.'; else subEls.note.textContent = ''; }));
  for (const sel of [subEls.font]) { sel.addEventListener('pointerdown', previewFontNames); sel.addEventListener('focus', previewFontNames); }
  // the user's own font file (this session only; not stored in the project)
  subEls.fontPick.addEventListener('click', () => subEls.fontFile.click());
  subEls.fontFile.addEventListener('change', async () => {
    const f = subEls.fontFile.files && subEls.fontFile.files[0]; subEls.fontFile.value = ''; if (!f) return;
    try {
      const name = f.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/["\\]/g, '').slice(0, 40) || '내 글꼴';
      const face = new FontFace(name, await f.arrayBuffer(), { weight: '100 900' }); await face.load(); document.fonts.add(face);
      if (!userFonts.includes(name)) userFonts.push(name); const s = fx().subs.style; s.font = name; s.weight = 700; fillFontSelects(); styleToUI(); api.autosave(); redraw();
      toast(`"${name}" 글꼴을 자막에 적용했습니다 (이번 작업 동안만 유지 · Pro 엔진 렌더에서는 기본 글꼴로 대체)`, 4500);
    } catch { toast('글꼴 파일을 읽지 못했습니다 (TTF·OTF·WOFF)'); }
  });

  // ---- effects: zoom / fade / dissolve / color ----
  const fxEls = { autoZoom: $('fxAutoZoom'), autoScale: $('fxAutoScale'), autoScaleVal: $('fxAutoScaleVal'), zScale: $('fxZoomScale'), zScaleVal: $('fxZoomScaleVal'), zAnchor: $('fxZoomAnchor'), zEase: $('fxZoomEase'), zAdd: $('btnZoomAdd'), zList: $('zoomList'), fadeIn: $('fxFadeIn'), fadeOut: $('fxFadeOut'), trans: $('fxTransition'), transDur: $('fxTransDur'), bright: $('fxBright'), contrast: $('fxContrast'), sat: $('fxSat'), adjVal: $('fxAdjustVal'), adjReset: $('btnAdjustReset') };
  fxEls.zAnchor.innerHTML = Object.entries(POS_LABELS).map(([k, v]) => `<option value="${k}"${k === 'mc' ? ' selected' : ''}>${v}</option>`).join('');
  const anchorXY = pos => ({ ax: { l: 0.2, c: 0.5, r: 0.8 }[pos[1]] ?? 0.5, ay: { t: 0.25, m: 0.5, b: 0.75 }[pos[0]] ?? 0.5 });
  const adjLabel = a => adjustActive(a) ? `밝기 ${a.brightness > 0 ? '+' : ''}${a.brightness} · 대비 ${a.contrast > 0 ? '+' : ''}${a.contrast} · 채도 ${a.saturation > 0 ? '+' : ''}${a.saturation}` : '원본 그대로';
  function fxToUI() { const f = fx(); fxEls.autoZoom.checked = f.autoZoom.on; fxEls.autoScale.value = Math.round(f.autoZoom.scale * 100); fxEls.autoScaleVal.textContent = `${f.autoZoom.scale.toFixed(2)}×`; fxEls.fadeIn.value = f.fade.in; fxEls.fadeOut.value = f.fade.out; fxEls.trans.value = f.transition.type; fxEls.transDur.value = f.transition.dur; fxEls.zScaleVal.textContent = `${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`; const a = f.adjust || (f.adjust = { brightness: 0, contrast: 0, saturation: 0 }); fxEls.bright.value = a.brightness; fxEls.contrast.value = a.contrast; fxEls.sat.value = a.saturation; fxEls.adjVal.textContent = adjLabel(a); }
  fxEls.autoZoom.addEventListener('change', () => { fx().autoZoom.on = fxEls.autoZoom.checked; refresh(); });
  fxEls.autoScale.addEventListener('input', () => { fx().autoZoom.scale = Number(fxEls.autoScale.value) / 100; fxEls.autoScaleVal.textContent = `${fx().autoZoom.scale.toFixed(2)}×`; api.autosave(); });
  fxEls.zScale.addEventListener('input', () => { fxEls.zScaleVal.textContent = `${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`; });
  fxEls.zAdd.addEventListener('click', () => { if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } const r = curRange(); const { ax, ay } = anchorXY(fxEls.zAnchor.value); fx().zooms = fx().zooms.filter(z => z.e <= r.s || z.s >= r.e); fx().zooms.push({ s: r.s, e: r.e, scale: Number(fxEls.zScale.value) / 100, ax, ay, ease: Number(fxEls.zEase.value) }); fx().zooms.sort((a, b) => a.s - b.s); refresh(); toast(`현재 구간(${fmtClock(r.s)}–${fmtClock(r.e)})에 줌 ${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`, 2200); });
  fxEls.fadeIn.addEventListener('input', () => { fx().fade.in = Number(fxEls.fadeIn.value) || 0; api.autosave(); });
  fxEls.fadeOut.addEventListener('input', () => { fx().fade.out = Number(fxEls.fadeOut.value) || 0; api.autosave(); });
  fxEls.trans.addEventListener('change', () => { fx().transition.type = fxEls.trans.value; api.autosave(); });
  fxEls.transDur.addEventListener('input', () => { fx().transition.dur = Number(fxEls.transDur.value) || 0.3; api.autosave(); });
  const onAdjust = () => { const a = fx().adjust; a.brightness = Number(fxEls.bright.value); a.contrast = Number(fxEls.contrast.value); a.saturation = Number(fxEls.sat.value); fxEls.adjVal.textContent = adjLabel(a); renderLists(); api.autosave(); redraw(); };
  [fxEls.bright, fxEls.contrast, fxEls.sat].forEach(el => { el.addEventListener('input', onAdjust); el.addEventListener('dblclick', () => { el.value = 0; onAdjust(); }); });
  fxEls.adjReset.addEventListener('click', () => { fxEls.bright.value = fxEls.contrast.value = fxEls.sat.value = 0; onAdjust(); });
  fxEls.zList.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (!b) return; const i = Number(b.dataset.i); if (b.dataset.act === 'del') { fx().zooms.splice(i, 1); refresh(); } else if (b.dataset.act === 'seek') seek(fx().zooms[i].s + 0.01); });

  // ---- sound effects ----
  const sfxEls = { kind: $('sfxKind'), vol: $('sfxVol'), volVal: $('sfxVolVal'), add: $('btnSfxAdd'), test: $('btnSfxTest'), file: $('sfxFile'), pick: $('btnSfxPick'), list: $('sfxList') };
  sfxEls.kind.innerHTML = Object.entries(SFX_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sfxEls.vol.addEventListener('input', () => { sfxEls.volVal.textContent = `${sfxEls.vol.value}%`; });
  sfxEls.test.addEventListener('click', () => playSfx({ kind: sfxEls.kind.value, volume: Number(sfxEls.vol.value) / 100 }));
  sfxEls.add.addEventListener('click', () => { if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } const s = { id: uid(), t: state.cur, kind: sfxEls.kind.value, volume: Number(sfxEls.vol.value) / 100, name: SFX_KINDS[sfxEls.kind.value] }; fx().sfx.push(s); fx().sfx.sort((a, b) => a.t - b.t); playSfx(s); refresh(); toast(`${fmtClock(state.cur)}에 효과음 추가`, 1500); });
  sfxEls.pick.addEventListener('click', () => sfxEls.file.click());
  sfxEls.file.addEventListener('change', async () => { const f = sfxEls.file.files && sfxEls.file.files[0]; sfxEls.file.value = ''; if (!f) return; if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } try { const c = ac(); const buf = await c.decodeAudioData(await f.arrayBuffer()); if (buf.duration > 10) { toast('효과음은 10초 이하 파일만 넣을 수 있습니다'); return; } const data = new Float32Array(buf.length); for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) data[i] += d[i] / buf.numberOfChannels; } const s = { id: uid(), t: state.cur, kind: 'custom', volume: Number(sfxEls.vol.value) / 100, name: f.name, file: f }; customSfx.set(s.id, { data, sr: buf.sampleRate }); fx().sfx.push(s); fx().sfx.sort((a, b) => a.t - b.t); playSfx(s); refresh(); toast(`${fmtClock(state.cur)}에 "${f.name}" 추가 (프로젝트 파일에는 저장되지 않음)`, 3000); } catch { toast('이 소리 파일을 읽지 못했습니다'); } });
  sfxEls.list.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (!b) return; const i = Number(b.dataset.i); const s = fx().sfx[i]; if (!s) return; if (b.dataset.act === 'del') { fx().sfx.splice(i, 1); customSfx.delete(s.id); refresh(); } else if (b.dataset.act === 'seek') seek(s.t); else if (b.dataset.act === 'play') playSfx(s); });

  // ---- overlays: image / text ----
  const ovEls = { imgPick: $('btnOvImage'), imgFile: $('ovImageFile'), text: $('ovText'), textAdd: $('btnOvText'), textStyle: $('ovTextStyle'), font: $('ovFont'), pos: $('ovPos'), size: $('ovSize'), sizeVal: $('ovSizeVal'), range: $('ovRange'), fade: $('ovFade'), opacity: $('ovOpacity'), list: $('ovList') };
  ovEls.pos.innerHTML = Object.entries(POS_LABELS).map(([k, v]) => `<option value="${k}"${k === 'tr' ? ' selected' : ''}>${v}</option>`).join('');
  ovEls.textStyle.innerHTML = Object.entries(SUB_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  ovEls.font.addEventListener('pointerdown', previewFontNames); ovEls.font.addEventListener('focus', previewFontNames);
  fillFontSelects();
  ovEls.size.addEventListener('input', () => { ovEls.sizeVal.textContent = `${ovEls.size.value}%`; });
  const rangeFor = () => { const v = ovEls.range.value; if (v === 'all') return { s: 0, e: state.duration }; if (v === 'seg') return curRange(); if (v === '5s') return { s: state.cur, e: Math.min(state.duration, state.cur + 5) }; return { s: state.cur, e: Math.min(state.duration, state.cur + 3) }; };
  function addOverlay(o) { if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } const r = rangeFor(); Object.assign(o, { id: uid(), s: r.s, e: r.e, layer: freeLayer(fx().overlays, r.s, r.e), pos: ovEls.pos.value, opacity: Number(ovEls.opacity.value) / 100, fade: Number(ovEls.fade.value) || 0 }); fx().overlays.push(o); fx().overlays.sort((a, b) => a.s - b.s); select({ kind: 'ov', id: o.id }); refresh(); toast(`${o.type === 'image' ? '이미지' : '텍스트'} 추가 (${fmtClock(r.s)}–${fmtClock(r.e)}) · 화면에서 끌어 옮기고 모서리로 크기 조절`, 2600); }
  ovEls.imgPick.addEventListener('click', () => ovEls.imgFile.click());
  ovEls.imgFile.addEventListener('change', async () => { const f = ovEls.imgFile.files && ovEls.imgFile.files[0]; ovEls.imgFile.value = ''; if (!f) return; try { const bitmap = await createImageBitmap(f); let dataUrl; if (f.size < 1.2e6) dataUrl = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => res(undefined); rd.readAsDataURL(f); }); addOverlay({ type: 'image', bitmap, dataUrl, file: f, ratio: bitmap.width / bitmap.height, w: Number(ovEls.size.value) / 100, name: f.name }); if (!dataUrl) toast('1.2MB가 넘는 이미지는 프로젝트 파일에 저장되지 않습니다 (이번 세션에서는 사용 가능)', 4000); } catch { toast('이미지를 읽지 못했습니다'); } });
  ovEls.textAdd.addEventListener('click', () => { const t = ovEls.text.value.trim(); if (!t) { toast('텍스트를 입력하세요'); ovEls.text.focus(); return; } const style = { ...SUB_PRESETS[ovEls.textStyle.value] }; if (ovEls.font.value) { style.font = ovEls.font.value; const info = fontInfo(style.font); if (info) style.weight = info.w; } ensureFont(style.font, t).then(redraw); addOverlay({ type: 'text', text: t, w: Number(ovEls.size.value) / 100 * 0.3, style, name: t.slice(0, 20) }); ovEls.text.value = ''; });
  ovEls.text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ovEls.textAdd.click(); } });
  ovEls.list.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (!b) return; const i = Number(b.dataset.i); const o = fx().overlays[i]; if (!o) return; if (b.dataset.act === 'del') { fx().overlays.splice(i, 1); if (sel && sel.id === o.id) select(null); const used = [...new Set(fx().overlays.map(x => x.layer || 0))].sort((a, b) => a - b); for (const x of fx().overlays) x.layer = used.indexOf(x.layer || 0); refresh(); } else if (b.dataset.act === 'seek') { seek(o.s + 0.01); select({ kind: 'ov', id: o.id }); } else if (b.dataset.act === 'start') { o.s = Math.min(state.cur, o.e - 0.1); refresh(); } else if (b.dataset.act === 'end') { o.e = Math.max(state.cur, o.s + 0.1); refresh(); } else if (b.dataset.act === 'edit') { const t = prompt('텍스트 수정', o.text); if (t != null && t.trim()) { o.text = t.trim(); o.name = o.text.slice(0, 20); ensureFont(o.style && o.style.font, o.text).then(redraw); refresh(); } } });
  ovEls.list.addEventListener('change', e => { const s = e.target.closest('select[data-i]'); if (!s) return; const o = fx().overlays[Number(s.dataset.i)]; if (!o) return; if (s.value === 'custom') { if (!isFinite(o.x)) { o.x = 0.5; o.y = 0.5; } } o.pos = s.value; refresh(); });

  function renderLists() {
    const f = fx();
    fxEls.zList.innerHTML = f.zooms.map((z, i) => `<li><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(z.s)}–${fmtClock(z.e)}</button> ${z.scale.toFixed(2)}× ${z.ease ? `· 부드럽게 ${z.ease}s` : ''} <button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">구간 줌 없음</li>';
    sfxEls.list.innerHTML = f.sfx.map((s, i) => `<li><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(s.t)}</button> ${api.escapeHtml(s.name || s.kind)} · ${Math.round((s.volume ?? 0.8) * 100)}% <button class="btn sm ghost" data-act="play" data-i="${i}" title="듣기">▶</button><button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">효과음 없음</li>';
    const posOpts = o => Object.entries({ ...POS_LABELS, custom: '직접 배치(끌기)' }).map(([k, v]) => `<option value="${k}"${k === o.pos ? ' selected' : ''}>${v}</option>`).join('');
    ovEls.list.innerHTML = f.overlays.map((o, i) => `<li${sel && sel.id === o.id ? ' class="on"' : ''}><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(o.s)}–${fmtClock(o.e)}</button> ${o.type === 'image' ? '🖼' : 'T'} ${api.escapeHtml(o.name || '')} <select data-i="${i}" aria-label="위치">${posOpts(o)}</select> ${o.type === 'text' ? `<button class="btn sm ghost" data-act="edit" data-i="${i}" title="글자 수정 (미리보기에서 더블클릭해도 됩니다)">✎</button>` : ''}<button class="btn sm ghost" data-act="start" data-i="${i}" title="시작을 현재 위치로">시작=현재</button><button class="btn sm ghost" data-act="end" data-i="${i}" title="끝을 현재 위치로">끝=현재</button><button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">이미지·텍스트 없음</li>';
    $('fxSummary').textContent = fxActive(f, (captionsOf() || []).length > 0) ? `적용 중: ${[f.subs.burn ? '자막 굽기' : '', f.autoZoom.on ? '자동 줌' : '', f.zooms.length ? `구간 줌 ${f.zooms.length}` : '', f.fade.in || f.fade.out ? '페이드' : '', f.transition.type === 'dissolve' ? '디졸브' : '', adjustActive(f.adjust) ? '색 보정' : '', f.overlays.length ? `오버레이 ${f.overlays.length}` : '', f.sfx.length ? `효과음 ${f.sfx.length}` : ''].filter(Boolean).join(' · ')} · 미리보기에서 자막·텍스트·이미지를 끌어 옮길 수 있습니다` : '적용된 효과 없음. 아래에서 추가하면 미리보기와 MP4에 바로 반영됩니다.';
  }

  // ---- live preview over the <video> ----
  const cv = $('fxCanvas'); const cctx = cv.getContext('2d'); let lastSfxCur = -1; let lastComp = null; let view = null; // view: canvas px <-> CSS px
  const SAMPLE = [{ s: 0, e: Infinity, text: '자막 미리보기 · 끌어서 옮기세요' }];
  function previewTick(playing) {
    const f = liveFx(fx()); const caps = captionsOf() || []; const showSample = subEls.sample.checked && !$('tab-ai').hidden;
    const active = state.hasMedia && state.videoPlayable && (fxActive(f, caps.length > 0) || showSample || f.sfx.length);
    if (!active) { if (!cv.hidden) { cv.hidden = true; lastComp = null; layoutSel(); } return; }
    const M = els.monitor.getBoundingClientRect(); const sw = state.width || els.video.videoWidth, sh = state.height || els.video.videoHeight; if (!sw || !sh) { cv.hidden = true; return; }
    const a = sw / sh; let cw = M.width, ch = cw / a; if (ch > M.height) { ch = M.height; cw = ch * a; }
    const scale = Math.min(1, 960 / cw); const W = Math.round(cw * scale), H = Math.round(ch * scale);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const left = (M.width - cw) / 2, top = (M.height - ch) / 2;
    Object.assign(cv.style, { left: left + 'px', top: top + 'px', width: cw + 'px', height: ch + 'px' }); cv.hidden = false;
    view = { W, H, left, top, k: cw / W };
    const ranges = api.keepRanges(state.segments); const total = api.keptDuration(state.segments); const outT = api.outTime(state.segments, state.cur);
    const ri = Math.max(0, ranges.findIndex(r => state.cur >= r.s && state.cur < r.e)); const rangeStartOut = ranges.slice(0, ri).reduce((t, r) => t + r.e - r.s, 0);
    const useSample = showSample && !(f.subs.burn && caps.length);
    const crop = { left: 0, top: 0, width: sw, height: sh };
    const comp = makeCompositor({ W, H, crop, fx: useSample ? { ...f, subs: { ...f.subs, burn: true } } : f, captions: useSample ? SAMPLE : (f.subs.burn ? caps : null), ranges, total });
    comp.draw(cctx, (c, sx, sy, sW, sH, dx, dy, dW, dH) => { try { c.drawImage(els.video, sx, sy, sW, sH, dx, dy, dW, dH); } catch {} }, state.cur, outT, ri, rangeStartOut);
    lastComp = comp; layoutSel();
    if (playing && f.sfx.length) { for (const s of f.sfx) if (s.t > lastSfxCur && s.t <= state.cur && state.cur - s.t < 0.5) playSfx(s); }
    lastSfxCur = playing ? state.cur : -1;
  }
  subEls.sample.addEventListener('change', redraw);

  // ---- direct manipulation on the preview: select, drag, resize, double-click to edit ----
  const mk = (cls, parent = els.monitor) => { const d = document.createElement('div'); d.className = cls; d.hidden = true; parent.appendChild(d); return d; };
  const selBox = mk('fx-sel'); const handle = document.createElement('i'); handle.className = 'fx-handle'; handle.title = '끌어서 크기 조절'; selBox.appendChild(handle);
  const guideV = mk('fx-guide v'), guideH = mk('fx-guide h');
  let sel = null; // {kind: 'cap'} | {kind: 'ov', id}
  let drag = null;
  const boxOf = s => { if (!s || !lastComp) return null; return lastComp.boxes.find(b => s.kind === 'cap' ? b.kind === 'cap' : (b.kind === 'ov' && b.o.id === s.id)) || null; };
  function select(s, fromTimeline) { sel = s; layoutSel(); if (ovEls.list) renderLists(); if (!fromTimeline && api.selectionChanged) api.selectionChanged(s && s.kind === 'ov' ? { kind: 'ov', ref: ovById(s.id) } : s && s.kind === 'cap' && s.line && s.line !== SAMPLE[0] ? { kind: 'cap', ref: s.line } : null); }
  function layoutSel() {
    const b = boxOf(sel); if (!b || !view || cv.hidden) { selBox.hidden = true; return; }
    const pad = 4; Object.assign(selBox.style, { left: (view.left + b.x * view.k - pad) + 'px', top: (view.top + b.y * view.k - pad) + 'px', width: (b.w * view.k + pad * 2) + 'px', height: (b.h * view.k + pad * 2) + 'px' }); selBox.hidden = false;
  }
  const toCanvas = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; };
  const hit = p => { if (!lastComp) return null; const bs = lastComp.boxes; for (let i = bs.length - 1; i >= 0; i--) { const b = bs[i]; const m = 6; if (p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m) return b; } return null; };
  const targetOf = b => b.kind === 'cap' ? { kind: 'cap', line: b.line } : { kind: 'ov', id: b.o.id };
  const ovById = id => fx().overlays.find(o => o.id === id);
  function startDrag(e, b, mode) {
    e.preventDefault(); e.stopPropagation(); cv.setPointerCapture(e.pointerId);
    const p = toCanvas(e); const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const o = b.kind === 'ov' ? b.o : null; const st = fx().subs.style;
    drag = { mode, kind: b.kind, o, p0: p, c0: { x: cx, y: cy }, d0: Math.max(8, Math.hypot(p.x - cx, p.y - cy)), size0: o ? o.w : st.size, moved: false };
  }
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !view) return;
    const p = toCanvas(e); const b = hit(p);
    if (!b) { if (sel) select(null); return; }
    select(targetOf(b)); startDrag(e, b, 'move');
  });
  handle.addEventListener('pointerdown', e => { const b = boxOf(sel); if (!b || e.button !== 0) return; handle.setPointerCapture(e.pointerId); startDrag(e, b, 'resize'); drag.viaHandle = true; });
  const onMove = e => {
    if (!drag) { if (view && !cv.hidden) { const b = hit(toCanvas(e)); cv.style.cursor = b ? 'move' : ''; } return; }
    const p = toCanvas(e); const { W, H } = view; drag.moved = true;
    if (drag.mode === 'move') {
      let x = (drag.c0.x + p.x - drag.p0.x) / W, y = (drag.c0.y + p.y - drag.p0.y) / H;
      const snapX = Math.abs(x - 0.5) < 0.015, snapY = Math.abs(y - 0.5) < 0.015; if (snapX) x = 0.5; if (snapY) y = 0.5;
      x = Math.max(0.02, Math.min(0.98, x)); y = Math.max(0.02, Math.min(0.98, y));
      guideV.hidden = !snapX; guideH.hidden = !snapY;
      if (snapX) Object.assign(guideV.style, { left: (view.left + view.W * view.k / 2) + 'px', top: view.top + 'px', height: (view.H * view.k) + 'px' });
      if (snapY) Object.assign(guideH.style, { top: (view.top + view.H * view.k / 2) + 'px', left: view.left + 'px', width: (view.W * view.k) + 'px' });
      const t = drag.kind === 'cap' ? fx().subs.style : drag.o; t.pos = 'custom'; t.x = Math.round(x * 1000) / 1000; t.y = Math.round(y * 1000) / 1000;
    } else {
      const k = Math.max(0.2, Math.hypot(p.x - drag.c0.x, p.y - drag.c0.y) / drag.d0);
      if (drag.kind === 'cap') fx().subs.style.size = Math.max(0.025, Math.min(0.15, drag.size0 * k));
      else if (drag.o.type === 'image') drag.o.w = Math.max(0.03, Math.min(1, drag.size0 * k));
      else drag.o.w = Math.max(0.015, Math.min(0.3, drag.size0 * k));
    }
    redraw();
  };
  const onUp = () => {
    if (!drag) return; const d = drag; drag = null; guideV.hidden = guideH.hidden = true;
    if (d.moved) { if (d.kind === 'cap') { fx().subs.preset = 'custom'; styleToUI(); } renderLists(); api.autosave(); api.refreshAll(); }
  };
  for (const el of [cv, handle]) { el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp); }
  cv.addEventListener('pointerleave', () => { if (!drag) cv.style.cursor = ''; });
  // double-click: edit the text in place
  let editor = null;
  cv.addEventListener('dblclick', e => {
    const b = hit(toCanvas(e)); if (!b || !view) return; e.preventDefault();
    if (b.kind === 'cap' && (!b.line || b.line === SAMPLE[0])) { toast('샘플 자막입니다. 왼쪽 자막에서 자막을 만들거나 SRT를 불러오세요'); return; }
    if (editor) editor.remove();
    const ta = document.createElement('textarea'); ta.className = 'fx-edit'; ta.value = b.kind === 'cap' ? b.line.text : b.o.text; editor = ta;
    Object.assign(ta.style, { left: (view.left + b.x * view.k) + 'px', top: (view.top + b.y * view.k) + 'px', width: Math.max(160, b.w * view.k) + 'px', height: Math.max(40, b.h * view.k + 8) + 'px' });
    els.monitor.appendChild(ta); ta.focus(); ta.select();
    const wasPlaying = !els.video.paused; if (wasPlaying) els.video.pause();
    let done = false;
    const finish = ok => {
      if (done) return; done = true; const v = ta.value.replace(/\s*\n\s*/g, ' ').trim(); ta.remove(); if (editor === ta) editor = null;
      if (!ok || !v) return;
      if (b.kind === 'cap') { b.line.text = v; b.line.edited = true; if (api.captionsChanged) api.captionsChanged(); }
      else { b.o.text = v; b.o.name = v.slice(0, 20); renderLists(); }
      ensureFont(b.kind === 'cap' ? fx().subs.style.font : (b.o.style && b.o.style.font), v).then(redraw); api.autosave(); redraw();
    };
    ta.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } });
    ta.addEventListener('blur', () => finish(true));
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && sel && !editor) select(null); });

  // restore image bitmaps after a project load
  async function rehydrate() { for (const o of fx().overlays) if (o.type === 'image' && !o.bitmap && o.dataUrl) { try { const blob = await (await fetch(o.dataUrl)).blob(); o.bitmap = await createImageBitmap(blob); } catch {} } styleToUI(); fxToUI(); renderLists(); preloadFonts(fx(), (captionsOf() || []).map(l => l.text)).then(redraw); }
  styleToUI(); fxToUI(); renderLists(); ensureFont(fx().subs.style.font);
  return { previewTick, getSfxBuf, renderLists, rehydrate, syncUI: () => { styleToUI(); fxToUI(); renderLists(); }, selectOverlay: id => select(id ? { kind: 'ov', id } : null, true) };
}
