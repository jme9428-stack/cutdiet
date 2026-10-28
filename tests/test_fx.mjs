import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveFx, freeLayer, layerCount, defaultTracks, SUB_PRESETS, FONT_CATALOG, SUB_FONTS, fontInfo, adjustActive, adjustFilter, adjustEq, captionAnim, customXY, defaultFx, fxActive, zoomAt, zoomSourceRect, fadeAlpha, dissolveAlpha, activeOverlays, overlayAlpha, overlayBox, textLines, textEm, fitScale, captionAt, synthSfx, mixSfxInto, hexA, fxToJSON, fxFromJSON } from '../src/fxlogic.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dec = fs.readFileSync(path.join(root, 'src/decorate.js'), 'utf8');
// every $('id') in decorate.js exists in index.html
const ids = [...new Set([...dec.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map(m => m[1]))];
const missing = ids.filter(id => !html.includes(`id="${id}"`)); assert.deepEqual(missing, [], 'missing: ' + missing.join(','));
console.log('decorate ids ok', ids.length);

const fx = defaultFx(); assert.equal(fxActive(fx, false), false);
fx.subs.burn = true; assert.equal(fxActive(fx, false), false); assert.equal(fxActive(fx, true), true); fx.subs.burn = false;
// zoom: explicit beats auto; ease ramps; auto alternates by kept range index
const ranges = [{ s: 0, e: 2 }, { s: 3, e: 5 }, { s: 6, e: 8 }];
fx.autoZoom = { on: true, scale: 1.12 };
assert.equal(zoomAt(fx, 1, ranges).scale, 1); assert.equal(zoomAt(fx, 4, ranges).scale, 1.12); assert.equal(zoomAt(fx, 7, ranges).scale, 1);
fx.zooms = [{ s: 3, e: 5, scale: 1.5, ax: 0.5, ay: 0.5, ease: 0.5 }];
assert.equal(zoomAt(fx, 4, ranges).scale, 1.5); assert.ok(Math.abs(zoomAt(fx, 3.25, ranges).scale - 1.25) < 1e-9); assert.ok(Math.abs(zoomAt(fx, 4.9, ranges).scale - 1.1) < 1e-9);
const r = zoomSourceRect({ left: 0, top: 0, width: 1920, height: 1080 }, 2, 0.5, 0.5); assert.deepEqual(r, { left: 480, top: 270, width: 960, height: 540 });
const r2 = zoomSourceRect({ left: 100, top: 0, width: 608, height: 1080 }, 1.25, 0, 1); assert.ok(Math.abs(r2.left - 100) < 1e-9 && Math.abs(r2.top - (1080 - 864)) < 1e-9);
// fades + dissolve
assert.equal(fadeAlpha({ in: 1, out: 0 }, 0, 10), 1); assert.equal(fadeAlpha({ in: 1, out: 0 }, 0.5, 10), 0.5); assert.equal(fadeAlpha({ in: 0, out: 2 }, 9, 10), 0.5); assert.equal(fadeAlpha({ in: 0, out: 0 }, 5, 10), 0);
assert.equal(dissolveAlpha({ type: 'dissolve', dur: 0.5 }, 10.25, 10, 1), 0.5); assert.equal(dissolveAlpha({ type: 'dissolve', dur: 0.5 }, 10.25, 10, 0), 0); assert.equal(dissolveAlpha({ type: 'none' }, 10.1, 10, 1), 0); assert.equal(dissolveAlpha({ type: 'dissolve', dur: 0.5 }, 10.6, 10, 1), 0);
// overlays
const ov = [{ id: 'a', type: 'text', s: 1, e: 3, pos: 'tr', w: 0.25, opacity: 0.8, fade: 0.5, text: 'hi', ratio: 2 }];
assert.equal(activeOverlays(ov, 2).length, 1); assert.equal(activeOverlays(ov, 3).length, 0);
assert.ok(Math.abs(overlayAlpha(ov[0], 1.25) - 0.4) < 1e-9); assert.ok(Math.abs(overlayAlpha(ov[0], 2) - 0.8) < 1e-9);
const b = overlayBox(ov[0], 1920, 1080); assert.equal(b.w, 480); assert.equal(b.h, 240); assert.equal(b.x, 1920 - 480 - 58); assert.equal(b.y, 58);
assert.equal(overlayBox({ pos: 'mc', w: 0.5, ratio: 1 }, 1000, 1000).x, 250);
// captions
// one line per typed line (no automatic wrapping); a line wider than the frame shrinks to fit
assert.deepEqual(textLines('오늘은 날씨가 정말 좋네요 여러분'), ['오늘은 날씨가 정말 좋네요 여러분']);
assert.deepEqual(textLines('첫 줄\n 둘째 줄 '), ['첫 줄', '둘째 줄']);
assert.equal(textEm('가나'), 2); assert.ok(textEm('5A') > 1 && textEm('5A') < 1.4);
assert.equal(fitScale('짧은 자막', 60, 1920), 1);
const sc = fitScale('가'.repeat(40), 60, 1920); assert.ok(sc < 1 && Math.abs(sc * 40 * 60 - 1920 * 0.92) < 1);
const lines = [{ s: 0, e: 1, text: 'a' }, { s: 2, e: 3, text: 'b' }]; assert.equal(captionAt(lines, 2.5).text, 'b'); assert.equal(captionAt(lines, 1.5), null);
// sfx
for (const k of ['ding', 'pop', 'whoosh', 'thud', 'click']) { const d = synthSfx(k, 48000); assert.ok(d.length > 1000 && d.length < 48000, k); let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v)); assert.ok(peak > 0.2 && peak <= 1.2, k + ' peak ' + peak); }
const chans = [new Float32Array(4800), new Float32Array(4800)]; const buf = { data: new Float32Array(480).fill(0.5), sr: 48000 };
mixSfxInto(chans, 48000, 10, [{ t: 10.05, volume: 0.5 }], () => buf);
assert.ok(Math.abs(chans[0][2400 + 10] - 0.25) < 1e-6 && chans[0][100] === 0 && chans[1][2400 + 479] !== 0 && chans[0][2400 + 490] === 0);
// sfx starting before the buffer window continues into it
const chans2 = [new Float32Array(480)]; mixSfxInto(chans2, 48000, 10, [{ t: 9.995, volume: 1 }], () => buf); assert.ok(Math.abs(chans2[0][0] - 0.5) < 1e-6 && chans2[0][240] === 0);
assert.equal(hexA('#ff0000', 0.5), 'rgba(255,0,0,0.5)'); assert.equal(hexA('#abc', 1), 'rgba(170,187,204,1)');
// json round trip
fx.overlays = [{ id: 'x', type: 'image', s: 1, e: 2, pos: 'bl', w: 0.3, opacity: 1, fade: 0, ratio: 1.5, name: 'logo.png', dataUrl: 'data:image/png;base64,AAAA', bitmap: {} }, { id: 'y', type: 'image', s: 1, e: 2, pos: 'bl', w: 0.3, ratio: 1, name: 'big.png', dataUrl: undefined, bitmap: {} }];
fx.sfx = [{ id: 's1', t: 1.5, kind: 'ding', volume: 0.7, name: '띵' }, { id: 's2', t: 2, kind: 'custom', volume: 1, name: 'my.wav' }];
const j = JSON.parse(JSON.stringify(fxToJSON(fx))); const back = fxFromJSON(j);
assert.equal(back.zooms.length, 1); assert.equal(back.overlays.length, 1); assert.equal(back.overlays[0].bitmap, null); assert.equal(back.sfx.length, 1); assert.equal(back.autoZoom.scale, 1.12); assert.equal(back.subs.style.font, SUB_PRESETS.outline.font);
assert.equal(fxFromJSON(null).zooms.length, 0);
// fonts: every entry is loadable in the browser (Google CSS or a webfont URL); names unique; presets use catalog fonts
assert.ok(FONT_CATALOG.length >= 30); assert.equal(new Set(SUB_FONTS).size, SUB_FONTS.length);
for (const f of FONT_CATALOG) { assert.ok(f.f && f.k && f.cat && [400, 500, 700, 800].includes(f.w), f.f); assert.ok(f.g || /^https:\/\/cdn\.jsdelivr\.net\//.test(f.url), f.f); if (f.ttf) assert.ok(/^https:\/\//.test(f.ttf) && /\.(ttf|otf|woff)$/i.test(f.ttf), f.f); }
for (const p of Object.values(SUB_PRESETS)) assert.ok(fontInfo(p.font), p.font);
// dragged positions
assert.equal(customXY({ pos: 'bottom', x: 0.2, y: 0.2 }), null); assert.deepEqual(customXY({ pos: 'custom', x: 0.2, y: 1.4 }), { x: 0.2, y: 1 });
assert.deepEqual(overlayBox({ pos: 'custom', x: 0.5, y: 0.25, w: 0.2, ratio: 2 }, 1000, 800), { x: 400, y: 150, w: 200, h: 100 });
assert.equal(overlayBox({ pos: 'custom', w: 0.2, ratio: 2 }, 1000, 800).x, 400, 'custom without x/y falls back to center');
// color adjust
const fx2 = defaultFx(); assert.equal(adjustActive(fx2.adjust), false); assert.equal(adjustFilter(fx2.adjust), 'none'); assert.equal(adjustEq(fx2.adjust), null);
fx2.adjust.contrast = 20; assert.equal(fxActive(fx2, false), true); assert.equal(adjustFilter(fx2.adjust), 'brightness(1) contrast(1.2) saturate(1)'); assert.deepEqual(adjustEq(fx2.adjust), { brightness: 0, contrast: 1.2, saturation: 1 });
// caption entrance animation
assert.deepEqual(captionAnim('none', 0), { alpha: 1, scale: 1, dy: 0 }); assert.equal(captionAnim('fade', 0).alpha, 0); assert.equal(captionAnim('fade', 1).alpha, 1);
assert.ok(captionAnim('pop', 0.05).scale < 1); assert.equal(captionAnim('pop', 0.3).scale, 1); assert.ok(captionAnim('up', 0).dy > 0 && captionAnim('up', 1).dy === 0);
// project file keeps text overlay style, dragged positions, color adjust and caption style extras
fx2.subs.style = { ...fx2.subs.style, pos: 'custom', x: 0.3, y: 0.7, anim: 'pop', font: 'Jalnan' };
fx2.overlays = [{ id: 't', type: 'text', s: 0, e: 2, pos: 'custom', x: 0.4, y: 0.6, w: 0.05, text: '구독', style: { ...SUB_PRESETS.variety, font: 'Gaegu' } }];
const back2 = fxFromJSON(JSON.parse(JSON.stringify(fxToJSON(fx2))));
assert.equal(back2.adjust.contrast, 20); assert.equal(back2.overlays[0].style.font, 'Gaegu'); assert.equal(back2.overlays[0].x, 0.4); assert.equal(back2.overlays[0].pos, 'custom');
assert.deepEqual([back2.subs.style.pos, back2.subs.style.x, back2.subs.style.anim, back2.subs.style.font], ['custom', 0.3, 'pop', 'Jalnan']);
assert.equal(fxFromJSON({ adjust: { brightness: 999 } }).adjust.brightness, 50);
// layers: overlapping clips stack upward; drawing order bottom layer first; hidden layers / muted effects drop out
{
  const ovs = [{ id: 'a', s: 0, e: 5, layer: 0 }, { id: 'b', s: 4, e: 8, layer: 1 }];
  assert.equal(freeLayer(ovs, 1, 2), 1); assert.equal(freeLayer(ovs, 4.5, 5), 2); assert.equal(freeLayer(ovs, 6, 7), 0); assert.equal(freeLayer(ovs, 4.5, 5, 'b'), 1); assert.equal(layerCount([]), 1); assert.equal(layerCount(ovs), 2);
  assert.deepEqual(activeOverlays([{ id: 'top', s: 0, e: 9, layer: 2 }, { id: 'low', s: 0, e: 9, layer: 0 }], 1).map(o => o.id), ['low', 'top']);
  const f = defaultFx(); f.overlays = ovs.map(o => ({ ...o, type: 'text', text: 'x' })); f.sfx = [{ id: 's', t: 1, kind: 'ding' }];
  assert.equal(liveFx(f), f, 'nothing hidden: same object');
  f.tracks.hidden = ['ov1']; f.tracks.sfxMuted = true; const L = liveFx(f); assert.deepEqual(L.overlays.map(o => o.id), ['a']); assert.equal(L.sfx.length, 0); assert.equal(f.overlays.length, 2, 'original untouched');
  const back = fxFromJSON(JSON.parse(JSON.stringify(fxToJSON(f)))); assert.deepEqual(back.tracks.hidden, ['ov1']); assert.equal(back.tracks.sfxMuted, true); assert.equal(back.overlays[1].layer, 1);
  assert.deepEqual(fxFromJSON({}).tracks, defaultTracks()); assert.deepEqual(fxFromJSON({ tracks: { hidden: 'x', locked: [1, 'cap'] } }).tracks.locked, ['cap']);
}
console.log('ALL FX TESTS PASSED');
