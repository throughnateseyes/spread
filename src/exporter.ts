import Konva from 'konva';
import { useStore, currentLayout, activeOrigin } from './store';
import { absoluteBoxes, canvasRefs, setSourceOverride } from './render';
import { loadFull } from './assets';
import { walk } from './tree';
import type { Box, SceneNode } from './types';

// Export renders a clone of the live content layer on an offscreen stage at scale 1,
// cropping one slide at a time. Photos are swapped to full-resolution bitmaps
// (decoded per slide, so memory stays bounded) instead of the on-screen previews.

export interface ExportOptions {
  scale: number;
  format: 'png' | 'jpeg';
  quality?: number;
  slides?: number[];
  includeStrip?: boolean;
  prefix?: string;
  onProgress?: (done: number, total: number) => void;
  /** Board to export (default: the active board). */
  boardId?: string;
}

/** Rendering always works on the active board; switch to the requested one first. */
function useBoard(id?: string) {
  if (id) useStore.getState().setActiveBoard(id);
}

const MAX_CANVAS = 16000;

async function quiesce() {
  // Editing/cropping state changes what the content layer draws; clear it first.
  const s = useStore.getState();
  if (s.editingTextId || s.croppingId) s.set({ editingTextId: null, croppingId: null });
  await document.fonts.ready;
  // Let React commit the state change (rAF alone stalls when the window is in the background).
  await new Promise((r) => {
    requestAnimationFrame(() => r(null));
    setTimeout(() => r(null), 60);
  });
}

function withOffscreenLayer<T>(fn: (layer: Konva.Layer) => Promise<T>): Promise<T> {
  const live = canvasRefs.content;
  if (!live) throw new Error('Canvas not ready');
  const s = useStore.getState();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;';
  document.body.appendChild(host);
  const stage = new Konva.Stage({ container: host, width: s.doc.slideWidth, height: s.doc.slideHeight });
  const layer = live.clone() as Konva.Layer;
  stage.add(layer);
  return fn(layer).finally(() => {
    stage.destroy();
    host.remove();
  });
}

function assetsIn(region: Box): Set<string> {
  const s = useStore.getState();
  const abs = absoluteBoxes(s.doc.nodes, currentLayout());
  const out = new Set<string>();
  walk(s.doc.nodes, (n) => {
    if (!n.visible) return false;
    const b = abs.get(n.id);
    if (n.type === 'image' && n.assetId && b && b.x < region.x + region.w && b.x + b.w > region.x && b.y < region.y + region.h && b.y + b.h > region.y) {
      out.add(n.assetId);
    }
  });
  return out;
}

function toBlob(c: HTMLCanvasElement, format: 'png' | 'jpeg', quality = 0.95): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), `image/${format}`, quality));
}

/** How far past a slide's edges to draw, so background blur at a seam can see the next slide. */
function blurReach(nodes: SceneNode[]) {
  let most = 0;
  walk(nodes, (n) => {
    if ((n.type === 'rect' || n.type === 'ellipse' || n.type === 'frame') && n.visible && n.backdropBlur) most = Math.max(most, n.backdropBlur);
  });
  return Math.ceil(most * 3);
}

