import Konva from 'konva';
import type { Box, FrameNode, SceneNode, TextNode } from './types';
import { clearRichCache, hasSpans, measureRich, richLines } from './richtext';

// Layout engine: resolves every node's box (relative to its parent) from stored sizes,
// hug/fill sizing and auto layout frames. Pure function of the node tree (+ loaded fonts).

export type LayoutMap = Map<string, Box>;

// ---------- text measurement ----------

const measurer = new Konva.Text({ wrap: 'word', padding: 0 });
const measureCache = new Map<string, { w: number; h: number }>();

export function clearMeasureCache() {
  measureCache.clear();
  clearRichCache();
}

export function textFontStyle(t: TextNode) {
  return `${t.italic ? 'italic ' : ''}${t.fontWeight}`;
}

export function displayText(t: TextNode) {
  return t.uppercase ? t.text.toUpperCase() : t.text;
}

export function letterSpacingPx(t: TextNode) {
  return (t.letterSpacing / 100) * t.fontSize;
}

/** Measures text. `width` undefined = no wrapping (auto width). */
export function measureText(t: TextNode, width?: number): { w: number; h: number } {
  // Styled ranges change widths (a bold word is wider), so those layers are measured run by run.
  if (hasSpans(t)) return measureRich(t, width);
  const key = [t.text, t.uppercase, t.fontFamily, t.fontWeight, t.italic, t.fontSize, t.lineHeight, t.letterSpacing, width ?? 'auto'].join('|');
  const hit = measureCache.get(key);
  if (hit) return hit;
  measurer.setAttrs({
    text: displayText(t) || ' ',
    fontFamily: t.fontFamily,
    fontStyle: textFontStyle(t),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: letterSpacingPx(t),
    width: (width === undefined ? 'auto' : Math.max(1, width)) as number,
  });
  // Round up to whole units, but ignore float noise: 2 lines of 9.5pt at 1.4737 is 28.0003, not 29.
  const up = (v: number) => Math.ceil(v - 0.01);
  const r = { w: width === undefined ? up(measurer.width()) : width, h: up(measurer.height()) };
  measureCache.set(key, r);
  return r;
}

export interface TextLine {
  text: string;
  /** Rendered width including letter spacing. */
  width: number;
  /** Last line of its paragraph (not stretched when justified). */
  last: boolean;
}

/**
 * The exact lines the canvas draws for a text layer at `width` (Konva's word wrap). The PDF
 * export places each one explicitly so line breaks match the canvas, and lint reads them.
 */
export function textLines(t: TextNode, width: number): TextLine[] {
  if (hasSpans(t)) return richLines(t, width).map((l) => ({ text: l.text, width: l.width, last: l.last }));
  measurer.setAttrs({
    text: displayText(t) || ' ',
    fontFamily: t.fontFamily,
    fontStyle: textFontStyle(t),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: letterSpacingPx(t),
    width: Math.max(1, width),
  });
  const arr = (measurer as unknown as { textArr: { text: string; width: number; lastInParagraph: boolean }[] }).textArr;
  return arr.map((l) => ({ text: l.text, width: l.width, last: l.lastInParagraph }));
}

// ---------- layout ----------

/** Natural size of a node, given optional externally-imposed width/height (from fill sizing). */
function measure(n: SceneNode, map: LayoutMap, fixedW?: number, fixedH?: number): { w: number; h: number } {
  if (n.type === 'text') {
    let w: number;
    let h: number;
    if (fixedW !== undefined) w = fixedW;
    else if (n.sizingH === 'hug') w = measureText(n).w;
    else w = n.w;
    if (fixedH !== undefined) h = fixedH;
    else if (n.sizingV === 'hug') h = n.sizingH === 'hug' && fixedW === undefined ? measureText(n).h : measureText(n, w).h;
    else h = n.h;
    return { w, h };
  }
  if (n.type === 'frame') return layoutFrame(n, map, fixedW, fixedH);
  return { w: fixedW ?? n.w, h: fixedH ?? n.h };
}

