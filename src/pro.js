// Pro layer: channel defaults + batch queue (automation), remappable keyboard (speed), work log (analytics).
import './pro.css';
import { DEFAULT_KEYS, ACTION_LABELS, comboFromEvent, comboLabel, resolveKeymap, invertKeymap, makeRecord, summarize, toCSV, planQueue } from './prologic.js';
import { initEngine } from './engine.js';

const LS = { defaults: 'cutdiet:pro:defaults', keys: 'cutdiet:pro:keys', log: 'cutdiet:pro:log' };
const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// IndexedDB keeps the chosen output folder handle between sessions (File System Access API, Chrome/Edge)
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('cutdiet-pro', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch { return undefined; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch {} }

function boot() {
  const C = window.cutdiet; if (!C) return;
  const { state, els, toast, fmtClock, fmtBytes } = C;
  document.body.classList.add('pro');

  // ---------- output folder (browser Pro without the engine) ----------
  const outBtn = $('btnOutDir'), outLabel = $('outDirLabel');
  const showOut = () => { if (!outLabel) return; outLabel.textContent = state.outDirHandle ? `출력 폴더: ${state.outDirHandle.name} (저장 창 없이 바로 저장)` : (C.fsAccess ? '출력 폴더를 지정하면 렌더·썸네일·프로젝트가 저장 창 없이 그 폴더에 쌓입니다.' : '이 브라우저는 폴더 지정을 지원하지 않아 다운로드 폴더에 저장됩니다.'); };
  if (outBtn) {
    if (!C.fsAccess) outBtn.disabled = true;
    outBtn.addEventListener('click', async () => {
      if (state.outDirHandle && outBtn.dataset.mode === 'reconnect') { try { if ((await state.outDirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') { outBtn.dataset.mode = ''; outBtn.textContent = '출력 폴더 변경'; showOut(); toast('출력 폴더를 다시 연결했습니다'); return; } } catch {} }
      try { const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cutdiet-out' }); state.outDirHandle = h; await idbSet('outDir', h); outBtn.dataset.mode = ''; outBtn.textContent = '출력 폴더 변경'; showOut(); toast(`출력 폴더: ${h.name}`); } catch (e) { if (e && e.name !== 'AbortError') toast('폴더를 지정하지 못했습니다: ' + e.message); }
    });
    idbGet('outDir').then(async h => { if (!h) { showOut(); return; } state.outDirHandle = h; let perm = 'prompt'; try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch {} if (perm === 'granted') { showOut(); } else { outBtn.dataset.mode = 'reconnect'; outBtn.textContent = `출력 폴더 다시 연결 (${h.name})`; if (outLabel) outLabel.textContent = '이전에 지정한 출력 폴더가 있습니다. 버튼을 눌러 다시 연결하세요(브라우저 보안상 매 세션 확인).'; } });
  }

  // ---------- channel defaults ----------
  const defaults = Object.assign({ preset: 'lecture', quality: 'high', tasks: { render: true, shorts: false, thumbs: true, project: true }, shortsPos: 0.5, bgmVolume: 18, bgmDuck: true, autoLog: true }, lsGet(LS.defaults, {}));
  const saveDefaults = () => lsSet(LS.defaults, defaults);
  const applyDefaults = () => {
    if (C.PRESETS[defaults.preset]) { state.preset = defaults.preset; try { localStorage.setItem('cutdiet:preset', defaults.preset); } catch {} }
    els.selQuality.value = defaults.quality; els.selQuality.dispatchEvent(new Event('change'));
    els.bgmVol.value = defaults.bgmVolume; els.bgmDuck.checked = defaults.bgmDuck; els.bgmVol.dispatchEvent(new Event('input'));
    state.shorts.pos = defaults.shortsPos; els.cropPos.value = Math.round(defaults.shortsPos * 100);
  };
  applyDefaults();
  $('defPreset').value = defaults.preset; $('defQuality').value = defaults.quality;
  for (const t of ['render', 'shorts', 'thumbs', 'project']) $('task_' + t).checked = !!defaults.tasks[t];
  $('defPreset').addEventListener('change', e => { defaults.preset = e.target.value; saveDefaults(); C.applyPreset(defaults.preset); });
  $('defQuality').addEventListener('change', e => { defaults.quality = e.target.value; saveDefaults(); applyDefaults(); });
  for (const t of ['render', 'shorts', 'thumbs', 'project']) $('task_' + t).addEventListener('change', e => { defaults.tasks[t] = e.target.checked; saveDefaults(); });
  $('btnSnapDefaults').addEventListener('click', () => { defaults.preset = C.PRESETS[state.preset] ? state.preset : defaults.preset; defaults.quality = els.selQuality.value; defaults.shortsPos = state.shorts.pos; defaults.bgmVolume = Number(els.bgmVol.value); defaults.bgmDuck = els.bgmDuck.checked; saveDefaults(); $('defPreset').value = defaults.preset; $('defQuality').value = defaults.quality; toast('지금 설정을 채널 기본값으로 저장했습니다'); });

  // ---------- queue ----------
  let queue = []; let queueRunning = false; let queueAbort = false;
  const qEl = $('queue'), qChip = $('queueChip');
  const renderQueue = () => {
    qChip.textContent = queue.length ? `${queue.filter(q => q.status === 'done').length}/${queue.length}` : '비어 있음';
    qEl.innerHTML = queue.map(q => `<div class="qitem ${q.status}" data-i="${q.idx}"><span class="mono muted small">${q.idx + 1}</span><span class="qname" title="${esc(q.name)}">${esc(q.name)}</span><span class="qbar"><i style="width:${Math.round(q.progress * 100)}%"></i></span><span class="qstat">${q.status === 'wait' ? '대기' : q.status === 'run' ? (q.step || '처리 중') : q.status === 'done' ? '완료' : q.status === 'skip' ? '건너뜀' : '실패'}</span></div>`).join('') || '<div class="hint">영상 파일을 여러 개 고르거나 끌어다 놓으세요. 파일마다 분석 → 선택한 작업 순서로 자동 처리되고, 결과는 다운로드 폴더에 저장됩니다.</div>';
    $('btnRunQueue').disabled = queueRunning || !queue.some(q => q.status === 'wait');
    $('btnStopQueue').hidden = !queueRunning; $('btnClearQueue').disabled = queueRunning;
  };
  const addFiles = files => { const list = [...files].filter(f => f.engine || /^(video|audio)\//.test(f.type) || /\.(mp4|mov|mkv|webm|m4a|mp3|wav|m4v|avi|mts)$/i.test(f.name)); if (!list.length) { toast('영상·음성 파일이 아닙니다'); return; } const tasks = defaults.tasks; const planned = planQueue(list, tasks); const base = queue.length; planned.forEach(p => { p.idx = base + p.idx; }); queue = queue.concat(planned); renderQueue(); toast(`${list.length}개를 큐에 넣었습니다. Shift+Enter로 실행`); };
  $('queueInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  $('btnQueueAdd').addEventListener('click', () => $('queueInput').click());
  $('btnClearQueue').addEventListener('click', () => { queue = queue.filter(q => q.status === 'run'); renderQueue(); });
  $('btnStopQueue').addEventListener('click', () => { queueAbort = true; if (state.rendering) state.rendering.abort.abort(); toast('현재 파일을 마치는 대로 멈춥니다'); });
  document.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 1) { e.preventDefault(); e.stopImmediatePropagation(); addFiles(e.dataTransfer.files); } }, true);
  qEl.addEventListener('click', e => { const it = e.target.closest('.qitem'); if (!it || queueRunning) return; const q = queue.find(x => x.idx === Number(it.dataset.i)); if (q && q.status !== 'run') { q.status = 'wait'; q.progress = 0; q.error = ''; renderQueue(); } });

  const waitAnalyzed = () => new Promise(res => document.addEventListener('cutdiet:analyzed', e => res(e.detail.ok), { once: true }));
  async function runQueue() {
    if (queueRunning) return; const pending = queue.filter(q => q.status === 'wait'); if (!pending.length) { toast('실행할 파일이 없습니다'); return; }
    queueRunning = true; queueAbort = false; renderQueue(); const t0 = performance.now(); let doneCount = 0;
    for (const q of pending) {
      if (queueAbort) { q.status = 'skip'; continue; }
      q.status = 'run'; q.step = '분석'; q.progress = 0.05; renderQueue();
      try {
        const analyzed = waitAnalyzed(); const openP = C.openFile(q.file); const ok = await analyzed; await openP;
        if (!ok) throw new Error('분석 실패');
        if (C.PRESETS[defaults.preset]) C.applyPreset(defaults.preset, { silent: true, force: true });
        q.progress = 0.25; const steps = q.steps.filter(s => s !== 'analyze'); let si = 0;
        for (const s of steps) {
          if (queueAbort) break;
          q.step = { render: 'MP4 렌더', shorts: '숏츠 렌더', thumbs: '썸네일', project: '프로젝트' }[s]; renderQueue();
          if (s === 'render') { if (C.renderBlockReason()) q.error += 'MP4 불가 · '; else { const r = await C.startRender('main', false); if (!r) q.error += 'MP4 실패 · '; } }
          else if (s === 'shorts') { C.resetShortsRange(); state.shorts.pos = defaults.shortsPos; if (C.shortsBlockReason()) q.error += '숏츠 불가 · '; else { const r = await C.startRender('shorts', false); if (!r) q.error += '숏츠 실패 · '; } }
          else if (s === 'thumbs') { const n = await C.pickThumbs(); if (n) await C.saveThumbsZip(); }
          else if (s === 'project') await C.saveProjectFile();
          si++; q.progress = 0.25 + 0.75 * (si / steps.length); renderQueue();
        }
        if (defaults.autoLog) addRecord({ rendered: state.activity.renders > 0, note: '큐 자동 처리' });
        q.status = q.error ? 'err' : 'done'; q.progress = 1; doneCount++;
      } catch (e) { q.status = 'err'; q.error = (e && e.message) || String(e); q.progress = 1; }
      renderQueue();
    }
    queueRunning = false; renderQueue();
    toast(`큐 완료 · ${doneCount}개 처리 · ${fmtClock((performance.now() - t0) / 1000, false)}`, 5000);
  }
  $('btnRunQueue').addEventListener('click', runQueue);
  renderQueue();

  // ---------- work log ----------
  let log = lsGet(LS.log, []);
  const saveLog = () => lsSet(LS.log, log);
  function addRecord(extra = {}) {
    if (!state.hasMedia || !state.duration) return null;
    const rec = makeRecord({ file: state.file ? state.file.name : '', preset: state.preset, duration: state.duration, kept: C.keptDuration(state.segments), cuts: C.countRemoveRuns(state.segments), manualEdits: state.activity.manualEdits, aiApplied: state.activity.aiApplied, editSeconds: state.activity.openedAt ? (Date.now() - state.activity.openedAt) / 1000 : 0, rendered: state.activity.renders > 0, ...extra });
    const key = rec.file + '|' + rec.duration; const i = log.findIndex(r => r.file + '|' + r.duration === key && Date.now() - new Date(r.at).getTime() < 6 * 3600e3);
    if (i >= 0) log[i] = { ...rec, id: log[i].id }; else log.push(rec);
    saveLog(); renderLog(); return rec;
  }
  document.addEventListener('cutdiet:rendered', e => { if (defaults.autoLog && e.detail.kind === 'main' && !queueRunning) addRecord({ rendered: true }); });
  $('btnLogNow').addEventListener('click', () => { const r = addRecord({ note: '수동 기록' }); toast(r ? '기록했습니다' : '기록할 영상이 없습니다'); });
  $('btnLogCsv').addEventListener('click', () => C.saveFile(`cutdiet_log_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(log)));
  $('btnLogJson').addEventListener('click', () => C.saveFile(`cutdiet_log_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(log, null, 1)));
  $('logImport').addEventListener('change', async e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return; try { const arr = JSON.parse(await f.text()); if (!Array.isArray(arr)) throw 0; const ids = new Set(log.map(r => r.id)); let n = 0; for (const r of arr) if (r && r.id && !ids.has(r.id)) { log.push(r); n++; } log.sort((a, b) => a.at < b.at ? -1 : 1); saveLog(); renderLog(); toast(`${n}건을 합쳤습니다`); } catch { toast('기록 파일을 읽지 못했습니다'); } });
  $('btnLogImport').addEventListener('click', () => $('logImport').click());
  $('btnLogClear').addEventListener('click', () => { if ($('btnLogClear').dataset.arm === '1') { log = []; saveLog(); renderLog(); $('btnLogClear').dataset.arm = ''; $('btnLogClear').textContent = '기록 전체 삭제'; } else { $('btnLogClear').dataset.arm = '1'; $('btnLogClear').textContent = '정말 삭제 (다시 클릭)'; setTimeout(() => { $('btnLogClear').dataset.arm = ''; $('btnLogClear').textContent = '기록 전체 삭제'; }, 4000); } });
  $('logBody').addEventListener('click', e => { const b = e.target.closest('button[data-del]'); if (!b) return; log = log.filter(r => r.id !== b.dataset.del); saveLog(); renderLog(); });
  function renderLog() {
    const s = summarize(log);
    $('lt_n').textContent = s.n; $('lt_dur').textContent = fmtClock(s.totalDuration, false); $('lt_removed').textContent = fmtClock(s.totalRemoved, false); $('lt_ratio').textContent = s.n ? s.avgCutRatio + '%' : '–';
    $('lt_edit').textContent = s.avgEditPerMin ? `${Math.round(s.avgEditPerMin / 60 * 10) / 10}분` : '–'; $('lt_manual').textContent = s.n ? s.avgManualEdits : '–';
    $('logBody').innerHTML = log.slice().reverse().map(r => `<tr><td class="mono muted">${esc(r.at.slice(0, 16).replace('T', ' '))}</td><td style="white-space:normal;min-width:160px">${esc(r.file)}</td><td>${esc(C.PRESETS[r.preset] ? C.PRESETS[r.preset].label : r.preset)}</td><td class="mono">${fmtClock(r.duration, false)}</td><td class="mono">${fmtClock(r.kept, false)}</td><td class="mono">${r.cutRatio}%</td><td class="mono">${r.cuts}</td><td class="mono">${r.manualEdits}</td><td class="mono">${r.aiApplied}</td><td class="mono">${r.editSeconds ? fmtClock(r.editSeconds, false) : '–'}</td><td>${r.rendered ? '<span class="chip ok">Y</span>' : ''}</td><td><button class="btn sm ghost" data-del="${r.id}" title="삭제">✕</button></td></tr>`).join('') || '<tr><td colspan="12" class="muted">아직 기록이 없습니다. MP4를 렌더하면 자동으로 쌓이고, "지금 기록"으로 직접 남길 수도 있습니다.</td></tr>';
    drawTrend(s.trend);
  }
  function drawTrend(vals) {
    const cv = $('logTrend'); const dpr = window.devicePixelRatio || 1; const W = cv.clientWidth || 600, H = cv.clientHeight || 90; cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    ctx.font = '10px ' + css('--font-mono'); ctx.fillStyle = css('--muted'); ctx.fillText('최근 20편 컷 비율(%)', 8, 12);
    if (!vals.length) { ctx.fillText('기록이 쌓이면 추세가 표시됩니다', 8, H / 2 + 4); return; }
    const max = Math.max(30, ...vals); const pad = 8, bw = Math.max(6, (W - pad * 2) / vals.length - 4);
    vals.forEach((v, i) => { const h = (v / max) * (H - 30); const x = pad + i * ((W - pad * 2) / vals.length); ctx.fillStyle = i === vals.length - 1 ? css('--accent') : css('--keep'); ctx.fillRect(x, H - 10 - h, bw, h); ctx.fillStyle = css('--fg'); ctx.fillText(String(v), x, H - 12 - h); });
  }
  renderLog();

  // ---------- keyboard ----------
  let keymap = resolveKeymap(lsGet(LS.keys, {})); let inv = invertKeymap(keymap);
  const actions = { ...C.actions, render: () => C.startRender('main', false), runQueue, thumbs: () => { C.showTab('thumbs'); C.pickThumbs(); }, saveProject: () => C.saveProjectFile(), help: () => toggleSheet() };
  const defaultCombos = new Set(Object.values(DEFAULT_KEYS));
  document.addEventListener('keydown', e => {
    if (!$('keysheet').hidden) { if (e.code === 'Escape' || comboFromEvent(e) === keymap.help) { e.preventDefault(); toggleSheet(false); e.cutdietHandled = true; } return; }
    if (listening) return;
    const tag = (e.target && e.target.tagName) || ''; const isRange = tag === 'INPUT' && e.target.type === 'range';
    const typing = (tag === 'INPUT' && !/^(checkbox|radio|range|color|button|submit|reset|file|image)$/.test(e.target.type || 'text')) || tag === 'TEXTAREA' || e.target.isContentEditable;
    if (typing) return;
    const combo = comboFromEvent(e); if (!combo) return;
    // a focused checkbox/dropdown/button must not swallow the play key: drop focus and let the binding run
    if (combo === keymap.play && (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON')) e.target.blur();
    else if ((tag === 'INPUT' && !isRange) || tag === 'SELECT') return;
    if (/^Digit[1-9]$/.test(combo)) { const tabs = [...document.querySelectorAll('.tab')]; const t = tabs[Number(combo.slice(5)) - 1]; if (t) { e.preventDefault(); e.cutdietHandled = true; C.showTab(t.dataset.tab); } return; }
    const action = inv[combo];
    if (action) { e.preventDefault(); e.cutdietHandled = true; actions[action](); return; }
    // a default key that the user moved elsewhere must not trigger the built-in binding
    if (defaultCombos.has(combo) && Object.values(keymap).indexOf(combo) === -1) { e.preventDefault(); e.cutdietHandled = true; }
  }, true);
  let listening = null;
  function renderKeys() {
    $('keyGrid').innerHTML = Object.keys(DEFAULT_KEYS).map(a => `<div class="krow"><span>${ACTION_LABELS[a]}</span><kbd data-a="${a}" title="클릭 후 새 키 입력 · Esc 취소">${comboLabel(keymap[a])}</kbd></div>`).join('');
    document.querySelectorAll('.tab').forEach((t, i) => { t.dataset.key = String(i + 1); });
  }
  $('keyGrid').addEventListener('click', e => { const k = e.target.closest('kbd[data-a]'); if (!k) return; document.querySelectorAll('.krow kbd.listen').forEach(x => x.classList.remove('listen')); listening = k.dataset.a; k.classList.add('listen'); k.textContent = '키 입력…'; });
  document.addEventListener('keydown', e => { if (!listening) return; e.preventDefault(); e.stopImmediatePropagation(); e.cutdietHandled = true; if (e.code === 'Escape') { listening = null; renderKeys(); return; } const combo = comboFromEvent(e); if (!combo) return; const taken = Object.entries(keymap).find(([a, c]) => c === combo && a !== listening); if (taken) { toast(`이미 "${ACTION_LABELS[taken[0]]}"에 쓰는 키입니다`); return; } keymap[listening] = combo; inv = invertKeymap(keymap); lsSet(LS.keys, keymap); listening = null; renderKeys(); }, true);
  $('btnKeysReset').addEventListener('click', () => { keymap = resolveKeymap({}); inv = invertKeymap(keymap); lsSet(LS.keys, {}); renderKeys(); toast('단축키를 기본값으로 되돌렸습니다'); });
  function toggleSheet(force) { const sh = $('keysheet'); sh.hidden = force === undefined ? !sh.hidden : !force; if (!sh.hidden) { $('sheetGrid').innerHTML = Object.keys(DEFAULT_KEYS).map(a => `<div class="krow"><span>${ACTION_LABELS[a]}</span><kbd>${comboLabel(keymap[a])}</kbd></div>`).join('') + '<div class="krow"><span>탭 전환</span><kbd>1 ~ 9</kbd></div>'; } }
  $('btnKeySheet').addEventListener('click', () => toggleSheet());
  $('keysheet').addEventListener('click', e => { if (e.target === $('keysheet')) toggleSheet(false); });
  renderKeys();
  window.addEventListener('resize', () => drawTrend(summarize(log).trend));
  try { new ResizeObserver(() => { if ($('logTrend').clientWidth) drawTrend(summarize(log).trend); }).observe($('logTrend')); } catch {}

  // ---------- local engine (ffmpeg, watch folder, native dialogs) ----------
  initEngine(C, { addFiles }).then(eng => { if (eng) window.cutdietEngine = eng; }).catch(e => console.warn('engine init failed', e));
}

if (window.cutdiet) boot(); else document.addEventListener('cutdiet:ready', boot, { once: true });
