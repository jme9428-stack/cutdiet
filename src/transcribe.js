// AI 자막·NG tab: extracts 16 kHz mono audio, runs Whisper in a Web Worker, builds SRT and removal candidates.
// Captions can be corrected line by line afterwards (text, timing, split/merge/delete), imported from SRT, and find/replaced.
import { wordsFromChunks, dropSilentWords, buildCaptionLines, buildSRT, findFillers, findStutters, findMumbles, findRepeats, stripFromLines, parseSRT, mergeSpans, resampleInto } from './textlogic.js';

const TARGET_SR = 16000;
const KIND_CHIP = { filler: '<span class="chip">추임새</span>', stutter: '<span class="chip warn">버벅임</span>', mumble: '<span class="chip">웅얼거림</span>' };

export function initTranscribe(api) {
  const { state, toast, saveFile, copyText, outTime, fmtClock, baseName, seek, markSpans, heavyReason, escapeHtml } = api;
  const $ = id => document.getElementById(id);
  const el = { chip: $('aiChip'), model: $('aiModel'), gpu: $('aiGpu'), run: $('btnAiRun'), cancel: $('btnAiCancel'), progress: $('aiProgress'), status: $('aiStatus'), srtOut: $('btnSrtOut'), srtSrc: $('btnSrtSrc'), txtCopy: $('btnTxtCopy'), text: $('aiText'), candChip: $('aiCandChip'), apply: $('btnAiApply'), checkAll: $('btnAiCheckAll'), uncheckAll: $('btnAiUncheckAll'), candBody: $('aiCandBody'),
    optFiller: $('aiOptFiller'), optStutter: $('aiOptStutter'), optRepeat: $('aiOptRepeat'), optMumble: $('aiOptMumble'), optStrip: $('aiOptStrip'),
    capList: $('capList'), capChip: $('capChip'), capAdd: $('btnCapAdd'), capImport: $('btnCapImport'), capFile: $('capFile'), capFind: $('capFind'), capRepl: $('capReplace'), capReplBtn: $('btnCapReplace'), capFollow: $('capFollow') };
  const ai = { worker: null, running: false, words: [], lines: [], cands: [], forFile: null, wordLevel: true };
  const gpuOk = !!navigator.gpu; if (!gpuOk) { el.gpu.disabled = true; el.gpu.parentElement.title = '이 브라우저는 WebGPU를 지원하지 않습니다'; }
  try { const m = localStorage.getItem('cutdiet:aiModel'); if (m) el.model.value = m; } catch {}
  el.model.addEventListener('change', () => { try { localStorage.setItem('cutdiet:aiModel', el.model.value); } catch {} });
  // which removal candidates to look for (remembered per browser)
  const OPT_KEY = 'cutdiet:aiOpts'; const optEls = { filler: el.optFiller, stutter: el.optStutter, repeat: el.optRepeat, mumble: el.optMumble, strip: el.optStrip };
  try { const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); for (const [k, v] of Object.entries(o)) if (optEls[k] && typeof v === 'boolean') optEls[k].checked = v; } catch {}
  for (const [k, c] of Object.entries(optEls)) c.addEventListener('change', () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(Object.fromEntries(Object.entries(optEls).map(([a, b]) => [a, b.checked])))); } catch {} if (k !== 'strip' && ai.words.length) { computeCands(); renderCands(); } });

  const setProgress = (frac, text) => { el.progress.hidden = false; el.progress.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; if (text != null) el.status.textContent = text; };
  const fmtMB = b => (b / 1e6).toFixed(0) + 'MB';
  const fileKey = () => state.file ? state.file.name + ':' + state.file.size : (state.engineMedia ? 'engine:' + (state.engineMedia.path || state.engineMedia.name || '') : null);
  const changed = () => { if (api.autosave) api.autosave(); if (api.captionsChanged) api.captionsChanged(); };

  async function extractAudio(onProgress) {
    const dur = state.duration; const target = new Float32Array(Math.ceil((dur + 1) * TARGET_SR));
    let filled = 0;
    if (state.mb && state.aTrack) {
      const sink = new state.mb.AudioBufferSink(state.aTrack); let lastUi = 0;
      for await (const wb of sink.buffers(0, dur)) {
        if (!ai.running) throw new Error('canceled');
        const b = wb.buffer; const chans = []; for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
        filled = Math.max(filled, resampleInto(target, TARGET_SR, chans, b.sampleRate, wb.timestamp));
        if (wb.timestamp - lastUi > 3) { lastUi = wb.timestamp; onProgress(wb.timestamp / dur); await new Promise(r => setTimeout(r, 0)); }
      }
    } else {
      if (!state.file) throw new Error('nofile');
      const ab = await state.file.arrayBuffer(); const ctx = new OfflineAudioContext(1, 1, TARGET_SR); const buf = await ctx.decodeAudioData(ab);
      const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      filled = resampleInto(target, TARGET_SR, chans, buf.sampleRate, 0);
    }
    return target.subarray(0, Math.max(1, filled));
  }

  function stopWorker() { if (ai.worker) { ai.worker.terminate(); ai.worker = null; } }

  async function run() {
    if (!state.hasMedia) { toast('먼저 영상을 불러오세요'); return; }
    if (ai.running) return;
    const heavy = heavyReason(); if (heavy) { toast('1시간이 넘는 영상은 자막 생성을 지원하지 않습니다. 30분 이하로 나눠서 올려 주세요', 4500); return; }
    if (ai.lines.some(l => l.edited) && !confirm('직접 고친 자막이 있습니다. 새로 만들면 지금 자막을 덮어씁니다. 계속할까요?')) return;
    if (state.duration > 1800 && !confirmLong()) return;
    ai.running = true; el.run.disabled = true; el.cancel.hidden = false; el.text.value = ''; el.candBody.innerHTML = ''; el.text.closest('details').open = true;
    setProgress(0, '오디오를 추출하는 중…');
    const t0 = performance.now(); ai.abort = new AbortController();
    try {
      const useEngine = !!(state.engineMedia && state.hooks.transcribe);
      const audio = useEngine ? null : await extractAudio(p => setProgress(p * 0.1, `오디오 추출 ${Math.round(p * 100)}%`));
      if (!ai.running) throw new Error('canceled');
      const device = (el.gpu.checked && gpuOk) ? 'webgpu' : 'wasm'; const model = el.model.value;
      const result = useEngine ? await state.hooks.transcribe({ model, signal: ai.abort.signal, onProgress: (frac, text) => setProgress(frac, text) }) : await new Promise((resolve, reject) => {
        stopWorker();
        const w = new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' }); ai.worker = w;
        w.onmessage = e => {
          const m = e.data;
          if (m.type === 'progress') {
            if (m.phase === 'download') setProgress(0.1 + m.pct * 0.25, `모델 내려받는 중 ${Math.round(m.pct * 100)}%${m.total ? ` (${fmtMB(m.loaded)} / ${fmtMB(m.total)}) · 처음 한 번만` : ''}`);
            else if (m.phase === 'load') setProgress(0.1, '모델을 준비하는 중… (처음이면 내려받기에 1~3분)');
            else if (m.phase === 'ready') setProgress(0.35, '모델 준비 완료. 인식 시작…');
            else if (m.phase === 'transcribe') { const el2 = (performance.now() - t0) / 1000; const eta = m.pct > 0.03 ? (el2 / m.pct - el2) : null; setProgress(0.35 + m.pct * 0.65, `음성 인식 ${Math.round(m.pct * 100)}% · 경과 ${fmtClock(el2, false)}${eta != null ? ` · 남은 시간 약 ${fmtClock(eta, false)}` : ''}${m.note === 'segment' ? ' · 문장 단위로 재시도' : ''}`); }
          } else if (m.type === 'partial') { el.text.value = m.text; el.text.scrollTop = el.text.scrollHeight; }
          else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        w.onerror = ev => reject(new Error(ev.message || '워커 오류'));
        w.postMessage({ type: 'run', audio, model, device, language: 'korean', duration: state.duration }, [audio.buffer]);
      });
      if (!ai.running) throw new Error('canceled');
      const raw = wordsFromChunks(result.chunks, state.duration); ai.words = dropSilentWords(raw, state.env, api.HOP, state.params.threshold - 6); ai.wordLevel = result.wordLevel !== false; ai.forFile = fileKey();
      const dropped = raw.length - ai.words.length;
      if (!ai.words.length && result.text) ai.words = [{ text: result.text.trim(), s: 0, e: state.duration }];
      ai.lines = buildCaptionLines(ai.words);
      computeCands();
      renderResults(); el.text.closest('details').open = false; changed();
      const took = (performance.now() - t0) / 1000;
      setProgress(1, `완료 · ${ai.lines.length}줄 · ${fmtClock(took, false)} 걸림${dropped ? ` · 무음 구간의 환청 ${dropped}단어 제거` : ''}${ai.wordLevel ? '' : ' · 이 모델은 단어 단위 시간을 주지 않아 추임새·버벅임 감지는 건너뜀'}`);
      toast(`자막 완료 · 삭제 후보 ${ai.cands.length}개 · 아래 자막 편집에서 바로 고칠 수 있습니다`, 3500);
    } catch (e) {
      if (/canceled/.test(String(e.message))) { el.status.textContent = '중단했습니다'; }
      else { console.error(e); el.status.textContent = '실패: ' + humanError(e.message); }
      el.progress.hidden = true;
    } finally { ai.running = false; el.run.disabled = false; el.cancel.hidden = true; stopWorker(); }
  }
  function confirmLong() { toast('30분이 넘는 영상은 인식에 30분 이상 걸릴 수 있습니다. 진행합니다', 4000); return true; }
  function humanError(msg) {
    msg = String(msg || '');
    if (/fetch|network|Failed to|404|load/i.test(msg)) return '모델 파일을 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요. (' + msg.slice(0, 80) + ')';
    if (/memory|allocat|out of/i.test(msg)) return '메모리가 부족합니다. "빠름" 모델로 바꾸거나 다른 탭을 닫고 다시 시도하세요.';
    if (/webgpu|gpu|adapter/i.test(msg)) return 'GPU 가속을 쓸 수 없습니다. GPU 가속 체크를 끄고 다시 시도하세요.';
    return msg.slice(0, 160);
  }
  el.run.addEventListener('click', run);
  el.cancel.addEventListener('click', () => { ai.running = false; stopWorker(); if (ai.abort) ai.abort.abort(); el.status.textContent = '중단했습니다'; el.progress.hidden = true; el.run.disabled = false; el.cancel.hidden = true; });

  // ---- removal candidates (each kind can be turned off) ----
  function computeCands() {
    const w = ai.words; const list = [];
    if (ai.wordLevel) {
      if (el.optFiller.checked) list.push(...findFillers(w));
      if (el.optStutter.checked) list.push(...findStutters(w));
      if (el.optMumble.checked) list.push(...findMumbles(w, state.env, api.HOP, state.params.threshold));
    }
    if (el.optRepeat.checked) list.push(...findRepeats(w));
    list.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
    // the same words can be both a filler and a stutter ("어 어"): keep the first one found for a span
    ai.cands = list.filter((c, i) => !list.some((d, j) => j < i && d.kind !== 'repeat' && c.kind !== 'repeat' && d.s <= c.s + 0.01 && d.e >= c.e - 0.01));
  }
  function renderResults() {
    el.text.readOnly = false; el.text.placeholder = '자막을 만들면 여기에 표시됩니다. 줄을 직접 고칠 수 있습니다 (시간은 그대로, 글자만).';
    el.text.value = ai.lines.map(l => `[${fmtClock(l.s)}] ${l.text}`).join('\n');
    const has = ai.lines.length > 0; el.srtOut.disabled = el.srtSrc.disabled = el.txtCopy.disabled = !has;
    renderCands(); renderEditor();
  }
  function renderCands() {
    el.candChip.textContent = `${ai.cands.length}개`;
    if (!ai.cands.length) { el.candBody.innerHTML = `<tr><td colspan="5" class="muted">${ai.lines.length ? (ai.words.length ? '선택한 종류의 삭제 후보를 찾지 못했습니다.' : 'SRT로 불러온 자막은 단어 시간이 없어 후보를 찾지 않습니다. 자막 만들기를 실행하세요.') : '자막을 만들면 후보가 여기에 표시됩니다.'}</td></tr>`; el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = true; return; }
    el.candBody.innerHTML = ai.cands.map((c, i) => `<tr data-i="${i}"><td><input type="checkbox" id="aiCand${i}" ${c.confident ? 'checked' : ''} aria-label="선택"></td><td>${KIND_CHIP[c.kind] || `<span class="chip warn">반복·NG${c.sim ? ` ${Math.round(c.sim * 100)}%` : ''}</span>`}</td><td class="mono"><button class="link mono" data-act="seek">${fmtClock(c.s)}</button></td><td style="white-space:normal;min-width:200px">${escapeHtml(c.text)}${c.pair ? `<div class="hint">→ ${c.kind === 'repeat' ? '다시 한 말' : '이어진 말'}: ${escapeHtml(c.pair)}</div>` : ''}</td><td class="mono">${(c.e - c.s).toFixed(1)}s</td></tr>`).join('');
    el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = false;
  }
  el.candBody.addEventListener('click', e => { const b = e.target.closest('button[data-act="seek"]'); const tr = e.target.closest('tr[data-i]'); if (b && tr) seek(Math.max(0, ai.cands[Number(tr.dataset.i)].s - 0.4)); });
  el.checkAll.addEventListener('click', () => el.candBody.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = true; }));
  el.uncheckAll.addEventListener('click', () => el.candBody.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = false; }));
  el.apply.addEventListener('click', () => {
    const picked = []; el.candBody.querySelectorAll('tr[data-i]').forEach(tr => { if (tr.querySelector('input').checked) picked.push(ai.cands[Number(tr.dataset.i)]); });
    if (!picked.length) { toast('체크한 항목이 없습니다'); return; }
    const spans = mergeSpans(picked, 0.04); markSpans(spans, false);
    if (el.optStrip.checked) { ai.lines = stripFromLines(ai.lines, picked); renderEditor(); changed(); }
    ai.cands = ai.cands.filter(c => !picked.includes(c)); renderCands();
    toast(`${picked.length}개 구간을 삭제 표시했습니다 (Ctrl+Z로 되돌리기)`, 3000);
  });

  function staleWarn() { const key = fileKey(); if (ai.forFile && key && ai.forFile !== key) toast('이 자막은 다른 영상에서 만든 것입니다', 3000); }
  el.srtOut.addEventListener('click', async () => { staleWarn(); const srt = buildSRT(ai.lines, t => outTime(state.segments, t)); if (!srt.trim()) { toast('편집 후 남는 자막이 없습니다'); return; } await saveFile(`${baseName(state.file ? state.file.name : 'video')}_cut.srt`, srt); });
  el.srtSrc.addEventListener('click', async () => { staleWarn(); await saveFile(`${baseName(state.file ? state.file.name : 'video')}_original.srt`, buildSRT(ai.lines)); });
  el.txtCopy.addEventListener('click', () => copyText(ai.lines.map(l => l.text).join('\n')));
  // bulk correction in the text box: keep timings, take the words
  el.text.addEventListener('change', () => {
    const rows = el.text.value.split('\n').map(s => s.trim()).filter(Boolean);
    const parsed = rows.map(r => { const m = r.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/); return m ? { s: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() } : { s: null, text: r }; });
    if (parsed.length === ai.lines.length) ai.lines = ai.lines.map((l, i) => (parsed[i].text && parsed[i].text !== l.text ? { ...l, text: parsed[i].text, edited: true } : l));
    else { const next = []; for (let i = 0; i < parsed.length; i++) { const p = parsed[i]; const s = p.s != null ? p.s : (next.length ? next[next.length - 1].e : 0); const nextS = parsed[i + 1] && parsed[i + 1].s != null ? parsed[i + 1].s : s + 3; next.push({ s, e: Math.max(s + 0.3, nextS), text: p.text, edited: true }); } ai.lines = next.filter(l => l.text); }
    renderEditor(); changed(); toast('자막을 반영했습니다', 1200);
  });

  // ---- caption editor: one row per line ----
  const parseClock = v => { v = String(v).trim(); const m = v.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); if (m) return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]); const h = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/); return h ? Number(h[1]) * 3600 + Number(h[2]) * 60 + Number(h[3]) : NaN; };
  const sortLines = () => ai.lines.sort((a, b) => a.s - b.s);
  function renderEditor() {
    const n = ai.lines.length; el.capChip.textContent = `${n}줄`;
    el.srtOut.disabled = el.srtSrc.disabled = el.txtCopy.disabled = !n;
    if (!n) { el.capList.innerHTML = '<p class="muted small" style="padding:10px">자막이 없습니다. ① 자막 만들기를 실행하거나, SRT 파일을 불러오거나, 재생 위치에 직접 추가하세요.</p>'; return; }
    el.capList.innerHTML = ai.lines.map((l, i) => `<div class="caprow" data-i="${i}"><button class="link mono" data-act="seek" title="이 줄로 이동해 재생">▶ ${fmtClock(l.s)}</button><span class="captime"><input class="mono" data-f="s" value="${fmtClock(l.s)}" aria-label="시작 시간" title="시작 (분:초)"><span class="muted">–</span><input class="mono" data-f="e" value="${fmtClock(l.e)}" aria-label="끝 시간" title="끝 (분:초)"></span><input class="captext" data-f="text" value="${escapeHtml(l.text)}" aria-label="자막 ${i + 1}"><span class="capacts"><button class="btn sm ghost" data-act="s-here" title="시작을 현재 재생 위치로">⇤</button><button class="btn sm ghost" data-act="e-here" title="끝을 현재 재생 위치로">⇥</button><button class="btn sm ghost" data-act="split" title="재생 위치(또는 가운데)에서 둘로 나누기">✂</button><button class="btn sm ghost" data-act="merge" title="다음 줄과 합치기"${i === n - 1 ? ' disabled' : ''}>⇣</button><button class="btn sm ghost" data-act="del" title="이 줄 삭제">✕</button></span></div>`).join('');
    lastActive = -1; highlight(true);
  }
  el.capList.addEventListener('input', e => { const inp = e.target.closest('input[data-f="text"]'); if (!inp) return; const l = ai.lines[Number(inp.closest('.caprow').dataset.i)]; if (!l) return; l.text = inp.value; l.edited = true; changed(); });
  el.capList.addEventListener('change', e => {
    const inp = e.target.closest('input[data-f]'); if (!inp) return; const i = Number(inp.closest('.caprow').dataset.i); const l = ai.lines[i]; if (!l) return;
    if (inp.dataset.f === 'text') { if (!inp.value.trim()) { ai.lines.splice(i, 1); renderEditor(); } changed(); return; }
    const v = parseClock(inp.value); if (!isFinite(v)) { inp.value = fmtClock(l[inp.dataset.f]); toast('시간은 분:초 형식으로 입력하세요 (예: 1:23.5)'); return; }
    l[inp.dataset.f] = Math.max(0, Math.min(state.duration || v, v)); if (l.e <= l.s) l.e = l.s + 0.3; l.edited = true; sortLines(); renderEditor(); changed();
  });
  el.capList.addEventListener('keydown', e => {
    const inp = e.target.closest('input[data-f="text"]'); if (!inp || e.key !== 'Enter' || e.isComposing) return; e.preventDefault();
    const rows = [...el.capList.querySelectorAll('input[data-f="text"]')]; const k = rows.indexOf(inp); const next = rows[k + (e.shiftKey ? -1 : 1)];
    if (next) { next.focus(); next.select(); const l = ai.lines[Number(next.closest('.caprow').dataset.i)]; if (l) seek(l.s + 0.01); }
  });
  el.capList.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return; const i = Number(b.closest('.caprow').dataset.i); const l = ai.lines[i]; if (!l) return;
    const act = b.dataset.act;
    if (act === 'seek') { seek(l.s + 0.01); if (api.play) api.play(); return; }
    if (act === 's-here') { l.s = Math.min(state.cur, l.e - 0.1); l.edited = true; sortLines(); }
    else if (act === 'e-here') { l.e = Math.max(state.cur, l.s + 0.1); l.edited = true; }
    else if (act === 'del') ai.lines.splice(i, 1);
    else if (act === 'merge') { const n = ai.lines[i + 1]; if (!n) return; ai.lines.splice(i, 2, { s: l.s, e: Math.max(l.e, n.e), text: `${l.text} ${n.text}`.trim(), edited: true }); }
    else if (act === 'split') {
      const t = state.cur > l.s + 0.15 && state.cur < l.e - 0.15 ? state.cur : (l.s + l.e) / 2; const frac = (t - l.s) / (l.e - l.s);
      const words = l.text.split(/\s+/); let cut = Math.max(1, Math.min(words.length - 1, Math.round(words.length * frac)));
      const a = words.length > 1 ? words.slice(0, cut).join(' ') : l.text.slice(0, Math.max(1, Math.round(l.text.length * frac))); const bTxt = words.length > 1 ? words.slice(cut).join(' ') : l.text.slice(a.length);
      ai.lines.splice(i, 1, { s: l.s, e: t, text: a, edited: true }, { s: t, e: l.e, text: bTxt || '…', edited: true });
    }
    renderEditor(); changed();
  });
  el.capAdd.addEventListener('click', () => {
    if (!state.duration) { toast('먼저 영상을 불러오세요'); return; }
    const t = state.cur; const nextL = ai.lines.find(l => l.s > t + 0.05); const e = Math.min(state.duration, nextL ? Math.max(t + 0.5, Math.min(t + 2.5, nextL.s)) : t + 2.5);
    const inside = ai.lines.find(l => t >= l.s && t < l.e); if (inside) { toast('이 위치에는 이미 자막이 있습니다. 그 줄의 ✂로 나누거나 글자를 고치세요'); focusLine(inside); return; }
    const nl = { s: t, e, text: '새 자막', edited: true }; ai.lines.push(nl); sortLines(); if (!ai.forFile) ai.forFile = fileKey(); renderEditor(); changed(); focusLine(nl, true);
  });
  function focusLine(l, selectAll) { const i = ai.lines.indexOf(l); const inp = el.capList.querySelector(`.caprow[data-i="${i}"] input[data-f="text"]`); if (inp) { inp.focus(); if (selectAll) inp.select(); } }
  el.capImport.addEventListener('click', () => el.capFile.click());
  el.capFile.addEventListener('change', async () => {
    const f = el.capFile.files && el.capFile.files[0]; el.capFile.value = ''; if (!f) return;
    try {
      const lines = parseSRT(await f.text()); if (!lines.length) { toast('자막 줄을 찾지 못했습니다 (SRT·VTT 파일인지 확인하세요)'); return; }
      if (ai.lines.length && !confirm(`지금 자막 ${ai.lines.length}줄을 "${f.name}"(${lines.length}줄)로 바꿀까요?`)) return;
      ai.lines = lines.map(l => ({ ...l, edited: true })); ai.words = []; ai.cands = []; ai.forFile = fileKey(); renderResults(); changed();
      toast(`${lines.length}줄을 불러왔습니다. 원본 영상 시간 기준 SRT여야 맞습니다`, 3500);
    } catch { toast('자막 파일을 읽지 못했습니다'); }
  });
  el.capReplBtn.addEventListener('click', () => {
    const find = el.capFind.value; if (!find) { toast('찾을 말을 입력하세요'); el.capFind.focus(); return; }
    const repl = el.capRepl.value; let n = 0;
    for (const l of ai.lines) { const parts = l.text.split(find); if (parts.length > 1) { n += parts.length - 1; l.text = parts.join(repl).replace(/\s{2,}/g, ' ').trim(); l.edited = true; } }
    ai.lines = ai.lines.filter(l => l.text); renderEditor(); if (n) changed();
    toast(n ? `${n}곳을 바꿨습니다` : `"${find}"을(를) 찾지 못했습니다`);
  });
  el.capFind.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.capRepl.focus(); } });
  el.capRepl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.capReplBtn.click(); } });
  // highlight (and follow) the line under the playhead
  let lastActive = -1;
  function highlight(force) {
    if ($('tab-ai').hidden && !force) return;
    const t = state.cur; let i = ai.lines.findIndex(l => t >= l.s && t < l.e);
    if (i === lastActive && !force) return; lastActive = i;
    el.capList.querySelectorAll('.caprow.on').forEach(r => r.classList.remove('on'));
    if (i < 0) return; const row = el.capList.querySelector(`.caprow[data-i="${i}"]`); if (!row) return; row.classList.add('on');
    const playing = !document.getElementById('video').paused;
    if (el.capFollow.checked && playing && !el.capList.contains(document.activeElement)) { const top = row.offsetTop - el.capList.offsetTop; if (top < el.capList.scrollTop || top > el.capList.scrollTop + el.capList.clientHeight - row.offsetHeight) el.capList.scrollTop = top - el.capList.clientHeight / 3; }
  }
  setInterval(() => highlight(false), 200);

  // reset when a new file is opened (a restored project brings its captions back through setLines)
  let lastKey = null;
  setInterval(() => { const key = fileKey(); if (key !== lastKey) { lastKey = key; if (ai.running) { ai.running = false; stopWorker(); el.run.disabled = false; el.cancel.hidden = true; } ai.words = []; ai.lines = []; ai.cands = []; el.text.value = ''; el.progress.hidden = true; el.status.textContent = state.hasMedia ? '준비됨. "자막 만들기"를 누르세요.' : '영상을 불러온 뒤 실행하세요.'; renderResults(); } }, 500);
  function setLines(lines) {
    lastKey = fileKey(); ai.words = []; ai.cands = []; ai.forFile = lastKey;
    ai.lines = (lines || []).map(l => ({ s: Number(l.s), e: Number(l.e), text: String(l.text || ''), edited: !!l.edited })).filter(l => l.e > l.s && l.text).sort((a, b) => a.s - b.s);
    renderResults(); if (api.captionsChanged) api.captionsChanged();
  }
  renderEditor();
  return { getLines: () => ai.lines, setLines, refresh: renderEditor };
}