function layoutFrame(f: FrameNode, map: LayoutMap, fixedW?: number, fixedH?: number): { w: number; h: number } {
  const auto = f.layout !== 'none';
  if (!auto) {
    const w = fixedW ?? f.w;
    const h = fixedH ?? f.h;
    for (const c of f.children) {
      const s = measure(c, map);
      map.set(c.id, { x: c.x, y: c.y, w: s.w, h: s.h });
    }
    return { w, h };
  }

  const row = f.layout === 'row';
  const pad = f.padding;
  const padMain = row ? pad.l + pad.r : pad.t + pad.b;
  const padCross = row ? pad.t + pad.b : pad.l + pad.r;
  const mainSizing = row ? f.sizingH : f.sizingV;
  const crossSizing = row ? f.sizingV : f.sizingH;
  const outerMain = row ? fixedW : fixedH;
  const outerCross = row ? fixedH : fixedW;

  const hugMain = outerMain === undefined && mainSizing === 'hug';
  const hugCross = outerCross === undefined && crossSizing === 'hug';
  const frameMain = outerMain ?? (row ? f.w : f.h);
  const frameCross = outerCross ?? (row ? f.h : f.w);
  const innerMain = hugMain ? undefined : Math.max(0, frameMain - padMain);
  const innerCross = hugCross ? undefined : Math.max(0, frameCross - padCross);

  const kids = f.children.filter((c) => c.visible);
  const sizes = new Map<string, { w: number; h: number }>();
  const mainOf = (s: { w: number; h: number }) => (row ? s.w : s.h);
  const crossOf = (s: { w: number; h: number }) => (row ? s.h : s.w);
  const childMainSizing = (c: SceneNode) => (row ? c.sizingH : c.sizingV);
  const childCrossSizing = (c: SceneNode) => (row ? c.sizingV : c.sizingH);
  const fit = (c: SceneNode, main?: number, cross?: number) =>
    row ? measure(c, map, main, cross) : measure(c, map, cross, main);

  // Pass 1: everything that doesn't fill the main axis.
  let used = 0;
  const fillers: SceneNode[] = [];
  for (const c of kids) {
    const crossFill = childCrossSizing(c) === 'fill' && innerCross !== undefined ? innerCross : undefined;
    if (childMainSizing(c) === 'fill' && innerMain !== undefined) {
      fillers.push(c);
      continue;
    }
    const s = fit(c, undefined, crossFill);
    sizes.set(c.id, s);
    used += mainOf(s);
  }
  const gapTotal = Math.max(0, kids.length - 1) * (f.justify === 'between' ? 0 : f.gap);
  // Pass 2: fill children share what's left.
  if (fillers.length && innerMain !== undefined) {
    const each = Math.max(0, (innerMain - used - gapTotal) / fillers.length);
    for (const c of fillers) {
      const crossFill = childCrossSizing(c) === 'fill' && innerCross !== undefined ? innerCross : undefined;
      const s = fit(c, each, crossFill);
      sizes.set(c.id, s);
      used += mainOf(s);
    }
  }

  let maxCross = 0;
  for (const c of kids) maxCross = Math.max(maxCross, crossOf(sizes.get(c.id)!));
  const resolvedInnerCross = innerCross ?? maxCross;
  // Cross-fill children inside a hugging frame stretch to the tallest sibling.
  if (innerCross === undefined) {
    for (const c of kids) {
      if (childCrossSizing(c) === 'fill') {
        const s = sizes.get(c.id)!;
        sizes.set(c.id, fit(c, mainOf(s), resolvedInnerCross));
      }
    }
  }

  const contentMain = used + gapTotal;
  const resolvedInnerMain = innerMain ?? contentMain;
  let gap = f.gap;
  let cursor = 0;
  if (f.justify === 'between') {
    gap = kids.length > 1 ? Math.max(0, (resolvedInnerMain - used) / (kids.length - 1)) : 0;
  } else if (f.justify === 'center') cursor = (resolvedInnerMain - contentMain) / 2;
  else if (f.justify === 'end') cursor = resolvedInnerMain - contentMain;

  const startMain = row ? pad.l : pad.t;
  const startCross = row ? pad.t : pad.l;
  for (const c of kids) {
    const s = sizes.get(c.id)!;
    const cm = mainOf(s);
    const cc = crossOf(s);
    let off = 0;
    if (f.alignItems === 'center') off = (resolvedInnerCross - cc) / 2;
    else if (f.alignItems === 'end') off = resolvedInnerCross - cc;
    const m = startMain + cursor;
    const x = row ? m : startCross + off;
    const y = row ? startCross + off : m;
    map.set(c.id, { x, y, w: s.w, h: s.h });
    cursor += cm + gap;
  }
  // Hidden children keep their stored geometry so the layers panel can still reference them.
  for (const c of f.children) if (!c.visible) map.set(c.id, { x: c.x, y: c.y, ...measure(c, map) });

  const main = hugMain ? contentMain + padMain : frameMain;
  const cross = hugCross ? maxCross + padCross : frameCross;
  return row ? { w: main, h: cross } : { w: cross, h: main };
}

export function computeLayout(nodes: SceneNode[]): LayoutMap {
  const map: LayoutMap = new Map();
  for (const n of nodes) {
    const s = measure(n, map);
    map.set(n.id, { x: n.x, y: n.y, w: s.w, h: s.h });
  }
  return map;
}

