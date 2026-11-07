import type { TextNode, TextSpan } from './types';

// Rich text: a text layer can style ranges of its text differently (a bold word in a sentence).
// The ranges live on the layer as `spans` (UTF-16 offsets into `text`, end exclusive) and only
// hold what differs from the layer. Layers without spans keep using Konva.Text everywhere, so
// nothing changes for them. Layers with spans are measured, wrapped and drawn here, with the same
// rules Konva uses (break at spaces and dashes, letter spacing per character, alphabetic baseline),
// so canvas, lint, PDF and the text editor all agree on where lines break.

export interface RunStyle {
  fontWeight: number;
  italic: boolean;
  fill: string;
  decoration: TextNode['decoration'];
}
type Override = Partial<RunStyle>;
const KEYS = ['fontWeight', 'italic', 'fill', 'decoration'] as const;

export const hasSpans = (t: Pick<TextNode, 'spans'>) => !!t.spans && t.spans.length > 0;

export function baseStyle(t: TextNode): RunStyle {
  return { fontWeight: t.fontWeight, italic: t.italic, fill: t.fill, decoration: t.decoration };
}

// ---------- spans ----------

function perChar(t: TextNode): (Override | null)[] {
  const len = t.text.length;
  const arr: (Override | null)[] = new Array(len).fill(null);
  for (const s of t.spans ?? []) {
    const a = Math.max(0, Math.min(len, Math.floor(s.start)));
    const b = Math.max(a, Math.min(len, Math.floor(s.end)));
    for (let i = a; i < b; i++) {
      const o: Override = { ...(arr[i] ?? {}) };
      for (const k of KEYS) if (s[k] !== undefined) (o as Record<string, unknown>)[k] = s[k];
      arr[i] = o;
    }
  }
  return arr;
}

function fromPerChar(t: TextNode, arr: (Override | null)[]): TextSpan[] | undefined {
  const base = baseStyle(t);
  const out: TextSpan[] = [];
  let cur: TextSpan | null = null;
  let curKey = '';
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    const clean: Override = {};
    if (o) for (const k of KEYS) if (o[k] !== undefined && o[k] !== base[k]) (clean as Record<string, unknown>)[k] = o[k];
    const key = KEYS.map((k) => String(clean[k] ?? '')).join('|');
    if (!Object.keys(clean).length) {
      cur = null;
      continue;
    }
    if (cur && key === curKey && cur.end === i) cur.end = i + 1;
    else {
      cur = { start: i, end: i + 1, ...clean };
      out.push(cur);
      curKey = key;
    }
  }
  return out.length ? out : undefined;
}

/** Spans cleaned up: inside the text, no overlaps, nothing that matches the layer, neighbours merged. */
export function normaliseSpans(t: TextNode): TextSpan[] | undefined {
  return hasSpans(t) ? fromPerChar(t, perChar(t)) : undefined;
}

/** The layer's spans with `patch` applied to [start, end). */
export function styleRange(t: TextNode, start: number, end: number, patch: Override): TextSpan[] | undefined {
  const arr = perChar(t);
  const a = Math.max(0, Math.min(t.text.length, start));
  const b = Math.max(a, Math.min(t.text.length, end));
  for (let i = a; i < b; i++) arr[i] = { ...(arr[i] ?? {}), ...patch };
  return fromPerChar(t, arr);
}

/** The layer's spans without one property, for when it's set on the whole layer. */
export function withoutSpanProp(t: TextNode, key: keyof RunStyle): TextSpan[] | undefined {
  if (!hasSpans(t)) return undefined;
  return fromPerChar(
    t,
    perChar(t).map((o) => {
      if (!o) return o;
      const c = { ...o };
      delete c[key];
      return c;
    }),
  );
}

/** The resolved style of every character in [start, end). */
export function rangeStyles(t: TextNode, start: number, end: number): RunStyle[] {
  const base = baseStyle(t);
  const arr = perChar(t);
  const out: RunStyle[] = [];
  for (let i = Math.max(0, start); i < Math.min(t.text.length, end); i++) out.push({ ...base, ...(arr[i] ?? {}) });
  return out;
}

