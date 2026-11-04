import type Konva from 'konva';
import type { Box, ImageNode, Paint, SceneNode } from './types';
import { getAsset } from './assets';
import { paintCanvas } from './gradients';
import type { LayoutMap } from './layout';

// Rendering helpers shared by the on-screen canvas and the exporter.

/** The live content layer (registered by Canvas). The exporter clones it. */
export const canvasRefs: {
  content: Konva.Layer | null;
  stage: Konva.Stage | null;
  /** Applies any view change still queued for the next frame (tests / benchmarks). */
  flushView?: () => void;
} = { content: null, stage: null };

/** One zoom range for every zoom path (wheel, pinch, fit, shortcuts, top bar). */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 32;
/** Ctrl +/- presets (Figma-like). */
export const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16, 32];

type Source = CanvasImageSource & { width: number; height: number };

/** During export, full-resolution bitmaps replace previews. */
let sourceOverride: Map<string, Source> | null = null;
export function setSourceOverride(m: typeof sourceOverride) {
  sourceOverride = m;
}

/** True while an export has full-resolution bitmaps in place. */
export const isExporting = () => sourceOverride !== null;

export function imageSource(assetId: string | null): Source | null {
  if (!assetId) return null;
  return sourceOverride?.get(assetId) ?? getAsset(assetId)?.preview ?? null;
}

// ---------- on-screen image sources: mip levels + baked adjustments ----------

/** Smaller copies of each preview (the preview itself is ≤1800px). Built lazily on first need. */
const MIP_SIZES = [600, 200];
const mips = new WeakMap<object, Source[]>();

function mipChain(src: Source): Source[] {
  let chain = mips.get(src);
  if (chain) return chain;
  chain = [src];
  let prev = src;
  for (const max of MIP_SIZES) {
    const k = max / Math.max(prev.width, prev.height);
    if (k >= 0.95) continue;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(prev.width * k));
    c.height = Math.max(1, Math.round(prev.height * k));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(prev, 0, 0, c.width, c.height);
    chain.push(c);
    prev = c;
  }
  mips.set(src, chain);
  return chain;
}

/** Brightness/contrast/saturation baked once per (source, filter) instead of a CSS filter on every draw. */
const baked = new WeakMap<object, Map<string, Source>>();
function bake(src: Source, filter: string): Source {
  let m = baked.get(src);
  if (!m) baked.set(src, (m = new Map()));
  let out = m.get(filter);
  if (!out) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.filter = filter;
    ctx.drawImage(src, 0, 0);
    out = c;
    // Keep a couple of variants per source (slider drags create many short-lived ones).
    if (m.size >= 3) m.delete(m.keys().next().value!);
    m.set(filter, out);
  } else {
    // LRU touch.
    m.delete(filter);
    m.set(filter, out);
  }
  return out;
}

/**
 * Picks the bitmap to draw an image node with: the smallest mip level that still has at least one
 * source pixel per device pixel (`devicePxPerSrcPx` is measured against the full preview), with the
 * node's adjustments pre-applied. `filtered` says whether the caller must still apply `filterString`.
 * During export (full-res override) the original bitmap is returned unchanged.
 */
export function drawSource(n: ImageNode, devicePxPerSrcPx: number): { src: Source; filtered: boolean } | null {
  if (!n.assetId) return null;
  const over = sourceOverride?.get(n.assetId);
  if (over) return { src: over, filtered: false };
  const preview = getAsset(n.assetId)?.preview;
  if (!preview) return null;
  let src: Source = preview;
  if (devicePxPerSrcPx > 0) {
    for (const lvl of mipChain(preview)) {
      if (lvl.width / preview.width >= devicePxPerSrcPx) src = lvl;
      else break;
    }
  }
  const f = filterString(n);
  if (f === 'none') return { src, filtered: true };
  return { src: bake(src, f), filtered: true };
}

export interface CropGeometry {
  /** Source rect (in source pixels of `src`). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rect inside the node box. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Destination px per source px. */
  k: number;
}

