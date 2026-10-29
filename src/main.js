import { initTranscribe } from './transcribe.js';
import { initDecorate, makeCompositor, preloadFonts } from './decorate.js';
import { initInspector } from './inspector.js';
import { defaultFx, defaultTracks, fxActive, fxToJSON, fxFromJSON, mixSfxInto, liveFx, layerCount } from './fxlogic.js';
import { HOP, clamp, PRESETS, detectSegments, suggestThreshold, keepRanges, intersectRanges, rangesDuration, keptDuration, applySpan, countRemoveRuns, outTime, sourceTimeAtOutput, segIndexAt, fmtClock, ytStamp, tcFromSeconds, buildEDL, buildFCPXML, buildFFmpeg, chapterLines, validateChapters, pickThumbnailTimes, mixBgmInto, buildZip, assembleBlob, accumulateEnergy, energyToDb, demoEnvelope } from './cutlogic.js';
const LS_PREFIX = 'cutdiet:v1:';
const HEAVY_LIMIT = 3600; // seconds: above this only light features

// ===================== PURE LOGIC (unit-tested) =====================
// (pure logic lives in ./cutlogic.js)


// ===================== STATE =====================
const state = {
  mb: null, mbStatus: 'loading',
  file: null, fileURL: null, hasMedia: false, isDemo: true,
  input: null, vTrack: null, aTrack: null, canDecodeVideo: false, videoPlayable: false,
  duration: 0, fps: 30, width: 0, height: 0, rotation: 0,
  env: null, params: { threshold: -42, minSilence: 0.6, pad: 0.15, minKeep: 0.25 }, autoThreshold: -42, preset: 'lecture',
  segments: [], chapters: [], dirty: false,
  cur: 0, skip: true, zoom: 1, scroll: 0, hoverT: null, previewStop: null,
  shuttle: { dir: 0, speed: 1, last: 0 }, rate: 1, marks: { in: null, out: null },
  analyzing: false, rendering: null, lastRender: null, lastShorts: null, currentRow: -1,
  activity: { openedAt: 0, manualEdits: 0, aiApplied: 0, renders: 0 },
  fx: defaultFx(),
  bgm: { file: null, url: null, name: '', data: null, sr: 0, duration: 0, volume: 0.18, duck: true, fade: 1.5, loop: true, ready: false, decoding: false },
  shorts: { in: 0, out: 0, pos: 0.5, upscale: true },
  thumbs: [], thumbSel: -1,
  // Pro integrations: engineMedia = file opened through the local engine (path-based); hooks = engine/outDir overrides
  engineMedia: null, hooks: {}, outDirHandle: null,
};
const $ = s => document.querySelector(s);
let decor = null; let captionsOf = () => []; let trApi = null; let inspApi = null;
const ids = ['drop','fileInput','filebar','fileName','fileMeta','btnOtherFile','notice','video','monitor','monitorEmpty','hudState','hudRes','hudCand','tlHeads','btnMiniClose','engineChip','cropOverlay','cropFrame',
  'presetNote','adv','advSummary','rngThreshold','rngMinSilence','rngPad','valThreshold','valMinSilence','valPad','btnAuto','btnReanalyze','dirtyHint',
  'stOrig','stAfter','stSaved','stSavedPct','stCuts','stCutsNote',
  'btnPlay','btnRev','btnFwd','btnPrevCut','btnNextCut','speedBadge','selRate','btnMute','rngVolume','btnFull','btnMarkIn','btnMarkOut','btnMarkDel','tcCur','tcDur','tcOut','chkSkip','btnToggle','btnSplit','btnTrimL','btnTrimR','btnChapter','btnUndo','btnRedo','btnZoomIn','btnZoomOut','btnZoomFit','zoomLabel','tl','scroller',
  'segFilter','segCount','segBody','btnReviveShort','btnKeepAll','btnChapterHere','chBody','chText','chText2','chValid','btnCopyChapters','btnCopyChapters2',
  'bgmChip','btnBgmPick','btnBgmClear','bgmInput','bgmInfo','bgmProgress','bgmVol','bgmVolVal','bgmDuck','bgmFade','bgmFadeVal','bgmLoop',
  'shIn','shOut','btnShInHere','btnShOutHere','btnShAll','shInfo','btnShPreview','cropPos','cropPosVal','chkUpscale','cropInfo','shortsChip','shEstimate','btnShortsRender','btnShortsCancel','btnShortsResave','shortsProgress','shortsStatus',
  'btnThumbs','btnThumbNow','btnThumbsZip','thumbsInfo','thumbGrid',
  'renderChip','selQuality','renderEstimate','btnRender','btnCancelRender','btnResave','renderProgress','renderStatus','fpsInput','btnZip','btnCopyFfmpeg',
  'btnSaveProject','btnSaveProject2','btnLoadProject','btnLoadProject2','projectInput','btnHelp','onb','onbStart','onbGuide','toast'];
const els = {}; for (const id of ids) els[id] = document.getElementById(id);

// ===================== UTIL =====================
let toastT = 0;
function toast(msg, ms = 2600) { els.toast.textContent = msg; els.toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => els.toast.classList.remove('show'), ms); }
function notice(html, kind = '', progress = null) {
  if (html == null) { els.notice.hidden = true; els.notice.innerHTML = ''; return; }
  els.notice.hidden = false; els.notice.className = 'notice ' + kind;
  els.notice.innerHTML = html + (progress != null ? `<span class="bar"><i style="width:${Math.round(progress * 100)}%"></i></span><span class="mono small">${Math.round(progress * 100)}%</span>` : '');
}
// Yield to the event loop with a timer, never rAF: rAF stops in background tabs and would freeze long analyses.
const nextFrame = () => new Promise(r => setTimeout(r, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function baseName(name) { return (name || 'video').replace(/\.[^.]+$/, ''); }
function fmtBytes(b) { if (b < 1e6) return (b / 1e3).toFixed(0) + ' KB'; if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB'; return (b / 1e9).toFixed(2) + ' GB'; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
// input types where keys are typed (Space included); everything else (checkbox, slider, color…) lets Space play/pause
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image']);
function isTextEntry(t) { if (!t) return false; const tag = t.tagName || ''; return (tag === 'INPUT' && !NON_TEXT_INPUTS.has((t.type || 'text').toLowerCase())) || tag === 'TEXTAREA' || !!t.isContentEditable; }
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); return true; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); toast(ok ? '복사했습니다' : '복사가 막혀 있습니다. 텍스트를 직접 선택해 복사하세요'); return ok; }
}
// ---- saving ----
// Order: engine hook (Pro, writes into the engine's output folder) → chosen output folder (Pro, File System Access) →
// save dialog (Chrome/Edge, when the call happens right after a click) → plain download.
const fsAccess = typeof window.showSaveFilePicker === 'function' && window.self === window.top;
const userActive = () => !navigator.userActivation || navigator.userActivation.isActive;
const MIME_TYPES = { mp4: ['MP4 동영상', 'video/mp4'], srt: ['SRT 자막', 'text/plain'], json: ['JSON', 'application/json'], zip: ['ZIP', 'application/zip'], jpg: ['JPEG 이미지', 'image/jpeg'], csv: ['CSV', 'text/csv'], txt: ['텍스트', 'text/plain'] };
function pickerTypes(filename) { const ext = (filename.match(/\.(\w+)$/) || [])[1]; const t = MIME_TYPES[ext]; return t ? [{ description: t[0], accept: { [t[1]]: ['.' + ext] } }] : undefined; }
async function writeToDir(dir, filename, data) {
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('폴더 쓰기 권한이 없습니다');
  let name = filename, k = 2; const base = filename.replace(/\.[^.]+$/, ''), ext = (filename.match(/\.[^.]+$/) || [''])[0];
  while (true) { try { await dir.getFileHandle(name); name = `${base} (${k++})${ext}`; } catch { break; } }
  const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(data); await w.close(); return name;
}
async function saveFile(filename, data) {
  if (state.hooks.saveFile) { try { return await state.hooks.saveFile(filename, data); } catch (e) { toast('엔진 저장 실패: ' + e.message, 4000); return false; } }
  if (state.outDirHandle) { try { const n = await writeToDir(state.outDirHandle, filename, data); toast(`출력 폴더에 저장했습니다: ${n}`, 3000); return true; } catch (e) { console.warn(e); toast('출력 폴더에 쓰지 못해 다운로드로 저장합니다', 3000); } }
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (fsAccess && userActive()) {
    try { const h = await window.showSaveFilePicker({ suggestedName: filename, id: 'cutdiet', types: pickerTypes(filename) }); const w = await h.createWritable(); await w.write(blob); await w.close(); toast(`저장했습니다: ${h.name}`, 3000); return true; }
    catch (e) { if (e && e.name === 'AbortError') { toast('저장을 취소했습니다'); return false; } console.warn('save picker failed, downloading instead', e); }
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`다운로드 폴더에 저장합니다: ${filename} (주소창 오른쪽 다운로드 아이콘에서 확인)`, 4000);
  return true;
}
// Where a render should be written. Asked BEFORE rendering so the save dialog can use the button click, and so big files
// stream straight to disk instead of living in memory. Returns { writable, name } | { memory: true } | { canceled: true }.
async function openRenderSink(filename) {
  if (state.hooks.saveFile) return { memory: true };
  if (state.outDirHandle) {
    try { if ((await state.outDirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await state.outDirHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('perm'); let name = filename, k = 2; const base = filename.replace(/\.[^.]+$/, ''); while (true) { try { await state.outDirHandle.getFileHandle(name); name = `${base} (${k++}).mp4`; } catch { break; } } const h = await state.outDirHandle.getFileHandle(name, { create: true }); return { writable: await h.createWritable(), name, where: '출력 폴더' }; }
    catch (e) { console.warn(e); }
  }
  if (fsAccess && userActive()) {
    try { const h = await window.showSaveFilePicker({ suggestedName: filename, id: 'cutdiet-render', types: pickerTypes(filename) }); return { writable: await h.createWritable(), name: h.name, where: '' }; }
    catch (e) { if (e && e.name === 'AbortError') return { canceled: true }; console.warn(e); }
  }
  return { memory: true };
}
function canvasToJpeg(canvas, q = 0.92) { return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', q)); }

// ===================== MEDIABUNNY LOAD =====================
(async () => {
  try {
    state.mb = await import('mediabunny');
    state.mbStatus = 'ready';
    els.engineChip.textContent = ('VideoEncoder' in window) ? '엔진 준비됨' : '엔진 준비됨 · MP4 렌더 불가';
    els.engineChip.className = 'chip ok';
  } catch (e) {
    state.mbStatus = 'failed';
    els.engineChip.textContent = '기본 모드';
    els.engineChip.className = 'chip warn';
    els.engineChip.title = '고급 엔진을 불러오지 못했습니다. 분석과 EDL 내보내기는 가능하고 MP4 렌더링은 되지 않습니다.';
  }
  updateRenderAvailability();
})();

// ===================== FILE OPEN & ANALYSIS =====================
els.fileInput.addEventListener('change', () => { const f = els.fileInput.files && els.fileInput.files[0]; if (f) openFile(f); els.fileInput.value = ''; });
['dragenter', 'dragover'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); els.drop.classList.remove('over'); }));
els.drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });
els.drop.addEventListener('click', e => { if (e.target !== els.fileInput) els.fileInput.click(); });
els.drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); els.fileInput.click(); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (e.target.closest && e.target.closest('#drop')) return; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f && /^(video|audio)\//.test(f.type)) openFile(f); });
els.btnOtherFile.addEventListener('click', () => els.fileInput.click());

async function openFile(file) {
  if (state.analyzing) { toast('분석 중입니다. 잠시만 기다려 주세요'); return; }
  if (state.rendering) { toast('렌더링 중에는 파일을 바꿀 수 없습니다'); return; }
  state.analyzing = true;
  const isEngine = !!(file && file.engine); // {engine:true, token, path, name, size, mediaUrl, info} from the local engine
  try { if (state.input) state.input.dispose(); } catch {}
  if (state.fileURL && state.fileURL.startsWith('blob:')) URL.revokeObjectURL(state.fileURL);
  setShuttle(0);
  Object.assign(state, { file, fileURL: isEngine ? file.mediaUrl : URL.createObjectURL(file), engineMedia: isEngine ? file : null, hasMedia: true, isDemo: false, input: null, vTrack: null, aTrack: null, canDecodeVideo: false, videoPlayable: false, duration: 0, env: null, segments: [], chapters: [], dirty: false, cur: 0, zoom: 1, scroll: 0, lastRender: null, lastShorts: null, width: 0, height: 0, rotation: 0, fps: 30, currentRow: -1, thumbs: [], thumbSel: -1, previewStop: null, autosaveBlocked: true });
  state.activity = { openedAt: Date.now(), manualEdits: 0, aiApplied: 0, renders: 0 };
  state.fx.zooms = []; state.fx.overlays = []; state.fx.sfx = []; if (decor) decor.renderLists();
  undoReset(); els.btnReanalyze.hidden = true; els.dirtyHint.hidden = true; els.btnResave.hidden = true; els.btnShortsResave.hidden = true; els.thumbGrid.innerHTML = ''; els.btnThumbsZip.hidden = true;
  els.video.pause(); els.video.src = state.fileURL; els.video.load();
  els.monitorEmpty.hidden = true; els.hudState.textContent = '분석 중';
  els.drop.hidden = true; els.filebar.hidden = false; els.fileName.textContent = file.name; els.fileMeta.textContent = fmtBytes(file.size);
  notice('오디오를 분석하고 있습니다. 영상은 이 브라우저 밖으로 나가지 않습니다.', '', 0);
  drawTimeline(); updateStats(); renderSegList(); renderChapters();

  const videoMeta = new Promise(res => {
    const ok = () => { state.videoPlayable = true; res(); }; const bad = () => { state.videoPlayable = false; res(); };
    els.video.addEventListener('loadedmetadata', ok, { once: true }); els.video.addEventListener('error', bad, { once: true });
    setTimeout(res, 8000);
  });

  let result = null, err = null;
  if (state.mbStatus === 'loading') { for (let i = 0; i < 100 && state.mbStatus === 'loading'; i++) await sleep(100); }
  if (isEngine && state.hooks.analyze) {
    try { result = await analyzeWithEngine(file, p => notice('엔진(ffmpeg)이 오디오를 분석하고 있습니다.', '', p)); }
    catch (e) { err = e; console.warn('engine analysis failed', e); }
  } else if (state.mb) {
    try { result = await analyzeWithMediabunny(file, p => notice('오디오를 분석하고 있습니다. 영상은 이 브라우저 밖으로 나가지 않습니다.', '', p)); }
    catch (e) { err = e; console.warn('mediabunny analysis failed, falling back', e); }
  }
  if (!result && !isEngine) {
    try { result = await analyzeWithWebAudio(file, p => notice('오디오를 분석하고 있습니다 (기본 모드).', '', p)); }
    catch (e2) { err = err || e2; console.warn('web audio analysis failed', e2); }
  }
  await videoMeta;
  if (!result) {
    state.analyzing = false;
    const msg = (err && /noaudio/.test(String(err.message))) ? '이 파일에는 오디오 트랙이 없어 무음 구간을 찾을 수 없습니다.' : '이 파일을 분석하지 못했습니다. 브라우저가 지원하는 형식(MP4 H.264/AAC)으로 변환한 뒤 다시 시도해 보세요.';
    notice(msg + (err && err.message ? ` <span class="muted small">(${escapeHtml(String(err.message)).slice(0, 120)})</span>` : ''), 'err');
    state.autosaveBlocked = false;
    if (state.videoPlayable && els.video.duration) { state.duration = els.video.duration; state.segments = [{ s: 0, e: state.duration, keep: true }]; resetShortsRange(); refreshAll(); }
    els.hudState.textContent = '분석 실패';
    document.dispatchEvent(new CustomEvent('cutdiet:analyzed', { detail: { ok: false } }));
    return false;
  }
  Object.assign(state, result);
  if (!state.duration && state.videoPlayable && isFinite(els.video.duration)) state.duration = els.video.duration;
  state.autoThreshold = suggestThreshold(state.env);
  if (PRESETS[state.preset]) applyPreset(state.preset, { silent: true });
  else { state.params.threshold = state.autoThreshold; syncSliders(); state.segments = detectSegments(state.env, HOP, state.duration, state.params); }
  state.analyzing = false;
  els.hudState.textContent = state.videoPlayable ? '미리보기' : '미리보기 불가';
  if (state.width) { els.hudRes.hidden = false; els.hudRes.textContent = `${state.width}×${state.height} · ${state.fps.toFixed(2).replace(/\.?0+$/, '')}fps`; } else els.hudRes.hidden = true;
  els.fpsInput.value = String(Math.round(state.fps * 1000) / 1000);
  if (!state.videoPlayable) { els.monitorEmpty.hidden = false; els.monitorEmpty.querySelector('.me-title').textContent = '이 브라우저에서 재생할 수 없는 영상 형식입니다'; els.monitorEmpty.querySelector('p').textContent = '분석과 내보내기는 그대로 할 수 있습니다. 미리 들어보려면 MP4(H.264)로 변환한 파일을 여세요.'; }
  notice(null);
  resetShortsRange();
  refreshAll();
  if (state.duration > HEAVY_LIMIT && !state.engineMedia) notice('1시간이 넘는 영상입니다. 분석·컷 목록·챕터·EDL/FFmpeg 내보내기는 되지만, 브라우저 안에서의 MP4·숏츠 렌더링은 꺼집니다. 컷본 파일이 필요하면 zip 안의 FFmpeg 스크립트를 쓰세요.', 'warn');
  const saved = loadSavedProject();
  if (saved && saved.segments && saved.segments.length) {
    state.autosaveBlocked = true; clearTimeout(autosaveT);
    const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    notice(`이 영상의 이전 작업이 있습니다${when ? ` (${when})` : ''}. <button class="btn sm primary" id="btnRestore">복구</button><button class="btn sm ghost" id="btnDismissRestore">새로 시작</button>`, 'warn');
    $('#btnRestore').addEventListener('click', () => { state.autosaveBlocked = false; try { applyProject(saved); toast('이전 작업을 복구했습니다'); } catch (e) { toast('복구하지 못했습니다'); } notice(null); });
    $('#btnDismissRestore').addEventListener('click', () => { state.autosaveBlocked = false; notice(null); autosave(); });
  } else {
    state.autosaveBlocked = false; autosave();
    const removed = state.duration - keptDuration(state.segments);
    toast(`분석 완료 · 무음 ${fmtClock(removed, false)} 발견 (${Math.round(removed / Math.max(1e-6, state.duration) * 100)}%)`, 3500);
  }
  document.dispatchEvent(new CustomEvent('cutdiet:analyzed', { detail: { ok: true } }));
  return true;
}

