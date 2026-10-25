// 꾸미기 layer: subtitle burn-in styles, zoom/fade/dissolve, sound effects, image/text overlays.
// The same compositor draws the live preview (over the <video>) and the rendered frames.
import { SUB_PRESETS, SUB_FONTS, SFX_KINDS, POS_LABELS, fxActive, zoomAt, zoomSourceRect, fadeAlpha, dissolveAlpha, activeOverlays, overlayAlpha, overlayBox, wrapCaption, captionAt, synthSfx, mixSfxInto, hexA } from './fxlogic.js';

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
export function fontSpec(style, px) { return `${style.weight || 700} ${px}px "${style.font || 'Noto Sans KR'}", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`; }

export function drawCaption(ctx, text, style, W, H) {
  const fontPx = Math.max(10, Math.round(H * (style.size || 0.055))); ctx.font = fontSpec(style, fontPx); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrapCaption(text, Math.max(8, Math.floor((W * 0.9) / (fontPx * 0.98)))); const lh = fontPx * 1.3; const total = lh * lines.length;
  const yBase = style.pos === 'top' ? H * 0.08 + lh / 2 : style.pos === 'center' ? (H - total) / 2 + lh / 2 : H * 0.93 - total + lh / 2;
  lines.forEach((ln, i) => {
    const y = yBase + i * lh, x = W / 2;
    if (style.box) { const tw = ctx.measureText(ln).width; ctx.fillStyle = hexA(style.boxColor, style.boxAlpha ?? 0.6); roundRect(ctx, x - tw / 2 - fontPx * 0.4, y - lh / 2, tw + fontPx * 0.8, lh, fontPx * 0.18); ctx.fill(); }
    if (style.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = fontPx * 0.18; ctx.shadowOffsetY = fontPx * 0.05; }
    if ((style.strokeW || 0) > 0 && style.stroke) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = fontPx * style.strokeW; ctx.strokeStyle = style.stroke; ctx.strokeText(ln, x, y); }
    ctx.fillStyle = style.color || '#fff'; ctx.fillText(ln, x, y);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  });
}
function drawTextOverlay(ctx, o, W, H, alpha) {
  const px = Math.max(10, Math.round(H * (o.w || 0.06))); const st = o.style || SUB_PRESETS.outline; ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = fontSpec(st, px); ctx.textBaseline = 'middle'; const lines = wrapCaption(o.text, Math.max(6, Math.floor((W * 0.9) / (px * 0.98)))); const lh = px * 1.3; const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
  const pos = o.pos || 'mc'; const m = Math.round(W * 0.03); const bw = tw + px * 0.8, bh = lh * lines.length;
  const x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - bw - m : (W - bw) / 2; const y = pos[0] === 't' ? m : pos[0] === 'b' ? H - bh - m : (H - bh) / 2;
  if (st.box) { ctx.fillStyle = hexA(st.boxColor, st.boxAlpha ?? 0.6); roundRect(ctx, x, y, bw, bh, px * 0.18); ctx.fill(); }
  ctx.textAlign = 'center';
  lines.forEach((ln, i) => { const cx = x + bw / 2, cy = y + lh / 2 + i * lh; if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = px * 0.18; } if ((st.strokeW || 0) > 0 && st.stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = px * st.strokeW; ctx.strokeStyle = st.stroke; ctx.strokeText(ln, cx, cy); } ctx.fillStyle = st.color || '#fff'; ctx.fillText(ln, cx, cy); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; });
  ctx.restore();
}

