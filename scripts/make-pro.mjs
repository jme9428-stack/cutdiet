// Generates pro.html from index.html so both pages share one markup source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const need = (s) => { if (!html.includes(s)) throw new Error('make-pro: anchor not found: ' + s.slice(0, 60)); };

need('<title>컷다이어트</title>'); html = html.replace('<title>컷다이어트</title>', '<title>컷다이어트 Pro</title>');
need('<span class="name">컷다이어트</span>'); html = html.replace('<span class="name">컷다이어트</span>', '<span class="name">컷다이어트 <span class="chip ok">Pro</span></span>');

const probar = `
  <section class="probar">
    <div class="card">
      <h3><span>큐 · 자동 처리</span><span class="chip" id="queueChip">비어 있음</span></h3>
      <div class="row">
        <button class="btn primary sm" id="btnQueueAdd">영상 여러 개 추가</button>
        <button class="btn sm" id="btnRunQueue" disabled title="Shift+Enter">큐 실행</button>
        <button class="btn sm" id="btnStopQueue" hidden>중지</button>
        <button class="btn sm ghost" id="btnClearQueue">비우기</button>
        <input type="file" id="queueInput" class="sr" tabindex="-1" multiple accept="video/*,audio/*,.mkv,.mov,.mp4,.webm,.m4a,.mp3,.wav">
      </div>
      <div class="tasks">
        <span class="muted small">파일마다:</span>
        <label><input type="checkbox" id="task_render">MP4 렌더</label>
        <label><input type="checkbox" id="task_shorts">숏츠 9:16</label>
        <label><input type="checkbox" id="task_thumbs">썸네일 zip</label>
        <label><input type="checkbox" id="task_project">프로젝트 저장</label>
      </div>
      <div class="queue" id="queue"></div>
    </div>
    <div class="card">
      <h3><span>채널 기본값</span><button class="btn sm" id="btnSnapDefaults" title="지금 화면의 프리셋·화질·크롭 위치·음악 음량을 기본값으로">지금 설정을 기본값으로</button></h3>
      <div class="defaults">
        <label for="defPreset">프리셋</label><select id="defPreset"><option value="lecture">강의형</option><option value="talk">토크·인터뷰</option><option value="vlog">브이로그</option></select>
        <label for="defQuality">화질</label><select id="defQuality"><option value="high">고화질 · 원본</option><option value="std">표준 · 원본</option><option value="1080">1080p</option><option value="720">720p</option></select>
      </div>
      <p class="hint">새 영상을 열면 이 값이 자동 적용됩니다. 배경음악 파일은 보안상 브라우저에 저장되지 않으니 세션마다 다시 고르세요(음량·덕킹 설정은 기억됩니다).</p>
      <div class="row"><button class="btn sm" id="btnOutDir">출력 폴더 지정</button><span class="hint" id="outDirLabel"></span></div>
      <div class="row"><button class="btn sm" id="btnKeySheet" title="/">단축키 보기 (/)</button><span class="hint">탭 전환 1~9 · 큐 실행 Shift+Enter · 렌더 Ctrl+Enter · 썸네일 Shift+T</span></div>
    </div>
    <div class="card engine" id="engineCard" hidden></div>
  </section>
`;
need('<div id="notice" hidden class="notice"></div>'); html = html.replace('<div id="notice" hidden class="notice"></div>', '<div id="notice" hidden class="notice"></div>' + probar);

need('<button class="tab" role="tab" data-tab="guide" aria-selected="false">가이드</button>');
html = html.replace('<button class="tab" role="tab" data-tab="guide" aria-selected="false">가이드</button>', '<button class="tab" role="tab" data-tab="log" aria-selected="false">기록</button>\n    <button class="tab" role="tab" data-tab="keys" aria-selected="false">단축키</button>\n    <button class="tab" role="tab" data-tab="guide" aria-selected="false">가이드</button>');