async function analyzeWithMediabunny(file, onProgress) {
  const mb = state.mb;
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const duration = await input.computeDuration();
  const vTrack = await input.getPrimaryVideoTrack();
  const aTrack = await input.getPrimaryAudioTrack();
  if (!aTrack) throw new Error('noaudio');
  if (!(await aTrack.canDecode())) throw new Error('audio codec not decodable');
  let fps = 30, width = 0, height = 0, rotation = 0, canDecodeVideo = false;
  if (vTrack) {
    width = await vTrack.getDisplayWidth(); height = await vTrack.getDisplayHeight(); rotation = await vTrack.getRotation();
    try { canDecodeVideo = await vTrack.canDecode(); } catch {}
    try { const m = await vTrack.computeFrameRateMetrics({ targetPacketCount: 240 }); fps = m.bestGuessFrameRate || m.averageFrameRate || 30; } catch {}
  }
  const n = Math.ceil(duration / HOP) + 1; const sumSq = new Float64Array(n), cnt = new Float64Array(n);
  const sink = new mb.AudioBufferSink(aTrack);
  let lastUi = 0;
  for await (const wb of sink.buffers(0, duration)) {
    accumulateEnergy(wb.buffer, wb.timestamp, sumSq, cnt, HOP);
    if (wb.timestamp - lastUi > 2) { lastUi = wb.timestamp; onProgress(Math.min(0.99, wb.timestamp / duration)); await nextFrame(); }
  }
  onProgress(1);
  return { input, vTrack, aTrack, duration, fps, width, height, rotation, canDecodeVideo, env: energyToDb(sumSq, cnt) };
}

// Local engine (Pro): ffmpeg decodes the audio and returns the same 20 ms envelope, no browser decode needed
async function analyzeWithEngine(desc, onProgress) {
  onProgress(0.1);
  const r = await state.hooks.analyze(desc);
  if (r.noAudio) throw new Error('noaudio');
  const info = r.info || desc.info || {};
  const env = r.env instanceof Float32Array ? r.env : Float32Array.from(r.env);
  return { input: null, vTrack: null, aTrack: null, duration: r.duration || info.duration || 0, fps: info.fps || 30, width: info.width || 0, height: info.height || 0, rotation: 0, canDecodeVideo: false, env };
}

async function analyzeWithWebAudio(file, onProgress) {
  if (file.size > 1.6e9) throw new Error('기본 모드에서는 1.6GB 이하 파일만 분석할 수 있습니다');
  onProgress(0.05);
  const ab = await file.arrayBuffer(); onProgress(0.2);
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(ab); onProgress(0.7);
  const duration = buf.duration; const n = Math.ceil(duration / HOP) + 1; const sumSq = new Float64Array(n), cnt = new Float64Array(n);
  accumulateEnergy(buf, 0, sumSq, cnt, HOP); onProgress(1);
  let width = 0, height = 0;
  if (state.videoPlayable || els.video.videoWidth) { width = els.video.videoWidth; height = els.video.videoHeight; }
  return { input: null, vTrack: null, aTrack: null, duration, fps: 30, width, height, rotation: 0, canDecodeVideo: false, env: energyToDb(sumSq, cnt) };
}

// ===================== PRESETS / PARAMS =====================
function syncSliders() {
  els.rngThreshold.value = state.params.threshold; els.rngMinSilence.value = state.params.minSilence; els.rngPad.value = state.params.pad;
  els.valThreshold.textContent = `${state.params.threshold} dB`; els.valMinSilence.textContent = `${Number(state.params.minSilence).toFixed(2)} s`; els.valPad.textContent = `${Number(state.params.pad).toFixed(2)} s`;
  els.advSummary.textContent = `${state.params.threshold} dB · ${Number(state.params.minSilence).toFixed(2)} s · ${Number(state.params.pad).toFixed(2)} s`;
  document.querySelectorAll('.preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset)));
  const p = PRESETS[state.preset];
  els.presetNote.textContent = p ? p.note : '직접 설정 중입니다. 프리셋을 누르면 기본값으로 돌아갑니다.';
}
function applyPreset(name, opts = {}) {
  const p = PRESETS[name]; if (!p) return;
  state.preset = name; lsSet('cutdiet:preset', name);
  state.params.minSilence = p.minSilence; state.params.pad = p.pad; state.params.threshold = clamp(state.autoThreshold + p.thrOffset, -70, -20);
  syncSliders();
  if (!state.env) return;
  if (state.dirty && !opts.force) { els.btnReanalyze.hidden = false; els.dirtyHint.hidden = false; if (!opts.silent) toast('수동 수정이 있어 "다시 분석"을 눌러야 적용됩니다', 2600); return; }
  if (!opts.silent) pushUndo();
  state.dirty = false; els.btnReanalyze.hidden = true; els.dirtyHint.hidden = true;
  state.segments = detectSegments(state.env, HOP, state.duration, state.params); refreshAll();
  if (!opts.silent) toast(`${p.label} 프리셋 적용`, 1400);
}
document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
let paramT = 0;
function onParamInput() {
  state.params.threshold = Number(els.rngThreshold.value); state.params.minSilence = Number(els.rngMinSilence.value); state.params.pad = Number(els.rngPad.value);
  state.preset = 'custom'; syncSliders();
  if (state.dirty || !state.env) { els.btnReanalyze.hidden = !state.env; els.dirtyHint.hidden = !state.dirty; return; }
  clearTimeout(paramT); paramT = setTimeout(() => { state.segments = detectSegments(state.env, HOP, state.duration, state.params); refreshAll(); }, 120);
}
['input', 'change'].forEach(ev => { els.rngThreshold.addEventListener(ev, onParamInput); els.rngMinSilence.addEventListener(ev, onParamInput); els.rngPad.addEventListener(ev, onParamInput); });
els.btnAuto.addEventListener('click', () => { state.params.threshold = state.autoThreshold; state.preset = 'custom'; syncSliders(); if (!state.dirty && state.env) { state.segments = detectSegments(state.env, HOP, state.duration, state.params); refreshAll(); } else onParamInput(); toast(`추천 기준값 ${state.autoThreshold} dB 적용`); });
els.btnReanalyze.addEventListener('click', () => { if (!state.env) return; pushUndo(); state.dirty = false; state.segments = detectSegments(state.env, HOP, state.duration, state.params); els.btnReanalyze.hidden = true; els.dirtyHint.hidden = true; refreshAll(); toast('자동 감지로 다시 분석했습니다'); });

// ===================== UNDO =====================
const undo = { stack: [], redo: [] };
function snapshot() {
  return { json: JSON.stringify({ segments: state.segments, chapters: state.chapters, dirty: state.dirty }),
    clips: { ov: state.fx.overlays.map(o => ({ ref: o, s: o.s, e: o.e, layer: o.layer || 0 })), sfx: state.fx.sfx.map(x => ({ ref: x, t: x.t })), caps: (captionsOf() || []).map(l => ({ ref: l, s: l.s, e: l.e })), bgmStart: state.bgm.start || 0 } };
}
// put clips back where they were; ones deleted on the timeline since then come back, everything added later stays
function restoreClips(c) {
  // put back what was deleted on the timeline since; take out what a split added since (and remember both for redo)
  const back = (list, entries) => {
    const refs = new Set(entries.map(e => e.ref));
    for (const en of entries) { const { ref, ...f } = en; Object.assign(ref, f); if (!list.includes(ref) && ref._tlDeleted) { delete ref._tlDeleted; ref._tlAdded = true; list.push(ref); } }
    for (let k = list.length - 1; k >= 0; k--) { const r = list[k]; if (r._tlAdded && !refs.has(r)) { list.splice(k, 1); delete r._tlAdded; r._tlDeleted = true; } }
  };
  back(state.fx.overlays, c.ov); back(state.fx.sfx, c.sfx); state.fx.overlays.sort((x, y) => x.s - y.s); state.fx.sfx.sort((x, y) => x.t - y.t);
  const lines = captionsOf() || []; back(lines, c.caps); lines.sort((x, y) => x.s - y.s); if (trApi) trApi.refresh();
  state.bgm.start = c.bgmStart; if (decor) { decor.renderLists(); decor.previewTick(false); }
}
function updateUndoButtons() { els.btnUndo.disabled = !undo.stack.length; els.btnRedo.disabled = !undo.redo.length; }
function pushUndo() { undo.stack.push(snapshot()); if (undo.stack.length > 60) undo.stack.shift(); undo.redo.length = 0; updateUndoButtons(); state.activity.manualEdits++; }
function popUndoSilently() { undo.stack.pop(); updateUndoButtons(); }
function undoReset() { undo.stack.length = 0; undo.redo.length = 0; updateUndoButtons(); }
function restoreSnapshot(snap) { const o = JSON.parse(typeof snap === 'string' ? snap : snap.json); if (snap.clips) restoreClips(snap.clips); state.segments = o.segments; state.chapters = o.chapters; state.dirty = !!o.dirty; els.btnReanalyze.hidden = !(state.dirty && state.env); els.dirtyHint.hidden = !state.dirty; refreshAll(); }
function doUndo() { if (!undo.stack.length) { toast('되돌릴 작업이 없습니다', 1200); return; } undo.redo.push(snapshot()); restoreSnapshot(undo.stack.pop()); updateUndoButtons(); toast('되돌렸습니다', 1000); }
function doRedo() { if (!undo.redo.length) { toast('다시 실행할 작업이 없습니다', 1200); return; } undo.stack.push(snapshot()); restoreSnapshot(undo.redo.pop()); updateUndoButtons(); toast('다시 실행했습니다', 1000); }
els.btnUndo.addEventListener('click', doUndo); els.btnRedo.addEventListener('click', doRedo);

// ===================== SEGMENT OPS =====================
function markDirty() { state.dirty = true; els.btnReanalyze.hidden = !state.env; els.dirtyHint.hidden = false; }
function toggleSegmentAt(t) { if (!state.segments.length) return; pushUndo(); const i = segIndexAt(state.segments, t); state.segments[i].keep = !state.segments[i].keep; markDirty(); refreshAll(); toast(state.segments[i].keep ? '유지로 바꿨습니다' : '삭제로 바꿨습니다', 1200); }
// Split (S / Ctrl+B), like CapCut: a selected caption or text/image clip is split on its own; otherwise everything under
// the playhead is cut there — the video segment, the caption (at the most natural word boundary) and text/image clips.
function splitClip(c, t) {
  if (c.kind === 'cap') {
    const two = trApi && trApi.splitCaptionAt(t, c.ref); if (!two) return false;
    c.ref._tlDeleted = true; two.forEach(x => { x._tlAdded = true; }); return true;
  }
  if (c.kind === 'ov') {
    const o = c.ref; if (!(t > o.s + 0.1 && t < o.e - 0.1)) return false;
    const n = { ...o, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), s: t, style: o.style ? { ...o.style } : o.style, _tlAdded: true }; delete n._tlDeleted;
    o.e = t; state.fx.overlays.splice(state.fx.overlays.indexOf(o) + 1, 0, n); return true;
  }
  return false;
}
function splitAt(t) {
  const sel = state.selClip;
  if (sel && (sel.kind === 'cap' || sel.kind === 'ov') && t > sel.ref.s + 0.1 && t < sel.ref.e - 0.1) {
    const lane = sel.kind === 'cap' ? 'cap' : 'ov' + (sel.ref.layer || 0); if (isLocked(lane)) { toast('잠긴 트랙입니다'); return; }
    pushUndo(); if (!splitClip(sel, t)) { popUndoSilently(); toast('이 위치에서는 나눌 수 없습니다'); return; }
    state.selClip = null; afterClipSplit(); toast(sel.kind === 'cap' ? '자막을 둘로 나눴습니다' : '클립을 둘로 나눴습니다', 1500); return;
  }
  if (!state.segments.length) return; const i = segIndexAt(state.segments, t); const g = state.segments[i];
  const segOk = t >= g.s + 0.05 && t <= g.e - 0.05;
  const clips = [];
  if (!isLocked('cap')) { const l = (captionsOf() || []).find(x => t > x.s + 0.1 && t < x.e - 0.1); if (l) clips.push({ kind: 'cap', ref: l }); }
  for (const o of state.fx.overlays) if (t > o.s + 0.1 && t < o.e - 0.1 && !isLocked('ov' + (o.layer || 0))) clips.push({ kind: 'ov', ref: o });
  if (!segOk && !clips.length) { toast('구간 경계와 너무 가깝습니다', 1500); return; }
  pushUndo();
  if (segOk) { state.segments.splice(i, 1, { s: g.s, e: t, keep: g.keep }, { s: t, e: g.e, keep: g.keep }); markDirty(); }
  let n = 0; for (const c of clips) if (splitClip(c, t)) n++;
  afterClipSplit(); refreshAll();
  toast(n ? `여기서 나눴습니다 (영상${n ? ` + 자막·텍스트 ${n}개` : ''}) · 한쪽을 Q·W·X로 지우세요` : '구간을 나눴습니다. 한쪽을 Q·W·X로 삭제 표시하세요', 2200);
}
function afterClipSplit() { autosave(); drawTimeline(); if (decor) { decor.renderLists(); decor.previewTick(false); } }
// CapCut Q/W: delete the part of the current clip left/right of the playhead
function trimDelete(side) {
  if (!state.segments.length) return; const t = state.cur; const i = segIndexAt(state.segments, t); const g = state.segments[i];
  if (!g.keep) { toast('이미 삭제 구간입니다', 1200); return; }
  if (side === 'left' && t <= g.s + 0.03) { toast('구간의 시작점이라 앞쪽에 지울 부분이 없습니다', 1500); return; }
  if (side === 'right' && t >= g.e - 0.03) { toast('구간의 끝점이라 뒤쪽에 지울 부분이 없습니다', 1500); return; }
  pushUndo();
  if (side === 'left') { if (t >= g.e - 0.03) g.keep = false; else state.segments.splice(i, 1, { s: g.s, e: t, keep: false }, { s: t, e: g.e, keep: true }); }
  else { if (t <= g.s + 0.03) g.keep = false; else state.segments.splice(i, 1, { s: g.s, e: t, keep: true }, { s: t, e: g.e, keep: false }); }
  markDirty(); refreshAll(); toast(side === 'left' ? '재생 위치 앞쪽을 삭제했습니다 (Q)' : '재생 위치 뒤쪽을 삭제했습니다 (W)', 1500);
}
// In/Out range (Premiere-style I / O): Delete removes the marked range instead of the current segment
function markRange() { const m = state.marks; return m.in != null && m.out != null && m.out - m.in > 0.04 ? { s: Math.min(m.in, m.out), e: Math.max(m.in, m.out) } : null; }
function setMark(which, t) {
  if (!state.duration) return; state.marks[which] = clamp(t, 0, state.duration);
  const m = state.marks; if (m.in != null && m.out != null && m.out < m.in) { if (which === 'in') m.out = null; else m.in = null; }
  const r = markRange(); els.btnMarkDel.disabled = !r; drawTimeline();
  toast(r ? `범위 ${fmtClock(r.s)}–${fmtClock(r.e)} (${(r.e - r.s).toFixed(1)}s) · Delete로 삭제, Esc로 해제` : `${which === 'in' ? '시작(I)' : '끝(O)'} ${fmtClock(state.marks[which])}`, 2200);
}
function clearMarks() { state.marks = { in: null, out: null }; els.btnMarkDel.disabled = true; drawTimeline(); }
function deleteMarked() { const r = markRange(); if (!r) { toast('I로 시작, O로 끝을 먼저 찍으세요'); return; } pushUndo(); state.segments = applySpan(state.segments, r.s, r.e, false); markDirty(); clearMarks(); refreshAll(); toast(`${(r.e - r.s).toFixed(1)}초 범위를 삭제했습니다 (Ctrl+Z로 되돌리기)`, 2200); }
function deleteCurrent() { if (markRange()) { deleteMarked(); return; } if (!state.segments.length) return; const i = segIndexAt(state.segments, state.cur); if (!state.segments[i].keep) { toast('이미 삭제 구간입니다', 1200); return; } pushUndo(); state.segments[i].keep = false; markDirty(); refreshAll(); toast('현재 구간을 삭제했습니다', 1200); }
function setBoundary(i, t) { const a = state.segments[i - 1], b = state.segments[i]; if (!a || !b) return; t = clamp(t, a.s + 0.04, b.e - 0.04); a.e = t; b.s = t; }
function boundaries() { return state.segments.slice(1).map(g => g.s); }
function jumpCut(dir) { const bs = boundaries(); if (!bs.length) return; const t = state.cur; let target = null; if (dir > 0) target = bs.find(b => b > t + 0.01); else { for (let i = bs.length - 1; i >= 0; i--) if (bs[i] < t - 0.01) { target = bs[i]; break; } } if (target == null) target = dir > 0 ? state.duration : 0; seek(target); }