/** Works in the source's own pixel space, so previews and full-res bitmaps crop identically. */
export function cropGeometry(n: ImageNode, w: number, h: number, srcW: number, srcH: number): CropGeometry {
  if (n.fit === 'fit') {
    const k = Math.min(w / srcW, h / srcH);
    const dw = srcW * k;
    const dh = srcH * k;
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh, k };
  }
  const k = Math.max(w / srcW, h / srcH) * Math.max(1, n.crop.zoom);
  const rw = Math.min(srcW, w / k);
  const rh = Math.min(srcH, h / k);
  const cx = clamp(n.crop.cx * srcW, rw / 2, srcW - rw / 2);
  const cy = clamp(n.crop.cy * srcH, rh / 2, srcH - rh / 2);
  return { sx: cx - rw / 2, sy: cy - rh / 2, sw: rw, sh: rh, dx: 0, dy: 0, dw: w, dh: h, k };
}

export function clamp(v: number, lo: number, hi: number) {
  return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

export function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  if (rr <= 0) c.rect(x, y, w, h);
  else c.roundRect(x, y, w, h, rr);
}

export function filterString(n: ImageNode) {
  const { brightness: b, contrast: c, saturation: s } = n.adjust;
  if (!b && !c && !s) return 'none';
  return `brightness(${1 + b}) contrast(${1 + c}) saturate(${1 + s})`;
}

/** Start and end of a linear gradient across a w×h box. Angle is CSS-style: 0 = to top, 90 = to right, 180 = to bottom. */
export function linearPoints(angle: number, w: number, h: number) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  return { start: { x: w / 2 - dx * half, y: h / 2 - dy * half }, end: { x: w / 2 + dx * half, y: h / 2 + dy * half } };
}

/** Konva fill props for a Paint over a w×h box. */
export function paintProps(p: Paint | null, w: number, h: number): Record<string, unknown> {
  if (!p) return { fill: 'rgba(0,0,0,0)' };
  if (p.kind === 'solid') return { fill: p.color };
  if (p.kind !== 'linear' || p.grain) {
    const c = paintCanvas(p, w, h);
    return { fillPriority: 'pattern', fillPatternImage: c, fillPatternRepeat: 'no-repeat', fillPatternScaleX: w / c.width, fillPatternScaleY: h / c.height };
  }
  const { start, end } = linearPoints(p.angle, w, h);
  return { fillLinearGradientStartPoint: start, fillLinearGradientEndPoint: end, fillLinearGradientColorStops: [0, p.from, 1, p.to] };
}

/** Ellipses are centred on their origin, so fills computed for the box have to shift with them. */
export function ellipsePaintProps(p: Paint | null, w: number, h: number): Record<string, unknown> {
  const out = paintProps(p, w, h);
  for (const k of ['fillLinearGradientStartPoint', 'fillLinearGradientEndPoint']) {
    const pt = out[k] as { x: number; y: number } | undefined;
    if (pt) out[k] = { x: pt.x - w / 2, y: pt.y - h / 2 };
  }
  if (out.fillPatternImage) Object.assign(out, { fillPatternX: -w / 2, fillPatternY: -h / 2 });
  return out;
}

export function shadowProps(n: SceneNode): Record<string, unknown> {
  const s = n.shadow;
  if (!s?.enabled) return { shadowEnabled: false };
  return { shadowEnabled: true, shadowColor: s.color, shadowBlur: s.blur, shadowOffsetX: s.x, shadowOffsetY: s.y, shadowOpacity: 1 };
}

/** Absolute (strip-space) boxes for every node. */
export function absoluteBoxes(nodes: SceneNode[], layout: LayoutMap): Map<string, Box> {
  const out = new Map<string, Box>();
  const rec = (list: SceneNode[], ox: number, oy: number) => {
    for (const n of list) {
      const b = layout.get(n.id);
      if (!b) continue;
      const ab = { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h };
      out.set(n.id, ab);
      if (n.type === 'frame') rec(n.children, ab.x, ab.y);
    }
  };
  rec(nodes, 0, 0);
  return out;
}
