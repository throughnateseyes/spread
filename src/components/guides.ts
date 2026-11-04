import type { Box } from '../types';

// Smart guides v2: snapping maths and the guide geometry drawn while dragging / resizing /
// measuring. Everything here is pure and works in the active board's strip space.
// Thresholds are in screen px (divided by zoom by the callers' `zoom` argument).

/** Snap distance to other objects' edges / centres. */
export const SNAP_OBJ = 5;
/** Snap distance to slide seams, slide edges / centres and the layout grid (magnetic). */
export const SNAP_STRONG = 8;
/** Snap distance for equal spacing (difference between gaps). */
export const SNAP_SPACING = 5;

export type LineKind = 'seam' | 'edge' | 'center' | 'grid';
export interface StrongLine {
  v: number;
  kind: LineKind;
}

export interface SnapContext {
  /** Vertical lines (x values) and horizontal lines (y values) with magnetic snapping. */
  xs: StrongLine[];
  ys: StrongLine[];
  /** Candidate objects (siblings, parent frame) in strip coords. */
  boxes: Box[];
  slideW: number;
  slideH: number;
  slides: number;
}

export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 'align' = red object guide, 'seam' = accent full-height slide line. */
  kind: 'align' | 'seam';
  /** Points that get a small × mark. */
  marks: { x: number; y: number }[];
}

export interface GuideGap {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
  /** 'spacing' = pink equal-spacing, 'measure' = red Alt measurement. */
  kind: 'spacing' | 'measure';
  /** Dashed extension lines (measurement to non-overlapping objects). */
  ext?: { x1: number; y1: number; x2: number; y2: number }[];
}

export interface Guides {
  lines: GuideLine[];
  gaps: GuideGap[];
}

export const NO_GUIDES: Guides = { lines: [], gaps: [] };

type Ax = 0 | 1; // 0 = x, 1 = y
const lo = (b: Box, ax: Ax) => (ax ? b.y : b.x);
const size = (b: Box, ax: Ax) => (ax ? b.h : b.w);
const hi = (b: Box, ax: Ax) => lo(b, ax) + size(b, ax);
const shift = (b: Box, ax: Ax, d: number): Box => (ax ? { ...b, y: b.y + d } : { ...b, x: b.x + d });
const overlaps = (a: Box, b: Box, ax: Ax) => lo(a, ax) < hi(b, ax) - 0.01 && hi(a, ax) > lo(b, ax) + 0.01;

interface Cand {
  d: number;
  rank: number; // tie-break: magnetic lines first, then objects, then spacing
}

/** Equal-spacing snap along one axis. Returns the correction, or null. */
function spacingSnap(m: Box, ax: Ax, boxes: Box[], thr: number): number | null {
  const cross = (1 - ax) as Ax;
  const row = boxes.filter((b) => overlaps(b, m, cross));
  if (!row.length) return null;
  const P = lo(m, ax);
  const S = size(m, ax);
  let L: Box | null = null;
  let R: Box | null = null;
  for (const b of row) {
    if (hi(b, ax) <= P + thr && lo(b, ax) < P && (!L || hi(b, ax) > hi(L, ax))) L = b;
    if (lo(b, ax) >= P + S - thr && hi(b, ax) > P + S && (!R || lo(b, ax) < lo(R, ax))) R = b;
  }
  let best: number | null = null;
  const consider = (d: number) => {
    if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  };
  if (L && R) consider((hi(L, ax) + lo(R, ax) - S) / 2 - P);
  // Match a gap that already exists between two other neighbours in this row.
  const sorted = [...row].sort((a, b) => lo(a, ax) - lo(b, ax));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const g = lo(sorted[i + 1], ax) - hi(sorted[i], ax);
    if (g <= 0) continue;
    if (L) consider(hi(L, ax) + g - P);
    if (R) consider(lo(R, ax) - g - S - P);
  }
  return best;
}

function bestAxis(m: Box, ax: Ax, ctx: SnapContext, zoom: number, objects: boolean): Cand | null {
  const P = lo(m, ax);
  const S = size(m, ax);
  const vals = [P, P + S / 2, P + S];
  let best: Cand | null = null;
  const consider = (c: Cand, thr: number) => {
    if (Math.abs(c.d) > thr) return;
    if (!best || Math.abs(c.d) < Math.abs(best.d) - 1e-6 || (Math.abs(c.d) <= Math.abs(best.d) + 1e-6 && c.rank < best.rank)) best = c;
  };
  const thrS = SNAP_STRONG / zoom;
  for (const l of ax ? ctx.ys : ctx.xs) for (const v of vals) consider({ d: l.v - v, rank: 0 }, thrS);
  if (objects) {
    const thrO = SNAP_OBJ / zoom;
    for (const b of ctx.boxes) {
      const bp = lo(b, ax);
      const bs = size(b, ax);
      for (const t of [bp, bp + bs / 2, bp + bs]) for (const v of vals) consider({ d: t - v, rank: 1 }, thrO);
    }
    const sp = spacingSnap(m, ax, ctx.boxes, SNAP_SPACING / zoom);
    if (sp !== null) consider({ d: sp, rank: 2 }, SNAP_SPACING / zoom);
  }
  return best;
}