/**
 * Moves spans to follow an edit from `before` to `after`. Typed text takes the style of the
 * character before it (at the very start, the one after), as in Figma and every word processor.
 */
export function remapSpans(before: string, after: string, spans: TextSpan[] | undefined): TextSpan[] | undefined {
  if (!spans?.length || before === after) return spans;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const delEnd = before.length - s;
  const insLen = after.length - s - p;
  const delta = insLen - (delEnd - p);
  const map = (pos: number) => (pos <= p ? pos : pos >= delEnd ? pos + delta : p);
  const out: TextSpan[] = [];
  for (const sp of spans) {
    const ns = map(sp.start);
    let ne = map(sp.end);
    // A span that ran up to (or into) the edit grows over what was typed there.
    if (insLen > 0 && sp.start < p && sp.end >= p && sp.end <= delEnd) ne = p + insLen;
    if (ne > ns) out.push({ ...sp, start: ns, end: ne });
  }
  return out.length ? out : undefined;
}

/** Spans located by text instead of offsets: { match: 'Resident Services', fontWeight: 600 }. */
export function resolveSpanInput(text: string, input: unknown): TextSpan[] | undefined {
  if (input == null) return undefined;
  if (!Array.isArray(input)) throw new Error('spans must be a list like [{ match: "word", fontWeight: 700 }] or [{ start, end, fontWeight }].');
  const out: TextSpan[] = [];
  for (const raw of input as Record<string, unknown>[]) {
    const style: Override = {};
    for (const k of KEYS) if (raw[k] !== undefined) (style as Record<string, unknown>)[k] = raw[k];
    if (typeof raw.match === 'string' && raw.match) {
      const m = raw.match;
      let from = 0;
      let found = false;
      for (;;) {
        const i = text.indexOf(m, from);
        if (i < 0) break;
        out.push({ start: i, end: i + m.length, ...style });
        found = true;
        if (!raw.all) break;
        from = i + m.length;
      }
      if (!found) throw new Error(`spans: "${m}" isn't in the text.`);
    } else if (typeof raw.start === 'number' && typeof raw.end === 'number') {
      out.push({ start: raw.start, end: raw.end, ...style });
    } else throw new Error('Each span needs match (a piece of the text) or start and end offsets.');
  }
  return out;
}

// ---------- measuring and wrapping ----------

export interface RichSeg {
  text: string;
  /** Offset of the segment's first character in the layer's text. */
  start: number;
  style: RunStyle;
  /** Left edge within the line, before alignment. */
  x: number;
  width: number;
}

export interface RichLine {
  text: string;
  width: number;
  /** Last line of its paragraph (not stretched when justified). */
  last: boolean;
  segs: RichSeg[];
}

