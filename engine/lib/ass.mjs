// ASS subtitle builder for burned-in captions and text overlays (rendered by libass via ffmpeg's subtitles filter).
// Mirrors the browser compositor's styling: font, size as a share of frame height, outline, box, shadow, 9 positions,
// dragged (custom) positions and the caption entrance animation.
import { customXY } from '../../src/fxlogic.js';

function assColor(hex, alpha = 1) { // '#RRGGBB' + opacity -> &HAABBGGRR
  const h = String(hex || '#000000').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16) || 0;
  const a = Math.round((1 - Math.max(0, Math.min(1, alpha))) * 255);
  const hx = v => v.toString(16).toUpperCase().padStart(2, '0');
  return `&H${hx(a)}${hx(n & 255)}${hx((n >> 8) & 255)}${hx((n >> 16) & 255)}`;
}
export function assTime(sec) { sec = Math.max(0, sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), cs = Math.min(99, Math.round((sec - Math.floor(sec)) * 100)); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; }
export function assText(t) { return String(t || '').replace(/\r?\n/g, '\\N').replace(/[{}]/g, c => (c === '{' ? '｛' : '｝')).replace(/\\(?![Nnh])/g, '＼'); }

// style: {font, weight, size, color, stroke, strokeW, box, boxColor, boxAlpha, pos, shadow}
export function styleLine(name, style, W, H, { sizeFrac, align, marginV, fontMap } = {}) {
  const px = Math.max(10, Math.round(H * (sizeFrac ?? style.size ?? 0.055)));
  const bold = (style.weight || 700) >= 600 ? -1 : 0;
  const box = !!style.box;
  const outline = box ? Math.round(px * 0.35) : (style.strokeW > 0 && style.stroke ? Math.max(1, Math.round(px * style.strokeW / 2)) : 0);
  const outlineColour = box ? assColor(style.boxColor || '#000000', style.boxAlpha ?? 0.6) : assColor(style.stroke || '#000000', 1);
  const shadow = !box && style.shadow ? Math.max(1, Math.round(px * 0.06)) : 0;
  const backColour = box ? assColor(style.boxColor || '#000000', 0) : assColor('#000000', 0.65);
  const a = align ?? (style.pos === 'top' ? 8 : style.pos === 'center' ? 5 : 2);
  const mv = marginV ?? (style.pos === 'top' ? Math.round(H * 0.08) : style.pos === 'center' ? 0 : Math.round(H * 0.07));
  const font = ((fontMap && fontMap[style.font]) || style.font || 'Noto Sans KR').replace(/,/g, ' ');
  return `Style: ${name},${font},${px},${assColor(style.color || '#FFFFFF', 1)},${assColor('#FFFFFF', 1)},${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,${box ? 3 : 1},${outline},${shadow},${a},${Math.round(W * 0.05)},${Math.round(W * 0.05)},${mv},1`;
}

const AN = { tl: 7, tc: 8, tr: 9, ml: 4, mc: 5, mr: 6, bl: 1, bc: 2, br: 3 };
export function overlayAnchor(pos, W, H, o = {}) {
  if (pos === 'custom' && isFinite(o.x) && isFinite(o.y)) return { an: 5, x: Math.round(o.x * W), y: Math.round(o.y * H) };
  const m = Math.round(W * 0.03); const p = pos || 'mc';
  const x = p[1] === 'l' ? m : p[1] === 'r' ? W - m : Math.round(W / 2);
  const y = p[0] === 't' ? m : p[0] === 'b' ? H - m : Math.round(H / 2);
  return { an: AN[p] || 5, x, y };
}

// captions: [{s, e, text}] and textOverlays: [{s, e, text, style, pos, sizeFrac, opacity, fade}] — all times in OUTPUT seconds
// Caption override tags for a dragged position and the entrance animation (browser: captionAnim in fxlogic.js)
export function captionTags(style, W, H) {
  if (!style) return ''; const c = customXY(style); const px = Math.round(H * (style.size || 0.055)); let t = '';
  const x = c ? Math.round(c.x * W) : 0, y = c ? Math.round(c.y * H) : 0;
  if (style.anim === 'up' && c) t += `\\an5\\move(${x},${y + Math.round(px * 0.6)},${x},${y},0,250)\\fad(220,0)`;
  else { if (c) t += `\\an5\\pos(${x},${y})`; if (style.anim === 'fade' || style.anim === 'up') t += '\\fad(250,0)'; else if (style.anim === 'pop') t += '\\fad(90,0)\\fscx70\\fscy70\\t(0,220,\\fscx100\\fscy100)'; }
  return t ? `{${t}}` : '';
}
export function buildASS({ W, H, style, captions = [], textOverlays = [], fontMap }) {
  const head = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding'];
  const styles = [styleLine('Cap', style || { size: 0.055 }, W, H, { fontMap })];
  const events = []; const capTags = captionTags(style, W, H);
  for (const c of captions) if (c.e - c.s >= 0.05 && c.text) events.push(`Dialogue: 0,${assTime(c.s)},${assTime(c.e)},Cap,,0,0,0,,${capTags}${assText(c.text)}`);
  textOverlays.forEach((o, i) => {
    if (!(o.e - o.s >= 0.05) || !o.text) return;
    const name = `Ov${i + 1}`; const st = o.style || { size: 0.06 };
    styles.push(styleLine(name, st, W, H, { sizeFrac: o.sizeFrac ?? 0.06, align: 5, marginV: 0, fontMap }));
    const { an, x, y } = overlayAnchor(o.pos, W, H, o);
    const fadeMs = Math.round(Math.max(0, o.fade || 0) * 1000); const alpha = Math.round((1 - Math.max(0, Math.min(1, o.opacity ?? 1))) * 255).toString(16).toUpperCase().padStart(2, '0');
    const tags = `{\\an${an}\\pos(${x},${y})${fadeMs ? `\\fad(${fadeMs},${fadeMs})` : ''}${alpha !== '00' ? `\\alpha&H${alpha}&` : ''}}`;
    events.push(`Dialogue: 1,${assTime(o.s)},${assTime(o.e)},${name},,0,0,0,,${tags}${assText(o.text)}`);
  });
  return [...head, ...styles, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, ''].join('\n');
}