els.btnReviveShort.addEventListener('click', () => { const hits = state.segments.filter(g => !g.keep && g.e - g.s < 0.4); if (!hits.length) { toast('0.4초 미만 삭제 구간이 없습니다'); return; } pushUndo(); for (const g of hits) g.keep = true; markDirty(); refreshAll(); toast(`${hits.length}개 구간을 되살렸습니다`); });
els.btnKeepAll.addEventListener('click', () => { pushUndo(); for (const g of state.segments) g.keep = true; markDirty(); refreshAll(); toast('모든 구간을 유지로 바꿨습니다'); });
els.segFilter.addEventListener('change', renderSegList);
els.segBody.addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]'); const tr = e.target.closest('tr[data-i]'); if (!tr || !btn) return; const i = Number(tr.dataset.i);
  if (btn.dataset.act === 'toggle') { pushUndo(); state.segments[i].keep = !state.segments[i].keep; markDirty(); refreshAll(); }
  else if (btn.dataset.act === 'seek') seek(state.segments[i].s + 0.001);
});
els.btnToggle.addEventListener('click', () => toggleSegmentAt(state.cur));
els.btnSplit.addEventListener('click', () => splitAt(state.cur));
els.btnTrimL.addEventListener('click', () => trimDelete('left'));
els.btnTrimR.addEventListener('click', () => trimDelete('right'));

function refreshAll() { updateStats(); renderSegList(); renderChapters(); updateTimeUI(); drawTimeline(); updateRenderAvailability(); updateShortsUI(); autosave(); }

function updateStats() {
  const dur = state.duration, kept = keptDuration(state.segments), removed = Math.max(0, dur - kept);
  els.stOrig.textContent = dur ? fmtClock(dur, false) : '–'; els.stAfter.textContent = dur ? fmtClock(kept, false) : '–';
  els.stSaved.textContent = dur ? '−' + fmtClock(removed, false) : '–'; els.stSavedPct.textContent = dur ? `${Math.round(removed / dur * 100)}% 줄어듭니다` : '';
  const cuts = countRemoveRuns(state.segments);
  els.stCuts.textContent = dur ? `${cuts}개` : '–'; els.stCutsNote.textContent = cuts ? `평균 ${(removed / cuts).toFixed(1)}초씩` : '';
  els.tcDur.textContent = fmtClock(dur);
}
function renderSegList() {
  const f = els.segFilter.value; const rows = []; let shown = 0;
  state.segments.forEach((g, i) => {
    if ((f === 'remove' && g.keep) || (f === 'keep' && !g.keep)) return; shown++;
    rows.push(`<tr data-i="${i}" class="${g.keep ? '' : 'is-remove'}${i === state.currentRow ? ' current' : ''}"><td class="mono muted">${i + 1}</td><td><button class="pill ${g.keep ? 'keep' : 'remove'}" data-act="toggle" title="클릭해서 전환">${g.keep ? '유지' : '삭제'}</button></td><td class="mono time"><button class="link mono" data-act="seek">${fmtClock(g.s)}</button> – ${fmtClock(g.e)}</td><td class="mono">${(g.e - g.s).toFixed(1)}s</td><td class="mono muted">${g.keep ? fmtClock(outTime(state.segments, g.s)) : '—'}</td></tr>`);
  });
  els.segBody.innerHTML = rows.join('') || `<tr><td colspan="5" class="muted">표시할 구간이 없습니다</td></tr>`;
  const removed = state.segments.filter(g => !g.keep).length;
  els.segCount.textContent = state.segments.length ? `전체 ${state.segments.length}개 · 삭제 ${removed}개 · 표시 ${shown}개` : '';
}
function highlightCurrentRow() {
  const i = state.segments.length ? segIndexAt(state.segments, state.cur) : -1;
  if (i === state.currentRow) return; state.currentRow = i;
  els.segBody.querySelectorAll('tr.current').forEach(tr => tr.classList.remove('current'));
  const tr = els.segBody.querySelector(`tr[data-i="${i}"]`); if (tr) tr.classList.add('current');
}

// ===================== CHAPTERS =====================
function addChapterAt(t) {
  if (!state.duration) return;
  if (state.chapters.some(c => Math.abs(c.t - t) < 0.5)) { toast('같은 위치에 이미 챕터가 있습니다', 1500); return; }
  pushUndo();
  const n = state.chapters.length + 1; state.chapters.push({ t, title: n === 1 && t < 1 ? '인트로' : `챕터 ${n}` }); state.chapters.sort((a, b) => a.t - b.t);
  renderChapters(); drawTimeline(); autosave(); toast(`챕터 추가: ${fmtClock(t)}`, 1400);
  if ($('#tab-export') && !$('#tab-export').hidden) { const inp = els.chBody.querySelector(`tr[data-i="${state.chapters.findIndex(c => c.t === t)}"] input`); if (inp) { inp.focus(); inp.select(); } }
}
function renderChapters() {
  els.chBody.innerHTML = state.chapters.map((c, i) => `<tr data-i="${i}"><td class="ttl"><input type="text" value="${escapeHtml(c.title)}" aria-label="챕터 제목" id="chTitle${i}"></td><td class="mono"><button class="link mono" data-act="seek">${fmtClock(c.t)}</button></td><td class="mono">${ytStamp(outTime(state.segments, c.t))}</td><td><button class="btn sm ghost" data-act="del" title="삭제">✕</button></td></tr>`).join('') || `<tr><td colspan="4" class="muted">아직 챕터가 없습니다. 재생 중 M키를 누르거나 위 버튼으로 추가하세요.</td></tr>`;
  const text = chapterLines(state.chapters, state.segments).join('\n');
  els.chText.value = text; els.chText2.value = text; els.chValid.textContent = validateChapters(state.chapters, state.segments);
}
els.chBody.addEventListener('input', e => { const tr = e.target.closest('tr[data-i]'); if (!tr || e.target.tagName !== 'INPUT') return; state.chapters[Number(tr.dataset.i)].title = e.target.value; const text = chapterLines(state.chapters, state.segments).join('\n'); els.chText.value = text; els.chText2.value = text; autosave(); });
els.chBody.addEventListener('click', e => { const btn = e.target.closest('button[data-act]'); const tr = e.target.closest('tr[data-i]'); if (!btn || !tr) return; const i = Number(tr.dataset.i); if (btn.dataset.act === 'del') { pushUndo(); state.chapters.splice(i, 1); renderChapters(); drawTimeline(); autosave(); } else if (btn.dataset.act === 'seek') seek(state.chapters[i].t); });
els.btnChapterHere.addEventListener('click', () => addChapterAt(state.cur));
els.btnChapter.addEventListener('click', () => addChapterAt(state.cur));
els.btnCopyChapters.addEventListener('click', () => copyText(els.chText.value));
els.btnCopyChapters2.addEventListener('click', () => copyText(els.chText2.value));

// ===================== PLAYBACK / SHUTTLE =====================
const bgmAudio = new Audio(); bgmAudio.preload = 'auto'; let bgmGain = 1;
function seek(t) {
  t = clamp(t, 0, state.duration || 0); state.cur = t;
  if (state.hasMedia && state.videoPlayable && els.video.readyState > 0) { try { els.video.currentTime = t; } catch {} }
  followPlayhead(); updateTimeUI(); drawTimeline();
}
function isPlaying() { return !els.video.paused && !els.video.ended; }
function updateTimeUI() {
  els.tcCur.textContent = fmtClock(state.cur); els.tcOut.textContent = fmtClock(outTime(state.segments, state.cur));
  els.btnPlay.textContent = isPlaying() ? '❚❚ 일시정지' : '▶ 재생';
  const sh = state.shuttle; els.speedBadge.textContent = sh.dir === -1 ? `◀◀ ${sh.speed}×` : (sh.dir === 1 && sh.speed > 1 ? `▶▶ ${sh.speed}×` : '');
  highlightCurrentRow();
}
function requirePlayable() { if (!state.hasMedia || !state.videoPlayable) { toast(state.hasMedia ? '이 영상은 브라우저에서 재생할 수 없습니다' : '먼저 영상을 불러오세요'); return false; } return true; }
function togglePlay() {
  if (!requirePlayable()) return;
  if (state.shuttle.dir === -1) { setShuttle(0); return; }
  if (els.video.paused) { els.video.playbackRate = state.rate; state.shuttle = { dir: 1, speed: 1, last: 0 }; if (state.cur >= state.duration - 0.05) seek(0); els.video.play().catch(() => toast('재생을 시작하지 못했습니다')); } else els.video.pause();
}
// dir: -1 reverse (J), 0 stop (K), 1 forward (L); repeated presses double the speed up to 8x
function setShuttle(dir) {
  const v = els.video;
  if (dir === 0) { state.shuttle = { dir: 0, speed: 1, last: 0 }; v.playbackRate = state.rate; v.pause(); bgmAudio.pause(); updateTimeUI(); return; }
  if (!requirePlayable()) return;
  if (dir === 1) {
    const sp = (state.shuttle.dir === 1 && isPlaying()) ? Math.min(8, state.shuttle.speed * 2) : 1;
    state.shuttle = { dir: 1, speed: sp, last: 0 }; v.playbackRate = sp === 1 ? state.rate : sp; if (state.cur >= state.duration - 0.05) seek(0); v.play().catch(() => {});
  } else {
    const sp = state.shuttle.dir === -1 ? Math.min(8, state.shuttle.speed * 2) : 1;
    v.pause(); v.playbackRate = 1; bgmAudio.pause(); state.shuttle = { dir: -1, speed: sp, last: performance.now() };
  }
  updateTimeUI();
}
els.btnPlay.addEventListener('click', togglePlay);
els.btnRev.addEventListener('click', () => setShuttle(-1)); els.btnFwd.addEventListener('click', () => setShuttle(1));
els.btnPrevCut.addEventListener('click', () => jumpCut(-1)); els.btnNextCut.addEventListener('click', () => jumpCut(1));
els.chkSkip.addEventListener('change', () => { state.skip = els.chkSkip.checked; });
// playback speed / volume / fullscreen (preview only; exports are unaffected)
els.selRate.addEventListener('change', () => { state.rate = Number(els.selRate.value) || 1; if (state.shuttle.dir !== -1) { els.video.playbackRate = state.rate; state.shuttle.speed = 1; updateTimeUI(); } els.selRate.blur(); });
let userMuted = false;
function setVolume(v, muted) { const vid = els.video; userMuted = !!muted; vid.volume = clamp(v, 0, 1); vid.muted = userMuted || !!(state.fx.tracks && state.fx.tracks.origMuted); els.rngVolume.value = Math.round(vid.volume * 100); els.btnMute.textContent = userMuted || vid.volume === 0 ? '🔇' : vid.volume < 0.5 ? '🔉' : '🔊'; lsSet('cutdiet:volume', JSON.stringify({ v: vid.volume, m: userMuted })); }
try { const sv = JSON.parse(lsGet('cutdiet:volume') || 'null'); if (sv) setVolume(Number(sv.v ?? 1), !!sv.m); } catch {}
els.rngVolume.addEventListener('input', () => setVolume(Number(els.rngVolume.value) / 100, false));
els.btnMute.addEventListener('click', () => setVolume(els.video.volume || 1, !userMuted));
function toggleFullscreen() { const m = els.monitor; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (m.requestFullscreen) m.requestFullscreen().catch(() => toast('전체 화면으로 전환하지 못했습니다')); }
els.btnFull.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => { setTimeout(() => { layoutCrop(); if (decor) decor.previewTick(false); }, 60); });
els.btnMarkIn.addEventListener('click', () => setMark('in', state.cur)); els.btnMarkOut.addEventListener('click', () => setMark('out', state.cur)); els.btnMarkDel.addEventListener('click', deleteMarked);
els.video.addEventListener('play', () => { if (state.shuttle.dir !== 1) state.shuttle = { dir: 1, speed: els.video.playbackRate === state.rate ? 1 : Math.max(1, els.video.playbackRate), last: 0 }; updateTimeUI(); });
els.video.addEventListener('pause', () => { if (state.shuttle.dir === 1) state.shuttle = { dir: 0, speed: 1, last: 0 }; bgmAudio.pause(); state.previewStop = null; updateTimeUI(); });
els.video.addEventListener('ended', () => { bgmAudio.pause(); updateTimeUI(); });
els.video.addEventListener('seeked', () => { state.cur = els.video.currentTime; updateTimeUI(); drawTimeline(); });

function speechAt(t) { if (!state.env) return false; const i = (t / HOP) | 0; return i < state.env.length && state.env[i] > state.params.threshold; }
function syncBgmPreview(playing) {
  const b = state.bgm; if (!b.ready || !b.url || (state.fx.tracks && state.fx.tracks.bgmMuted)) { if (!bgmAudio.paused) bgmAudio.pause(); return; }
  if (!playing) { if (!bgmAudio.paused) bgmAudio.pause(); return; }
  const outT = outTime(state.segments, state.cur); const total = keptDuration(state.segments);
  const mt = outT - outTime(state.segments, b.start || 0); if (mt < 0) { if (!bgmAudio.paused) bgmAudio.pause(); return; }
  let want = b.loop ? mt % b.duration : mt;
  if (!b.loop && want >= b.duration - 0.05) { if (!bgmAudio.paused) bgmAudio.pause(); return; }
  if (Math.abs(bgmAudio.currentTime - want) > 0.35) { try { bgmAudio.currentTime = want; } catch {} }
  const rate = els.video.playbackRate || 1; if (bgmAudio.playbackRate !== rate) { try { bgmAudio.playbackRate = rate; } catch {} }
  if (bgmAudio.paused) bgmAudio.play().catch(() => {});
  const target = (b.duck && speechAt(state.cur)) ? 0.3 : 1; bgmGain += (target - bgmGain) * (target < bgmGain ? 0.35 : 0.08);
  let fade = 1; if (b.fade > 0) { if (mt < b.fade) fade = mt / b.fade; const rem = total - outT; if (rem < b.fade) fade = Math.min(fade, Math.max(0, rem / b.fade)); }
  bgmAudio.volume = clamp(b.volume * bgmGain * fade, 0, 1);
}

let lastTick = 0;
function tick() {
  lastTick = performance.now();
  const v = els.video; const segs = state.segments;
  if (state.shuttle.dir === -1 && state.hasMedia && state.videoPlayable) {
    const now = performance.now(); const dt = Math.min(0.1, (now - state.shuttle.last) / 1000); state.shuttle.last = now;
    let t = state.cur - dt * state.shuttle.speed;
    if (state.skip && segs.length) { const i = segIndexAt(segs, t); const g = segs[i]; if (g && !g.keep && t >= g.s && t < g.e) { let prev = null; for (let k = i - 1; k >= 0; k--) if (segs[k].keep) { prev = segs[k]; break; } t = prev ? prev.e - 0.001 : 0; } }
    if (t <= 0) { t = 0; setShuttle(0); }
    state.cur = t; if (!v.seeking) { try { v.currentTime = t; } catch {} }
    followPlayhead(); updateTimeUI(); drawTimeline();
  } else if (state.hasMedia && state.videoPlayable && isPlaying()) {
    let t = v.currentTime;
    if (state.previewStop != null && t >= state.previewStop) { v.pause(); state.previewStop = null; }
    else if (state.skip && segs.length && !v.seeking) {
      const i = segIndexAt(segs, t); const g = segs[i];
      if (g && !g.keep && t >= g.s && t < g.e) {
        let next = null; for (let k = i + 1; k < segs.length; k++) if (segs[k].keep) { next = segs[k]; break; }
        if (next && (state.previewStop == null || next.s < state.previewStop)) { v.currentTime = next.s + 0.001; t = next.s; }
        else { v.pause(); v.currentTime = g.s; t = g.s; }
      }
    }
    state.cur = t; followPlayhead(); updateTimeUI(); drawTimeline(); syncBgmPreview(true);
  }
  if (decor) decor.previewTick(state.hasMedia && state.videoPlayable && isPlaying());
}
(function rafLoop() { tick(); requestAnimationFrame(rafLoop); })();
// rAF pauses in background tabs; keep skipping removed segments (and BGM sync) alive on a timer meanwhile
setInterval(() => { if (performance.now() - lastTick > 120) tick(); }, 60);