interface Glyph {
  ch: string;
  /** Offset in the layer's text. */
  i: number;
  style: RunStyle;
  styleKey: string;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function graphemes(s: string): { ch: string; i: number }[] {
  if (segmenter) return Array.from(segmenter.segment(s), (g) => ({ ch: g.segment, i: g.index }));
  const out: { ch: string; i: number }[] = [];
  let i = 0;
  for (const ch of s) {
    out.push({ ch, i });
    i += ch.length;
  }
  return out;
}

let mctx: CanvasRenderingContext2D | null = null;
function ctx() {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d')!;
  return mctx;
}

export function fontString(t: TextNode, st: Pick<RunStyle, 'fontWeight' | 'italic'>) {
  return `${st.italic ? 'italic ' : ''}${st.fontWeight} normal ${t.fontSize}px "${t.fontFamily.replace(/"/g, '')}"`;
}

const widthCache = new Map<string, number>();
export function clearRichCache() {
  widthCache.clear();
}

function measureRun(text: string, font: string, kerning: CanvasFontKerning) {
  const key = `${font}|${kerning}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const c = ctx();
  c.font = font;
  c.fontKerning = kerning;
  if ('letterSpacing' in c) c.letterSpacing = '0px';
  const w = c.measureText(text).width;
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

const isBreak = (ch: string) => ch === ' ' || ch === '-';

/** Whether characters are drawn (and measured) one at a time, as Konva does. */
const perGlyph = (t: TextNode, ls: number) => ls !== 0 || t.align === 'justify';

function glyphsOf(t: TextNode): Glyph[] {
  const base = baseStyle(t);
  const arr = perChar(t);
  return graphemes(t.text).map(({ ch, i }) => {
    const style = { ...base, ...(arr[i] ?? {}) };
    return { ch: t.uppercase ? ch.toUpperCase() : ch, i, style, styleKey: `${style.fontWeight}|${style.italic}|${style.fill}|${style.decoration}` };
  });
}

/** Lays a line out as segments of one style each, with their widths. */
function segsOf(t: TextNode, gs: Glyph[], a: number, b: number, ls: number): { segs: RichSeg[]; width: number } {
  const kern: CanvasFontKerning = perGlyph(t, ls) ? 'none' : 'auto';
  const segs: RichSeg[] = [];
  let x = 0;
  let k = a;
  while (k < b) {
    let j = k;
    while (j < b && gs[j].styleKey === gs[k].styleKey) j++;
    const text = gs.slice(k, j).map((g) => g.ch).join('');
    const w = measureRun(text, fontString(t, gs[k].style), kern) + ls * (j - k);
    segs.push({ text, start: gs[k].i, style: gs[k].style, x, width: w });
    x += w;
    k = j;
  }
  return { segs, width: x };
}

/** The lines a text layer with spans breaks into at `width` (undefined = no wrapping). */
export function richLines(t: TextNode, width?: number): RichLine[] {
  const ls = (t.letterSpacing / 100) * t.fontSize;
  const all = glyphsOf(t);
  const lines: RichLine[] = [];
  const push = (gs: Glyph[], a: number, b: number) => {
    // Konva trims trailing spaces at a wrap, and both ends of justified lines.
    while (b > a && !gs[b - 1].ch.trim()) b--;
    if (t.align === 'justify') while (a < b && !gs[a].ch.trim()) a++;
    const { segs, width: w } = segsOf(t, gs, a, b, ls);
    lines.push({ text: segs.map((s) => s.text).join(''), width: w, last: false, segs });
  };
  // Paragraphs: split on newlines, keeping offsets.
  const paras: Glyph[][] = [[]];
  for (const g of all) {
    if (g.ch === '\n' || g.ch === '\r\n') paras.push([]);
    else paras[paras.length - 1].push(g);
  }
  for (const gs of paras) {
    const len = gs.length;
    const full = segsOf(t, gs, 0, len, ls).width;
    if (width === undefined || full <= width) {
      const { segs, width: w } = segsOf(t, gs, 0, len, ls);
      if (t.align === 'justify') push(gs, 0, len);
      else lines.push({ text: segs.map((s) => s.text).join(''), width: w, last: false, segs });
    } else {
      let start = 0;
      while (start < len) {
        // Longest prefix that fits (width grows with every character, so binary search).
        let low = start;
        let high = len;
        while (high - low > 0) {
          const mid = (low + high + 1) >>> 1;
          if (segsOf(t, gs, start, mid, ls).width <= width) low = mid;
          else high = mid - 1;
        }
        if (low === start) break; // not even one character fits
        if (low === len) {
          const { segs, width: w } = segsOf(t, gs, start, len, ls);
          if (t.align === 'justify') push(gs, start, len);
          else lines.push({ text: segs.map((s) => s.text).join(''), width: w, last: false, segs });
          break;
        }
        if (!isBreak(gs[low].ch)) {
          let wrap = low - 1;
          while (wrap >= start && !isBreak(gs[wrap].ch)) wrap--;
          if (wrap >= start) low = wrap + 1;
        }
        push(gs, start, low);
        start = low;
        while (start < len && !gs[start].ch.trim()) start++;
      }
    }
    if (lines.length) lines[lines.length - 1].last = true;
  }
  return lines;
}

/** Size of a text layer with spans, like layout.measureText. */
export function measureRich(t: TextNode, width?: number): { w: number; h: number } {
  const lines = richLines(t, width);
  const up = (v: number) => Math.ceil(v - 0.01);
  const w = width === undefined ? up(Math.max(0, ...lines.map((l) => l.width))) : width;
  return { w, h: up(Math.max(1, lines.length) * t.lineHeight * t.fontSize) };
}

// ---------- drawing ----------

/** Draws a text layer with spans into a 2D context at the layer's origin, box width `w`. */
export function drawRichText(c: CanvasRenderingContext2D, t: TextNode, w: number) {
  const ls = (t.letterSpacing / 100) * t.fontSize;
  const lh = t.lineHeight * t.fontSize;
  const lines = richLines(t, w);
  c.save();
  c.font = fontString(t, t);
  const m = c.measureText('M');
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  const top = (ascent - descent) / 2 + lh / 2;
  if (t.shadow?.enabled) {
    // Canvas shadows ignore the transform, so scale them like Konva does.
    const tr = c.getTransform();
    const scale = Math.sqrt(tr.a * tr.a + tr.b * tr.b) || 1;
    c.shadowColor = t.shadow.color;
    c.shadowBlur = t.shadow.blur * scale;
    c.shadowOffsetX = t.shadow.x * scale;
    c.shadowOffsetY = t.shadow.y * scale;
  }
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  const one = perGlyph(t, ls);
  c.fontKerning = one ? 'none' : 'auto';
  if ('letterSpacing' in c) c.letterSpacing = '0px';
  const deco = (x: number, y: number, len: number, kind: RunStyle['decoration'], color: string) => {
    if (kind === 'none') return;
    c.save();
    c.shadowColor = 'transparent';
    c.beginPath();
    const dy = kind === 'underline' ? Math.round(t.fontSize / 4) : -Math.round(t.fontSize / 4);
    c.moveTo(x, y + dy);
    c.lineTo(x + Math.round(len), y + dy);
    c.lineWidth = t.fontSize / 15;
    c.strokeStyle = color;
    c.stroke();
    c.restore();
  };
  lines.forEach((line, n) => {
    const y = top + n * lh;
    let x = t.align === 'right' ? w - line.width : t.align === 'center' ? (w - line.width) / 2 : 0;
    const spaces = line.text.split(' ').length - 1;
    const extra = t.align === 'justify' && !line.last && spaces ? (w - line.width) / spaces : 0;
    for (const seg of line.segs) {
      c.font = fontString(t, seg.style);
      c.fillStyle = seg.style.fill;
      const x0 = x;
      if (one) {
        for (const { ch } of graphemes(seg.text)) {
          if (ch === ' ') x += extra;
          c.fillText(ch, x, y);
          x += c.measureText(ch).width + ls;
        }
      } else {
        c.fillText(seg.text, x, y);
        x += seg.width;
      }
      deco(x0, y, x - x0, seg.style.decoration, seg.style.fill);
    }
  });
  c.restore();
}

// ---------- HTML (the text editor and the PDF export) ----------

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** CSS for a run, leaving out whatever matches `base`. */
export function runCss(st: RunStyle, base: RunStyle) {
  const out: string[] = [];
  if (st.fontWeight !== base.fontWeight) out.push(`font-weight:${st.fontWeight}`);
  if (st.italic !== base.italic) out.push(`font-style:${st.italic ? 'italic' : 'normal'}`);
  if (st.fill !== base.fill) out.push(`color:${st.fill}`);
  if (st.decoration !== base.decoration) out.push(`text-decoration:${st.decoration === 'none' ? 'none' : st.decoration}`);
  return out.join(';');
}

/** The text as HTML runs (no line breaking): styled spans for the ranges, plain text elsewhere. */
export function richHtml(t: TextNode, esc: (s: string) => string = escHtml): string {
  const base = baseStyle(t);
  const arr = perChar(t);
  let out = '';
  let i = 0;
  while (i < t.text.length) {
    let j = i + 1;
    const key = (o: Override | null) => KEYS.map((k) => String(o?.[k] ?? '')).join('|');
    while (j < t.text.length && key(arr[j]) === key(arr[i])) j++;
    const piece = esc(t.text.slice(i, j));
    const css = arr[i] ? runCss({ ...base, ...arr[i] }, base) : '';
    out += css ? `<span style="${css}">${piece}</span>` : piece;
    i = j;
  }
  return out;
}
