import Konva from 'konva';
import type { Box, Doc, FrameNode, ImageNode, SceneNode, ShapeNode } from '../types';
import { displayText, letterSpacingPx, textFontStyle, type LayoutMap } from '../layout';
import { getAsset, loadFull } from '../assets';
import { cropGeometry, ellipsePaintProps, filterString, paintProps } from '../render';
import { backdropScene, hasEffects, paintEffects } from '../effects';
import { findNode } from '../tree';
import type { EmailImage } from './html';

// Renders the pictures an email references (see buildEmailHtml's `images`): each photo layer
// with its crop, adjustments and corner radius, and each flattened frame/shape, at `scale`
// (2x by default so they stay sharp on retina screens). JPEG has no alpha, so rounded corners
// and letterboxing are filled with the colour behind the layer (`matte`) rather than left
// transparent; that keeps photos small and still looks right in Outlook. Each file is named with a
// short hash of its bytes, so a changed picture never reuses the name a sending tool already cached.

export interface RenderedEmailImage {
  nodeId: string;
  /** The exported name: the compiler's name plus a short hash of the file ("07-unit-6-photo-3f9a1c2b4d5e.jpg"). */
  fileName: string;
  /** The compiler's name (EmailImage.fileName), without the hash. */
  baseName: string;
  /** Hash of the file's bytes: the same picture always gets the same one. */
  hash: string;
  blob: Blob;
  /** Pixel size of the file. */
  width: number;
  height: number;
}

export interface RenderEmailImagesOptions {
  onProgress?: (done: number, total: number) => void;
  /** Problems are appended here (a picture that fails is skipped, not fatal). */
  warnings?: string[];
  /** JPEG quality 0..1 (default 0.9). */
  quality?: number;
}

type Source = CanvasImageSource & { width: number; height: number };

const PLACEHOLDER = '#D9D4CE';

/** Decoded photos for one export run. Full resolution when possible, else the preview. */
class Sources {
  private cache = new Map<string, Source | null>();
  private bitmaps: ImageBitmap[] = [];

  async get(assetId: string | null): Promise<Source | null> {
    if (!assetId) return null;
    if (this.cache.has(assetId)) return this.cache.get(assetId)!;
    let src: Source | null = null;
    try {
      const p = loadFull(assetId);
      if (p) {
        const bmp = await p;
        this.bitmaps.push(bmp);
        src = bmp;
      }
    } catch {
      src = null;
    }
    if (!src) src = getAsset(assetId)?.preview ?? null;
    this.cache.set(assetId, src);
    return src;
  }

  /** Drops decoded bitmaps no longer needed (keeps memory bounded on big shoots). */
  release(assetId: string) {
    const s = this.cache.get(assetId);
    if (s && typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) {
      s.close();
      this.bitmaps = this.bitmaps.filter((b) => b !== s);
    }
    this.cache.delete(assetId);
  }