/** Snaps a moving box (already offset by dx/dy) and returns the corrections plus guides to draw. */
export function snapMove(m: Box, ctx: SnapContext, zoom: number, lock: { x: boolean; y: boolean } = { x: false, y: false }) {
  const cx = lock.x ? null : bestAxis(m, 0, ctx, zoom, true);
  const cy = lock.y ? null : bestAxis(m, 1, ctx, zoom, true);
  const dx = cx?.d ?? 0;
  const dy = cy?.d ?? 0;
  const fin = { x: m.x + dx, y: m.y + dy, w: m.w, h: m.h };
  return { dx, dy, guides: buildGuides(fin, ctx, true) };
}

/** Snaps a single point (a resize anchor). `axes` says which coordinates may move. */
export function snapPoint(p: { x: number; y: number }, axes: { x: boolean; y: boolean }, ctx: SnapContext, zoom: number) {
  const box = { x: p.x, y: p.y, w: 0, h: 0 };
  const cx = axes.x ? bestAxis(box, 0, ctx, zoom, true) : null;
  const cy = axes.y ? bestAxis(box, 1, ctx, zoom, true) : null;
  return { x: p.x + (cx?.d ?? 0), y: p.y + (cy?.d ?? 0), snappedX: !!cx, snappedY: !!cy };
}

const EPS = 0.75;

/** Guides for a box at its final position: alignment segments, seam lines and equal spacing. */
export function buildGuides(m: Box, ctx: SnapContext, spacing: boolean): Guides {
  const lines: GuideLine[] = [];
  const gaps: GuideGap[] = [];
  for (const ax of [0, 1] as Ax[]) {
    const vals = [lo(m, ax), lo(m, ax) + size(m, ax) / 2, hi(m, ax)];
    const strong = ax ? ctx.ys : ctx.xs;
    const done = new Set<number>();
    for (const v of vals) {
      const key = Math.round(v * 2);
      if (done.has(key)) continue;
      // Seam / slide line: full slide height (or strip width), accent coloured.
      const sl = strong.find((l) => Math.abs(l.v - v) < EPS);
      if (sl) {
        done.add(key);
        lines.push(
          ax
            ? { x1: 0, y1: sl.v, x2: ctx.slideW * ctx.slides, y2: sl.v, kind: 'seam', marks: [] }
            : { x1: sl.v, y1: 0, x2: sl.v, y2: ctx.slideH, kind: 'seam', marks: [] },
        );
        continue;
      }
      // Object alignment: a segment spanning the moving box and every box sharing this coordinate.
      const hits = ctx.boxes.filter((b) => [lo(b, ax), lo(b, ax) + size(b, ax) / 2, hi(b, ax)].some((t) => Math.abs(t - v) < EPS));
      if (!hits.length) continue;
      done.add(key);
      const cross = (1 - ax) as Ax;
      const all = [m, ...hits];
      const a = Math.min(...all.map((b) => lo(b, cross)));
      const b = Math.max(...all.map((b) => hi(b, cross)));
      const marks = all.flatMap((bx) => [lo(bx, cross), hi(bx, cross)]).map((c) => (ax ? { x: c, y: v } : { x: v, y: c }));
      lines.push(ax ? { x1: a, y1: v, x2: b, y2: v, kind: 'align', marks } : { x1: v, y1: a, x2: v, y2: b, kind: 'align', marks });
    }
    if (spacing) gaps.push(...spacingGuides(m, ax, ctx.boxes));
  }
  return { lines, gaps };
}

/** Pink segments for every gap in the moving box's row that equals one of its own gaps. */
function spacingGuides(m: Box, ax: Ax, boxes: Box[]): GuideGap[] {
  const cross = (1 - ax) as Ax;
  const row = boxes.filter((b) => overlaps(b, m, cross));
  if (!row.length) return [];
  const sorted = [...row, m].sort((a, b) => lo(a, ax) - lo(b, ax));
  const pairs: { a: Box; b: Box; g: number }[] = [];
  // Consecutive non-overlapping neighbours (skip boxes that overlap along the axis).
  for (let i = 0; i < sorted.length; i++) {
    let j = i + 1;
    while (j < sorted.length && lo(sorted[j], ax) < hi(sorted[i], ax) - 0.01) j++;
    if (j < sorted.length) pairs.push({ a: sorted[i], b: sorted[j], g: lo(sorted[j], ax) - hi(sorted[i], ax) });
  }
  const mine = pairs.filter((p) => (p.a === m || p.b === m) && p.g > 0.5);
  if (!mine.length) return [];
  const out: GuideGap[] = [];
  const used = new Set<(typeof pairs)[number]>();
  for (const p of mine) {
    const same = pairs.filter((q) => q !== p && Math.abs(q.g - p.g) < EPS);
    if (!same.length) continue;
    for (const q of [p, ...same]) {
      if (used.has(q)) continue;
      used.add(q);
      const c0 = Math.max(lo(q.a, cross), lo(q.b, cross));
      const c1 = Math.min(hi(q.a, cross), hi(q.b, cross));
      const c = c1 > c0 ? (c0 + c1) / 2 : (lo(q.a, cross) + hi(q.a, cross)) / 2;
      const a = hi(q.a, ax);
      const b = lo(q.b, ax);
      out.push(ax ? { x1: c, y1: a, x2: c, y2: b, value: q.g, kind: 'spacing' } : { x1: a, y1: c, x2: b, y2: c, value: q.g, kind: 'spacing' });
    }
  }
  return out;
}