// drawSource(ctx, sx, sy, sw, sh, dx, dy, dw, dh) paints the raw frame; everything else is layered here.
export function makeCompositor({ W, H, crop, fx, captions, ranges, total }) {
  let prev = null, prevCtx = null; let lineIdx = 0;
  const findCaption = srcT => { if (!captions || !captions.length) return null; if (lineIdx >= captions.length || captions[lineIdx].s > srcT) lineIdx = 0; while (lineIdx < captions.length && captions[lineIdx].e <= srcT) lineIdx++; const l = captions[lineIdx]; return l && srcT >= l.s && srcT < l.e ? l : null; };
  return {
    draw(ctx, drawSource, srcT, outT, rangeIndex, rangeStartOut) {
      const z = zoomAt(fx, srcT, ranges); const r = zoomSourceRect(crop, z.scale, z.ax, z.ay);
      drawSource(ctx, r.left, r.top, r.width, r.height, 0, 0, W, H);
      const da = dissolveAlpha(fx.transition, outT, rangeStartOut, rangeIndex);
      if (da > 0 && prev) { ctx.save(); ctx.globalAlpha = da; ctx.drawImage(prev, 0, 0, W, H); ctx.restore(); }
      for (const o of activeOverlays(fx.overlays, srcT)) {
        const a = overlayAlpha(o, srcT); if (a <= 0) continue;
        if (o.type === 'image' && o.bitmap) { const b = overlayBox(o, W, H); ctx.save(); ctx.globalAlpha = a; ctx.drawImage(o.bitmap, b.x, b.y, b.w, b.h); ctx.restore(); }
        else if (o.type === 'text' && o.text) drawTextOverlay(ctx, o, W, H, a);
      }
      if (fx.subs.burn && captions) { const l = findCaption(srcT); if (l) drawCaption(ctx, l.text, fx.subs.style, W, H); }
      const fa = fadeAlpha(fx.fade, outT, total); if (fa > 0) { ctx.save(); ctx.globalAlpha = fa; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    },
    endRange(canvas) { if (fx.transition && fx.transition.type === 'dissolve') { if (!prev) { prev = new OffscreenCanvas(W, H); prevCtx = prev.getContext('2d'); } prevCtx.drawImage(canvas, 0, 0, W, H); } },
  };
}
export async function preloadFonts(fx) {
  const fonts = new Set([fx.subs.style.font]); for (const o of fx.overlays) if (o.type === 'text' && o.style) fonts.add(o.style.font);
  try { await Promise.all([...fonts].filter(Boolean).map(f => document.fonts.load(`700 40px "${f}"`))); } catch {}
}

// ===================== UI =====================
export function initDecorate(api) {
  const { state, els, toast, fmtClock, seek, captionsOf } = api; const fx = () => state.fx;
  const $ = id => document.getElementById(id);
  const sfxCache = new Map(); // key: kind|sr -> {data, sr}
  const customSfx = new Map(); // id -> {data, sr}
  const getSfxBuf = (s, sr = 48000) => { if (s.kind === 'custom') return customSfx.get(s.id) || null; const key = s.kind + '|' + sr; if (!sfxCache.has(key)) sfxCache.set(key, { data: synthSfx(s.kind, sr), sr }); return sfxCache.get(key); };
  let audioCtx = null; const ac = () => { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); return audioCtx; };
  function playSfx(s) { try { const c = ac(); const b = getSfxBuf(s, c.sampleRate); if (!b) return; const ab = c.createBuffer(1, b.data.length, b.sr); ab.copyToChannel(b.data, 0); const src = c.createBufferSource(); src.buffer = ab; const g = c.createGain(); g.gain.value = s.volume ?? 0.8; src.connect(g).connect(c.destination); src.start(); } catch {} }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const curRange = () => { const i = api.segIndexAt(state.segments, state.cur); const g = state.segments[i]; return g ? { s: g.s, e: g.e } : { s: 0, e: state.duration }; };
  const refresh = () => { api.refreshAll(); renderLists(); };

  // ---- subtitle style ----
  const subEls = { preset: $('subPreset'), burn: $('subBurn'), font: $('subFont'), size: $('subSize'), sizeVal: $('subSizeVal'), color: $('subColor'), stroke: $('subStroke'), strokeW: $('subStrokeW'), box: $('subBox'), boxColor: $('subBoxColor'), pos: $('subPos'), shadow: $('subShadow'), sample: $('subSample'), note: $('subNote') };
  subEls.preset.innerHTML = Object.entries(SUB_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  subEls.font.innerHTML = SUB_FONTS.map(f => `<option value="${f}">${f}</option>`).join('');
  function styleToUI() { const s = fx().subs.style; subEls.preset.value = fx().subs.preset; subEls.burn.checked = fx().subs.burn; subEls.font.value = s.font; subEls.size.value = Math.round(s.size * 1000); subEls.sizeVal.textContent = `${(s.size * 100).toFixed(1)}%`; subEls.color.value = s.color; subEls.stroke.value = s.stroke || '#000000'; subEls.strokeW.value = Math.round((s.strokeW || 0) * 100); subEls.box.checked = !!s.box; subEls.boxColor.value = s.boxColor || '#000000'; subEls.pos.value = s.pos; subEls.shadow.checked = !!s.shadow; }
  function uiToStyle() { const s = fx().subs.style; s.font = subEls.font.value; s.size = Number(subEls.size.value) / 1000; s.color = subEls.color.value; s.stroke = subEls.stroke.value; s.strokeW = Number(subEls.strokeW.value) / 100; s.box = subEls.box.checked; s.boxColor = subEls.boxColor.value; s.pos = subEls.pos.value; s.shadow = subEls.shadow.checked; fx().subs.burn = subEls.burn.checked; fx().subs.preset = 'custom'; subEls.sizeVal.textContent = `${(s.size * 100).toFixed(1)}%`; preloadFonts(fx()); api.autosave(); }
  subEls.preset.addEventListener('change', () => { const p = SUB_PRESETS[subEls.preset.value]; if (!p) return; fx().subs.preset = subEls.preset.value; fx().subs.style = { ...p }; styleToUI(); preloadFonts(fx()); api.autosave(); });
  ['font', 'size', 'color', 'stroke', 'strokeW', 'box', 'boxColor', 'pos', 'shadow', 'burn'].forEach(k => subEls[k].addEventListener('input', () => { if (k === 'burn') { fx().subs.burn = subEls.burn.checked; api.autosave(); } else uiToStyle(); if (k === 'burn' && subEls.burn.checked && !(captionsOf() || []).length) subEls.note.textContent = '아직 자막이 없습니다. AI 자막·NG 탭에서 자막을 먼저 만들면 영상에 구워집니다.'; else subEls.note.textContent = ''; }));
  styleToUI();

  // ---- effects: zoom / fade / dissolve ----
  const fxEls = { autoZoom: $('fxAutoZoom'), autoScale: $('fxAutoScale'), autoScaleVal: $('fxAutoScaleVal'), zScale: $('fxZoomScale'), zScaleVal: $('fxZoomScaleVal'), zAnchor: $('fxZoomAnchor'), zEase: $('fxZoomEase'), zAdd: $('btnZoomAdd'), zList: $('zoomList'), fadeIn: $('fxFadeIn'), fadeOut: $('fxFadeOut'), trans: $('fxTransition'), transDur: $('fxTransDur') };
  fxEls.zAnchor.innerHTML = Object.entries(POS_LABELS).map(([k, v]) => `<option value="${k}"${k === 'mc' ? ' selected' : ''}>${v}</option>`).join('');
  const anchorXY = pos => ({ ax: { l: 0.2, c: 0.5, r: 0.8 }[pos[1]] ?? 0.5, ay: { t: 0.25, m: 0.5, b: 0.75 }[pos[0]] ?? 0.5 });
  function fxToUI() { const f = fx(); fxEls.autoZoom.checked = f.autoZoom.on; fxEls.autoScale.value = Math.round(f.autoZoom.scale * 100); fxEls.autoScaleVal.textContent = `${f.autoZoom.scale.toFixed(2)}×`; fxEls.fadeIn.value = f.fade.in; fxEls.fadeOut.value = f.fade.out; fxEls.trans.value = f.transition.type; fxEls.transDur.value = f.transition.dur; fxEls.zScaleVal.textContent = `${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`; }
  fxEls.autoZoom.addEventListener('change', () => { fx().autoZoom.on = fxEls.autoZoom.checked; refresh(); });
  fxEls.autoScale.addEventListener('input', () => { fx().autoZoom.scale = Number(fxEls.autoScale.value) / 100; fxEls.autoScaleVal.textContent = `${fx().autoZoom.scale.toFixed(2)}×`; api.autosave(); });
  fxEls.zScale.addEventListener('input', () => { fxEls.zScaleVal.textContent = `${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`; });
  fxEls.zAdd.addEventListener('click', () => { if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } const r = curRange(); const { ax, ay } = anchorXY(fxEls.zAnchor.value); fx().zooms = fx().zooms.filter(z => z.e <= r.s || z.s >= r.e); fx().zooms.push({ s: r.s, e: r.e, scale: Number(fxEls.zScale.value) / 100, ax, ay, ease: Number(fxEls.zEase.value) }); fx().zooms.sort((a, b) => a.s - b.s); refresh(); toast(`현재 구간(${fmtClock(r.s)}–${fmtClock(r.e)})에 줌 ${(Number(fxEls.zScale.value) / 100).toFixed(2)}×`, 2200); });
  fxEls.fadeIn.addEventListener('input', () => { fx().fade.in = Number(fxEls.fadeIn.value) || 0; api.autosave(); });
  fxEls.fadeOut.addEventListener('input', () => { fx().fade.out = Number(fxEls.fadeOut.value) || 0; api.autosave(); });
  fxEls.trans.addEventListener('change', () => { fx().transition.type = fxEls.trans.value; api.autosave(); });
  fxEls.transDur.addEventListener('input', () => { fx().transition.dur = Number(fxEls.transDur.value) || 0.3; api.autosave(); });
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
  const ovEls = { imgPick: $('btnOvImage'), imgFile: $('ovImageFile'), text: $('ovText'), textAdd: $('btnOvText'), textStyle: $('ovTextStyle'), pos: $('ovPos'), size: $('ovSize'), sizeVal: $('ovSizeVal'), range: $('ovRange'), fade: $('ovFade'), opacity: $('ovOpacity'), list: $('ovList') };
  ovEls.pos.innerHTML = Object.entries(POS_LABELS).map(([k, v]) => `<option value="${k}"${k === 'tr' ? ' selected' : ''}>${v}</option>`).join('');
  ovEls.textStyle.innerHTML = Object.entries(SUB_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  ovEls.size.addEventListener('input', () => { ovEls.sizeVal.textContent = `${ovEls.size.value}%`; });
  const rangeFor = () => { const v = ovEls.range.value; if (v === 'all') return { s: 0, e: state.duration }; if (v === 'seg') return curRange(); if (v === '5s') return { s: state.cur, e: Math.min(state.duration, state.cur + 5) }; return { s: state.cur, e: Math.min(state.duration, state.cur + 3) }; };
  function addOverlay(o) { if (!state.duration) { toast('먼저 영상을 불러오세요'); return; } const r = rangeFor(); Object.assign(o, { id: uid(), s: r.s, e: r.e, pos: ovEls.pos.value, opacity: Number(ovEls.opacity.value) / 100, fade: Number(ovEls.fade.value) || 0 }); fx().overlays.push(o); fx().overlays.sort((a, b) => a.s - b.s); refresh(); toast(`${o.type === 'image' ? '이미지' : '텍스트'} 추가 (${fmtClock(r.s)}–${fmtClock(r.e)})`, 1800); }
  ovEls.imgPick.addEventListener('click', () => ovEls.imgFile.click());
  ovEls.imgFile.addEventListener('change', async () => { const f = ovEls.imgFile.files && ovEls.imgFile.files[0]; ovEls.imgFile.value = ''; if (!f) return; try { const bitmap = await createImageBitmap(f); let dataUrl; if (f.size < 1.2e6) dataUrl = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => res(undefined); rd.readAsDataURL(f); }); addOverlay({ type: 'image', bitmap, dataUrl, file: f, ratio: bitmap.width / bitmap.height, w: Number(ovEls.size.value) / 100, name: f.name }); if (!dataUrl) toast('1.2MB가 넘는 이미지는 프로젝트 파일에 저장되지 않습니다 (이번 세션에서는 사용 가능)', 4000); } catch { toast('이미지를 읽지 못했습니다'); } });
  ovEls.textAdd.addEventListener('click', () => { const t = ovEls.text.value.trim(); if (!t) { toast('텍스트를 입력하세요'); ovEls.text.focus(); return; } addOverlay({ type: 'text', text: t, w: Number(ovEls.size.value) / 100 * 0.3, style: { ...SUB_PRESETS[ovEls.textStyle.value] }, name: t.slice(0, 20) }); ovEls.text.value = ''; });
  ovEls.list.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (!b) return; const i = Number(b.dataset.i); const o = fx().overlays[i]; if (!o) return; if (b.dataset.act === 'del') { fx().overlays.splice(i, 1); refresh(); } else if (b.dataset.act === 'seek') seek(o.s + 0.01); else if (b.dataset.act === 'start') { o.s = Math.min(state.cur, o.e - 0.1); refresh(); } else if (b.dataset.act === 'end') { o.e = Math.max(state.cur, o.s + 0.1); refresh(); } });
  ovEls.list.addEventListener('change', e => { const sel = e.target.closest('select[data-i]'); if (!sel) return; const o = fx().overlays[Number(sel.dataset.i)]; if (o) { o.pos = sel.value; refresh(); } });

  function renderLists() {
    const f = fx();
    fxEls.zList.innerHTML = f.zooms.map((z, i) => `<li><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(z.s)}–${fmtClock(z.e)}</button> ${z.scale.toFixed(2)}× ${z.ease ? `· 부드럽게 ${z.ease}s` : ''} <button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">구간 줌 없음</li>';
    sfxEls.list.innerHTML = f.sfx.map((s, i) => `<li><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(s.t)}</button> ${api.escapeHtml(s.name || s.kind)} · ${Math.round((s.volume ?? 0.8) * 100)}% <button class="btn sm ghost" data-act="play" data-i="${i}" title="듣기">▶</button><button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">효과음 없음</li>';
    ovEls.list.innerHTML = f.overlays.map((o, i) => `<li><button class="link mono" data-act="seek" data-i="${i}">${fmtClock(o.s)}–${fmtClock(o.e)}</button> ${o.type === 'image' ? '🖼' : 'T'} ${api.escapeHtml(o.name || '')} <select data-i="${i}" aria-label="위치">${Object.entries(POS_LABELS).map(([k, v]) => `<option value="${k}"${k === o.pos ? ' selected' : ''}>${v}</option>`).join('')}</select> <button class="btn sm ghost" data-act="start" data-i="${i}" title="시작을 현재 위치로">시작=현재</button><button class="btn sm ghost" data-act="end" data-i="${i}" title="끝을 현재 위치로">끝=현재</button><button class="btn sm ghost" data-act="del" data-i="${i}" title="삭제">✕</button></li>`).join('') || '<li class="muted">이미지·텍스트 없음</li>';
    $('fxSummary').textContent = fxActive(f, (captionsOf() || []).length > 0) ? `적용 중: ${[f.subs.burn ? '자막 굽기' : '', f.autoZoom.on ? '자동 줌' : '', f.zooms.length ? `구간 줌 ${f.zooms.length}` : '', f.fade.in || f.fade.out ? '페이드' : '', f.transition.type === 'dissolve' ? '디졸브' : '', f.overlays.length ? `오버레이 ${f.overlays.length}` : '', f.sfx.length ? `효과음 ${f.sfx.length}` : ''].filter(Boolean).join(' · ')}` : '적용된 효과 없음. 아래에서 추가하면 미리보기와 MP4에 바로 반영됩니다.';
  }

  // ---- live preview over the <video> ----
  const cv = $('fxCanvas'); const cctx = cv.getContext('2d'); let lastSfxCur = -1;
  function previewTick(playing) {
    const f = fx(); const caps = captionsOf() || []; const showSample = subEls.sample.checked && !$('tab-decorate').hidden;
    const active = state.hasMedia && state.videoPlayable && (fxActive(f, caps.length > 0) || showSample || f.sfx.length);
    if (!active) { if (!cv.hidden) cv.hidden = true; return; }
    const M = els.monitor.getBoundingClientRect(); const sw = state.width || els.video.videoWidth, sh = state.height || els.video.videoHeight; if (!sw || !sh) { cv.hidden = true; return; }
    const a = sw / sh; let cw = M.width, ch = cw / a; if (ch > M.height) { ch = M.height; cw = ch * a; }
    const scale = Math.min(1, 960 / cw); const W = Math.round(cw * scale), H = Math.round(ch * scale);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    Object.assign(cv.style, { left: ((M.width - cw) / 2) + 'px', top: ((M.height - ch) / 2) + 'px', width: cw + 'px', height: ch + 'px' }); cv.hidden = false;
    const ranges = api.keepRanges(state.segments); const total = api.keptDuration(state.segments); const outT = api.outTime(state.segments, state.cur);
    const ri = Math.max(0, ranges.findIndex(r => state.cur >= r.s && state.cur < r.e)); const rangeStartOut = ranges.slice(0, ri).reduce((t, r) => t + r.e - r.s, 0);
    const comp = previewComp(W, H, f, showSample ? [{ s: 0, e: Infinity, text: '자막 미리보기 · 이렇게 보입니다' }] : (f.subs.burn ? caps : null), ranges, total);
    comp.draw(cctx, (c, sx, sy, sW, sH, dx, dy, dW, dH) => { try { c.drawImage(els.video, sx, sy, sW, sH, dx, dy, dW, dH); } catch {} }, state.cur, outT, ri, rangeStartOut);
    if (playing && f.sfx.length) { for (const s of f.sfx) if (s.t > lastSfxCur && s.t <= state.cur && state.cur - s.t < 0.5) playSfx(s); }
    lastSfxCur = playing ? state.cur : -1;
  }
  let compCache = null;
  function previewComp(W, H, f, caps, ranges, total) { const crop = { left: 0, top: 0, width: state.width || els.video.videoWidth, height: state.height || els.video.videoHeight }; compCache = makeCompositor({ W, H, crop, fx: f, captions: caps ? caps : null, ranges, total }); if (!caps) compCache = Object.assign(compCache, {}); return compCache; }
  subEls.sample.addEventListener('change', () => previewTick(false));

  // restore image bitmaps after a project load
  async function rehydrate() { for (const o of fx().overlays) if (o.type === 'image' && !o.bitmap && o.dataUrl) { try { const blob = await (await fetch(o.dataUrl)).blob(); o.bitmap = await createImageBitmap(blob); } catch {} } styleToUI(); fxToUI(); renderLists(); preloadFonts(fx()); }
  fxToUI(); renderLists();
  return { previewTick, getSfxBuf, renderLists, rehydrate, syncUI: () => { styleToUI(); fxToUI(); renderLists(); } };
}