  dispose() {
    for (const b of this.bitmaps) b.close();
    this.bitmaps = [];
    this.cache.clear();
  }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function roundedPath(c: CanvasRenderingContext2D, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  if (rr <= 0) c.rect(0, 0, w, h);
  else c.roundRect(0, 0, w, h, rr);
}

/** Draws a photo layer into a w×h (CSS px) box at `scale`, on a transparent canvas. */
function drawPhoto(n: ImageNode, w: number, h: number, scale: number, src: Source | null): HTMLCanvasElement {
  const c = canvas(w * scale, h * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  roundedPath(ctx, c.width, c.height, n.radius * scale);
  ctx.clip();
  ctx.globalAlpha = n.opacity;
  if (!src) {
    ctx.fillStyle = PLACEHOLDER;
    ctx.fillRect(0, 0, c.width, c.height);
  } else if (hasEffects(n)) {
    ctx.scale(scale, scale);
    paintEffects(ctx, n, w, h, src, scale, true);
  } else {
    ctx.filter = filterString(n);
    if (n.flipX || n.flipY) {
      ctx.translate(n.flipX ? c.width : 0, n.flipY ? c.height : 0);
      ctx.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1);
    }
    const g = cropGeometry(n, w, h, src.width, src.height);
    ctx.drawImage(src, g.sx, g.sy, g.sw, g.sh, g.dx * scale, g.dy * scale, g.dw * scale, g.dh * scale);
  }
  ctx.restore();
  if (n.stroke && n.strokeWidth > 0) {
    const sw = n.strokeWidth * scale;
    ctx.save();
    ctx.globalAlpha = n.opacity;
    ctx.strokeStyle = n.stroke;
    ctx.lineWidth = sw;
    ctx.beginPath();
    const rr = Math.max(0, n.radius * scale - sw / 2);
    ctx.roundRect(sw / 2, sw / 2, c.width - sw, c.height - sw, rr);
    ctx.stroke();
    ctx.restore();
  }
  return c;
}

function clipRounded(w: number, h: number, r: number) {
  return (ctx: Konva.Context) => {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(rr, 0);
    ctx.arcTo(w, 0, w, h, rr);
    ctx.arcTo(w, h, 0, h, rr);
    ctx.arcTo(0, h, 0, 0, rr);
    ctx.arcTo(0, 0, w, 0, rr);
    ctx.closePath();
  };
}

/** Builds a Konva subtree for `n` (box relative to its parent). Mirrors NodeView, minus editing. */
async function toKonva(n: SceneNode, b: Box, layout: LayoutMap, scale: number, sources: Sources, isRoot = false): Promise<Konva.Node | null> {
  if (!n.visible) return null;
  const common = { x: isRoot ? 0 : b.x, y: isRoot ? 0 : b.y, rotation: isRoot ? 0 : n.rotation, opacity: n.opacity };
  if (n.type === 'frame') {
    const g = new Konva.Group({ ...common });
    const content = new Konva.Group(
      n.clip ? (n.radius > 0 ? { clipFunc: clipRounded(b.w, b.h, n.radius) as any } : { clip: { x: 0, y: 0, width: b.w, height: b.h } }) : {},
    );
    if (n.backdropBlur) g.add(new Konva.Shape({ width: b.w, height: b.h, listening: false, sceneFunc: backdropScene(n, b.w, b.h) }));
    if (n.fill) g.add(new Konva.Rect({ width: b.w, height: b.h, cornerRadius: n.radius, ...paintProps(n.fill, b.w, b.h) }));
    g.add(content);
    for (const c of n.children) {
      const cb = layout.get(c.id);
      if (!cb) continue;
      const k = await toKonva(c, cb, layout, scale, sources);
      if (k) content.add(k as Konva.Shape | Konva.Group);
    }
    if (n.stroke && n.strokeWidth > 0) g.add(new Konva.Rect({ width: b.w, height: b.h, cornerRadius: n.radius, stroke: n.stroke, strokeWidth: n.strokeWidth, listening: false }));
    return g;
  }
  if (n.type === 'text') {
    return new Konva.Text({
      ...common,
      width: b.w,
      text: displayText(n),
      fontFamily: n.fontFamily,
      fontStyle: textFontStyle(n),
      fontSize: n.fontSize,
      lineHeight: n.lineHeight,
      letterSpacing: letterSpacingPx(n),
      align: n.align,
      fill: n.fill,
      textDecoration: n.decoration === 'none' ? '' : n.decoration,
      wrap: 'word',
    });
  }
  if (n.type === 'image') {
    const src = await sources.get(n.assetId);
    const pic = drawPhoto(n, b.w, b.h, scale, src);
    // drawPhoto already applied the layer opacity.
    return new Konva.Image({ ...common, opacity: 1, image: pic, width: b.w, height: b.h });
  }
  // Drawn under the shape, so the two go in a group that takes the layer's position.
  const behind = (shape: Konva.Shape) => {
    if (!n.backdropBlur) return shape;
    const g = new Konva.Group({ listening: false });
    g.add(new Konva.Shape({ ...common, width: b.w, height: b.h, sceneFunc: backdropScene(n, b.w, b.h) }), shape);
    return g;
  };
  if (n.type === 'rect') {
    return behind(
      new Konva.Rect({
        ...common,
        width: b.w,
        height: b.h,
        cornerRadius: n.radius,
        ...paintProps(n.fill, b.w, b.h),
        stroke: n.stroke ?? undefined,
        strokeWidth: n.stroke ? n.strokeWidth : 0,
      }),
    );
  }
  const p = ellipsePaintProps(n.fill, b.w, b.h);
  const e = new Konva.Ellipse({
    ...common,
    x: common.x + b.w / 2,
    y: common.y + b.h / 2,
    radiusX: b.w / 2,
    radiusY: b.h / 2,
    ...p,
    stroke: n.stroke ?? undefined,
    strokeWidth: n.stroke ? n.strokeWidth : 0,
  });
  if (isRoot) e.rotation(0);
  return behind(e);
}

/** Flattens a frame (or shape) into one canvas via an offscreen Konva stage. */
async function rasterize(n: SceneNode, w: number, h: number, layout: LayoutMap, scale: number, sources: Sources): Promise<HTMLCanvasElement> {
  await document.fonts.ready;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;pointer-events:none;';
  document.body.appendChild(host);
  const stage = new Konva.Stage({ container: host, width: w, height: h });
  try {
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    const k = await toKonva(n, { x: 0, y: 0, w, h }, layout, scale, sources, true);
    if (k) layer.add(k as Konva.Group | Konva.Shape);
    layer.draw();
    return layer.toCanvas({ x: 0, y: 0, width: w, height: h, pixelRatio: scale }) as HTMLCanvasElement;
  } finally {
    stage.destroy();
    host.remove();
  }
}

/** Everything painted before `id`, which is what its background blur shows. */
function paintedBefore(nodes: SceneNode[], id: string): { nodes: SceneNode[]; found: boolean } {
  const out: SceneNode[] = [];
  for (const n of nodes) {
    if (n.id === id) return { nodes: out, found: true };
    if (n.type === 'frame') {
      const inner = paintedBefore(n.children, id);
      if (inner.found) return { nodes: [...out, { ...n, children: inner.nodes }], found: true };
    }
    out.push(n);
  }
  return { nodes: out, found: false };
}

/**
 * A layer's background blur as a PNG of its box (`b`, in strip coordinates), for formats that can't
 * blur live. Drawn upright, so a rotated layer can rotate the picture with it.
 */
export async function backdropPicture(board: Doc, n: ShapeNode | FrameNode, b: Box, layout: LayoutMap, scale = 2): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;pointer-events:none;';
  document.body.appendChild(host);
  const stage = new Konva.Stage({ container: host, width: board.slideWidth * board.slides.length, height: board.slideHeight });
  const sources = new Sources();
  try {
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    const world = new Konva.Group({ x: b.x, y: b.y, offsetX: b.x, offsetY: b.y, rotation: -n.rotation });
    layer.add(world);
    board.slides.forEach((sl, i) => world.add(new Konva.Rect({ x: i * board.slideWidth, y: 0, width: board.slideWidth, height: board.slideHeight, fill: sl.background ?? board.background })));
    for (const c of paintedBefore(board.nodes, n.id).nodes) {
      const cb = layout.get(c.id);
      const k = cb && (await toKonva(c, cb, layout, scale, sources));
      if (k) world.add(k as Konva.Group | Konva.Shape);
    }
    world.add(new Konva.Shape({ x: b.x, y: b.y, rotation: n.rotation, width: b.w, height: b.h, sceneFunc: backdropScene(n, b.w, b.h) }));
    layer.draw();
    const c = layer.toCanvas({ x: b.x, y: b.y, width: b.w, height: b.h, pixelRatio: scale }) as HTMLCanvasElement;
    return c.toDataURL('image/png');
  } finally {
    sources.dispose();
    stage.destroy();
    host.remove();
  }
}

