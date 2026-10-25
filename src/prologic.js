// Pure helpers for the Pro layer: work log analytics, CSV, keymap. Unit-tested in tests/test_pro.mjs.

export const DEFAULT_KEYS = {
  play: 'Space', rev: 'KeyJ', stop: 'KeyK', fwd: 'KeyL', toggle: 'KeyX', split: 'KeyS', trimL: 'KeyQ', trimR: 'KeyW', del: 'Delete', chapter: 'KeyM',
  undo: 'Ctrl+KeyZ', redo: 'Ctrl+Shift+KeyZ', prevCut: 'BracketLeft', nextCut: 'BracketRight', home: 'Home', end: 'End', back1: 'ArrowLeft', fwd1: 'ArrowRight', frameBack: 'Comma', frameFwd: 'Period',
  render: 'Ctrl+Enter', runQueue: 'Shift+Enter', thumbs: 'Shift+KeyT', saveProject: 'Ctrl+KeyS', help: 'Slash',
};
export const ACTION_LABELS = {
  play: '재생/일시정지', rev: '뒤로 재생 (반복: 배속)', stop: '멈춤', fwd: '앞으로 재생 (반복: 배속)', toggle: '유지↔삭제', split: '분할', trimL: '앞부분 삭제', trimR: '뒷부분 삭제', del: '현재 구간 삭제', chapter: '챕터 추가',
  undo: '되돌리기', redo: '다시 실행', prevCut: '이전 컷', nextCut: '다음 컷', home: '처음으로', end: '끝으로', back1: '1초 뒤로', fwd1: '1초 앞으로', frameBack: '1프레임 뒤로', frameFwd: '1프레임 앞으로',
  render: 'MP4 렌더', runQueue: '큐 실행', thumbs: '썸네일 뽑기', saveProject: '프로젝트 저장', help: '단축키 보기',
};

// Normalize a KeyboardEvent (or event-like) to a combo string such as "Ctrl+Shift+KeyZ"
export function comboFromEvent(e) {
  const parts = []; if (e.ctrlKey || e.metaKey) parts.push('Ctrl'); if (e.shiftKey) parts.push('Shift'); if (e.altKey) parts.push('Alt');
  const code = e.code || ''; if (/^(Control|Shift|Alt|Meta)/.test(code)) return null;
  parts.push(code); return parts.join('+');
}
export function comboLabel(combo) {
  if (!combo) return '—';
  return combo.split('+').map(p => p.replace(/^Key/, '').replace(/^Digit/, '').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('BracketLeft', '[').replace('BracketRight', ']').replace('Comma', ',').replace('Period', '.').replace('Slash', '/').replace('Space', 'Space').replace('Enter', 'Enter')).join('+');
}
// Merge saved keymap over defaults; drop invalid entries
export function resolveKeymap(saved) {
  const map = { ...DEFAULT_KEYS };
  if (saved && typeof saved === 'object') for (const [action, combo] of Object.entries(saved)) if (action in DEFAULT_KEYS && typeof combo === 'string' && combo) map[action] = combo;
  return map;
}
// combo -> action lookup; later duplicates lose
export function invertKeymap(map) { const inv = {}; for (const [action, combo] of Object.entries(map)) if (!(combo in inv)) inv[combo] = action; return inv; }

// ---- work log ----
export function makeRecord(input) {
  const removed = Math.max(0, input.duration - input.kept);
  return {
    id: input.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: input.at || new Date().toISOString(), file: input.file || '', preset: input.preset || '',
    duration: round1(input.duration), kept: round1(input.kept), removed: round1(removed), cutRatio: input.duration ? Math.round(removed / input.duration * 1000) / 10 : 0,
    cuts: input.cuts || 0, manualEdits: input.manualEdits || 0, aiApplied: input.aiApplied || 0, editSeconds: Math.round(input.editSeconds || 0), rendered: !!input.rendered, note: input.note || '',
  };
}
const round1 = v => Math.round((v || 0) * 10) / 10;

export function summarize(records) {
  const n = records.length; if (!n) return { n: 0, totalDuration: 0, totalRemoved: 0, avgCutRatio: 0, avgEditPerMin: 0, avgManualEdits: 0, trend: [] };
  const totalDuration = records.reduce((a, r) => a + r.duration, 0), totalRemoved = records.reduce((a, r) => a + r.removed, 0);
  const avgCutRatio = Math.round(records.reduce((a, r) => a + r.cutRatio, 0) / n * 10) / 10;
  const withTime = records.filter(r => r.editSeconds > 0 && r.duration > 0);
  const avgEditPerMin = withTime.length ? Math.round(withTime.reduce((a, r) => a + r.editSeconds / (r.duration / 60), 0) / withTime.length) : 0;
  const avgManualEdits = Math.round(records.reduce((a, r) => a + r.manualEdits, 0) / n * 10) / 10;
  const trend = records.slice(-20).map(r => r.cutRatio);
  return { n, totalDuration, totalRemoved, avgCutRatio, avgEditPerMin, avgManualEdits, trend };
}

export function toCSV(records) {
  const head = ['일시', '파일', '프리셋', '원본(초)', '편집후(초)', '줄인(초)', '컷비율(%)', '삭제구간수', '수동수정', 'AI적용', '편집시간(초)', '렌더', '메모'];
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = records.map(r => [r.at, r.file, r.preset, r.duration, r.kept, r.removed, r.cutRatio, r.cuts, r.manualEdits, r.aiApplied, r.editSeconds, r.rendered ? 'Y' : 'N', r.note].map(esc).join(','));
  return '﻿' + [head.join(','), ...rows].join('\n');
}

// ---- queue ----
export function planQueue(files, tasks) {
  const steps = ['analyze']; if (tasks.render) steps.push('render'); if (tasks.shorts) steps.push('shorts'); if (tasks.thumbs) steps.push('thumbs'); if (tasks.project) steps.push('project');
  return files.map((f, i) => ({ idx: i, name: f.name, size: f.size, file: f, status: 'wait', step: '', steps, progress: 0, error: '' }));
}
