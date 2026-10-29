// AI 자막·NG tab: extracts 16 kHz mono audio, runs Whisper in a Web Worker, builds SRT and removal candidates.
// Captions can be corrected line by line afterwards (text, timing, split/merge/delete), imported from SRT, and find/replaced.
import { planWindows, speechSeconds, dedupeWords } from './asrplan.js';
import { resplitLines, splitLineAt, CAPTION_CHARS } from './textlogic.js';
import { wordsFromChunks, dropSilentWords, buildCaptionLines, buildSRT, findFillers, findStutters, findMumbles, findRepeats, findShortBursts, stripFromLines, parseSRT, mergeSpans, resampleInto } from './textlogic.js';

const TARGET_SR = 16000;
const KIND_CHIP = { filler: '<span class="chip">추임새</span>', stutter: '<span class="chip warn">버벅임</span>', mumble: '<span class="chip">웅얼거림</span>', short: '<span class="chip">짧은 소리</span>' };

export function initTranscribe(api) {
  const { state, toast, saveFile, copyText, outTime, fmtClock, baseName, seek, markSpans, heavyReason, escapeHtml } = api;
  const $ = id => document.getElementById(id);
  const el = { chip: $('aiChip'), model: $('aiModel'), gpu: $('aiGpu'), run: $('btnAiRun'), cancel: $('btnAiCancel'), progress: $('aiProgress'), status: $('aiStatus'), srtOut: $('btnSrtOut'), srtSrc: $('btnSrtSrc'), txtCopy: $('btnTxtCopy'), text: $('aiText'), candChip: $('aiCandChip'), apply: $('btnAiApply'), checkAll: $('btnAiCheckAll'), uncheckAll: $('btnAiUncheckAll'), candBody: $('aiCandBody'), candNote: $('aiCandNote'), rescan: $('btnAiRescan'),
    optFiller: $('aiOptFiller'), optStutter: $('aiOptStutter'), optRepeat: $('aiOptRepeat'), optMumble: $('aiOptMumble'), optStrip: $('aiOptStrip'),
    capList: $('capList'), capChip: $('capChip'), capAdd: $('btnCapAdd'), capImport: $('btnCapImport'), capFile: $('capFile'), capFind: $('capFind'), capRepl: $('capReplace'), capReplBtn: $('btnCapReplace'), capFollow: $('capFollow'), capLen: $('capLen'), capResplit: $('btnCapResplit') };
  const ai = { workers: [], running: false, words: [], lines: [], cands: [], forFile: null, wordLevel: true };
  // GPU is on by default where the browser has WebGPU (several times faster); the worker falls back to the CPU if it fails
  const gpuOk = !!navigator.gpu; if (!gpuOk) { el.gpu.checked = false; el.gpu.disabled = true; el.gpu.parentElement.title = '이 브라우저는 WebGPU를 지원하지 않습니다'; }
  else { try { const g = localStorage.getItem('cutdiet:aiGpu'); el.gpu.checked = g == null ? true : g === '1'; } catch { el.gpu.checked = true; } el.gpu.addEventListener('change', () => { try { localStorage.setItem('cutdiet:aiGpu', el.gpu.checked ? '1' : '0'); } catch {} }); }
  try { const m = localStorage.getItem('cutdiet:aiModel'); if (m && [...el.model.options].some(o => o.value === m)) el.model.value = m; } catch {}
  el.model.addEventListener('change', () => { try { localStorage.setItem('cutdiet:aiModel', el.model.value); } catch {} });
  // which removal candidates to look for (remembered per browser)
  const OPT_KEY = 'cutdiet:aiOpts'; const optEls = { filler: el.optFiller, stutter: el.optStutter, repeat: el.optRepeat, mumble: el.optMumble, strip: el.optStrip };
  try { const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}'); for (const [k, v] of Object.entries(o)) if (optEls[k] && typeof v === 'boolean') optEls[k].checked = v; } catch {}
  for (const [k, c] of Object.entries(optEls)) c.addEventListener('change', () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(Object.fromEntries(Object.entries(optEls).map(([a, b]) => [a, b.checked])))); } catch {} if (k !== 'strip') { computeCands(); renderCands(); } });

  const setProgress = (frac, text) => { el.progress.hidden = false; el.progress.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; if (text != null) el.status.textContent = text; };
  const fmtMB = b => (b / 1e6).toFixed(0) + 'MB';
  const fileKey = () => state.file ? state.file.name + ':' + state.file.size : (state.engineMedia ? 'engine:' + (state.engineMedia.path || state.engineMedia.name || '') : null);
  const changed = () => { if (api.autosave) api.autosave(); if (api.captionsChanged) api.captionsChanged(); };

  async function extractAudio(onProgress, alive = () => ai.running) {
    const dur = state.duration; const target = new Float32Array(Math.ceil((dur + 1) * TARGET_SR));
    let filled = 0;
    if (state.mb && state.aTrack) {
      const sink = new state.mb.AudioBufferSink(state.aTrack); let lastUi = 0;
      for await (const wb of sink.buffers(0, dur)) {
        if (!alive()) throw new Error('canceled');
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

  function stopWorker() { for (const w of ai.workers || []) w.terminate(); ai.workers = []; }

  // How many Whisper workers to run side by side: one Whisper instance doesn't get faster with more CPU threads, but
  // separate windows can be recognized at the same time. Each worker holds its own copy of the model (~0.4 GB),
  // so the count follows the CPU and the memory the browser reports. The GPU path uses one worker.
  function poolSize(nWindows, device, model = '') {
    if (device === 'webgpu') return 1;
    try { const o = Number(localStorage.getItem('cutdiet:aiWorkers')); if (o > 0) return Math.min(o, nWindows); } catch {} // manual override
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
    if (/large|turbo/.test(model)) return Math.max(1, Math.min(nWindows, cores >= 8 && mem >= 8 ? 2 : 1)); // ~1 GB of memory per worker
    return Math.max(1, Math.min(nWindows, Math.floor(cores / 4), mem >= 8 ? 3 : mem >= 4 ? 2 : 1));
  }
  // Hands the planned windows to a small pool of workers, one window at a time. The first worker loads (and on the very
  // first run downloads) the model; the others start once it is in the browser cache, so nothing is fetched twice.
  function transcribePool({ audio, model, device, windows, t0 }) {
    const SR = 16000; const n = windows.length; const queue = windows.map((_, i) => i); const results = new Array(n);
    let done = 0, wordLevel = true, dev = device, tT = 0, finished = false, live = 0;
    let threads = 0; try { threads = Number(localStorage.getItem('cutdiet:aiThreads')) || 0; } catch {}
    const speech = fmtClock(speechSeconds(windows), false);
    stopWorker(); ai.workers = [];
    return new Promise((resolve, reject) => {
      const fail = err => { if (finished) return; finished = true; stopWorker(); reject(err); };
      const showProgress = () => {
        if (!tT) tT = performance.now(); const pct = done / n; const el2 = (performance.now() - t0) / 1000, run2 = (performance.now() - tT) / 1000; const eta = pct > 0.03 ? (run2 / pct - run2) : null;
        setProgress(0.35 + pct * 0.65, `음성 인식 ${Math.round(pct * 100)}% (${dev === 'webgpu' ? 'GPU' : `CPU ${ai.workers.length}개 동시`} · 말소리 ${speech}) · 경과 ${fmtClock(el2, false)}${eta != null ? ` · 남은 시간 약 ${fmtClock(eta, false)}` : ''}${wordLevel ? '' : ' · 문장 단위'}`);
      };
      const spawn = (first) => {
        const w = new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' }); ai.workers.push(w); live++;
        let cur = null;
        // a helper worker that dies (e.g. out of memory loading the large model) hands its window back to the others;
        // only when no worker is left does the whole run fail
        const lose = err => {
          if (finished) return; if (live <= 1) { fail(err); return; }
          live--; try { w.terminate(); } catch {} ai.workers = ai.workers.filter(x => x !== w); if (cur) { queue.unshift(cur.i); cur = null; }
          console.warn('음성 인식 작업자 하나가 멈춰 나머지로 계속합니다:', err && err.message);
        };
        const next = () => {
          if (finished) return; if (!ai.running) { fail(new Error('canceled')); return; }
          const i = queue.shift();
          if (i == null) { w.terminate(); if (--live === 0 && !finished) { finished = true; resolve({ chunks: dedupeWords(results.flat()), wordLevel }); } return; }
          const win = windows[i]; const S = win.parts[0].s, E = win.parts[win.parts.length - 1].e;
          const slice = audio.slice(Math.round(S * SR), Math.round(E * SR)); cur = { i, S };
          w.postMessage({ type: 'win', id: i, w: { parts: win.parts.map(q => ({ s: q.s - S, e: q.e - S })), keep: { s: win.keep.s - S, e: win.keep.e - S } }, audio: slice }, [slice.buffer]);
        };
        w.onmessage = e => {
          const m = e.data;
          if (m.type === 'progress') {
            if (!first) return;
            if (m.phase === 'download') setProgress(0.1 + m.pct * 0.25, `모델 내려받는 중 ${Math.round(m.pct * 100)}%${m.total ? ` (${fmtMB(m.loaded)} / ${fmtMB(m.total)}) · 처음 한 번만` : ''}`);
            else if (m.phase === 'load') setProgress(0.1, '모델을 준비하는 중… (처음이면 내려받기에 1~3분)');
          } else if (m.type === 'device') { dev = m.device; if (m.reason === 'error') toast('GPU에서 오류가 나서 CPU로 계속합니다', 3000); }
          else if (m.type === 'ready') {
            dev = m.device; if (first) { setProgress(0.35, '모델 준비 완료. 인식 시작…'); const extra = poolSize(n, dev, model) - 1; for (let k = 0; k < extra; k++) spawn(false); }
            next();
          } else if (m.type === 'win') {
            results[m.id] = m.chunks.map(c => ({ text: c.text, timestamp: c.timestamp.map(t => (t == null ? null : t + cur.S)) })); cur = null;
            if (!m.wordLevel) wordLevel = false; done++;
            el.text.value = results.filter(Boolean).flat().map(c => c.text).join('').slice(-4000); el.text.scrollTop = el.text.scrollHeight;
            showProgress(); next();
          } else if (m.type === 'error') lose(new Error(m.message));
        };
        w.onerror = ev => lose(new Error(ev.message || '워커 오류'));
        w.postMessage({ type: 'init', model, device: dev, threads, language: 'korean' });
      };
      if (!n) { resolve({ chunks: [], wordLevel: true }); return; }
      spawn(true);
    });
  }

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
      const cached = snd.audio && snd.audio.key === fileKey() ? snd.audio.data.slice() : null;
      const audio = useEngine ? null : cached || await extractAudio(p => setProgress(p * 0.1, `오디오 추출 ${Math.round(p * 100)}%`));
      if (!ai.running) throw new Error('canceled');
      const device = (el.gpu.checked && gpuOk) ? 'webgpu' : 'wasm'; const model = el.model.value;
      // only the speech, in non-overlapping windows cut at pauses (asrplan.js)
      const windows = planWindows(state.env, api.HOP, state.params.threshold, state.duration);
      const result = useEngine ? await state.hooks.transcribe({ model, signal: ai.abort.signal, onProgress: (frac, text) => setProgress(frac, text) }) : await transcribePool({ audio, model, device, windows, t0 });
      if (!ai.running) throw new Error('canceled');
      const raw = wordsFromChunks(result.chunks, state.duration); ai.words = dropSilentWords(raw, state.env, api.HOP, state.params.threshold - 6); ai.wordLevel = result.wordLevel !== false; ai.forFile = fileKey();
      const dropped = raw.length - ai.words.length;
      if (!ai.words.length && result.text) ai.words = [{ text: result.text.trim(), s: 0, e: state.duration }];
      ai.lines = clampEnd(buildCaptionLines(ai.words, { maxChars: lineChars() }));
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

  // ---- removal candidates (each kind can be turned off; rows are editable; shown on the timeline's "NG 후보" lane) ----
  function computeCands() {
    const w = ai.words; const list = [];
    if (w.length && ai.wordLevel) {
      if (el.optFiller.checked) list.push(...findFillers(w));
      if (el.optStutter.checked) list.push(...findStutters(w));
      if (el.optMumble.checked) list.push(...findMumbles(w, state.env, api.HOP, state.params.threshold));
    }
    if (w.length && el.optRepeat.checked) list.push(...findRepeats(w));
    // before 자막 만들기: the sound scan (audiologic.js) + short sounds standing alone between pauses
    if (!w.length && !state.isDemo && state.hasMedia) {
      const raw = snd.key === fileKey() && snd.raw ? snd.raw : [];
      for (const c of raw) if ((c.kind === 'filler' && el.optFiller.checked) || (c.kind === 'stutter' && el.optStutter.checked) || (c.kind === 'repeat' && el.optRepeat.checked)) list.push({ ...c });
      if (el.optFiller.checked || el.optMumble.checked) list.push(...findShortBursts(state.segments));
    }
    list.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
    // the same words can be both a filler and a stutter ("어 어"): keep the first one found for a span
    const alreadyCut = c => state.segments.some(g => !g.keep && g.s <= c.s + 0.03 && g.e >= c.e - 0.03);
    ai.cands = list.filter((c, i) => !alreadyCut(c) && !list.some((d, j) => j < i && d.kind !== 'repeat' && c.kind !== 'repeat' && d.s <= c.s + 0.01 && d.e >= c.e - 0.01)).map(c => ({ ...c, on: !!c.confident }));
    candsChanged();
  }
  const candsChanged = () => { if (api.candsChanged) api.candsChanged(); };
  function renderResults() {
    el.text.readOnly = false; el.text.placeholder = '자막을 만들면 여기에 표시됩니다. 줄을 직접 고칠 수 있습니다 (시간은 그대로, 글자만).';
    el.text.value = ai.lines.map(l => `[${fmtClock(l.s)}] ${l.text}`).join('\n');
    const has = ai.lines.length > 0; el.srtOut.disabled = el.srtSrc.disabled = el.txtCopy.disabled = !has;
    renderCands(); renderEditor();
  }
  function renderCands() {
    const on = ai.cands.filter(c => c.on).length;
    el.candChip.textContent = ai.cands.length ? `${on}/${ai.cands.length}개 선택` : '0개';
    const audioOnly = !ai.words.length; renderNote();
    if (!ai.cands.length) { el.candBody.innerHTML = `<tr><td colspan="6" class="muted">${!state.hasMedia || state.isDemo ? '영상을 불러오면 후보를 찾습니다.' : audioOnly && snd.running ? '소리를 분석하는 중입니다… 잠시 후 여기에 후보가 나옵니다.' : '찾은 후보가 없습니다. 위의 찾을 종류를 켜거나, 자막을 만들어 다시 찾아 보세요.'}</td></tr>`; el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = true; candsChanged(); return; }
    el.candBody.innerHTML = ai.cands.map((c, i) => `<tr data-i="${i}" class="cand-${c.kind}${c.on ? ' on' : ''}"><td><input type="checkbox" data-act="toggle" ${c.on ? 'checked' : ''} aria-label="삭제할 후보로 선택"></td><td>${KIND_CHIP[c.kind] || `<span class="chip warn">반복·NG${c.sim ? ` ${Math.round(c.sim * 100)}%` : ''}</span>`}</td><td class="mono"><button class="btn sm ghost" data-act="play" title="앞뒤를 조금 붙여 들어보기">▶ ${fmtClock(c.s)}</button></td><td class="captime"><input class="mono" data-f="s" value="${fmtClock(c.s)}" aria-label="시작"><span class="muted">–</span><input class="mono" data-f="e" value="${fmtClock(c.e)}" aria-label="끝"></td><td style="white-space:normal;min-width:160px">${escapeHtml(c.text)}${c.pair ? `<div class="hint">→ ${c.kind === 'repeat' ? '다시 한 말' : '이어진 말'}: ${escapeHtml(c.pair)}</div>` : ''}</td><td class="mono">${(c.e - c.s).toFixed(1)}s <button class="btn sm ghost" data-act="drop" title="이 후보 빼기 (삭제 안 함)">✕</button></td></tr>`).join('');
    el.apply.disabled = el.checkAll.disabled = el.uncheckAll.disabled = false;
    candsChanged();
  }
  el.candBody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return; const c = ai.cands[Number(tr.dataset.i)]; if (!c) return;
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'toggle') { c.on = b.checked; tr.classList.toggle('on', c.on); el.candChip.textContent = `${ai.cands.filter(x => x.on).length}/${ai.cands.length}개 선택`; candsChanged(); }
    else if (b.dataset.act === 'play') { if (api.previewSpan) api.previewSpan(c.s, c.e); else seek(Math.max(0, c.s - 0.4)); }
    else if (b.dataset.act === 'drop') { ai.cands.splice(ai.cands.indexOf(c), 1); renderCands(); }
  });
  el.candBody.addEventListener('change', e => {
    const inp = e.target.closest('input[data-f]'); if (!inp) return; const c = ai.cands[Number(inp.closest('tr').dataset.i)]; if (!c) return;
    const v = parseClock(inp.value); if (!isFinite(v)) { inp.value = fmtClock(c[inp.dataset.f]); toast('시간은 분:초 형식으로 입력하세요 (예: 1:23.5)'); return; }
    c[inp.dataset.f] = Math.max(0, Math.min(state.duration || v, v)); if (c.e <= c.s) c.e = c.s + 0.05; c.edited = true; renderCands();
  });
  const setAll = v => { for (const c of ai.cands) c.on = v; renderCands(); };
  el.checkAll.addEventListener('click', () => setAll(true));
  el.uncheckAll.addEventListener('click', () => setAll(false));
  el.rescan.addEventListener('click', () => { if (!ai.words.length) { soundScan(true); return; } computeCands(); renderCands(); toast(ai.cands.length ? `후보 ${ai.cands.length}개` : '후보를 찾지 못했습니다', 1500); });
  el.apply.addEventListener('click', () => {
    const picked = ai.cands.filter(c => c.on);
    if (!picked.length) { toast('체크한 항목이 없습니다'); return; }
    const spans = mergeSpans(picked, 0.04); markSpans(spans, false);
    if (el.optStrip.checked && ai.lines.length) { swapLines(stripFromLines(ai.lines, picked)); renderEditor(); changed(); } // undo: markSpans took the snapshot
    ai.cands = ai.cands.filter(c => !picked.includes(c)); renderCands();
    toast(`${picked.length}개 구간을 삭제 표시했습니다 (Ctrl+Z로 되돌리기)`, 3000);
  });
  // ---- sound-only scan: fillers / stutters / retakes without a transcript, started as soon as a video is analyzed ----
  const snd = { key: null, raw: null, running: false, token: 0, progress: 0, audio: null, worker: null, error: '' };
  function renderNote() {
    const audioOnly = !ai.words.length;
    el.candNote.innerHTML = !state.hasMedia || state.isDemo ? '영상을 불러오면 바로 소리로 후보를 찾습니다.'
      : !audioOnly ? '자막(단어 시간)으로 찾은 후보입니다. 타임라인의 <b>NG 후보</b> 줄에도 같은 색으로 표시됩니다.'
      : snd.running ? `<b>자막 없이 소리만으로</b> 추임새·말 버벅임·다시 말한 부분을 찾는 중… ${Math.round(snd.progress * 100)}%`
      : `<b>자막 없이 소리만으로</b> 찾은 후보입니다. ▶로 들어보고 지울 것만 체크하세요(확실한 것만 미리 체크돼 있음). 자막을 만들면 말 내용으로 더 정확하게 다시 찾습니다. <button class="btn sm" id="btnAiRun2">자막 만들고 더 정확하게 찾기</button>${snd.error ? ` <span class="muted">(${escapeHtml(snd.error)})</span>` : ''}`;
    const b2 = document.getElementById('btnAiRun2'); if (b2) b2.addEventListener('click', run);
  }
  async function soundScan(force) {
    const key = fileKey(); if (!state.hasMedia || state.isDemo || !key || ai.words.length) return;
    if (!force && snd.key === key && (snd.raw || snd.running)) return;
    const token = ++snd.token; snd.key = key; snd.raw = null; snd.error = ''; snd.progress = 0;
    if (heavyReason()) { snd.raw = []; snd.error = '1시간이 넘는 영상은 소리 분석을 건너뜁니다'; computeCands(); renderCands(); return; }
    snd.running = true; computeCands(); renderCands();
    const alive = () => snd.token === token && fileKey() === key;
    try {
      const audio = await extractAudio(p => { if (alive()) { snd.progress = p * 0.8; renderNote(); } }, alive);
      if (!alive()) return;
      snd.audio = state.duration <= 1800 ? { key, data: audio.slice() } : null; // 자막 만들기 reuses it
      if (snd.worker) snd.worker.terminate();
      const w = snd.worker = new Worker(new URL('./audioscan.worker.js', import.meta.url), { type: 'module' });
      snd.progress = 0.85; renderNote();
      const res = await new Promise((resolve, reject) => { w.onmessage = e => { if (e.data.id !== token) return; if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.cands); }; w.onerror = ev => reject(new Error(ev.message || 'worker')); w.postMessage({ id: token, samples: audio }, [audio.buffer]); });
      if (alive()) snd.raw = res;
    } catch (e) {
      if (alive()) { snd.raw = []; snd.error = /nofile|canceled/.test(String(e.message)) ? '이 방식으로 연 파일은 소리 분석을 할 수 없어 자막 만들기를 써야 합니다' : '소리 분석 실패: ' + String(e.message).slice(0, 80); }
    } finally {
      if (snd.token === token) { snd.running = false; if (snd.worker) { snd.worker.terminate(); snd.worker = null; } if (!ai.words.length) { computeCands(); renderCands(); if (alive() && snd.raw && snd.raw.length) toast(`소리로 찾은 삭제 후보 ${ai.cands.length}개 · 왼쪽 NG 정리에서 확인`, 3000); } }
    }
  }
  document.addEventListener('cutdiet:analyzed', () => { if (!ai.words.length) { computeCands(); renderCands(); soundScan(false); } });

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
      // at the playhead (or the middle), on the most natural word boundary near it
      const t = state.cur > l.s + 0.15 && state.cur < l.e - 0.15 ? state.cur : (l.s + l.e) / 2;
      const two = splitLineAt(l, t, ai.words); if (!two) { toast('한 단어라서 나눌 수 없습니다'); return; }
      ai.lines.splice(i, 1, ...two);
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
      ai.lines = lines.map(l => ({ ...l, edited: true })); ai.words = []; computeCands(); ai.forFile = fileKey(); renderResults(); changed();
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
  setInterval(() => { const key = fileKey(); if (key !== lastKey) { lastKey = key; if (ai.running) { ai.running = false; stopWorker(); el.run.disabled = false; el.cancel.hidden = true; } ai.words = []; ai.lines = []; ai.cands = []; if (!state.analyzing) computeCands(); el.text.value = ''; el.progress.hidden = true; el.status.textContent = state.hasMedia ? '준비됨. "자막 만들기"를 누르세요.' : '영상을 불러온 뒤 실행하세요.'; renderResults(); } }, 500);
  function setLines(lines) {
    lastKey = fileKey(); ai.words = []; computeCands(); ai.forFile = lastKey;
    ai.lines = (lines || []).map(l => ({ s: Number(l.s), e: Number(l.e), text: String(l.text || ''), edited: !!l.edited })).filter(l => l.e > l.s && l.text).sort((a, b) => a.s - b.s);
    renderResults(); if (api.captionsChanged) api.captionsChanged();
  }
  renderEditor();
  // undo/redo of timeline clip moves restores caption timing without touching the recognized words
  // Replace the caption list so Ctrl+Z can bring the old lines back (main.js restoreClips follows _tlAdded/_tlDeleted)
  function swapLines(next) { for (const l of ai.lines) if (!next.includes(l)) l._tlDeleted = true; for (const l of next) if (!ai.lines.includes(l)) l._tlAdded = true; ai.lines = next; }
  function clampEnd(lines) { const d = state.duration || Infinity; for (const l of lines) if (l.e > d) l.e = Math.max(l.s + 0.05, d); return lines; }
  function replaceLines(lines) { ai.lines = lines.map(l => ({ ...l })); renderEditor(); if (api.captionsChanged) api.captionsChanged(); }
  function focusCaption(line) { const i = ai.lines.indexOf(line); if (i < 0) return; if (api.showTab) api.showTab('ai'); const inp = el.capList.querySelector(`.caprow[data-i="${i}"] input[data-f="text"]`); if (inp) { inp.scrollIntoView({ block: 'center' }); inp.focus(); inp.select(); } }
  function toggleCand(c) { if (!ai.cands.includes(c)) return; c.on = !c.on; renderCands(); }
  // line length: how many characters fit on one caption line (shorts need shorter lines)
  function lineChars() { return Number(el.capLen && el.capLen.value) || CAPTION_CHARS; }
  try { const v = localStorage.getItem('cutdiet:capLen'); if (v && el.capLen && [...el.capLen.options].some(o => o.value === v)) el.capLen.value = v; } catch {}
  if (el.capLen) el.capLen.addEventListener('change', () => { try { localStorage.setItem('cutdiet:capLen', el.capLen.value); } catch {} });
  if (el.capResplit) el.capResplit.addEventListener('click', () => {
    if (!ai.lines.length) { toast('먼저 자막을 만들거나 불러오세요'); return; }
    const before = ai.lines.length; if (api.pushUndo) api.pushUndo(); swapLines(clampEnd(resplitLines(ai.lines, ai.words, { maxChars: lineChars() }))); renderEditor(); changed();
    toast(`문장 단위로 다시 나눴습니다 (${before}줄 → ${ai.lines.length}줄)`, 2200);
  });
  // timeline split: cut the caption under t in two at a natural word boundary
  function splitCaptionAt(t, line) {
    const l = line || ai.lines.find(x => t > x.s + 0.1 && t < x.e - 0.1); if (!l) return false;
    const two = splitLineAt(l, t, ai.words); if (!two) return false;
    ai.lines.splice(ai.lines.indexOf(l), 1, ...two); renderEditor(); changed(); return two;
  }
  return { getLines: () => ai.lines, setLines, splitCaptionAt, replaceLines, refresh: renderEditor, getCands: () => ai.cands, toggleCand, focusCaption };
}