function flattenOnto(c: HTMLCanvasElement, matte: string): HTMLCanvasElement {
  const out = canvas(c.width, c.height);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = matte;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

function encode(c: HTMLCanvasElement, format: 'jpeg' | 'png', quality: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), `image/${format}`, quality));
}

/** Short content hash (12 hex characters). WordPress uploads are matched on it, so keep it stable. */
export async function hashOf(data: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** "07-unit-6-photo.jpg" + hash → "07-unit-6-photo-3f9a1c2b4d5e.jpg". */
export const withHash = (fileName: string, hash: string) => fileName.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${hash}${ext}`);

/**
 * Renders every picture in `images` (from buildEmailHtml) to a file blob.
 * `nodes` is the email root frame or the list containing it; `layout` covers it.
 */
export async function renderEmailImages(
  nodes: FrameNode | SceneNode[],
  layout: LayoutMap,
  images: EmailImage[],
  scale = 2,
  opts: RenderEmailImagesOptions = {},
): Promise<RenderedEmailImage[]> {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const quality = opts.quality ?? 0.9;
  const sources = new Sources();
  const out: RenderedEmailImage[] = [];
  // How many more times each photo is needed, so decoded bitmaps can be freed early.
  const remaining = new Map<string, number>();
  const assetsOf = (n: SceneNode, acc: string[] = []) => {
    if (n.type === 'image' && n.assetId) acc.push(n.assetId);
    if (n.type === 'frame') n.children.forEach((c) => assetsOf(c, acc));
    return acc;
  };
  const needs = images.map((im) => {
    const n = findNode(list, im.nodeId);
    const ids = n ? assetsOf(n) : [];
    for (const id of ids) remaining.set(id, (remaining.get(id) ?? 0) + 1);
    return { im, n, ids };
  });
  opts.onProgress?.(0, images.length);
  try {
    let done = 0;
    for (const { im, n, ids } of needs) {
      try {
        if (!n) throw new Error('layer not found');
        const w = im.width;
        const h = im.height;
        let c: HTMLCanvasElement;
        if (n.type === 'image' && !im.rasterize) {
          c = drawPhoto(n, w, h, scale, await sources.get(n.assetId));
        } else {
          c = await rasterize(n, w, h, layout, scale, sources);
        }
        if (im.format === 'jpeg') c = flattenOnto(c, im.matte);
        const blob = await encode(c, im.format, quality);
        const hash = await hashOf(new Uint8Array(await blob.arrayBuffer()));
        out.push({ nodeId: im.nodeId, fileName: withHash(im.fileName, hash), baseName: im.fileName, hash, blob, width: c.width, height: c.height });
      } catch (e) {
        opts.warnings?.push(`Couldn't render ${im.fileName}: ${(e as Error).message}. It was skipped.`);
      }
      for (const id of ids) {
        const left = (remaining.get(id) ?? 1) - 1;
        remaining.set(id, left);
        if (left <= 0) sources.release(id);
      }
      opts.onProgress?.(++done, images.length);
    }
  } finally {
    sources.dispose();
  }
  return out;
}