// ===================== KEYBOARD (CapCut-compatible) =====================
document.addEventListener('keyup', e => { const tag = (e.target && e.target.tagName) || ''; if (e.key === ' ' && (tag === 'BUTTON' || (tag === 'INPUT' && NON_TEXT_INPUTS.has(e.target.type)))) e.preventDefault(); });
document.addEventListener('keydown', e => {
  if (e.cutdietHandled) return;
  if (!els.onb.hidden) { if (e.key === 'Escape') closeOnboarding(); return; }
  const tag = (e.target && e.target.tagName) || ''; const isRange = tag === 'INPUT' && e.target.type === 'range';
  if (isTextEntry(e.target)) return;
  // Space plays/pauses even right after clicking a checkbox, slider, dropdown or button (instead of toggling that control)
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') e.target.blur(); togglePlay(); return; }
  if ((tag === 'INPUT' && !isRange) || tag === 'SELECT') return;
  if (isRange && (/^Arrow/.test(e.key) || e.key === 'Home' || e.key === 'End' || e.code === 'Comma' || e.code === 'Period')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey) {
    if (e.code === 'KeyB') { e.preventDefault(); splitAt(state.cur); }
    else if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    else if (e.code === 'KeyY') { e.preventDefault(); doRedo(); }
    return;
  }
  if (e.altKey) return;
  const fps = state.fps || 30;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'KeyJ': setShuttle(-1); break;
    case 'KeyK': setShuttle(0); break;
    case 'KeyL': setShuttle(1); break;
    case 'ArrowLeft': e.preventDefault(); seek(state.cur - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight': e.preventDefault(); seek(state.cur + (e.shiftKey ? 5 : 1)); break;
    case 'Comma': seek(state.cur - 1 / fps); break;
    case 'Period': seek(state.cur + 1 / fps); break;
    case 'KeyX': toggleSegmentAt(state.cur); break;
    case 'KeyS': splitAt(state.cur); break;
    case 'KeyQ': trimDelete('left'); break;
    case 'KeyW': trimDelete('right'); break;
    case 'Delete': case 'Backspace': e.preventDefault(); if (!deleteSelectedClip()) deleteCurrent(); break;
    case 'KeyM': addChapterAt(state.cur); break;
    case 'KeyI': setMark('in', state.cur); break;
    case 'KeyO': setMark('out', state.cur); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'Escape': if (state.marks.in != null || state.marks.out != null) clearMarks(); else return; break;
    case 'BracketLeft': jumpCut(-1); break;
    case 'BracketRight': jumpCut(1); break;
    case 'Home': e.preventDefault(); seek(0); break;
    case 'End': e.preventDefault(); seek(state.duration); break;
    default: return;
  }
});