/**
 * Alt measurement (Figma's red distance lines) from selection S to target T.
 * T containing S: the four inner distances. Otherwise the edge-to-edge gap on each axis,
 * with dashed extensions when the boxes don't overlap on the other axis.
 */
export function measureGuides(S: Box, T: Box): Guides {
  const gaps: GuideGap[] = [];
  const contains = T.x <= S.x + 0.01 && T.y <= S.y + 0.01 && T.x + T.w >= S.x + S.w - 0.01 && T.y + T.h >= S.y + S.h - 0.01;
  const cx = S.x + S.w / 2;
  const cy = S.y + S.h / 2;
  if (contains) {
    const push = (x1: number, y1: number, x2: number, y2: number, v: number) => v > 0.01 && gaps.push({ x1, y1, x2, y2, value: v, kind: 'measure' });
    push(T.x, cy, S.x, cy, S.x - T.x);
    push(S.x + S.w, cy, T.x + T.w, cy, T.x + T.w - (S.x + S.w));
    push(cx, T.y, cx, S.y, S.y - T.y);
    push(cx, S.y + S.h, cx, T.y + T.h, T.y + T.h - (S.y + S.h));
    return { lines: [], gaps };
  }
  for (const ax of [0, 1] as Ax[]) {
    const cross = (1 - ax) as Ax;
    let a: number;
    let b: number;
    let edge: number; // T's edge the line ends on
    if (lo(S, ax) >= hi(T, ax)) {
      a = hi(T, ax);
      b = lo(S, ax);
      edge = a;
    } else if (hi(S, ax) <= lo(T, ax)) {
      a = hi(S, ax);
      b = lo(T, ax);
      edge = b;
    } else continue;
    const ov0 = Math.max(lo(S, cross), lo(T, cross));
    const ov1 = Math.min(hi(S, cross), hi(T, cross));
    const c = ov1 > ov0 ? (ov0 + ov1) / 2 : lo(S, cross) + size(S, cross) / 2;
    const ext: GuideGap['ext'] = [];
    if (ov1 <= ov0) {
      // Extend T's edge to the measurement line.
      const t0 = c < lo(T, cross) ? c : hi(T, cross);
      const t1 = c < lo(T, cross) ? lo(T, cross) : c;
      ext.push(ax ? { x1: t0, y1: edge, x2: t1, y2: edge } : { x1: edge, y1: t0, x2: edge, y2: t1 });
    }
    gaps.push(ax ? { x1: c, y1: a, x2: c, y2: b, value: b - a, kind: 'measure', ext } : { x1: a, y1: c, x2: b, y2: c, value: b - a, kind: 'measure', ext });
  }
  return { lines: [], gaps };
}

/** Distances to the slide containing S's centre (safe-margin check) plus seams S crosses. */
export function slideMeasure(S: Box, slideW: number, slideH: number, slides: number): Guides {
  const i = Math.max(0, Math.min(slides - 1, Math.floor((S.x + S.w / 2) / slideW)));
  const slide = { x: i * slideW, y: 0, w: slideW, h: slideH };
  const g = measureGuides(S, slide);
  // Clip-free variant when S pokes outside the slide: still show the inside distances that exist.
  if (!g.gaps.length) {
    const cy = S.y + S.h / 2;
    const cx = S.x + S.w / 2;
    if (S.x > slide.x) g.gaps.push({ x1: slide.x, y1: cy, x2: S.x, y2: cy, value: S.x - slide.x, kind: 'measure' });
    if (S.x + S.w < slide.x + slideW) g.gaps.push({ x1: S.x + S.w, y1: cy, x2: slide.x + slideW, y2: cy, value: slide.x + slideW - S.x - S.w, kind: 'measure' });
    if (S.y > 0) g.gaps.push({ x1: cx, y1: 0, x2: cx, y2: S.y, value: S.y, kind: 'measure' });
    if (S.y + S.h < slideH) g.gaps.push({ x1: cx, y1: S.y + S.h, x2: cx, y2: slideH, value: slideH - S.y - S.h, kind: 'measure' });
  }
  const cy = S.y + S.h / 2;
  for (let k = 1; k < slides; k++) {
    const sx = k * slideW;
    if (S.x < sx - 0.5 && S.x + S.w > sx + 0.5) {
      g.gaps.push({ x1: S.x, y1: cy - 14, x2: sx, y2: cy - 14, value: sx - S.x, kind: 'measure' });
      g.gaps.push({ x1: sx, y1: cy + 14, x2: S.x + S.w, y2: cy + 14, value: S.x + S.w - sx, kind: 'measure' });
    }
  }
  return g;
}

/** Label text for a gap: whole px, or one decimal when fractional. */
export function gapLabel(v: number) {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
