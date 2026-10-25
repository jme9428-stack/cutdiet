// Pro: client for the local engine (engine/server.mjs). Active only when the page is served by the engine itself
// (http://127.0.0.1:7797). Installs hooks on window.cutdiet.state.hooks so the main app renders/analyzes through ffmpeg.
const H = { 'x-cutdiet-engine': '1' };
const isLocal = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function api(p, body, opts = {}) {
  const r = await fetch('/api' + p, { method: body === undefined ? 'GET' : 'POST', headers: { ...H, ...(body !== undefined && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }, body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), signal: opts.signal });
  const ct = r.headers.get('content-type') || ''; const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || (typeof data === 'string' ? data : r.statusText));
  return data;
}
const assetCache = new WeakMap(); // File -> uploaded path
async function uploadAsset(file) { if (assetCache.has(file)) return assetCache.get(file); const r = await api('/asset?name=' + encodeURIComponent(file.name || 'asset'), file); assetCache.set(file, r.path); return r.path; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJob(id, { signal, onProgress } = {}) {
  let cancelSent = false;
  while (true) {
    if (signal && signal.aborted && !cancelSent) { cancelSent = true; try { await api(`/jobs/${id}/cancel`, {}); } catch {} }
    const j = await api(`/jobs/${id}`);
    if (onProgress) onProgress(j);
    if (j.status !== 'run') { if (j.status === 'done') return j; const e = new Error(j.status === 'cancel' ? 'aborted' : (j.error || '실패')); if (j.status === 'cancel') e.name = 'AbortError'; throw e; }
    await sleep(400);
  }
}

export async function initEngine(C, { addFiles } = {}) {
  const { state, toast, fmtClock, fmtBytes } = C; const card = document.getElementById('engineCard'); if (!card) return null;
  let status = null;
  if (isLocal) { try { status = await api('/status'); } catch {} }
  if (!status) { // hosted Pro page: explain how to get the engine
    card.hidden = false; card.innerHTML = `<h3><span>로컬 엔진</span><span class="chip">미연결</span></h3><p class="hint">내 컴퓨터에 엔진을 설치하면 FFmpeg 하드웨어 렌더(1시간+ 영상도), 폴더에 넣기만 하면 자동 처리되는 워치 폴더, 탐색기 파일 선택, 더 정확한 음성 인식을 쓸 수 있습니다. 설치 후에는 <span class="mono">http://127.0.0.1:7797/pro.html</span> 에서 이 화면을 열면 됩니다.</p><p class="hint">설치: Node.js 설치 → 저장소 받기 → <span class="mono">start-engine.command</span>(맥) / <span class="mono">start-engine.bat</span>(윈도우) 더블클릭. 자세한 순서는 README의 "Pro 엔진" 항목.</p>`;
    return null;
  }
  // ---------- hooks ----------
  state.hooks.analyze = async desc => api('/analyze', { token: desc.token });
  state.hooks.frames = async (times, maxW) => { const out = []; for (const t of times) { try { const img = new Image(); img.decoding = 'async'; await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('frame')); img.src = `/api/frame?token=${state.engineMedia.token}&t=${t.toFixed(3)}&w=${maxW || 0}&_=${Date.now()}`; }); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); out.push({ t, canvas: c }); } catch { out.push({ t, canvas: null }); } } return out; };
  state.hooks.saveThumbs = async times => api('/thumbs', { token: state.engineMedia.token, times });
  state.hooks.saveFile = async (name, data) => { const blob = data instanceof Blob ? data : new Blob([data]); let body; if (/\.(txt|srt|json|csv|edl|fcpxml|sh|bat)$/i.test(name) || (typeof data === 'string')) body = { name, text: typeof data === 'string' ? data : await blob.text() }; else { const b64 = await new Promise(res => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(',')[1]); rd.readAsDataURL(blob); }); body = { name, base64: b64 }; } const r = await api('/save', body); toast(`출력 폴더에 저장: ${r.path.split(/[\\/]/).pop()}`, 3000); return true; };
  state.hooks.render = async ({ kind, ranges, out, crop, quality, fps, name, signal, onProgress }) => {
    const b = state.bgm; let bgm = null;
    if (b.ready && b.file) { onProgress(0, '배경음악 전송'); bgm = { path: await uploadAsset(b.file), volume: b.volume, duck: b.duck, fade: b.fade, loop: b.loop }; }
    const fx = JSON.parse(JSON.stringify({ ...state.fx, overlays: [], sfx: [] }));
    for (const o of state.fx.overlays) { const c = { id: o.id, type: o.type, s: o.s, e: o.e, pos: o.pos, w: o.w, opacity: o.opacity, fade: o.fade, text: o.text, style: o.style, ratio: o.ratio, name: o.name }; if (o.type === 'image') { if (o.file) c.path = await uploadAsset(o.file); else c.dataUrl = o.dataUrl; } fx.overlays.push(c); }
    for (const s of state.fx.sfx) { const c = { id: s.id, t: s.t, kind: s.kind, volume: s.volume, name: s.name }; if (s.kind === 'custom') { if (!s.file) continue; c.path = await uploadAsset(s.file); } fx.sfx.push(c); }
    const captions = state.fx.subs.burn ? (C.captionsOf() || []).map(l => ({ s: l.s, e: l.e, text: l.text })) : [];
    const job = await api('/render', { token: state.engineMedia.token, kind, ranges, out, crop, quality, fps, filename: name, bgm, fx, captions });
    const done = await waitJob(job.id, { signal, onProgress: j => onProgress(j.progress, `엔진 렌더링(${j.meta && j.meta.encoder ? j.meta.encoder : 'ffmpeg'})`) });
    refreshJobs();
    return { out: done.out, size: (done.meta && done.meta.size) || 0, warnings: done.warnings };
  };
  state.hooks.transcribe = async ({ model, signal, onProgress }) => {
    const job = await api('/transcribe', { token: state.engineMedia.token, model });
    const done = await waitJob(job.id, { signal, onProgress: j => onProgress(j.progress, `엔진 음성 인식 · ${j.step || ''} ${Math.round(j.progress * 100)}%`) });
    return api(`/jobs/${job.id}/result`);
  };
  // engine models in the AI tab
  const sel = document.getElementById('aiModel');
  if (sel) { sel.innerHTML = Object.entries(status.asrModels).map(([k, v]) => `<option value="${k}"${k === status.settings.asrModel ? ' selected' : ''}>${esc(v)}</option>`).join(''); const gpu = document.getElementById('aiGpu'); if (gpu) { gpu.checked = false; gpu.disabled = true; gpu.parentElement.title = '엔진이 CPU 전체 코어로 처리합니다'; } const chip = document.getElementById('aiChip'); if (chip) chip.textContent = '로컬 엔진 · 무료'; }

  // ---------- open files ----------
  async function openPaths(paths, { queue = false } = {}) {
    if (!paths || !paths.length) return [];
    const regs = await api('/register', { paths }); const descs = [];
    for (const r of regs) { if (r.error) { toast(`${r.path.split(/[\\/]/).pop()}: ${r.error}`, 4000); continue; } descs.push({ engine: true, token: r.token, path: r.path, name: r.name, size: r.size, mediaUrl: r.mediaUrl, info: r.info }); }
    if (!descs.length) return [];
    if (queue || descs.length > 1) { if (addFiles) addFiles(descs); } else await C.openFile(descs[0]);
    renderRecent();
    return descs;
  }
  async function pick(kind) { try { const r = await api('/pick', { kind }); return r.paths || []; } catch (e) { toast('파일 선택 창을 열지 못했습니다: ' + e.message, 4000); return []; } }

  // ---------- card UI ----------
  card.hidden = false;
  const enc = status.ffmpeg ? status.ffmpeg.encoders.working : [];
  card.innerHTML = `
    <h3><span>로컬 엔진 <span class="chip ok">연결됨</span></span><span class="hint" id="engVer">v${esc(status.version)} · ffmpeg ${esc(status.ffmpeg ? status.ffmpeg.version : '없음')}${status.ffmpeg && !status.ffmpeg.libass ? ' · 자막 굽기 불가' : ''} · CPU ${status.cpu}코어</span></h3>
    <div class="row">
      <button class="btn primary sm" id="engOpen">영상 열기 (탐색기)</button>
      <button class="btn sm" id="engQueue">여러 개 골라 큐에 넣기</button>
      <select id="engRecent" class="sm" aria-label="최근 파일"><option value="">최근 파일…</option></select>
      <span style="flex:1"></span>
      <button class="btn sm" id="engOutOpen" title="출력 폴더 열기">출력 폴더 열기</button>
      <button class="btn sm ghost" id="engOutPick">출력 폴더 변경</button>
    </div>
    <p class="hint">출력: <span class="mono" id="engOut">${esc(status.outDir)}</span> — MP4·숏츠·썸네일·프로젝트가 여기에 바로 저장됩니다(저장 창 없음).</p>
    <div class="defaults">
      <label for="engEncoder">인코더</label><select id="engEncoder"><option value="auto">자동 (${esc(status.ffmpeg && status.ffmpeg.labels[status.encoder] || status.encoder)})</option>${enc.map(e => `<option value="${e}"${status.settings.encoder === e ? ' selected' : ''}>${esc(status.ffmpeg.labels[e] || e)}</option>`).join('')}</select>
      <label for="engAsr">음성 인식 모델</label><select id="engAsr">${Object.entries(status.asrModels).map(([k, v]) => `<option value="${k}"${k === status.settings.asrModel ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    </div>
    <div class="watch">
      <label class="switch"><input type="checkbox" id="engWatchOn"${status.settings.watch.on ? ' checked' : ''}>워치 폴더 자동 처리</label>
      <button class="btn sm" id="engWatchPick">폴더 선택</button>
      <span class="mono small" id="engWatchDir">${esc(status.settings.watch.dir || '(폴더 없음)')}</span>
      <label><input type="checkbox" id="engWatchRender"${status.settings.watch.tasks.render !== false ? ' checked' : ''}>MP4 렌더</label>
      <label><input type="checkbox" id="engWatchProject"${status.settings.watch.tasks.project !== false ? ' checked' : ''}>프로젝트 저장</label>
    </div>
    <p class="hint">워치 폴더에 영상을 넣어 두면(촬영 후 복사만) 채널 기본값 프리셋·화질로 분석→렌더가 자동으로 돌아가고, 결과는 출력 폴더에 쌓입니다. 손볼 영상은 프로젝트(.cutdiet.json)를 불러와 고치고 다시 렌더하면 됩니다.</p>
    <div class="queue" id="engJobs"></div>`;
  const $ = id => document.getElementById(id);
  $('engOpen').addEventListener('click', async () => { const p = await pick('files'); if (p.length) await openPaths(p); });
  $('engQueue').addEventListener('click', async () => { const p = await pick('files'); if (p.length) await openPaths(p, { queue: true }); });
  $('engRecent').addEventListener('change', async e => { const p = e.target.value; e.target.value = ''; if (p) await openPaths([p]); });
  $('engOutOpen').addEventListener('click', () => api('/open-folder', {}).catch(() => {}));
  $('engOutPick').addEventListener('click', async () => { const p = await pick('dir'); if (p.length) { status = await api('/settings', { outDir: p[0] }); $('engOut').textContent = status.outDir; toast('출력 폴더를 바꿨습니다'); } });
  $('engEncoder').addEventListener('change', async e => { status = await api('/settings', { encoder: e.target.value }); toast('인코더: ' + (status.ffmpeg.labels[status.encoder] || status.encoder)); });
  $('engAsr').addEventListener('change', async e => { status = await api('/settings', { asrModel: e.target.value }); if (sel) sel.value = e.target.value; });
  if (sel) sel.addEventListener('change', () => { $('engAsr').value = sel.value; api('/settings', { asrModel: sel.value }).catch(() => {}); });
  const watchSave = async () => { status = await api('/settings', { watch: { on: $('engWatchOn').checked, tasks: { render: $('engWatchRender').checked, project: $('engWatchProject').checked } } }); if ($('engWatchOn').checked && !status.settings.watch.dir) { toast('먼저 워치 폴더를 선택하세요'); $('engWatchOn').checked = false; } };
  ['engWatchOn', 'engWatchRender', 'engWatchProject'].forEach(id => $(id).addEventListener('change', watchSave));
  $('engWatchPick').addEventListener('click', async () => { const p = await pick('dir'); if (p.length) { status = await api('/settings', { watch: { dir: p[0] } }); $('engWatchDir').textContent = status.settings.watch.dir; } });
  function renderRecent() { const s = $('engRecent'); if (!s) return; const cur = s.value; api('/status').then(st => { s.innerHTML = '<option value="">최근 파일…</option>' + st.recent.map(p => `<option value="${esc(p)}">${esc(p.split(/[\\/]/).pop())}</option>`).join(''); s.value = cur; }).catch(() => {}); }
  renderRecent();
  // jobs panel (engine-side jobs incl. watch-folder auto jobs)
  let jobTimer = 0;
  async function refreshJobs() {
    let jobs = []; try { jobs = await api('/jobs'); } catch { return; }
    const el = $('engJobs'); if (!el) return;
    const recent = jobs.slice(-8).reverse();
    el.innerHTML = recent.map(j => `<div class="qitem ${j.status === 'run' ? 'run' : j.status === 'done' ? 'done' : j.status === 'err' ? 'err' : ''}"><span class="mono muted small">${esc(j.kind === 'auto' ? '자동' : j.kind === 'shorts' ? '숏츠' : j.kind === 'transcribe' ? '자막' : '렌더')}</span><span class="qname" title="${esc(j.out || j.error || '')}">${esc(j.meta && j.meta.name || '')}${j.out ? ' → ' + esc(j.out.split(/[\\/]/).pop()) : ''}${j.error ? ' · ' + esc(j.error) : ''}</span><span class="qbar"><i style="width:${Math.round(j.progress * 100)}%"></i></span><span class="qstat">${j.status === 'run' ? esc(j.step || '처리 중') + ' ' + Math.round(j.progress * 100) + '%' : j.status === 'done' ? '완료 ' + fmtClock(j.seconds, false) : j.status === 'cancel' ? '중단' : '실패'}</span></div>`).join('') || '<div class="hint">엔진 작업(렌더·워치 폴더 자동 처리)이 여기에 표시됩니다.</div>';
    clearTimeout(jobTimer); if (jobs.some(j => j.status === 'run')) jobTimer = setTimeout(refreshJobs, 1200); else jobTimer = setTimeout(refreshJobs, 6000);
  }
  refreshJobs();
  // multi-file drag & drop from the desktop still works through the browser; engine users mostly pick paths
  C.toast(`로컬 엔진 연결됨 · ${status.ffmpeg ? (status.ffmpeg.labels[status.encoder] || status.encoder) : 'ffmpeg 없음'}`, 3000);
  return { status: () => status, openPaths, pick, api, refreshJobs };
}