// ===================== TIMELINE (multi-track) =====================
// Lanes, top to bottom like CapCut: ruler · 자막 · 텍스트/이미지 layers (top layer first) · NG 후보 · 영상(파형·컷) · 효과음 · 음악 · 챕터
// Clips on the 자막/텍스트·이미지/효과음/음악 lanes can be dragged (move) and trimmed at their edges; overlays move between layers.
const RULER = 18, MARKS = 16;
const LANE_H = { cap: 24, ov: 22, cand: 14, sfx: 20, bgm: 24 };
const CLIP_COLORS = { cap: '#C65A3C', text: '#7D55C7', image: '#2A8A96', sfx: '#3C7FD0', bgm: '#1E6A9E' };
const CAND_COLORS = { filler: '#E0A030', stutter: '#E5533D', repeat: '#C2185B', mumble: '#8592A3', short: '#8592A3' };
const candList = () => (trApi && trApi.getCands ? trApi.getCands() : []);
const tracks = () => state.fx.tracks || (state.fx.tracks = defaultTracks());
const isLocked = key => tracks().locked.includes(key);
function laneLayout() {
  const rows = layerCount(state.fx.overlays); const L = []; let y = RULER;
  const add = (key, kind, h, extra) => { L.push({ key, kind, y, h, ...extra }); y += h; };
  add('cap', 'cap', LANE_H.cap);
  for (let r = rows - 1; r >= 0; r--) add('ov' + r, 'ov', LANE_H.ov, { layer: r });
  if (candList().length) add('cand', 'cand', LANE_H.cand);
  add('main', 'main', window.innerWidth < 720 ? 70 : 92);
  add('sfx', 'sfx', LANE_H.sfx); add('bgm', 'bgm', LANE_H.bgm); add('marks', 'marks', MARKS);
  return { L, H: y, lane: k => L.find(l => l.key === k) };
}
function timelineGeometry() {
  const lay = laneLayout(); if (els.tl.style.height !== lay.H + 'px') els.tl.style.height = lay.H + 'px';
  const W = els.tl.clientWidth || 600, H = lay.H; const dur = Math.max(state.duration, 1e-3);
  const vis = dur / state.zoom; state.scroll = clamp(state.scroll, 0, Math.max(0, dur - vis));
  return { W, H, dur, vis, t0: state.scroll, pps: W / vis, lay };
}
function bgmSpan() {
  const b = state.bgm; if (!b.ready) return null; const start = clamp(b.start || 0, 0, state.duration);
  const off = outTime(state.segments, start); const total = keptDuration(state.segments);
  const endOut = b.loop ? total : Math.min(total, off + b.duration);
  return { s: start, e: Math.max(start + 0.05, sourceTimeAtOutput(state.segments, endOut)) };
}
// clips on a lane: [{kind, ref, s, e, label, color}]
function laneClips(l) {
  if (l.kind === 'cap') return (captionsOf() || []).map(line => ({ kind: 'cap', ref: line, s: line.s, e: line.e, label: line.text, color: CLIP_COLORS.cap }));
  if (l.kind === 'ov') return state.fx.overlays.filter(o => (o.layer || 0) === l.layer).map(o => ({ kind: 'ov', ref: o, s: o.s, e: o.e, label: (o.type === 'image' ? '🖼 ' : 'T ') + (o.name || o.text || ''), color: o.type === 'image' ? CLIP_COLORS.image : CLIP_COLORS.text }));
  if (l.kind === 'sfx') return state.fx.sfx.map(s => { const b = decor && decor.getSfxBuf(s); const d = b && b.data ? b.data.length / (b.sr || 48000) : 0.4; return { kind: 'sfx', ref: s, s: s.t, e: s.t + Math.max(0.15, d), label: s.name || s.kind, color: CLIP_COLORS.sfx }; });
  if (l.kind === 'bgm') { const sp = bgmSpan(); return sp ? [{ kind: 'bgm', ref: state.bgm, s: sp.s, e: sp.e, label: '♫ ' + (state.bgm.name || '배경음악'), color: CLIP_COLORS.bgm }] : []; }
  if (l.kind === 'cand') return candList().map(c => ({ kind: 'cand', ref: c, s: c.s, e: c.e, label: '', color: CAND_COLORS[c.kind] || CAND_COLORS.repeat }));
  return [];
}
function laneDimmed(l) { const t = tracks(); return (l.kind === 'cap' && !state.fx.subs.burn) || (l.kind === 'ov' && t.hidden.includes(l.key)) || (l.kind === 'sfx' && t.sfxMuted) || (l.kind === 'bgm' && t.bgmMuted); }
function niceStep(vis) { const target = vis / 7; return [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find(s => s >= target) || 7200; }
function roundRectPath(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawTimeline() {
  const cv = els.tl; const dpr = window.devicePixelRatio || 1; const { W, H, dur, vis, t0, pps, lay } = timelineGeometry();
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const C = { keep: cssVar('--keep'), keepSoft: cssVar('--keep-soft'), remove: cssVar('--remove'), removeSoft: cssVar('--remove-soft'), line: cssVar('--line'), lineStrong: cssVar('--line-strong'), fg: cssVar('--fg'), muted: cssVar('--muted'), play: cssVar('--play'), accent: cssVar('--accent'), surface: cssVar('--surface') };
  renderTrackHeads(lay);
  const main = lay.lane('main'); const top = main.y, bottom = main.y + main.h, h = main.h; const marks = lay.lane('marks');
  if (!state.duration) { ctx.fillStyle = C.muted; ctx.font = '12px ' + cssVar('--font-body'); ctx.textAlign = 'center'; ctx.fillText('영상을 불러오면 파형과 컷 구간, 자막·텍스트·효과음·음악 트랙이 여기 표시됩니다', W / 2, top + h / 2 + 4); return; }
  // lane backgrounds + separators
  for (const l of lay.L) { if (l.kind === 'main' || l.kind === 'marks') continue; ctx.fillStyle = C.surface; ctx.globalAlpha = l.kind === 'cand' ? 0.35 : 0.55; ctx.fillRect(0, l.y, W, l.h); ctx.globalAlpha = 1; ctx.fillStyle = C.line; ctx.fillRect(0, l.y + l.h - 1, W, 1); }
  // removed stretches are shaded across every clip lane too, so you see what will be cut under each caption/effect
  for (const g of state.segments) { if (g.keep) continue; const x0 = (g.s - t0) * pps, x1 = (g.e - t0) * pps; if (x1 < 0 || x0 > W) continue; ctx.fillStyle = C.removeSoft; ctx.globalAlpha = 0.45; ctx.fillRect(Math.max(0, x0), RULER, Math.min(W, x1) - Math.max(0, x0), top - RULER); ctx.fillRect(Math.max(0, x0), bottom, Math.min(W, x1) - Math.max(0, x0), marks.y - bottom); ctx.globalAlpha = 1; }
  // ---- main track: keep/remove, waveform ----
  for (const g of state.segments) {
    const x0 = (g.s - t0) * pps, x1 = (g.e - t0) * pps; if (x1 < 0 || x0 > W) continue;
    ctx.fillStyle = g.keep ? C.keepSoft : C.removeSoft; ctx.fillRect(Math.max(0, x0), top, Math.min(W, x1) - Math.max(0, x0), h);
  }
  // In/Out marked range
  { const m = state.marks; const xi = m.in != null ? (m.in - t0) * pps : null, xo = m.out != null ? (m.out - t0) * pps : null; ctx.fillStyle = C.accent;
    if (xi != null && xo != null) { ctx.globalAlpha = .16; ctx.fillRect(xi, top, xo - xi, h); ctx.globalAlpha = 1; }
    if (xi != null) { ctx.fillRect(xi, top, 2, h); ctx.fillRect(xi, top, 7, 2); ctx.fillRect(xi, bottom - 2, 7, 2); }
    if (xo != null) { ctx.fillRect(xo - 2, top, 2, h); ctx.fillRect(xo - 7, top, 7, 2); ctx.fillRect(xo - 7, bottom - 2, 7, 2); } }
  // shorts range band
  if (state.shorts.out > state.shorts.in && !$('#tab-shorts').hidden) { const x0 = (state.shorts.in - t0) * pps, x1 = (state.shorts.out - t0) * pps; ctx.fillStyle = '#FFD166'; ctx.globalAlpha = .18; ctx.fillRect(x0, top, x1 - x0, h); ctx.globalAlpha = 1; ctx.fillRect(x0, top, 2, h); ctx.fillRect(x1 - 2, top, 2, h); }
  if (state.env) {
    const env = state.env; let si = 0; const segs = state.segments; const muted = tracks().origMuted;
    for (let x = 0; x < W; x++) {
      const ta = t0 + x / pps, tb = t0 + (x + 1) / pps; const i0 = Math.floor(ta / HOP), i1 = Math.max(i0 + 1, Math.ceil(tb / HOP));
      let m = -100; for (let i = Math.max(0, i0); i < i1 && i < env.length; i++) if (env[i] > m) m = env[i];
      if (m <= -99) continue;
      const a = clamp((m + 72) / 62, 0, 1); const bh = Math.max(1, a * (h - 6));
      while (si < segs.length - 1 && segs[si].e <= ta) si++;
      ctx.fillStyle = (segs[si] ? segs[si].keep : true) ? C.keep : C.remove; ctx.globalAlpha = muted ? 0.3 : 0.9; ctx.fillRect(x, bottom - 3 - bh, 1, bh); ctx.globalAlpha = 1;
    }
    const ty = bottom - 3 - clamp((state.params.threshold + 72) / 62, 0, 1) * (h - 6);
    ctx.setLineDash([3, 4]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, ty + .5); ctx.lineTo(W, ty + .5); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = C.lineStrong; ctx.lineWidth = 1;
  for (let i = 1; i < state.segments.length; i++) { const x = Math.round((state.segments[i].s - t0) * pps) + .5; if (x < 0 || x > W) continue; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); }
  for (const z of state.fx.zooms) { const x0 = (z.s - t0) * pps, x1 = (z.e - t0) * pps; if (x1 < 0 || x0 > W) continue; ctx.fillStyle = C.accent; ctx.globalAlpha = .8; ctx.fillRect(Math.max(0, x0), top + 2, Math.min(W, x1) - Math.max(0, x0), 3); ctx.globalAlpha = 1; }
  // ---- clip lanes ----
  ctx.font = '10.5px ' + cssVar('--font-body'); ctx.textBaseline = 'middle';
  for (const l of lay.L) {
    if (l.kind === 'main' || l.kind === 'marks') continue;
    const clips = laneClips(l); const dim = laneDimmed(l);
    if (!clips.length && l.kind !== 'cand') { ctx.fillStyle = C.muted; ctx.globalAlpha = 0.7; ctx.textAlign = 'left'; ctx.fillText({ cap: '자막 없음 · 왼쪽 자막에서 만들거나 SRT 불러오기', ov: '텍스트·이미지 없음 · 왼쪽 텍스트에서 추가', sfx: '효과음 없음 · 왼쪽 오디오에서 추가', bgm: '음악 없음 · 왼쪽 오디오에서 넣으면 여기서 위치를 옮길 수 있습니다' }[l.kind], 8, l.y + l.h / 2); ctx.globalAlpha = 1; continue; }
    for (const c of clips) {
      const x0 = (c.s - t0) * pps, x1 = (c.e - t0) * pps; if (x1 < -2 || x0 > W + 2) continue;
      const x = Math.max(-4, x0), w = Math.max(3, Math.min(W + 4, x1) - x); const y = l.y + 2, hh = l.h - 4;
      const sel = state.selClip && state.selClip.ref === c.ref;
      if (l.kind === 'cand') { ctx.globalAlpha = c.ref.on ? 0.9 : 1; ctx.fillStyle = c.color; ctx.strokeStyle = c.color; roundRectPath(ctx, x, y, w, hh, 3); if (c.ref.on) ctx.fill(); else { ctx.lineWidth = 1.5; ctx.stroke(); } ctx.globalAlpha = 1; continue; }
      ctx.globalAlpha = dim ? 0.35 : 0.95; ctx.fillStyle = c.color; roundRectPath(ctx, x, y, w, hh, 4); ctx.fill(); ctx.globalAlpha = 1;
      if (sel) { ctx.strokeStyle = '#FFD166'; ctx.lineWidth = 2; roundRectPath(ctx, x + 1, y + 1, w - 2, hh - 2, 4); ctx.stroke(); }
      if (w > 18) { ctx.save(); ctx.beginPath(); ctx.rect(x + 3, y, w - 6, hh); ctx.clip(); ctx.fillStyle = '#fff'; ctx.globalAlpha = dim ? 0.6 : 1; ctx.textAlign = 'left'; ctx.fillText(c.label, Math.max(x, 0) + 5, y + hh / 2 + 0.5); ctx.restore(); }
    }
  }
  ctx.textBaseline = 'alphabetic';
  // ruler
  const step = niceStep(vis); ctx.font = '10px ' + cssVar('--font-mono'); ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.strokeStyle = C.lineStrong;
  ctx.beginPath(); ctx.moveTo(0, RULER + .5); ctx.lineTo(W, RULER + .5); ctx.stroke();
  for (let t = Math.ceil(t0 / step) * step; t <= t0 + vis + 1e-9; t += step) { const x = Math.round((t - t0) * pps) + .5; ctx.beginPath(); ctx.moveTo(x, RULER - 5); ctx.lineTo(x, RULER); ctx.stroke(); ctx.fillText(fmtClock(t, step < 1), x + 3, 11); }
  // chapters
  ctx.font = '10px ' + cssVar('--font-body'); const my = marks.y;
  for (const c of state.chapters) { const x = (c.t - t0) * pps; if (x < -40 || x > W + 10) continue; ctx.fillStyle = C.accent; ctx.beginPath(); ctx.moveTo(x, my + 2); ctx.lineTo(x + 6, my + 7); ctx.lineTo(x, my + 12); ctx.closePath(); ctx.fill(); ctx.fillStyle = C.fg; ctx.fillText((c.title || '').slice(0, 14), x + 9, my + 12); }
  if (state.hoverT != null) { const x = Math.round((state.hoverT - t0) * pps) + .5; ctx.strokeStyle = C.muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, my); ctx.stroke(); ctx.setLineDash([]); ctx.font = '10px ' + cssVar('--font-mono'); ctx.fillStyle = C.fg; ctx.textAlign = x > W - 60 ? 'right' : 'left'; ctx.fillText(fmtClock(state.hoverT), x + (x > W - 60 ? -4 : 4), RULER + 11); ctx.textAlign = 'left'; }
  const px = (state.cur - t0) * pps;
  if (px >= -1 && px <= W + 1) { ctx.fillStyle = C.play; ctx.fillRect(Math.round(px) - 1, 0, 2, my); ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 7); ctx.closePath(); ctx.fill(); }
  els.scroller.max = String(Math.max(0, dur - vis)); els.scroller.value = String(t0); els.scroller.disabled = state.zoom <= 1.0001;
  els.zoomLabel.textContent = state.zoom < 10 ? state.zoom.toFixed(1).replace(/\.0$/, '') + '×' : Math.round(state.zoom) + '×';
  updateCandHud();
  if (inspApi) inspApi.render();
}
// ---- track headers (DOM column left of the canvas): eye / lock / speaker ----
const HEAD_INFO = { cap: ['T', '자막'], ov: ['▣', '레이어'], cand: ['!', 'NG 후보'], main: ['▶', '영상'], sfx: ['♪', '효과음'], bgm: ['♫', '음악'] };
let headSig = '';
function headButtons(l) {
  const t = tracks(); const lock = `<button class="th-btn" data-act="lock" data-key="${l.key}" aria-pressed="${isLocked(l.key)}" title="${isLocked(l.key) ? '잠금 풀기' : '잠그기 (실수로 옮기지 않게)'}">${isLocked(l.key) ? '🔒' : '🔓'}</button>`;
  if (l.kind === 'cap') return `<button class="th-btn" data-act="eye" data-key="cap" aria-pressed="${!state.fx.subs.burn}" title="${state.fx.subs.burn ? '자막을 영상에서 숨기기 (굽기 끄기)' : '자막을 영상에 보이기 (굽기 켜기)'}">${state.fx.subs.burn ? '👁' : '🚫'}</button>` + lock;
  if (l.kind === 'ov') { const hid = t.hidden.includes(l.key); return `<button class="th-btn" data-act="eye" data-key="${l.key}" aria-pressed="${hid}" title="${hid ? '이 레이어 보이기' : '이 레이어 숨기기'}">${hid ? '🚫' : '👁'}</button>` + lock; }
  if (l.kind === 'main') return `<button class="th-btn" data-act="mute" data-key="orig" aria-pressed="${t.origMuted}" title="${t.origMuted ? '원본 소리 켜기' : '원본 소리 끄기 (음악·효과음만 남김)'}">${t.origMuted ? '🔇' : '🔊'}</button>` + lock;
  if (l.kind === 'sfx') return `<button class="th-btn" data-act="mute" data-key="sfx" aria-pressed="${t.sfxMuted}" title="${t.sfxMuted ? '효과음 켜기' : '효과음 모두 끄기'}">${t.sfxMuted ? '🔇' : '🔊'}</button>` + lock;
  if (l.kind === 'bgm') return `<button class="th-btn" data-act="mute" data-key="bgm" aria-pressed="${t.bgmMuted}" title="${t.bgmMuted ? '음악 켜기' : '음악 끄기'}">${t.bgmMuted ? '🔇' : '🔊'}</button>` + lock;
  if (l.kind === 'cand') return `<span class="th-count">${candList().filter(c => c.on).length}/${candList().length}</span>`;
  return '';
}
function renderTrackHeads(lay) {
  const box = els.tlHeads; if (!box) return;
  const sig = JSON.stringify([lay.L.map(l => l.key + l.y + ':' + l.h), tracks(), state.fx.subs.burn, candList().length, candList().filter(c => c.on).length, state.duration > 0]);
  if (sig === headSig) return; headSig = sig;
  box.style.height = lay.H + 'px';
  box.innerHTML = lay.L.filter(l => HEAD_INFO[l.kind]).map(l => { const [ic, name] = HEAD_INFO[l.kind]; const label = l.kind === 'ov' ? `${name} ${l.layer + 1}` : name; const tip = l.kind === 'ov' ? `텍스트·이미지 레이어 ${l.layer + 1} (숫자가 클수록 위에 그려짐)` : name;
    return `<div class="th th-${l.kind}${laneDimmed(l) ? ' dim' : ''}" style="top:${l.y}px;height:${l.h}px" title="${tip}"><span class="th-ic">${ic}</span><span class="th-name">${label}</span><span class="th-btns">${state.duration ? headButtons(l) : ''}</span></div>`; }).join('');
}
function toggleTrack(act, key) {
  const t = tracks();
  if (act === 'lock') { t.locked = t.locked.includes(key) ? t.locked.filter(k => k !== key) : [...t.locked, key]; toast(t.locked.includes(key) ? '트랙을 잠갔습니다' : '잠금을 풀었습니다', 1000); }
  else if (act === 'eye' && key === 'cap') { state.fx.subs.burn = !state.fx.subs.burn; if (decor) decor.syncUI(); toast(state.fx.subs.burn ? '자막을 영상에 굽습니다' : '자막을 영상에서 숨겼습니다 (SRT는 그대로)', 1600); }
  else if (act === 'eye') { t.hidden = t.hidden.includes(key) ? t.hidden.filter(k => k !== key) : [...t.hidden, key]; toast(t.hidden.includes(key) ? '이 레이어를 숨겼습니다 (미리보기·내보내기 모두)' : '레이어를 다시 보입니다', 1600); }
  else if (act === 'mute') { const k = key + 'Muted'; t[k] = !t[k]; if (key === 'orig') setVolume(els.video.volume, userMuted); if (key === 'bgm') syncBgmPreview(isPlaying()); toast(t[k] ? { orig: '원본 소리를 껐습니다 (내보내기에도 적용)', sfx: '효과음을 껐습니다', bgm: '음악을 껐습니다' }[key] : '소리를 다시 켰습니다', 1600); }
  headSig = ''; autosave(); drawTimeline(); if (decor) { decor.renderLists(); decor.previewTick(false); }
}
if (els.tlHeads) els.tlHeads.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b) toggleTrack(b.dataset.act, b.dataset.key); });
function updateCandHud() {
  const hud = els.hudCand; if (!hud) return; const t = state.cur;
  const c = candList().find(c => t >= c.s && t < c.e);
  const txt = c ? `NG 후보 · ${{ filler: '추임새', stutter: '버벅임', repeat: '다시 말한 NG', mumble: '웅얼거림', short: '짧은 소리' }[c.kind] || ''}${c.on ? ' (삭제 예정)' : ''}` : '';
  if (hud.textContent !== txt) { hud.textContent = txt; hud.hidden = !txt; if (c) hud.style.background = CAND_COLORS[c.kind] || ''; }
}
function followPlayhead() { const { vis, t0 } = timelineGeometry(); if (state.cur < t0 || state.cur > t0 + vis) state.scroll = clamp(state.cur - vis * 0.15, 0, Math.max(0, state.duration - vis)); }
function zoomAt(t, factor) { const { W, dur } = timelineGeometry(); const oldVis = dur / state.zoom; const x = (t - state.scroll) * (W / oldVis); state.zoom = clamp(state.zoom * factor, 1, 400); const newVis = dur / state.zoom; state.scroll = t - x / (W / newVis); drawTimeline(); }
els.btnZoomIn.addEventListener('click', () => zoomAt(state.cur, 1.6)); els.btnZoomOut.addEventListener('click', () => zoomAt(state.cur, 1 / 1.6)); els.btnZoomFit.addEventListener('click', () => { state.zoom = 1; state.scroll = 0; drawTimeline(); });
els.scroller.addEventListener('input', () => { state.scroll = Number(els.scroller.value); drawTimeline(); });
function eventTime(e) { const r = els.tl.getBoundingClientRect(); const { t0, pps } = timelineGeometry(); const x = clamp(e.clientX - r.left, 0, r.width); return { x, y: e.clientY - r.top, t: clamp(t0 + x / pps, 0, state.duration) }; }
function laneAt(y) { const lay = laneLayout(); return lay.L.find(l => y >= l.y && y < l.y + l.h) || null; }
function boundaryNear(x) { const { t0, pps } = timelineGeometry(); for (let i = 1; i < state.segments.length; i++) { const bx = (state.segments[i].s - t0) * pps; if (Math.abs(bx - x) <= 6) return i; } return null; }
function clipAt(l, x) { if (!l) return null; const { t0, pps } = timelineGeometry(); const cs = laneClips(l); for (let i = cs.length - 1; i >= 0; i--) { const c = cs[i]; const x0 = (c.s - t0) * pps, x1 = Math.max(x0 + 3, (c.e - t0) * pps); if (x >= x0 - 3 && x <= x1 + 3) return { ...c, x0, x1 }; } return null; }
function selectClip(c) { state.selClip = c ? { kind: c.kind, ref: c.ref } : null; if (decor && decor.selectOverlay) decor.selectOverlay(c && c.kind === 'ov' ? c.ref.id : null); drawTimeline(); }
// move/trim a clip; times are source seconds. Captions may not overlap their neighbours (one caption at a time on screen).
function setClipTime(c, s, e, layer) {
  const r = c.ref;
  if (c.kind === 'cap') { const lines = captionsOf() || []; const others = lines.filter(l => l !== r); const prev = others.filter(l => l.e <= r.s + 0.001).pop(), next = others.find(l => l.s >= r.e - 0.001); const lo = prev ? prev.e : 0, hi = next ? next.s : state.duration; const len = e - s; if (s < lo) { s = lo; if (c.mode === 'move') e = s + len; } if (e > hi) { e = hi; if (c.mode === 'move') s = Math.max(lo, e - len); } r.s = s; r.e = Math.max(s + 0.1, e); r.edited = true; }
  else if (c.kind === 'ov') { r.s = s; r.e = Math.max(s + 0.1, e); if (layer != null) r.layer = layer; }
  else if (c.kind === 'sfx') r.t = s;
  else if (c.kind === 'bgm') r.start = s;
}
let pointer = null;
els.tl.addEventListener('pointerdown', e => {
  if (!state.duration) return; els.tl.setPointerCapture(e.pointerId); els.tl.focus({ preventScroll: true });
  const { x, y, t } = eventTime(e); const l = y < RULER ? null : laneAt(y);
  if (l && l.kind === 'main') {
    selectClip(null); const b = isLocked('main') ? null : boundaryNear(x);
    if (b != null) { pushUndo(); pointer = { mode: 'boundary', idx: b }; } else { pointer = { mode: 'scrub' }; seek(t); } return;
  }
  if (l && l.kind === 'cand') { const c = clipAt(l, x); if (c) { pointer = { mode: 'none' }; seek(Math.max(0, c.s - 0.3)); return; } }
  if (l && ['cap', 'ov', 'sfx', 'bgm'].includes(l.kind)) {
    const c = clipAt(l, x);
    if (c) {
      selectClip(c);
      if (isLocked(l.key)) { toast('잠긴 트랙입니다. 왼쪽 자물쇠를 누르면 편집할 수 있습니다', 2000); pointer = { mode: 'none' }; return; }
      const edge = c.kind === 'cap' || c.kind === 'ov' ? (Math.abs(x - c.x0) <= 6 && c.x1 - c.x0 > 14 ? 'trimL' : Math.abs(x - c.x1) <= 6 && c.x1 - c.x0 > 14 ? 'trimR' : 'move') : 'move';
      pushUndo(); pointer = { mode: 'clip', clip: { ...c, mode: edge }, tStart: t, yStart: y, orig: { s: c.s, e: c.e }, moved: false }; return;
    }
    selectClip(null);
  }
  pointer = { mode: 'scrub' }; seek(t);
});
els.tl.addEventListener('pointermove', e => {
  if (!state.duration) return; const { x, y, t } = eventTime(e);
  if (pointer && pointer.mode === 'boundary') { setBoundary(pointer.idx, t); state.hoverT = null; drawTimeline(); return; }
  if (pointer && pointer.mode === 'scrub') { seek(t); return; }
  if (pointer && pointer.mode === 'clip') {
    const p = pointer, c = p.clip; const { pps } = timelineGeometry(); let dt = t - p.tStart; if (!p.moved && Math.abs(dt) * pps < 3 && Math.abs(y - p.yStart) < 5) return; p.moved = true; if (Math.abs(dt) * pps < 3) dt = 0;
    const snap = v => Math.abs(v - state.cur) * pps < 7 ? state.cur : v; const len = p.orig.e - p.orig.s;
    let s = p.orig.s, en = p.orig.e;
    if (c.mode === 'move') { s = snap(clamp(p.orig.s + dt, 0, Math.max(0, state.duration - len))); const se = snap(s + len); if (se !== s + len) s = se - len; en = s + len; }
    else if (c.mode === 'trimL') s = snap(clamp(p.orig.s + dt, 0, p.orig.e - 0.1));
    else en = snap(clamp(p.orig.e + dt, p.orig.s + 0.1, state.duration));
    let layer = null;
    if (c.kind === 'ov' && c.mode === 'move') { const l = laneAt(y); if (l && l.kind === 'ov') layer = l.layer; else if (l && l.kind === 'cap') layer = layerCount(state.fx.overlays); }
    setClipTime(c, s, en, layer); state.hoverT = null; drawTimeline(); if (decor) decor.previewTick(false); return;
  }
  state.hoverT = t; const l = y < RULER ? null : laneAt(y);
  let cur = '';
  if (l && l.kind === 'main' && !isLocked('main') && boundaryNear(x) != null) cur = 'col-resize';
  else if (l && ['cap', 'ov', 'sfx', 'bgm', 'cand'].includes(l.kind)) { const c = clipAt(l, x); if (c) cur = l.kind === 'cand' ? 'pointer' : isLocked(l.key) ? 'not-allowed' : (c.kind === 'cap' || c.kind === 'ov') && c.x1 - c.x0 > 14 && (Math.abs(x - c.x0) <= 6 || Math.abs(x - c.x1) <= 6) ? 'ew-resize' : 'grab'; }
  els.tl.style.cursor = cur; drawTimeline();
});
function endPointer() {
  const p = pointer; pointer = null; if (!p) return;
  if (p.mode === 'boundary') { markDirty(); refreshAll(); return; }
  if (p.mode !== 'clip') return;
  if (!p.moved) { popUndoSilently(); return; }
  const k = p.clip.kind;
  if (k === 'cap') { (captionsOf() || []).sort((a, b) => a.s - b.s); if (trApi) trApi.refresh(); }
  if (k === 'ov') { const o = p.clip.ref; if (state.fx.overlays.some(x => x !== o && (x.layer || 0) === (o.layer || 0) && x.s < o.e && x.e > o.s)) o.layer = layerCount(state.fx.overlays); state.fx.overlays.sort((a, b) => a.s - b.s); compactLayers(); if (decor) decor.renderLists(); toast(`${fmtClock(o.s)}–${fmtClock(o.e)} · 레이어 ${(o.layer || 0) + 1}`, 1200); }
  if (k === 'sfx') state.fx.sfx.sort((a, b) => a.t - b.t);
  if (k === 'bgm') { syncBgmPreview(isPlaying()); toast(`음악이 ${fmtClock(state.bgm.start)}(편집 후 ${fmtClock(outTime(state.segments, state.bgm.start))})부터 나옵니다`, 2000); }
  autosave(); drawTimeline(); if (decor) decor.previewTick(false);
}
// drop empty layer rows left behind after moving clips up/down
function compactLayers() { const used = [...new Set(state.fx.overlays.map(o => o.layer || 0))].sort((a, b) => a - b); const map = new Map(used.map((L, i) => [L, i])); for (const o of state.fx.overlays) o.layer = map.get(o.layer || 0); }
els.tl.addEventListener('pointerup', endPointer); els.tl.addEventListener('pointercancel', endPointer);
els.tl.addEventListener('pointerleave', () => { state.hoverT = null; els.tl.style.cursor = ''; drawTimeline(); });
els.tl.addEventListener('dblclick', e => {
  if (!state.duration) return; const { x, y, t } = eventTime(e); const l = y < RULER ? null : laneAt(y);
  if (l && l.kind === 'main') { if (boundaryNear(x) != null) return; toggleSegmentAt(t); return; }
  const c = clipAt(l, x); if (!c) return;
  if (c.kind === 'cand' && trApi) trApi.toggleCand(c.ref);
  else if (c.kind === 'cap' && trApi) trApi.focusCaption(c.ref);
  else if (c.kind === 'ov' && c.ref.type === 'text') { const v = prompt('텍스트 수정', c.ref.text); if (v != null && v.trim()) { c.ref.text = v.trim(); c.ref.name = c.ref.text.slice(0, 20); autosave(); if (decor) { decor.renderLists(); decor.previewTick(false); } drawTimeline(); } }
  else if (c.kind === 'sfx' || c.kind === 'bgm') showTab(c.kind === 'sfx' ? 'decorate' : 'bgm');
});
function deleteSelectedClip() {
  const c = state.selClip; if (!c) return false;
  const lane = c.kind === 'ov' ? 'ov' + (c.ref.layer || 0) : c.kind; if (isLocked(lane)) { toast('잠긴 트랙입니다'); return true; }
  pushUndo(); c.ref._tlDeleted = true;
  if (c.kind === 'cap') { const lines = captionsOf() || []; const i = lines.indexOf(c.ref); if (i >= 0) lines.splice(i, 1); if (trApi) trApi.refresh(); }
  else if (c.kind === 'ov') { const i = state.fx.overlays.indexOf(c.ref); if (i >= 0) state.fx.overlays.splice(i, 1); compactLayers(); if (decor) decor.renderLists(); }
  else if (c.kind === 'sfx') { const i = state.fx.sfx.indexOf(c.ref); if (i >= 0) state.fx.sfx.splice(i, 1); if (decor) decor.renderLists(); }
  else if (c.kind === 'bgm') { popUndoSilently(); toast('음악은 왼쪽 오디오에서 지울 수 있습니다'); return true; }
  state.selClip = null; autosave(); drawTimeline(); if (decor) decor.previewTick(false); toast('클립을 지웠습니다 (Ctrl+Z로 되돌리기)', 1500); return true;
}
els.tl.addEventListener('wheel', e => {
  if (!state.duration) return; e.preventDefault(); const { vis, W } = timelineGeometry(); const { t } = eventTime(e);
  if (e.ctrlKey || e.metaKey) zoomAt(t, e.deltaY < 0 ? 1.25 : 0.8); else { state.scroll += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (vis / W) * 1.5; drawTimeline(); }
}, { passive: false });
window.addEventListener('resize', () => { drawTimeline(); layoutCrop(); });
if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawTimeline); } catch {} }
new MutationObserver(drawTimeline).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// play a candidate with a little context before and after (stops by itself)
function previewSpan(s, e) { if (!requirePlayable()) return; seek(Math.max(0, s - 0.8)); state.previewStop = Math.min(state.duration, e + 0.5); els.video.playbackRate = state.rate; els.video.play().catch(() => {}); }

