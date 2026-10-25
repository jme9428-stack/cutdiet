// AI 자막·NG tab: extracts 16 kHz mono audio, runs Whisper in a Web Worker, builds SRT and removal candidates.
import { wordsFromChunks, dropSilentWords, buildCaptionLines, buildSRT, findFillers, findRepeats, mergeSpans, resampleInto } from './textlogic.js';

const TARGET_SR = 16000;

export function initTranscribe(api) {
  const { state, toast, saveFile, copyText, outTime, fmtClock, baseName, seek, markSpans, heavyReason, escapeHtml } = api;
  const $ = id => document.getElementById(id);
  const el = { chip: $('aiChip'), model: $('aiModel'), gpu: $('aiGpu'), run: $('btnAiRun'), cancel: $('btnAiCancel'), progress: $('aiProgress'), status: $('aiStatus'), srtOut: $('btnSrtOut'), srtSrc: $('btnSrtSrc'), txtCopy: $('btnTxtCopy'), text: $('aiText'), candChip: $('aiCandChip'), apply: $('btnAiApply'), checkAll: $('btnAiCheckAll'), uncheckAll: $('btnAiUncheckAll'), candBody: $('aiCandBody') };
  const ai = { worker: null, running: false, words: [], lines: [], cands: [], forFile: null, wordLevel: true };
  const gpuOk = !!navigator.gpu; if (!gpuOk) { el.gpu.disabled = true; el.gpu.parentElement.title = '이 브라우저는 WebGPU를 지원하지 않습니다'; }
  try { const m = localStorage.getItem('cutdiet:aiModel'); if (m) el.model.value = m; } catch {}
  el.model.addEventListener('change', () => { try { localStorage.setItem('cutdiet:aiModel', el.model.value); } catch {} });

  const setProgress = (frac, text) => { el.progress.hidden = false; el.progress.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; if (text != null) el.status.textContent = text; };
  const fmtMB = b => (b / 1e6).toFixed(0) + 'MB';

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
    if (state.duration > 1800 && !confirmLong()) return;
    ai.running = true; el.run.disabled = true; el.cancel.hidden = false; el.text.value = ''; el.candBody.innerHTML = '';
    setProgress(0, '오디오를 추출하는 중…');
    const t0 = performance.now();
    try {
      const audio = await extractAudio(p => setProgress(p * 0.1, `오디오 추출 ${Math.round(p * 100)}%`));
      if (!ai.running) throw new Error('canceled');
      const device = (el.gpu.checked && gpuOk) ? 'webgpu' : 'wasm'; const model = el.model.value;
      const result = await new Promise((resolve, reject) => {
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
      const raw = wordsFromChunks(result.chunks, state.duration); ai.words = dropSilentWords(raw, state.env, api.HOP, state.params.threshold - 6); ai.wordLevel = result.wordLevel !== false; ai.forFile = state.file ? state.file.name + ':' + state.file.size : null;
      const dropped = raw.length - ai.words.length;
      if (!ai.words.length && result.text) ai.words = [{ text: result.text.trim(), s: 0, e: state.duration }];
      ai.lines = buildCaptionLines(ai.words);
      ai.cands = ai.wordLevel ? [...findFillers(ai.words), ...findRepeats(ai.words)].sort((a, b) => a.s - b.s) : findRepeats(ai.words);
      renderResults();
      const took = (performance.now() - t0) / 1000;
      setProgress(1, `완료 · ${ai.lines.length}줄 · ${fmtClock(took, false)} 걸림${dropped ? ` · 무음 구간의 환청 ${dropped}단어 제거` : ''}${ai.wordLevel ? '' : ' · 이 모델은 단어 단위 시간을 주지 않아 추임새 감지는 건너뜀'}`);
      toast(`자막 완료 · 삭제 후보 ${ai.cands.length}개`, 3000);
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
  el.cancel.addEventListener('click', () => { ai.running = false; stopWorker(); el.status.textContent = '중단했습니다'; el.progress.hidden = true; el.run.disabled = false; el.cancel.hidden = true; });

  function renderResults() {
    el.text.readOnly = false; el.text.placeholder = '자막을 만들면 여기에 표시됩니다. 줄을 직접 고칠 수 있습니다 (시간은 그대로, 글자만).';
    el.text.value = ai.lines.map(l => `[${fmtClock(l.s)}] ${l.text}`).join('\n');
    const has = ai.lines.length > 0; el.srtOut.disabled = el.srtSrc.disabled = el.txtCopy.disabled = !has;
    renderCands();
  }
  function renderCands() {
    el.candChip.textContent = `${ai.cands.length}개`;
    if (!ai.cands.length) { el.candBody.innerHTML = `<tr><td colspan="5" class="muted">${ai.lines.length ? '추임새나 반복 구간을 찾지 못했습니다.' : '자막을 만들면 후보가 여기에 표시됩니다.'}</td></tr>`; el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = true; return; }
    el.candBody.innerHTML = ai.cands.map((c, i) => `<tr data-i="${i}"><td><input type="checkbox" id="aiCand${i}" ${c.confident ? 'checked' : ''} aria-label="선택"></td><td>${c.kind === 'filler' ? '<span class="chip">추임새</span>' : `<span class="chip warn">반복·NG${c.sim ? ` ${Math.round(c.sim * 100)}%` : ''}</span>`}</td><td class="mono"><button class="link mono" data-act="seek">${fmtClock(c.s)}</button></td><td style="white-space:normal;min-width:200px">${escapeHtml(c.text)}${c.pair ? `<div class="hint">→ 다시 한 말: ${escapeHtml(c.pair)}</div>` : ''}</td><td class="mono">${(c.e - c.s).toFixed(1)}s</td></tr>`).join('');
    el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = false;
  }
  el.candBody.addEventListener('click', e => { const b = e.target.closest('button[data-act="seek"]'); const tr = e.target.closest('tr[data-i]'); if (b && tr) seek(ai.cands[Number(tr.dataset.i)].s); });
  el.checkAll.addEventListener('click', () => el.candBody.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = true; }));
  el.uncheckAll.addEventListener('click', () => el.candBody.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = false; }));
  el.apply.addEventListener('click', () => {
    const picked = []; el.candBody.querySelectorAll('tr[data-i]').forEach(tr => { if (tr.querySelector('input').checked) picked.push(ai.cands[Number(tr.dataset.i)]); });
    if (!picked.length) { toast('체크한 항목이 없습니다'); return; }
    const spans = mergeSpans(picked, 0.04); markSpans(spans, false);
    ai.cands = ai.cands.filter(c => !picked.includes(c)); renderCands();
    toast(`${picked.length}개 구간을 삭제 표시했습니다 (Ctrl+Z로 되돌리기)`, 3000);
  });

  function staleWarn() { const key = state.file ? state.file.name + ':' + state.file.size : null; if (ai.forFile && key && ai.forFile !== key) toast('이 자막은 다른 영상에서 만든 것입니다', 3000); }
  el.srtOut.addEventListener('click', async () => { staleWarn(); const srt = buildSRT(ai.lines, t => outTime(state.segments, t)); if (!srt.trim()) { toast('편집 후 남는 자막이 없습니다'); return; } await saveFile(`${baseName(state.file ? state.file.name : 'video')}_cut.srt`, srt); });
  el.srtSrc.addEventListener('click', async () => { staleWarn(); await saveFile(`${baseName(state.file ? state.file.name : 'video')}_original.srt`, buildSRT(ai.lines)); });
  el.txtCopy.addEventListener('click', () => copyText(ai.lines.map(l => l.text).join('\n')));
  // manual corrections: keep timings, take the words
  el.text.addEventListener('change', () => {
    const rows = el.text.value.split('\n').map(s => s.trim()).filter(Boolean);
    const parsed = rows.map(r => { const m = r.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/); return m ? { s: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() } : { s: null, text: r }; });
    if (parsed.length === ai.lines.length) ai.lines = ai.lines.map((l, i) => ({ ...l, text: parsed[i].text || l.text }));
    else { const next = []; for (let i = 0; i < parsed.length; i++) { const p = parsed[i]; const s = p.s != null ? p.s : (next.length ? next[next.length - 1].e : 0); const nextS = parsed[i + 1] && parsed[i + 1].s != null ? parsed[i + 1].s : s + 3; next.push({ s, e: Math.max(s + 0.3, nextS), text: p.text }); } ai.lines = next.filter(l => l.text); }
    toast('자막을 반영했습니다', 1200);
  });

  // reset when a new file is opened
  let lastKey = null;
  setInterval(() => { const key = state.file ? state.file.name + ':' + state.file.size : null; if (key !== lastKey) { lastKey = key; if (ai.running) { ai.running = false; stopWorker(); el.run.disabled = false; el.cancel.hidden = true; } ai.words = []; ai.lines = []; ai.cands = []; el.text.value = ''; el.progress.hidden = true; el.status.textContent = state.hasMedia ? '준비됨. "자막 만들기"를 누르세요.' : '영상을 불러온 뒤 실행하세요.'; renderResults(); } }, 500);
  return { getLines: () => ai.lines };
}