/** Absolute (strip-space) box of a node: sums parent offsets. Ignores ancestor rotation. */
export function absoluteBox(map: LayoutMap, path: string[]): Box | null {
  let x = 0;
  let y = 0;
  let last: Box | null = null;
  for (const pid of path) {
    const b = map.get(pid);
    if (!b) return null;
    x += b.x;
    y += b.y;
    last = b;
  }
  return last ? { x, y, w: last.w, h: last.h } : null;
}

// ---------- inferring auto layout from an arrangement (Figma's Shift+A) ----------

export interface InferredAutoLayout {
  layout: 'row' | 'column';
  gap: number;
  alignItems: 'start' | 'center' | 'end';
  /** The ids in the order the auto layout should hold them. */
  order: string[];
}

const EDGE_TOLERANCE = 1;

/** Do the boxes, sorted along an axis, sit one after another without overlapping on it? */
function stacksAlong(boxes: (Box & { id: string })[], row: boolean) {
  const s = [...boxes].sort((a, b) => (row ? a.x - b.x : a.y - b.y));
  for (let i = 1; i < s.length; i++) {
    const prevEnd = row ? s[i - 1].x + s[i - 1].w : s[i - 1].y + s[i - 1].h;
    if ((row ? s[i].x : s[i].y) < prevEnd - EDGE_TOLERANCE) return false;
  }
  return true;
}

/**
 * Works out the auto layout that reproduces how layers are already arranged, the way Figma does
 * when you press Shift+A: the direction they're stacked in, the space between them, and the edge
 * they line up on. Two layers keep their exact gap. Three or more get one even gap: the shared gap
 * if they're already evenly spaced, otherwise the average, rounded.
 */
export function inferAutoLayout(boxes: (Box & { id: string })[], force?: 'row' | 'column'): InferredAutoLayout {
  if (!boxes.length) return { layout: 'column', gap: 0, alignItems: 'start', order: [] };
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const asRow = stacksAlong(boxes, true);
  const asColumn = stacksAlong(boxes, false);
  let row: boolean;
  if (force) row = force === 'row';
  else if (boxes.length === 1) row = x1 - x0 >= y1 - y0;
  else if (asRow !== asColumn) row = asRow;
  else {
    // Both (a diagonal) or neither (overlapping): follow where the centres spread out more.
    const cx = boxes.map((b) => b.x + b.w / 2);
    const cy = boxes.map((b) => b.y + b.h / 2);
    row = Math.max(...cx) - Math.min(...cx) >= Math.max(...cy) - Math.min(...cy);
  }

  const sorted = [...boxes].sort((a, b) => (row ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1];
    const c = sorted[i];
    gaps.push(row ? c.x - (p.x + p.w) : c.y - (p.y + p.h));
  }
  let gap = 0;
  if (gaps.length === 1) gap = gaps[0];
  else if (gaps.length > 1) {
    const even = Math.max(...gaps) - Math.min(...gaps) <= EDGE_TOLERANCE;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    gap = even ? gaps[0] : mean;
  }
  // Keep half units (points on paper often land on .5), drop float noise.
  gap = Math.max(0, Math.round(gap * 2) / 2);

  // Cross-axis alignment: the edge the layers share. Start wins ties, as in Figma.
  const starts = sorted.map((b) => (row ? b.y : b.x));
  const ends = sorted.map((b) => (row ? b.y + b.h : b.x + b.w));
  const mids = sorted.map((b) => (row ? b.y + b.h / 2 : b.x + b.w / 2));
  const same = (v: number[]) => Math.max(...v) - Math.min(...v) <= EDGE_TOLERANCE;
  const alignItems = boxes.length < 2 || same(starts) ? 'start' : same(mids) ? 'center' : same(ends) ? 'end' : 'start';

  return { layout: row ? 'row' : 'column', gap, alignItems, order: sorted.map((b) => b.id) };
}

/** Is `id`'s parent an auto layout frame? (Its x/y are then computed, not stored.) */
export function inAutoLayout(parent: FrameNode | null) {
  return !!parent && parent.layout !== 'none';
}

// Memoised layout per node tree (one per board). Keyed by the immutable nodes array.
let cacheVersion = -1;
let cache = new WeakMap<SceneNode[], LayoutMap>();
export function getLayout(nodes: SceneNode[], fontsVersion: number): LayoutMap {
  if (fontsVersion !== cacheVersion) {
    clearMeasureCache();
    cache = new WeakMap();
    cacheVersion = fontsVersion;
  }
  let m = cache.get(nodes);
  if (!m) {
    m = computeLayout(nodes);
    cache.set(nodes, m);
  }
  return m;
}

/** Height a board occupies: its slide height, or for auto-height boards the bottom of its content. */
export function contentBottom(nodes: SceneNode[], map: LayoutMap): number {
  let bottom = 0;
  for (const n of nodes) {
    const b = map.get(n.id);
    if (b && n.visible) bottom = Math.max(bottom, b.y + b.h);
  }
  return bottom;
}