// ===================== MINI PLAYER =====================
// When the video scrolls out of view (working in the tabs below), it docks in the corner so you can watch while editing.
const monitorSlot = document.createElement('div'); monitorSlot.className = 'monitor-slot'; els.monitor.parentNode.insertBefore(monitorSlot, els.monitor); monitorSlot.appendChild(els.monitor);
let miniClosed = false;
function setMini(on) {
  if (on === els.monitor.classList.contains('mini')) return;
  if (on) { monitorSlot.style.height = monitorSlot.offsetHeight + 'px'; els.monitor.classList.add('mini'); } else { els.monitor.classList.remove('mini'); monitorSlot.style.height = ''; }
  setTimeout(() => { layoutCrop(); if (decor) decor.previewTick(false); }, 30);
}
if ('IntersectionObserver' in window) new IntersectionObserver(([en]) => { const out = en.intersectionRatio < 0.3; if (!out) miniClosed = false; setMini(out && !miniClosed && state.hasMedia && state.videoPlayable && !document.fullscreenElement); }, { threshold: [0, 0.3, 0.6] }).observe(monitorSlot);
els.btnMiniClose.addEventListener('click', e => { e.stopPropagation(); miniClosed = true; setMini(false); });

// ===================== TABS =====================
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
function showTab(name) {
  const names = [...document.querySelectorAll('.tab')].map(b => b.dataset.tab);
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  names.forEach(n => { const sec = $('#tab-' + n); if (sec) sec.hidden = n !== name; });
  els.cropOverlay.hidden = name !== 'shorts' || !cropRect();
  if (name === 'export') updateRenderAvailability();
  if (name === 'shorts') { updateShortsUI(); layoutCrop(); }
  drawTimeline();
}

// ===================== BGM =====================
els.btnBgmPick.addEventListener('click', () => els.bgmInput.click());
els.bgmInput.addEventListener('change', () => { const f = els.bgmInput.files && els.bgmInput.files[0]; els.bgmInput.value = ''; if (f) loadBgm(f); });
els.btnBgmClear.addEventListener('click', clearBgm);
function bgmSettingsFromUI() { const b = state.bgm; b.volume = Number(els.bgmVol.value) / 100; b.duck = els.bgmDuck.checked; b.fade = Number(els.bgmFade.value); b.loop = els.bgmLoop.checked; els.bgmVolVal.textContent = `${els.bgmVol.value}%`; els.bgmFadeVal.textContent = `${b.fade.toFixed(1)} s`; autosave(); }
['bgmVol', 'bgmDuck', 'bgmFade', 'bgmLoop'].forEach(id => els[id].addEventListener('input', bgmSettingsFromUI));
function clearBgm() { const b = state.bgm; bgmAudio.pause(); bgmAudio.removeAttribute('src'); if (b.url) URL.revokeObjectURL(b.url); Object.assign(b, { file: null, url: null, name: '', data: null, sr: 0, duration: 0, ready: false, decoding: false }); els.bgmChip.textContent = '없음'; els.bgmChip.className = 'chip'; els.btnBgmClear.hidden = true; els.bgmInfo.textContent = '15분 이하의 음악 파일을 권장합니다. 저작권이 확인된 음원(유튜브 오디오 보관함 등)을 쓰세요.'; updateRenderAvailability(); autosave(); }
async function loadBgm(file) {
  const b = state.bgm; if (b.decoding) { toast('음악을 아직 읽는 중입니다'); return; }
  clearBgm(); b.decoding = true; b.file = file; b.name = file.name; b.url = URL.createObjectURL(file); bgmAudio.src = b.url;
  els.bgmChip.textContent = '읽는 중'; els.bgmChip.className = 'chip warn'; els.bgmProgress.hidden = false; els.bgmProgress.firstElementChild.style.width = '0%';
  try {
    const r = await decodeBgm(file, p => { els.bgmProgress.firstElementChild.style.width = `${Math.round(p * 100)}%`; });
    Object.assign(b, r, { ready: true });
    els.bgmChip.textContent = '준비됨'; els.bgmChip.className = 'chip ok'; els.btnBgmClear.hidden = false;
    els.bgmInfo.textContent = `${file.name} · ${fmtClock(b.duration, false)} · ${fmtBytes(file.size)} · 미리보기 재생에서 함께 들립니다`;
    toast('배경음악을 올렸습니다. 재생해서 음량을 확인하세요', 2600);
  } catch (e) {
    console.warn(e); const tooLong = /toolong/.test(String(e.message));
    toast(tooLong ? '15분이 넘는 음악은 쓸 수 없습니다. 더 짧은 파일을 고르세요' : '이 음악 파일을 읽지 못했습니다. MP3나 WAV로 변환해 보세요', 4000); clearBgm();
  } finally { b.decoding = false; els.bgmProgress.hidden = true; updateRenderAvailability(); autosave(); }
}
async function decodeBgm(file, onProgress) {
  const mb = state.mb;
  if (mb) {
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack(); if (!track || !(await track.canDecode())) throw new Error('nodecode');
      const duration = await input.computeDuration(); if (duration > 900) throw new Error('toolong');
      const sink = new mb.AudioBufferSink(track); let data = null, sr = 0, filled = 0;
      for await (const wb of sink.buffers(0, duration)) {
        const buf = wb.buffer; if (!data) { sr = buf.sampleRate; data = new Float32Array(Math.ceil((duration + 1) * sr)); }
        const start = Math.round(wb.timestamp * sr); const ch = buf.numberOfChannels; const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
        for (let j = 0; j < buf.length && start + j < data.length; j++) { let v = 0; for (let c = 0; c < ch; c++) v += chans[c][j]; data[start + j] = v / ch; }
        filled = Math.max(filled, start + buf.length); onProgress(wb.timestamp / duration);
      }
      if (!data) throw new Error('empty');
      return { data: data.subarray(0, filled), sr, duration: filled / sr };
    } finally { input.dispose(); }
  }
  const ab = await file.arrayBuffer(); const ctx = new OfflineAudioContext(1, 1, 44100); const buf = await ctx.decodeAudioData(ab);
  if (buf.duration > 900) throw new Error('toolong');
  const data = new Float32Array(buf.length); const ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let j = 0; j < d.length; j++) data[j] += d[j] / ch; }
  onProgress(1); return { data, sr: buf.sampleRate, duration: buf.duration };
}

// ===================== SHORTS 9:16 =====================
function srcDims() { const w = state.width || els.video.videoWidth || 0, h = state.height || els.video.videoHeight || 0; return w && h ? { w, h } : null; }
function cropRect() {
  const d = srcDims(); if (!d) return null; const target = 9 / 16; let cw, ch;
  if (d.w / d.h > target) { ch = d.h; cw = Math.round(d.h * target); } else { cw = d.w; ch = Math.round(d.w / target); }
  cw = Math.min(cw, d.w) & ~1; ch = Math.min(ch, d.h) & ~1;
  const left = Math.round((d.w - cw) * state.shorts.pos) & ~1, top = Math.round((d.h - ch) * state.shorts.pos) & ~1;
  return { left, top, width: cw, height: ch, sw: d.w, sh: d.h, horizontal: d.w / d.h > target };
}
function layoutCrop() {
  const r = cropRect(); if (!r || els.cropOverlay.hidden) return;
  const M = els.monitor.getBoundingClientRect(); const a = r.sw / r.sh; let cw = M.width, ch = cw / a; if (ch > M.height) { ch = M.height; cw = ch * a; }
  const ox = (M.width - cw) / 2, oy = (M.height - ch) / 2, s = cw / r.sw;
  Object.assign(els.cropFrame.style, { left: (ox + r.left * s) + 'px', top: (oy + r.top * s) + 'px', width: (r.width * s) + 'px', height: (r.height * s) + 'px' });
}
let cropDrag = null;
els.cropFrame.addEventListener('pointerdown', e => { e.preventDefault(); els.cropFrame.setPointerCapture(e.pointerId); const r = cropRect(); if (!r) return; const M = els.monitor.getBoundingClientRect(); const a = r.sw / r.sh; let cw = M.width, ch = cw / a; if (ch > M.height) { ch = M.height; cw = ch * a; } const s = cw / r.sw; cropDrag = { x: e.clientX, y: e.clientY, pos: state.shorts.pos, range: r.horizontal ? (r.sw - r.width) * s : (r.sh - r.height) * s, horizontal: r.horizontal }; });
els.cropFrame.addEventListener('pointermove', e => { if (!cropDrag || cropDrag.range <= 0) return; const d = cropDrag.horizontal ? e.clientX - cropDrag.x : e.clientY - cropDrag.y; state.shorts.pos = clamp(cropDrag.pos + d / cropDrag.range, 0, 1); els.cropPos.value = Math.round(state.shorts.pos * 100); updateShortsUI(); layoutCrop(); });
['pointerup', 'pointercancel'].forEach(ev => els.cropFrame.addEventListener(ev, () => { cropDrag = null; autosave(); }));
els.cropPos.addEventListener('input', () => { state.shorts.pos = Number(els.cropPos.value) / 100; updateShortsUI(); layoutCrop(); autosave(); });
els.chkUpscale.addEventListener('change', () => { state.shorts.upscale = els.chkUpscale.checked; updateShortsUI(); autosave(); });
function resetShortsRange() { const ranges = keepRanges(state.segments); state.shorts.in = ranges.length ? ranges[0].s : 0; state.shorts.out = Math.min(state.duration, sourceTimeAtOutput(state.segments, outTime(state.segments, state.shorts.in) + 60)); }
els.btnShInHere.addEventListener('click', () => { state.shorts.in = state.cur; if (state.shorts.out <= state.shorts.in) state.shorts.out = Math.min(state.duration, state.shorts.in + 60); updateShortsUI(); autosave(); });
els.btnShOutHere.addEventListener('click', () => { if (state.cur <= state.shorts.in + 0.5) { toast('끝은 시작보다 뒤여야 합니다'); return; } state.shorts.out = state.cur; updateShortsUI(); autosave(); });
els.btnShAll.addEventListener('click', () => { resetShortsRange(); updateShortsUI(); autosave(); });
els.btnShPreview.addEventListener('click', () => { if (!requirePlayable()) return; state.previewStop = state.shorts.out; seek(state.shorts.in + 0.001); els.video.playbackRate = 1; els.video.play().catch(() => {}); });
function shortsRanges() { return intersectRanges(keepRanges(state.segments), state.shorts.in, state.shorts.out); }
function shortsOut() { const r = cropRect(); if (!r) return null; const w = state.shorts.upscale ? 1080 : r.width, h = state.shorts.upscale ? 1920 : r.height; return { w, h, bitrate: bitrateFor(w, h, 'high'), crop: { left: r.left, top: r.top, width: r.width, height: r.height } }; }
function shortsBlockReason() {
  const base = renderBlockReason(); if (base) return base;
  if (!cropRect()) return '영상 크기를 아직 알 수 없습니다';
  if (!shortsRanges().length) return '선택한 구간 안에 유지 구간이 없습니다';
  return null;
}
function updateShortsUI() {
  const sh = state.shorts; els.shIn.textContent = state.duration ? fmtClock(sh.in) : '–'; els.shOut.textContent = state.duration ? fmtClock(sh.out) : '–';
  const dur = rangesDuration(shortsRanges());
  els.shInfo.textContent = state.duration ? `숏츠 길이 ${fmtClock(dur, false)} (삭제 구간 제외)${dur > 180 ? ' · 3분을 넘어 쇼츠로 올라가지 않습니다' : dur > 60 ? ' · 60초 초과 (쇼츠 가능, 피드 노출은 짧을수록 유리)' : ''}` : '영상을 불러오면 설정할 수 있습니다';
  const r = cropRect();
  els.cropPosVal.textContent = sh.pos < 0.34 ? (r && !r.horizontal ? '위' : '왼쪽') : sh.pos > 0.66 ? (r && !r.horizontal ? '아래' : '오른쪽') : '가운데';
  const out = shortsOut();
  els.cropInfo.textContent = r ? `원본 ${r.sw}×${r.sh} → 크롭 ${r.width}×${r.height}${out ? ` → 출력 ${out.w}×${out.h}` : ''}` : '';
  const reason = shortsBlockReason();
  els.btnShortsRender.disabled = !!reason || !!state.rendering; els.shortsChip.textContent = reason ? '사용 불가' : '사용 가능'; els.shortsChip.className = 'chip ' + (reason ? 'warn' : 'ok');
  els.shEstimate.textContent = reason ? reason : (out ? `출력 ${out.w}×${out.h} · 약 ${(out.bitrate / 1e6).toFixed(1)} Mbps · 예상 용량 ${fmtBytes((out.bitrate + 192e3) * dur / 8)}${state.bgm.ready ? ' · 배경음악 포함' : ''}` : '');
  if (!$('#tab-shorts').hidden) layoutCrop();
}

// ===================== RENDER (MP4 + SHORTS) =====================
function heavyReason() { if (state.engineMedia) return null; return state.duration > HEAVY_LIMIT ? '1시간이 넘는 영상은 브라우저 렌더링을 지원하지 않습니다. zip 안의 FFmpeg 스크립트로 컷본을 만드세요' : null; }
function renderBlockReason() {
  if (!state.hasMedia) return '영상을 먼저 불러오세요';
  if (state.engineMedia) { if (!state.hooks.render) return '로컬 엔진과 연결이 끊겼습니다. 엔진을 다시 실행하세요'; if (state.bgm.decoding) return '배경음악을 아직 읽는 중입니다'; if (!keepRanges(state.segments).length) return '유지 구간이 없습니다'; return null; }
  if (state.mbStatus !== 'ready') return state.mbStatus === 'loading' ? '엔진을 불러오는 중입니다' : '엔진을 불러오지 못해 MP4 렌더링을 쓸 수 없습니다 (②를 이용하세요)';
  if (!('VideoEncoder' in window)) return '이 브라우저는 영상 인코딩(WebCodecs)을 지원하지 않습니다. 크롬·엣지 데스크톱에서 열어 주세요';
  if (!state.vTrack) return '영상 트랙이 없는 파일입니다';
  if (!state.canDecodeVideo) return '이 영상 코덱은 브라우저에서 디코딩할 수 없습니다 (②의 FFmpeg 스크립트를 이용하세요)';
  const heavy = heavyReason(); if (heavy) return heavy;
  if (state.bgm.decoding) return '배경음악을 아직 읽는 중입니다';
  if (!keepRanges(state.segments).length) return '유지 구간이 없습니다';
  return null;
}
function bitrateFor(w, h, q) { const pix = w * h; const base = (q === 'high' ? 10e6 : q === 'std' ? 5.5e6 : q === '1080' ? 8e6 : 4e6) * (pix / (1920 * 1080)); const fps = state.fps || 30; return Math.round(clamp(base * (fps > 40 ? 1.4 : 1), 800e3, 60e6)); }
function qualitySpec() {
  const q = els.selQuality.value; const dw = state.width || 1920, dh = state.height || 1080; const short = Math.min(dw, dh);
  let f = 1; if (q === '1080') f = Math.min(1, 1080 / short); if (q === '720') f = Math.min(1, 720 / short);
  const w = Math.max(2, Math.round(dw * f / 2) * 2), h = Math.max(2, Math.round(dh * f / 2) * 2);
  return { w, h, scaled: f < 1, bitrate: bitrateFor(w, h, q) };
}
function updateRenderAvailability() {
  const reason = renderBlockReason();
  els.btnRender.disabled = !!reason || !!state.rendering; els.renderChip.textContent = reason ? '사용 불가' : '사용 가능'; els.renderChip.className = 'chip ' + (reason ? 'warn' : 'ok'); els.renderChip.title = reason || '';
  if (reason) { els.renderEstimate.textContent = reason; return; }
  const qs = qualitySpec(); const kept = keptDuration(state.segments); const size = (qs.bitrate + 192e3) * kept / 8;
  els.renderEstimate.textContent = `출력 ${qs.w}×${qs.h} · 약 ${(qs.bitrate / 1e6).toFixed(1)} Mbps · 예상 용량 ${fmtBytes(size)} · 길이 ${fmtClock(kept, false)}${state.bgm.ready ? ' · 배경음악 포함' : ''}${state.engineMedia ? ' · 로컬 엔진(ffmpeg)으로 렌더 → 출력 폴더에 저장' : state.duration > 1800 ? ' · 30분이 넘어 시간이 오래 걸립니다' : ''}`;
}
els.selQuality.addEventListener('change', updateRenderAvailability);

const JOBS = {
  main: { btn: 'btnRender', cancel: 'btnCancelRender', resave: 'btnResave', progress: 'renderProgress', status: 'renderStatus', last: 'lastRender', suffix: '_cut' },
  shorts: { btn: 'btnShortsRender', cancel: 'btnShortsCancel', resave: 'btnShortsResave', progress: 'shortsProgress', status: 'shortsStatus', last: 'lastShorts', suffix: '_shorts' },
};
els.btnRender.addEventListener('click', () => startRender('main', false));
els.btnShortsRender.addEventListener('click', () => startRender('shorts', false));
els.btnCancelRender.addEventListener('click', () => { if (state.rendering) { state.rendering.abort.abort(); els.renderStatus.textContent = '중단하는 중…'; } });
els.btnShortsCancel.addEventListener('click', () => { if (state.rendering) { state.rendering.abort.abort(); els.shortsStatus.textContent = '중단하는 중…'; } });
els.btnResave.addEventListener('click', async () => { if (state.lastRender) await saveFile(state.lastRender.name, state.lastRender.blob); });
els.btnShortsResave.addEventListener('click', async () => { if (state.lastShorts) await saveFile(state.lastShorts.name, state.lastShorts.blob); });