const logTab = `
  <section class="tabpanel" id="tab-log" role="tabpanel" hidden>
    <div class="toolbar">
      <button class="btn sm primary" id="btnLogNow">지금 기록</button>
      <button class="btn sm" id="btnLogCsv">CSV 저장</button>
      <button class="btn sm" id="btnLogJson">JSON 백업</button>
      <button class="btn sm" id="btnLogImport">JSON 합치기</button>
      <input type="file" id="logImport" class="sr" tabindex="-1" accept=".json,application/json">
      <span style="flex:1"></span>
      <button class="btn sm ghost" id="btnLogClear">기록 전체 삭제</button>
    </div>
    <div class="logtiles">
      <div class="logtile"><div class="k">기록된 영상</div><div class="v" id="lt_n">0</div></div>
      <div class="logtile"><div class="k">원본 합계</div><div class="v" id="lt_dur">–</div></div>
      <div class="logtile"><div class="k">잘라낸 시간 합계</div><div class="v" id="lt_removed">–</div><div class="s">시청자가 안 보게 된 정적</div></div>
      <div class="logtile"><div class="k">평균 컷 비율</div><div class="v" id="lt_ratio">–</div><div class="s">낮아지면 촬영이 좋아진 것</div></div>
      <div class="logtile"><div class="k">편집 시간 / 원본 1분</div><div class="v" id="lt_edit">–</div><div class="s">열고 → 렌더까지</div></div>
      <div class="logtile"><div class="k">평균 수동 수정</div><div class="v" id="lt_manual">–</div><div class="s">자동 컷을 고친 횟수</div></div>
    </div>
    <canvas id="logTrend" aria-label="최근 영상의 컷 비율 추세"></canvas>
    <div class="tbl" style="margin-top:10px"><table><thead><tr><th>일시</th><th>파일</th><th>프리셋</th><th>원본</th><th>편집 후</th><th>컷%</th><th>삭제구간</th><th>수동</th><th>AI</th><th>편집시간</th><th>렌더</th><th></th></tr></thead><tbody id="logBody"></tbody></table></div>
    <p class="hint" style="margin-top:8px">기록은 이 브라우저에만 저장됩니다. 다른 기기로 옮기려면 JSON 백업 → 합치기를 쓰세요.</p>
  </section>
  <section class="tabpanel" id="tab-keys" role="tabpanel" hidden>
    <div class="toolbar"><span class="hint">키를 클릭한 뒤 새 조합을 누르면 바뀝니다. 바꾼 키는 이 브라우저에 저장됩니다.</span><span style="flex:1"></span><button class="btn sm" id="btnKeysReset">기본값으로</button></div>
    <div class="kgrid" id="keyGrid"></div>
  </section>
`;
need('\n  <section class="tabpanel" id="tab-guide" role="tabpanel" hidden>'); html = html.replace('\n  <section class="tabpanel" id="tab-guide" role="tabpanel" hidden>', logTab + '\n  <section class="tabpanel" id="tab-guide" role="tabpanel" hidden>');

const sheet = `<div class="keysheet" id="keysheet" hidden role="dialog" aria-modal="true" aria-label="단축키"><div class="onb-card"><h2>단축키</h2><div class="kgrid" id="sheetGrid"></div><div class="foot"><span class="hint">Esc 또는 / 로 닫기 · 단축키 탭에서 바꿀 수 있습니다</span></div></div></div>\n`;
need('<div id="toast" role="status" aria-live="polite"></div>'); html = html.replace('<div id="toast" role="status" aria-live="polite"></div>', sheet + '<div id="toast" role="status" aria-live="polite"></div>');

need('<script type="module" src="/src/main.js"></script>'); html = html.replace('<script type="module" src="/src/main.js"></script>', '<script type="module" src="/src/main.js"></script>\n<script type="module" src="/src/pro.js"></script>');
html = html.replace('<body>', '<body class="pro">');

fs.writeFileSync(path.join(root, 'pro.html'), html);
console.log('pro.html generated:', html.length, 'bytes');