function render(layer: Konva.Layer, region: Box, pixelRatio: number, format: 'png' | 'jpeg', bleed = { l: 0, r: 0 }) {
  let c = layer.toCanvas({ x: region.x - bleed.l, y: region.y, width: region.w + bleed.l + bleed.r, height: region.h, pixelRatio }) as HTMLCanvasElement;
  if (bleed.l || bleed.r) {
    const slide = document.createElement('canvas');
    slide.width = Math.round(region.w * pixelRatio);
    slide.height = c.height;
    slide.getContext('2d')!.drawImage(c, -bleed.l * pixelRatio, 0);
    c = slide;
  }
  if (format === 'png') return c;
  // JPEG has no alpha: flatten onto white.
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

/** Renders slides to canvases with full-res photos. `each` receives (slideIndex, canvas). */
async function renderSlides(indices: number[], pixelRatio: number, format: 'png' | 'jpeg', fullRes: boolean, each: (i: number, c: HTMLCanvasElement) => Promise<void>) {
  await quiesce();
  const s = useStore.getState();
  const W = s.doc.slideWidth;
  const H = s.doc.slideHeight;
  const o = activeOrigin();
  const reach = blurReach(s.doc.nodes);
  await withOffscreenLayer(async (layer) => {
    const cache = new Map<string, ImageBitmap>();
    try {
      for (const i of indices) {
        const region = { x: i * W, y: 0, w: W, h: H };
        const bleed = { l: Math.min(reach, i * W), r: Math.min(reach, (s.doc.slides.length - 1 - i) * W) };
        if (fullRes) {
          const need = assetsIn({ ...region, x: region.x - bleed.l, w: W + bleed.l + bleed.r });
          for (const [id, bmp] of cache) {
            if (!need.has(id)) {
              bmp.close();
              cache.delete(id);
            }
          }
          for (const id of need) {
            if (!cache.has(id)) {
              const p = loadFull(id);
              if (p) cache.set(id, await p);
            }
          }
          setSourceOverride(cache as any);
        }
        // Layer coords are canvas space; boards are offset by their origin.
        await each(i, render(layer, { ...region, x: region.x + o.x, y: region.y + o.y }, pixelRatio, format, bleed));
      }
    } finally {
      setSourceOverride(null);
      for (const b of cache.values()) b.close();
    }
  });
}

export async function exportSlides(opts: ExportOptions): Promise<{ name: string; blob: Blob }[]> {
  useBoard(opts.boardId);
  const s = useStore.getState();
  const n = s.doc.slides.length;
  const indices = (opts.slides?.length ? opts.slides : [...Array(n).keys()]).filter((i) => i >= 0 && i < n);
  const prefix = opts.prefix || 'slide';
  const ext = opts.format === 'png' ? 'png' : 'jpg';
  const total = indices.length + (opts.includeStrip ? 1 : 0);
  const out: { name: string; blob: Blob }[] = [];
  let done = 0;
  opts.onProgress?.(0, total);
  await renderSlides(indices, opts.scale, opts.format, true, async (i, c) => {
    out.push({ name: `${prefix}-${String(i + 1).padStart(2, '0')}.${ext}`, blob: await toBlob(c, opts.format, opts.quality ?? 0.95) });
    opts.onProgress?.(++done, total);
  });
  if (opts.includeStrip) {
    const W = s.doc.slideWidth * n;
    const ratio = Math.min(opts.scale, MAX_CANVAS / W, MAX_CANVAS / s.doc.slideHeight);
    await quiesce();
    await withOffscreenLayer(async (layer) => {
      const o = activeOrigin();
      const c = render(layer, { x: o.x, y: o.y, w: W, h: s.doc.slideHeight }, ratio, 'jpeg');
      out.push({ name: `${prefix}-strip.jpg`, blob: await toBlob(c, 'jpeg', 0.92) });
    });
    opts.onProgress?.(++done, total);
  }
  return out;
}

/** Quick JPEG renders (preview-resolution photos) for the phone preview. Caller revokes the URLs. */
export async function renderPreviews(scale = 0.5, boardId?: string): Promise<string[]> {
  useBoard(boardId);
  const n = useStore.getState().doc.slides.length;
  const urls: string[] = [];
  await renderSlides([...Array(n).keys()], scale, 'jpeg', false, async (_i, c) => {
    urls.push(URL.createObjectURL(await toBlob(c, 'jpeg', 0.85)));
  });
  return urls;
}

/** The whole board as one image (all slides side by side), longest side capped — for comparing variations. */
export async function renderBoardStripBase64(boardId: string, maxSide = 2400): Promise<{ boardId: string; mime: string; base64: string; width: number; height: number }> {
  useBoard(boardId);
  await quiesce();
  const s = useStore.getState();
  const W = s.doc.slideWidth * s.doc.slides.length;
  const H = s.doc.slideHeight;
  const ratio = Math.min(1, maxSide / Math.max(W, H));
  const o = activeOrigin();
  return withOffscreenLayer(async (layer) => {
    const c = render(layer, { x: o.x, y: o.y, w: W, h: H }, ratio, 'jpeg');
    return { boardId, mime: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.85).split(',')[1], width: c.width, height: c.height };
  });
}

/** The whole board on a canvas at 1x, or smaller when that wouldn't fit one (`ratio` says how much). */
export async function renderBoardCanvas(boardId: string, maxSide = 8000): Promise<{ canvas: HTMLCanvasElement; ratio: number }> {
  useBoard(boardId);
  await quiesce();
  const s = useStore.getState();
  const W = s.doc.slideWidth * s.doc.slides.length;
  const H = s.doc.slideHeight;
  const ratio = Math.min(1, maxSide / Math.max(W, H));
  const o = activeOrigin();
  return withOffscreenLayer(async (layer) => ({ canvas: render(layer, { x: o.x, y: o.y, w: W, h: H }, ratio, 'jpeg'), ratio }));
}

/** Base64 JPEG renders for automation (Claude looks at these). */
export async function renderSlidesBase64(indices: number[], scale = 0.4, boardId?: string): Promise<{ index: number; mime: string; base64: string }[]> {
  useBoard(boardId);
  const out: { index: number; mime: string; base64: string }[] = [];
  await renderSlides(indices, scale, 'jpeg', false, async (i, c) => {
    out.push({ index: i, mime: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
  });
  return out;
}