async function startRender(kind, rerender) {
  const J = JOBS[kind]; const ui = { btn: els[J.btn], cancel: els[J.cancel], resave: els[J.resave], progress: els[J.progress], status: els[J.status] };
  const reason = kind === 'shorts' ? shortsBlockReason() : renderBlockReason(); if (reason) { toast(reason); return; }
  if (state.rendering) return;
  els.video.pause(); setShuttle(0);
  const abort = new AbortController(); state.rendering = { abort, kind }; updateRenderAvailability(); updateShortsUI();
  ui.cancel.hidden = false; ui.resave.hidden = true; ui.progress.hidden = false; ui.progress.firstElementChild.style.width = '0%';
  const t0 = performance.now();
  let ranges, out, crop = null;
  if (kind === 'shorts') { const so = shortsOut(); ranges = shortsRanges(); out = { w: so.w, h: so.h, bitrate: so.bitrate }; crop = so.crop; }
  else { const qs = qualitySpec(); ranges = keepRanges(state.segments); out = { w: qs.w, h: qs.h, bitrate: qs.bitrate }; }
  const setProgress = (frac, label) => { frac = clamp(frac, 0, 1); ui.progress.firstElementChild.style.width = (frac * 100).toFixed(1) + '%'; const el = (performance.now() - t0) / 1000; const eta = frac > 0.02 ? el / frac - el : null; ui.status.textContent = `${label || '렌더링'} ${Math.round(frac * 100)}% · 경과 ${fmtClock(el, false)}${eta != null ? ` · 남은 시간 약 ${fmtClock(eta, false)}` : ''}${rerender ? ' · 호환 모드' : ''}`; };
  const name = `${baseName(state.file.name)}${J.suffix}.mp4`;
  try {
    if (state.engineMedia && state.hooks.render) { // Pro: ffmpeg in the local engine, written straight into the output folder
      const r = await state.hooks.render({ kind, ranges, out, crop, quality: els.selQuality.value, fps: state.fps, name, signal: abort.signal, onProgress: setProgress });
      ui.progress.firstElementChild.style.width = '100%';
      ui.status.textContent = `완료 · ${fmtBytes(r.size || 0)} · ${fmtClock((performance.now() - t0) / 1000, false)} 걸림 · 저장: ${r.out}${r.warnings && r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''}`;
      state.activity.renders++; document.dispatchEvent(new CustomEvent('cutdiet:rendered', { detail: { kind, name: r.out, size: r.size || 0, seconds: (performance.now() - t0) / 1000, engine: true } }));
      return true;
    }
    const sink = await openRenderSink(name);
    if (sink.canceled) { ui.status.textContent = '저장 위치를 고르지 않아 렌더링을 시작하지 않았습니다.'; ui.progress.hidden = true; return false; }
    if (sink.writable) ui.status.textContent = '렌더링을 시작합니다…';
    const res = await renderMp4({ ranges, out, crop, forceTransform: rerender, signal: abort.signal, onProgress: setProgress, sink });
    ui.progress.firstElementChild.style.width = '100%';
    const took = fmtClock((performance.now() - t0) / 1000, false);
    if (res.blob) {
      state[J.last] = { blob: res.blob, name };
      ui.status.textContent = `완료 · ${fmtBytes(res.blob.size)} · ${took} 걸림.`;
      const ok = await saveFile(name, res.blob); ui.resave.hidden = false; if (!ok) ui.status.textContent += ' 저장하지 못했다면 "다시 저장"을 누르세요.';
    } else { state[J.last] = null; ui.status.textContent = `완료 · ${fmtBytes(res.size)} · ${took} 걸림 · 저장함: ${res.name}${sink.where ? ` (${sink.where})` : ''}`; toast(`저장했습니다: ${res.name}`, 3000); }
    state.activity.renders++; document.dispatchEvent(new CustomEvent('cutdiet:rendered', { detail: { kind, name, size: res.blob ? res.blob.size : res.size, seconds: (performance.now() - t0) / 1000 } }));
    return true;
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) { ui.status.textContent = '렌더링을 중단했습니다'; }
    else if (!rerender) {
      console.warn('render failed, retrying in compatibility mode', e);
      ui.status.textContent = '일반 모드 실패 → 호환 모드로 다시 시도합니다…';
      state.rendering = null; ui.cancel.hidden = true; updateRenderAvailability(); updateShortsUI();
      await sleep(300); return startRender(kind, true);
    } else { console.error(e); ui.status.textContent = '렌더링 실패: ' + (e && e.message ? e.message : e) + ' — 더 낮은 화질로 다시 시도하거나 ②의 FFmpeg 스크립트를 이용하세요.'; }
    return false;
  } finally {
    state.rendering = null; ui.cancel.hidden = true; updateRenderAvailability(); updateShortsUI();
  }
}

async function renderMp4({ ranges, out, crop, forceTransform, signal, onProgress, sink }) {
  const mb = state.mb; const { vTrack, aTrack } = state; const total = rangesDuration(ranges);
  const parts = []; const direct = sink && sink.writable ? sink.writable : null; let written = 0;
  const target = new mb.StreamTarget(new WritableStream({
    write: async chunk => { if (direct) { await direct.write({ type: 'write', position: chunk.position, data: chunk.data }); written = Math.max(written, chunk.position + chunk.data.byteLength); } else parts.push({ pos: chunk.position, blob: new Blob([chunk.data]) }); },
  }), { chunked: true });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
  const captions = captionsOf() || []; const fxR = liveFx(state.fx); const useFx = fxActive(fxR, captions.length > 0);
  const useTransform = !useFx && (forceTransform || !!crop || out.w !== state.width || out.h !== state.height);
  const vCodec = await mb.getFirstEncodableVideoCodec(['avc', 'hevc', 'av1', 'vp9'], { width: out.w, height: out.h, bitrate: out.bitrate });
  if (!vCodec) throw new Error('이 해상도로 인코딩할 수 있는 코덱이 없습니다');
  const vConfig = { codec: vCodec, bitrate: out.bitrate, keyFrameInterval: 2, sizeChangeBehavior: 'contain' };
  if (useTransform) { vConfig.transform = { width: out.w, height: out.h, fit: 'fill', force: true }; if (crop) vConfig.transform.crop = crop; }
  const vSource = new mb.VideoSampleSource(vConfig);
  const meta = {}; if (!useTransform && !useFx) { meta.rotation = state.rotation || 0; try { meta.flip = await vTrack.getFlip(); } catch {} }
  output.addVideoTrack(vSource, meta);
  let comp = null, fxCanvas = null, fxCtx = null;
  if (useFx) {
    await preloadFonts(state.fx, state.fx.subs.burn ? captions.map(l => l.text) : []);
    fxCanvas = new OffscreenCanvas(out.w, out.h); fxCtx = fxCanvas.getContext('2d');
    comp = makeCompositor({ W: out.w, H: out.h, crop: crop || { left: 0, top: 0, width: state.width, height: state.height }, fx: fxR, captions: state.fx.subs.burn ? captions : null, ranges, total });
  }
  const tk = state.fx.tracks || {}; const origMuted = !!tk.origMuted;
  const bgm = state.bgm.ready && !tk.bgmMuted ? { ...state.bgm, offset: outTime(state.segments, state.bgm.start || 0) } : null;
  let aSource = null, aSr = 48000, aCh = 2;
  if (aTrack || bgm || fxR.sfx.length) {
    if (aTrack) { aCh = await aTrack.getNumberOfChannels(); aSr = await aTrack.getSampleRate(); }
    const aCodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: aCh, sampleRate: aSr, bitrate: 192000 });
    if (aCodec) { aSource = new mb.AudioBufferSource({ codec: aCodec, bitrate: 192000 }); output.addAudioTrack(aSource); }
    else toast('이 브라우저에서 쓸 수 있는 오디오 인코더가 없어 소리 없이 렌더링됩니다', 4000);
  }
  await output.start();
  const fps = state.fps || 30; let vProgress = 0;
  const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
  const videoPump = async () => {
    const sink = new mb.VideoSampleSink(vTrack); let cursor = 0, lastTs = -1;
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri]; let first = true;
      for await (const sample of sink.samples(r.s, r.e)) {
        if (signal.aborted) { sample.close(); throw abortErr(); }
        const srcTs = Math.max(sample.timestamp, r.s); const srcEnd = Math.min(sample.timestamp + (sample.duration || 1 / fps), r.e);
        if (srcEnd <= srcTs + 1e-6) { sample.close(); continue; }
        let ts = cursor + (srcTs - r.s); if (ts <= lastTs) ts = lastTs + 0.0005;
        const dur = Math.max(0.001, srcEnd - srcTs);
        if (comp) {
          comp.draw(fxCtx, (c, sx, sy, sw, sh, dx, dy, dw, dh) => sample.draw(c, sx, sy, sw, sh, dx, dy, dw, dh), srcTs, ts, ri, cursor); sample.close();
          const vs = new mb.VideoSample(fxCanvas, { timestamp: ts, duration: dur });
          await vSource.add(vs, first ? { keyFrame: true } : undefined); vs.close();
        } else {
          sample.setTimestamp(ts); sample.setDuration(dur);
          await vSource.add(sample, first ? { keyFrame: true } : undefined); sample.close();
        }
        lastTs = ts; first = false; vProgress = ts; onProgress(ts / total);
      }
      if (comp) comp.endRange(fxCanvas);
      cursor += r.e - r.s;
    }
  };
  const duckState = { g: 1 }; const thr = state.params.threshold;
  const audioPump = async () => {
    if (!aSource) return; let cursor = 0;
    if (aTrack) {
      const sink = new mb.AudioBufferSink(aTrack);
      for (const r of ranges) {
        for await (const wb of sink.buffers(r.s, r.e)) {
          if (signal.aborted) throw abortErr();
          const sliced = sliceAudio(wb, r.s, r.e); if (!sliced) continue;
          const srcStart = Math.max(wb.timestamp, r.s); const outStart = cursor + (srcStart - r.s);
          while (outStart > vProgress + 4 && !signal.aborted) await sleep(40);
          if (bgm || fxR.sfx.length || origMuted) {
            const chans = []; for (let c = 0; c < sliced.buffer.numberOfChannels; c++) chans.push(sliced.buffer.getChannelData(c));
            if (origMuted) for (const ch of chans) ch.fill(0);
            if (bgm) mixBgmInto(chans, sliced.buffer.sampleRate, outStart, srcStart, bgm, state.env, HOP, thr, total, duckState);
            if (fxR.sfx.length && decor) mixSfxInto(chans, sliced.buffer.sampleRate, srcStart, fxR.sfx, s => decor.getSfxBuf(s, sliced.buffer.sampleRate));
          }
          await aSource.add(sliced.buffer);
        }
        cursor += r.e - r.s;
      }
    } else {
      // no voice track: background music (and effects) only
      for (let outT = 0; outT < total; outT += 1) {
        if (signal.aborted) throw abortErr();
        const len = Math.round(Math.min(1, total - outT) * aSr); if (len <= 0) break;
        const buf = new AudioBuffer({ length: len, sampleRate: aSr, numberOfChannels: aCh });
        const chans = []; for (let c = 0; c < aCh; c++) chans.push(buf.getChannelData(c));
        if (bgm) mixBgmInto(chans, aSr, outT, 0, { ...bgm, duck: false }, null, HOP, thr, total, duckState);
        if (fxR.sfx.length && decor) mixSfxInto(chans, aSr, sourceTimeAtOutput(state.segments, outT), fxR.sfx, s => decor.getSfxBuf(s, aSr));
        while (outT > vProgress + 4 && !signal.aborted) await sleep(40);
        await aSource.add(buf);
      }
    }
  };
  try { await Promise.all([videoPump(), audioPump()]); }
  catch (e) { try { await output.cancel(); } catch {} if (direct) { try { await direct.abort(); } catch {} } throw e; }
  await output.finalize();
  if (direct) { await direct.close(); return { size: written, name: sink.name }; }
  return { blob: assembleBlob(parts, 'video/mp4') };
}
// returns {buffer} trimmed to [s,e] (a fresh AudioBuffer when partial; the original when whole)
function sliceAudio(wb, s, e) {
  const { buffer, timestamp } = wb; const sr = buffer.sampleRate, len = buffer.length; const bEnd = timestamp + len / sr;
  const from = Math.max(timestamp, s), to = Math.min(bEnd, e); if (to <= from) return null;
  const i0 = Math.max(0, Math.round((from - timestamp) * sr)), i1 = Math.min(len, Math.round((to - timestamp) * sr)); if (i1 <= i0) return null;
  if (i0 === 0 && i1 === len) return { buffer };
  const out = new AudioBuffer({ length: i1 - i0, sampleRate: sr, numberOfChannels: buffer.numberOfChannels });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(i0, i1), c);
  return { buffer: out };
}

// ===================== THUMBNAILS =====================
let thumbVideo = null;
async function grabFrames(times, maxW) {
  const out = []; if (!times.length) return out;
  if (state.engineMedia && state.hooks.frames) return state.hooks.frames(times, maxW);
  if (state.mb && state.vTrack && state.canDecodeVideo) {
    const sink = new state.mb.VideoSampleSink(state.vTrack); let k = 0;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      const t = times[k++]; if (!sample) { out.push({ t, canvas: null }); continue; }
      const dw = sample.displayWidth, dh = sample.displayHeight; const sc = maxW ? Math.min(1, maxW / dw) : 1;
      const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(dw * sc)); c.height = Math.max(2, Math.round(dh * sc));
      sample.draw(c.getContext('2d'), 0, 0, c.width, c.height); sample.close(); out.push({ t, canvas: c });
    }
    return out;
  }
  if (!state.videoPlayable) throw new Error('이 영상은 브라우저에서 프레임을 꺼낼 수 없습니다');
  if (!thumbVideo || thumbVideo.dataset.src !== state.fileURL) { thumbVideo = document.createElement('video'); thumbVideo.muted = true; thumbVideo.preload = 'auto'; thumbVideo.src = state.fileURL; thumbVideo.dataset.src = state.fileURL; await new Promise((res, rej) => { thumbVideo.addEventListener('loadeddata', res, { once: true }); thumbVideo.addEventListener('error', () => rej(new Error('video load failed')), { once: true }); }); }
  for (const t of times) {
    await new Promise(res => { thumbVideo.addEventListener('seeked', res, { once: true }); thumbVideo.currentTime = t; });
    const dw = thumbVideo.videoWidth, dh = thumbVideo.videoHeight; const sc = maxW ? Math.min(1, maxW / dw) : 1;
    const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(dw * sc)); c.height = Math.max(2, Math.round(dh * sc));
    c.getContext('2d').drawImage(thumbVideo, 0, 0, c.width, c.height); out.push({ t, canvas: c });
  }
  return out;
}
function thumbName(t) { return `${baseName(state.file ? state.file.name : 'video')}_thumb_${fmtClock(t, false).replace(/:/g, '-')}.jpg`; }
async function pickThumbs() {
  if (!state.hasMedia) { toast('먼저 영상을 불러오세요'); return 0; }
  const times = pickThumbnailTimes(state.env, HOP, state.segments, 12); if (!times.length) { toast('유지 구간이 없습니다'); return 0; }
  els.btnThumbs.disabled = true; els.thumbsInfo.textContent = '프레임을 꺼내는 중…'; els.thumbGrid.innerHTML = '';
  try {
    const frames = await grabFrames(times, 480); state.thumbs = frames.filter(f => f.canvas); state.thumbSel = -1;
    els.thumbGrid.innerHTML = '';
    state.thumbs.forEach((f, i) => { const d = document.createElement('div'); d.className = 'thumb'; d.dataset.i = i; d.appendChild(f.canvas); const m = document.createElement('div'); m.className = 'tmeta'; m.innerHTML = `<button class="link mono" data-act="seek">${fmtClock(f.t)}</button><button class="btn sm" data-act="save">JPG 저장</button>`; d.appendChild(m); els.thumbGrid.appendChild(d); });
    els.btnThumbsZip.hidden = !state.thumbs.length; els.thumbsInfo.textContent = `${state.thumbs.length}장을 골랐습니다. 클릭하면 그 위치로 이동하고, JPG 저장은 원본 해상도로 저장합니다.`;
  } catch (e) { console.warn(e); els.thumbsInfo.textContent = '프레임을 꺼내지 못했습니다: ' + (e.message || e); }
  finally { els.btnThumbs.disabled = false; }
  return state.thumbs.length;
}
els.btnThumbs.addEventListener('click', pickThumbs);
els.thumbGrid.addEventListener('click', async e => {
  const d = e.target.closest('.thumb'); if (!d) return; const i = Number(d.dataset.i); const f = state.thumbs[i]; if (!f) return;
  const act = e.target.closest('button[data-act]');
  if (act && act.dataset.act === 'save') { act.disabled = true; try { const [full] = await grabFrames([f.t], 0); if (!full || !full.canvas) throw new Error('frame'); await saveFile(thumbName(f.t), await canvasToJpeg(full.canvas)); } catch (err) { toast('프레임을 저장하지 못했습니다'); } finally { act.disabled = false; } return; }
  els.thumbGrid.querySelectorAll('.thumb.sel').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); state.thumbSel = i; seek(f.t);
});
els.btnThumbNow.addEventListener('click', async () => { if (!state.hasMedia) { toast('먼저 영상을 불러오세요'); return; } els.btnThumbNow.disabled = true; try { const [full] = await grabFrames([state.cur], 0); if (!full || !full.canvas) throw new Error('frame'); await saveFile(thumbName(state.cur), await canvasToJpeg(full.canvas)); } catch (err) { toast('프레임을 저장하지 못했습니다: ' + (err.message || err)); } finally { els.btnThumbNow.disabled = false; } });
async function saveThumbsZip() {
  if (!state.thumbs.length) return false; els.btnThumbsZip.disabled = true; els.thumbsInfo.textContent = '원본 해상도로 다시 꺼내는 중…';
  if (state.engineMedia && state.hooks.saveThumbs) { try { const r = await state.hooks.saveThumbs(state.thumbs.map(f => f.t)); els.thumbsInfo.textContent = `${r.files.length}장을 저장했습니다: ${r.dir}`; return true; } catch (e) { toast('썸네일 저장 실패: ' + e.message); return false; } finally { els.btnThumbsZip.disabled = false; } }
  try { const full = await grabFrames(state.thumbs.map(f => f.t), 0); const files = []; for (const f of full) { if (!f.canvas) continue; files.push({ name: thumbName(f.t), data: new Uint8Array(await (await canvasToJpeg(f.canvas)).arrayBuffer()) }); } await saveFile(`${baseName(state.file.name)}_thumbnails.zip`, buildZip(files)); els.thumbsInfo.textContent = `${files.length}장을 zip으로 저장했습니다.`; return true; }
  catch (e) { toast('zip을 만들지 못했습니다'); els.thumbsInfo.textContent = ''; return false; } finally { els.btnThumbsZip.disabled = false; }
}
els.btnThumbsZip.addEventListener('click', saveThumbsZip);

