// Right-hand inspector (like CapCut's property panel): edits the clip selected on the timeline or the preview —
// a caption, a text or image overlay, a sound effect or the music. With nothing selected it shows the project summary.
import { FONT_CATALOG, fontInfo, SUB_PRESETS } from './fxlogic.js';
import { ensureFont } from './decorate.js';

export function initInspector(api) {
  const { state, fmtClock, escapeHtml } = api; const $ = id => document.getElementById(id);
  const box = $('insClip'), proj = $('insProject'); let shown = null;
  const parseClock = v => { const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : NaN; };
  const alive = c => c && c.ref && (c.kind === 'cap' ? (api.captionsOf() || []).includes(c.ref) : c.kind === 'ov' ? state.fx.overlays.includes(c.ref) : c.kind === 'sfx' ? state.fx.sfx.includes(c.ref) : c.kind === 'bgm' ? !!state.bgm.ready : false);
  const span = c => c.kind === 'sfx' ? { s: c.ref.t, e: null } : c.kind === 'bgm' ? { s: c.ref.start || 0, e: null } : { s: c.ref.s, e: c.ref.e };
  const fontOpts = sel => FONT_CATALOG.map(f => `<option value="${f.f}"${f.f === sel ? ' selected' : ''}>${f.k}</option>`).join('');
  const times = c => { const t = span(c); return `<div class="times"><label>시작</label><input data-f="s" value="${fmtClock(t.s)}" aria-label="시작">${t.e != null ? `<label>끝</label><input data-f="e" value="${fmtClock(t.e)}" aria-label="끝">` : '<span></span><span></span>'}</div>`; };
  const acts = (c, extra = '') => `<div class="acts">${c.kind === 'cap' || c.kind === 'ov' ? '<button class="btn sm" data-a="split" title="재생 위치에서 둘로 (Ctrl+B)">✂ 재생 위치에서 나누기</button>' : ''}<button class="btn sm" data-a="play" title="이 클립부터 재생">▶</button>${extra}${c.kind !== 'bgm' ? '<button class="btn sm ghost" data-a="del" title="Delete">삭제</button>' : ''}<button class="btn sm ghost" data-a="close">선택 해제</button></div>`;
  function template(c) {
    const r = c.ref;
    if (c.kind === 'cap') return `<div class="ins"><div class="kind">자막</div><textarea data-f="text" aria-label="자막 글자">${escapeHtml(r.text)}</textarea>${times(c)}${acts(c)}<p class="hint">글꼴·색·위치는 모든 자막에 같이 적용됩니다.</p><button class="btn sm" data-a="style">자막 스타일 열기</button></div>`;
    if (c.kind === 'ov' && r.type === 'text') { const st = r.style || SUB_PRESETS.outline; return `<div class="ins"><div class="kind">텍스트 · 레이어 ${(r.layer || 0) + 1}</div><textarea data-f="text" aria-label="텍스트">${escapeHtml(r.text)}</textarea><div class="field"><label>글꼴</label><select data-f="font">${fontOpts(st.font)}</select></div><div class="field"><label>글자색</label><input type="color" data-f="color" value="${st.color || '#ffffff'}"></div><div class="field"><span class="pair grow"><label>크기</label><input type="range" data-f="w" min="15" max="300" step="1" value="${Math.round((r.w || 0.06) * 1000)}"></span></div><div class="field"><span class="pair grow"><label>불투명</label><input type="range" data-f="opacity" min="10" max="100" step="5" value="${Math.round((r.opacity ?? 1) * 100)}"></span></div>${times(c)}${acts(c)}</div>`; }
    if (c.kind === 'ov') return `<div class="ins"><div class="kind">이미지 · 레이어 ${(r.layer || 0) + 1}</div><p class="hint">${escapeHtml(r.name || '')}</p><div class="field"><span class="pair grow"><label>크기</label><input type="range" data-f="iw" min="3" max="100" step="1" value="${Math.round((r.w || 0.25) * 100)}"></span></div><div class="field"><span class="pair grow"><label>불투명</label><input type="range" data-f="opacity" min="10" max="100" step="5" value="${Math.round((r.opacity ?? 1) * 100)}"></span></div>${times(c)}${acts(c)}</div>`;
    if (c.kind === 'sfx') return `<div class="ins"><div class="kind">효과음</div><p>${escapeHtml(r.name || r.kind)}</p><div class="field"><span class="pair grow"><label>음량</label><input type="range" data-f="volume" min="10" max="100" step="5" value="${Math.round((r.volume ?? 0.8) * 100)}"></span></div>${times(c)}${acts(c)}</div>`;
    return `<div class="ins"><div class="kind">배경음악</div><p>${escapeHtml(r.name || '')}</p>${times(c)}<p class="hint">시작 위치는 타임라인에서 끌어 옮길 수도 있습니다. 음량·덕킹은 오디오 탭에서.</p>${acts(c, '<button class="btn sm" data-a="audio">오디오 탭</button>')}</div>`;
  }
  function refreshTimes(c) {
    const t = span(c);
    for (const inp of box.querySelectorAll('input[data-f="s"],input[data-f="e"]')) if (document.activeElement !== inp) inp.value = fmtClock(inp.dataset.f === 's' ? t.s : t.e);
  }
  function render(force) {
    const c = state.selClip;
    if (!alive(c)) { if (!box.hidden || shown) { box.hidden = true; box.innerHTML = ''; proj.hidden = false; shown = null; } return; }
    if (shown === c.ref && !force) { refreshTimes(c); return; }
    shown = c.ref; proj.hidden = true; box.hidden = false; box.innerHTML = template(c);
  }
  box.addEventListener('input', e => {
    const c = state.selClip; if (!alive(c)) return; const el = e.target; const f = el.dataset.f; const r = c.ref; if (!f || f === 's' || f === 'e') return;
    if (f === 'text') { r.text = el.value; if (c.kind === 'cap') r.edited = true; else r.name = el.value.slice(0, 20); ensureFont(c.kind === 'cap' ? state.fx.subs.style.font : (r.style && r.style.font), el.value); }
    else if (f === 'font') { r.style = { ...(r.style || SUB_PRESETS.outline), font: el.value }; const info = fontInfo(el.value); if (info) r.style.weight = info.w; ensureFont(el.value, r.text).then(() => api.changed(c)); }
    else if (f === 'color') r.style = { ...(r.style || SUB_PRESETS.outline), color: el.value };
    else if (f === 'w') r.w = Number(el.value) / 1000;
    else if (f === 'iw') r.w = Number(el.value) / 100;
    else if (f === 'opacity') r.opacity = Number(el.value) / 100;
    else if (f === 'volume') r.volume = Number(el.value) / 100;
    api.changed(c, f === 'text');
  });
  box.addEventListener('change', e => {
    const c = state.selClip; if (!alive(c)) return; const el = e.target; const f = el.dataset.f; if (f !== 's' && f !== 'e') return;
    const v = parseClock(el.value); const r = c.ref; if (!isFinite(v)) { render(true); api.toast('시간은 분:초 형식으로 (예: 1:23.5)'); return; }
    const t = Math.max(0, Math.min(state.duration || v, v));
    if (c.kind === 'sfx') r.t = t; else if (c.kind === 'bgm') r.start = t;
    else if (f === 's') { r.s = Math.min(t, r.e - 0.1); if (c.kind === 'cap') r.edited = true; } else { r.e = Math.max(t, r.s + 0.1); if (c.kind === 'cap') r.edited = true; }
    api.changed(c); render(true);
  });
  box.addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return; const c = state.selClip; const a = b.dataset.a;
    if (a === 'close') { api.select(null); return; }
    if (!alive(c)) return;
    if (a === 'split') api.split();
    else if (a === 'del') api.del();
    else if (a === 'play') { api.seek(span(c).s + 0.01); api.play(); }
    else if (a === 'style') { api.showTab('ai'); const el = $('subPreset'); if (el) el.scrollIntoView({ block: 'center' }); }
    else if (a === 'audio') api.showTab('bgm');
  });
  return { render };
}
