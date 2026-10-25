import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEYS, comboFromEvent, comboLabel, resolveKeymap, invertKeymap, makeRecord, summarize, toCSV, planQueue } from '../src/prologic.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pro = fs.readFileSync(path.join(root, 'pro.html'), 'utf8');
const projs = fs.readFileSync(path.join(root, 'src/pro.js'), 'utf8');
// every $('id') used in pro.js exists in pro.html
const ids = [...new Set([...projs.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))].concat([...projs.matchAll(/\$\('task_' \+ t\)/g)].length ? ['task_render', 'task_shorts', 'task_thumbs', 'task_project'] : []);
const missing = ids.filter(id => !pro.includes(`id="${id}"`));
assert.deepEqual(missing, [], 'pro.html missing ids: ' + missing.join(','));
assert.ok(pro.includes('<body class="pro">') && pro.includes('/src/pro.js') && pro.includes('data-tab="log"'));
// keymap
assert.equal(comboFromEvent({ code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+KeyZ');
assert.equal(comboFromEvent({ code: 'ShiftLeft', shiftKey: true }), null);
assert.equal(comboLabel('Ctrl+Shift+KeyZ'), 'Ctrl+Shift+Z'); assert.equal(comboLabel('BracketLeft'), '[');
const km = resolveKeymap({ split: 'KeyD', bogus: 'KeyQ', toggle: 42 }); assert.equal(km.split, 'KeyD'); assert.equal(km.toggle, DEFAULT_KEYS.toggle); assert.ok(!('bogus' in km));
assert.equal(invertKeymap(km)['KeyD'], 'split');
// records
const r = makeRecord({ file: 'a.mp4', preset: 'lecture', duration: 600, kept: 480, cuts: 12, manualEdits: 3, editSeconds: 900.4 });
assert.equal(r.removed, 120); assert.equal(r.cutRatio, 20); assert.equal(r.editSeconds, 900);
const s = summarize([r, makeRecord({ file: 'b.mp4', duration: 300, kept: 270, editSeconds: 300 })]);
assert.equal(s.n, 2); assert.equal(s.totalRemoved, 150); assert.equal(s.avgCutRatio, 15); assert.equal(s.avgEditPerMin, 75); assert.deepEqual(s.trend, [20, 10]);
const csv = toCSV([{ ...r, file: 'a,"b".mp4' }]); assert.ok(csv.startsWith('﻿일시,') && csv.includes('"a,""b"".mp4"'));
assert.deepEqual(summarize([]).trend, []);
// queue plan
const q = planQueue([{ name: 'x.mp4', size: 1 }, { name: 'y.mov', size: 2 }], { render: true, shorts: false, thumbs: true, project: false });
assert.equal(q.length, 2); assert.deepEqual(q[1].steps, ['analyze', 'render', 'thumbs']); assert.equal(q[1].idx, 1);
console.log('ALL PRO TESTS PASSED');