// ===================== EXPORT: ZIP / FFMPEG / PROJECT =====================
function currentFps() { const v = parseFloat(els.fpsInput.value); return v > 0 && v < 1000 ? v : (state.fps || 30); }
function exportNames() { const inName = state.file ? state.file.name : (state.isDemo ? '예시영상.mp4' : 'video.mp4'); const base = baseName(inName); return { inName, base, outName: `${base}_cut.mp4` }; }
function ffmpegPlan() {
  const ranges = keepRanges(state.segments); const { inName, base, outName } = exportNames(); const b = state.bgm;
  const bgm = b.ready ? { name: b.name, volume: b.volume, duck: b.duck, fade: b.fade, loop: b.loop } : null;
  return { ranges, inName, base, outName, ff: buildFFmpeg(ranges, inName, outName, { bgm, hasVoice: !!state.aTrack || !state.mb, kept: keptDuration(state.segments) }) };
}
els.btnCopyFfmpeg.addEventListener('click', () => { const { ranges, ff } = ffmpegPlan(); if (!ranges.length) { toast('유지 구간이 없습니다'); return; } copyText(ff.useScript ? ff.scriptCmd + '\n# 필터 파일이 필요합니다. "컷 패키지 저장"의 zip 안에 들어 있습니다.' : ff.inline); });
els.btnZip.addEventListener('click', async () => {
  const { ranges, inName, base, outName, ff } = ffmpegPlan(); if (!ranges.length) { toast('유지 구간이 없습니다'); return; }
  const fps = currentFps(); const kept = keptDuration(state.segments);
  const edl = buildEDL(base, ranges, fps, inName);
  const fcp = buildFCPXML(base, ranges, fps, inName, state.width, state.height, state.duration, !!state.aTrack || !state.mb);
  const sh = `#!/bin/sh\n# 컷다이어트 — 원본 영상${state.bgm.ready ? '과 음악 파일' : ''}과 같은 폴더에서 실행: sh ffmpeg_cut.sh\ncd "$(dirname "$0")"\n${ff.scriptCmd}\n`;
  const bat = `@echo off\r\nrem 컷다이어트 — 원본 영상${state.bgm.ready ? '과 음악 파일' : ''}과 같은 폴더에서 더블클릭\r\ncd /d "%~dp0"\r\n${ff.scriptCmd}\r\npause\r\n`;
  const readme = [`컷다이어트 컷 패키지`, `원본: ${inName}`, `원본 길이: ${fmtClock(state.duration, false)} → 편집 후: ${fmtClock(kept, false)} (유지 구간 ${ranges.length}개)`, state.bgm.ready ? `배경음악: ${state.bgm.name} (음량 ${Math.round(state.bgm.volume * 100)}%${state.bgm.duck ? ', 덕킹' : ''}${state.bgm.loop ? ', 반복' : ''}, 페이드 ${state.bgm.fade}s) — FFmpeg 스크립트에만 반영됩니다` : '', '',
    `[캡컷] 컷다이어트에서 만든 MP4를 그대로 가져오세요 (EDL/XML 미지원)`,
    `[프리미어 프로] 파일 > 가져오기 > ${base}.edl → 생성된 시퀀스의 오프라인 클립을 우클릭 > 미디어 연결 > 원본 영상 선택`,
    `[다빈치 리졸브] 원본 영상을 미디어 풀에 먼저 넣고 File > Import > Timeline > ${base}.edl 또는 ${base}.fcpxml`,
    `[파이널컷] 파일 > 가져오기 > XML > ${base}.fcpxml → 미디어 재연결 창에서 원본 영상 지정`,
    `[FFmpeg] 이 폴더의 파일들을 원본 영상과 같은 폴더에 두고 Mac: sh ffmpeg_cut.sh / Windows: ffmpeg_cut.bat 실행 → ${outName} 생성`,
    `  (ffmpeg 설치: Mac "brew install ffmpeg", Windows: ffmpeg.org 에서 받아 PATH에 추가)`,
    `[유튜브 챕터] chapters.txt 내용을 설명란에 붙여넣기`, `[프로젝트] ${base}.cutdiet.json 을 컷다이어트에서 불러오면 작업을 이어갈 수 있습니다`, '',
    `EDL/FCPXML 타임코드 프레임레이트: ${fps} (NON-DROP FRAME). 편집 프로그램의 시퀀스 프레임레이트와 같아야 합니다.`].filter(l => l !== '' || true).join('\n');
  const files = [
    { name: `${base}.edl`, data: edl }, { name: `${base}.fcpxml`, data: fcp },
    { name: 'ffmpeg_cut.sh', data: sh }, { name: 'ffmpeg_cut.bat', data: bat },
    { name: 'cut_video_filter.txt', data: ff.filterV }, { name: 'cut_audio_filter.txt', data: ff.filterA },
  ];
  if (ff.complex) files.push({ name: 'cut_filter_complex.txt', data: ff.complex }); else files.push({ name: 'ffmpeg_command_inline.txt', data: ff.inline });
  if (state.bgm.ready && state.bgm.file && state.bgm.file.size < 30e6) { try { files.push({ name: state.bgm.name, data: new Uint8Array(await state.bgm.file.arrayBuffer()) }); } catch {} }
  files.push({ name: 'chapters.txt', data: chapterLines(state.chapters, state.segments).join('\n') || '(챕터 없음)' }, { name: `${base}.cutdiet.json`, data: JSON.stringify(projectData(), null, 1) }, { name: 'README.txt', data: readme });
  await saveFile(`${base}_cut_package.zip`, buildZip(files));
});

function projectData() {
  const b = state.bgm, sh = state.shorts;
  return { app: 'cutdiet', version: 2, savedAt: new Date().toISOString(), file: state.file ? { name: state.file.name, size: state.file.size } : null, duration: state.duration, fps: state.fps, preset: state.preset, params: { ...state.params }, dirty: state.dirty,
    segments: state.segments.map(g => [Math.round(g.s * 1000) / 1000, Math.round(g.e * 1000) / 1000, g.keep ? 1 : 0]), chapters: state.chapters.map(c => [Math.round(c.t * 1000) / 1000, c.title]),
    bgm: { name: b.name || '', volume: b.volume, duck: b.duck, fade: b.fade, loop: b.loop, start: b.start || 0 }, shorts: { in: sh.in, out: sh.out, pos: sh.pos, upscale: sh.upscale }, fx: fxToJSON(state.fx),
    captions: (captionsOf() || []).map(l => [Math.round(l.s * 1000) / 1000, Math.round(l.e * 1000) / 1000, l.text, l.edited ? 1 : 0]) };
}
function applyProject(p) {
  if (!p || p.app !== 'cutdiet' || !Array.isArray(p.segments)) throw new Error('bad project');
  if (!state.hasMedia) { state.isDemo = false; state.env = null; state.duration = Number(p.duration) || 0; state.fps = Number(p.fps) || 30; els.fpsInput.value = String(state.fps); els.hudState.textContent = '프로젝트만 열림'; els.monitorEmpty.hidden = false; els.monitorEmpty.querySelector('.me-title').textContent = '프로젝트만 불러왔습니다'; els.monitorEmpty.querySelector('p').textContent = '원본 영상을 불러오면 파형과 미리보기가 다시 표시됩니다.'; }
  else if (Math.abs((Number(p.duration) || 0) - state.duration) > 0.5) toast('프로젝트의 영상 길이가 현재 영상과 다릅니다. 구간이 어긋날 수 있습니다', 4000);
  undoReset();
  state.segments = p.segments.map(([s, e, k]) => ({ s: Number(s), e: Number(e), keep: !!k })).filter(g => g.e > g.s).sort((a, b) => a.s - b.s);
  state.chapters = (p.chapters || []).map(([t, title]) => ({ t: Number(t), title: String(title || '') }));
  if (p.params) state.params = { ...state.params, ...p.params };
  state.preset = p.preset || 'custom';
  if (p.bgm) { const b = state.bgm; b.volume = Number(p.bgm.volume) || b.volume; b.duck = p.bgm.duck !== false; b.fade = Number(p.bgm.fade ?? b.fade); b.loop = p.bgm.loop !== false; b.start = Math.max(0, Number(p.bgm.start) || 0); els.bgmVol.value = Math.round(b.volume * 100); els.bgmDuck.checked = b.duck; els.bgmFade.value = b.fade; els.bgmLoop.checked = b.loop; els.bgmVolVal.textContent = `${els.bgmVol.value}%`; els.bgmFadeVal.textContent = `${b.fade.toFixed(1)} s`; if (p.bgm.name && !b.ready) els.bgmInfo.textContent = `이전 작업의 음악 "${p.bgm.name}"은 파일을 다시 선택해야 합니다 (브라우저에는 음악 파일이 저장되지 않습니다).`; }
  if (p.shorts) { Object.assign(state.shorts, { in: Number(p.shorts.in) || 0, out: Number(p.shorts.out) || 0, pos: clamp(Number(p.shorts.pos ?? 0.5), 0, 1), upscale: p.shorts.upscale !== false }); els.cropPos.value = Math.round(state.shorts.pos * 100); els.chkUpscale.checked = state.shorts.upscale; }
  if (Array.isArray(p.captions) && tr && tr.setLines) tr.setLines(p.captions.filter(Array.isArray).map(([s, e, text, ed]) => ({ s, e, text, edited: !!ed })));
  if (p.fx) { state.fx = fxFromJSON(p.fx); if (decor) decor.rehydrate(); setVolume(els.video.volume, userMuted); }
  state.dirty = p.dirty !== false; syncSliders(); if (state.dirty) markDirty(); else { els.btnReanalyze.hidden = true; els.dirtyHint.hidden = true; }
  state.cur = 0; state.zoom = 1; state.scroll = 0; refreshAll();
}
function projKey() { return state.file ? `${LS_PREFIX}${state.file.name}:${state.file.size}` : null; }
let autosaveT = 0;
function autosave() { const k = projKey(); if (!k || state.isDemo || state.autosaveBlocked) return; clearTimeout(autosaveT); autosaveT = setTimeout(() => { if (!state.autosaveBlocked) lsSet(k, JSON.stringify(projectData())); }, 600); }
function loadSavedProject() { const k = projKey(); if (!k) return null; try { const raw = lsGet(k); return raw ? JSON.parse(raw) : null; } catch { return null; } }
async function saveProjectFile() { if (!state.duration) { toast('저장할 작업이 없습니다'); return; } const base = state.file ? baseName(state.file.name) : 'cutdiet'; await saveFile(`${base}.cutdiet.json`, JSON.stringify(projectData(), null, 1)); }
els.btnSaveProject.addEventListener('click', saveProjectFile); els.btnSaveProject2.addEventListener('click', saveProjectFile);
els.btnLoadProject.addEventListener('click', () => els.projectInput.click()); els.btnLoadProject2.addEventListener('click', () => els.projectInput.click());
els.projectInput.addEventListener('change', async () => { const f = els.projectInput.files && els.projectInput.files[0]; els.projectInput.value = ''; if (!f) return; try { applyProject(JSON.parse(await f.text())); toast('프로젝트를 불러왔습니다'); } catch { toast('프로젝트 파일을 읽지 못했습니다'); } });

// ===================== ONBOARDING =====================
function openOnboarding() { els.onb.hidden = false; els.onbStart.focus(); }
function closeOnboarding() { els.onb.hidden = true; lsSet('cutdiet:onboarded', '1'); }
els.onbStart.addEventListener('click', closeOnboarding);
els.onbGuide.addEventListener('click', () => { closeOnboarding(); showTab('guide'); $('#tab-guide').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
els.onb.addEventListener('click', e => { if (e.target === els.onb) closeOnboarding(); });
els.btnHelp.addEventListener('click', openOnboarding);

// ===================== DEMO / BOOT =====================
function bootDemo() {
  const d = demoEnvelope(HOP); state.env = d.env; state.duration = d.duration; state.fps = 30; state.width = 1920; state.height = 1080; state.isDemo = true;
  state.autoThreshold = suggestThreshold(state.env);
  const savedPreset = lsGet('cutdiet:preset'); if (savedPreset && PRESETS[savedPreset]) state.preset = savedPreset;
  applyPreset(state.preset, { silent: true });
  state.chapters = [{ t: 1.2, title: '인트로' }, { t: 33.6, title: '핵심 개념' }, { t: 73.5, title: '정리' }];
  els.hudState.textContent = '예시 데이터 · 내 영상을 불러오면 바뀝니다'; els.fpsInput.value = '30';
  resetShortsRange(); bgmSettingsFromUI(); refreshAll(); undoReset();
  if (!lsGet('cutdiet:onboarded') && !document.body.classList.contains('pro')) openOnboarding();
}
bootDemo();

// ===================== AI (in-browser transcription) =====================
function markSpans(spans, keep = false) { if (!spans.length) return 0; pushUndo(); state.activity.aiApplied += spans.length; let segs = state.segments; for (const sp of spans) segs = applySpan(segs, clamp(sp.s, 0, state.duration), clamp(sp.e, 0, state.duration), keep); state.segments = segs; markDirty(); refreshAll(); return spans.length; }
const tr = initTranscribe({ state, HOP, pushUndo, toast, saveFile, copyText, outTime, keptDuration, fmtClock, baseName, seek, sleep, nextFrame, markSpans, heavyReason, escapeHtml, accumulateEnergy, autosave,
  play: () => { if (els.video.paused) togglePlay(); }, previewSpan, showTab, candsChanged: () => drawTimeline(), captionsChanged: () => { if (decor) { decor.renderLists(); decor.previewTick(false); } } });
if (tr && tr.getLines) captionsOf = tr.getLines;
trApi = tr;

decor = initDecorate({ state, els, toast, fmtClock, seek, refreshAll, autosave, keepRanges, keptDuration, outTime, segIndexAt, escapeHtml, captionsOf: () => captionsOf(), captionsChanged: () => { if (tr && tr.refresh) tr.refresh(); drawTimeline(); }, selectionChanged: c => { state.selClip = c && c.ref ? c : null; drawTimeline(); } });
// right-hand inspector: properties of the selected clip
inspApi = initInspector({ state, fmtClock, escapeHtml, toast, showTab, seek, captionsOf: () => captionsOf(),
  play: () => { if (els.video.paused) togglePlay(); }, split: () => splitAt(state.cur), del: () => deleteSelectedClip(), select: c => selectClip(c),
  changed: (c, typing) => { autosave(); if (c.kind === 'cap' && trApi) { if (!typing) (captionsOf() || []).sort((a, b) => a.s - b.s); trApi.refresh(); } if (decor) { decor.renderLists(); decor.previewTick(false); } if (c.kind === 'bgm') syncBgmPreview(isPlaying()); drawTimeline(); } });
document.getElementById('btnTopExport').addEventListener('click', () => showTab('export'));
window.addEventListener('resize', () => decor && decor.previewTick(false));

// Public API used by the Pro layer (src/pro.js)
window.cutdiet = {
  state, els, HOP, PRESETS, toast, saveFile, copyText, fmtClock, fmtBytes, baseName, sleep, openFile, applyPreset, startRender, pickThumbs, saveThumbsZip, saveProjectFile, projectData,
  keptDuration, countRemoveRuns, keepRanges, outTime, chapterLines, buildZip, showTab, seek, refreshAll, renderBlockReason, shortsBlockReason, heavyReason, loadBgm, clearBgm, resetShortsRange,
  notice, escapeHtml, fsAccess, updateRenderAvailability, pickThumbnailTimes: (count = 12) => pickThumbnailTimes(state.env, HOP, state.segments, count), captionsOf: () => captionsOf(),
  undoDepth: () => undo.stack.length,
  actions: { play: togglePlay, rev: () => setShuttle(-1), stop: () => setShuttle(0), fwd: () => setShuttle(1), toggle: () => toggleSegmentAt(state.cur), split: () => splitAt(state.cur), trimL: () => trimDelete('left'), trimR: () => trimDelete('right'), del: () => { if (!deleteSelectedClip()) deleteCurrent(); }, chapter: () => addChapterAt(state.cur), undo: doUndo, redo: doRedo, prevCut: () => jumpCut(-1), nextCut: () => jumpCut(1), home: () => seek(0), end: () => seek(state.duration), back1: () => seek(state.cur - 1), fwd1: () => seek(state.cur + 1), frameBack: () => seek(state.cur - 1 / (state.fps || 30)), frameFwd: () => seek(state.cur + 1 / (state.fps || 30)), markIn: () => setMark('in', state.cur), markOut: () => setMark('out', state.cur), fullscreen: toggleFullscreen },
};
document.dispatchEvent(new CustomEvent('cutdiet:ready'));
