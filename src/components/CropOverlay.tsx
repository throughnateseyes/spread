import { Group, Line, Rect, Shape, Text } from 'react-konva';
import type Konva from 'konva';
import { useStore, useLayout, activeOrigin } from '../store';
import { findNode } from '../tree';
import { getAsset } from '../assets';
import { clamp, cropGeometry, filterString, imageSource, roundRectPath } from '../render';
import { Floating } from '../ui/Floating';
import { Tooltip } from '../ui/Tooltip';
import { IconCheck, IconMinus, IconPlus, IconReset } from '../ui/icons';
import type { Box, ImageNode } from '../types';

// Figma-style crop mode. The frame keeps its size; the whole photo is shown on top of
// everything (dimmed outside the frame) with its own bounding box. Drag to reposition,
// drag a corner / scroll / use the slider to scale the photo inside the frame.

export const MAX_CROP_ZOOM = 8;

// The whole crop session (entry → Done) is one undo step: every edit uses this gesture key.
let sessionKey = 'g:crop';
export function beginCropSession(id: string) {
  sessionKey = `g:crop-${id}-${Date.now()}`;
}
export function cropKey() {
  return sessionKey;
}

export interface CropInfo {
  node: ImageNode;
  /** Frame box, absolute strip coords. */
  frame: Box;
  /** Original photo size (crop maths runs in these units). */
  srcW: number;
  srcH: number;
  /** Cover scale: frame px per source px at zoom 1. */
  base: number;
  /** Photo rect in "virtual" (unflipped) strip space. */
  image: Box;
}

export function cropInfoFor(id: string | null, nodes: Parameters<typeof findNode>[0], abs: Map<string, Box>): CropInfo | null {
  if (!id) return null;
  const n = findNode(nodes, id);
  const frame = abs.get(id);
  if (!n || n.type !== 'image' || !n.assetId || !frame || n.fit !== 'fill') return null;
  const meta = getAsset(n.assetId)?.meta;
  if (!meta) return null;
  const g = cropGeometry(n, frame.w, frame.h, meta.width, meta.height);
  const base = Math.max(frame.w / meta.width, frame.h / meta.height);
  return {
    node: n,
    frame,
    srcW: meta.width,
    srcH: meta.height,
    base,
    image: { x: frame.x - g.sx * g.k, y: frame.y - g.sy * g.k, w: meta.width * g.k, h: meta.height * g.k },
  };
}

/** Maps between real strip space and the unflipped space the crop maths uses (mirror about the frame centre). */
export function toVirtual(info: CropInfo, p: { x: number; y: number }) {
  const f = info.frame;
  return {
    x: info.node.flipX ? 2 * (f.x + f.w / 2) - p.x : p.x,
    y: info.node.flipY ? 2 * (f.y + f.h / 2) - p.y : p.y,
  };
}

export function displayRect(info: CropInfo): Box {
  const f = info.frame;
  const r = info.image;
  return {
    x: info.node.flipX ? 2 * (f.x + f.w / 2) - (r.x + r.w) : r.x,
    y: info.node.flipY ? 2 * (f.y + f.h / 2) - (r.y + r.h) : r.y,
    w: r.w,
    h: r.h,
  };
}

/** Clamps a crop so the photo always covers the frame. */
export function clampCrop(info: CropInfo, zoom: number, cx: number, cy: number) {
  const z = clamp(zoom, 1, MAX_CROP_ZOOM);
  const k = info.base * z;
  const visW = Math.min(1, info.frame.w / (info.srcW * k));
  const visH = Math.min(1, info.frame.h / (info.srcH * k));
  return { zoom: z, cx: clamp(cx, visW / 2, 1 - visW / 2), cy: clamp(cy, visH / 2, 1 - visH / 2) };
}

/** Crop after zooming by `factor` around strip point p (the point under the pointer stays put). */
export function cropZoomAt(info: CropInfo, factor: number, p: { x: number; y: number }) {
  const v = toVirtual(info, p);
  const r = info.image;
  const zoom = clamp(info.node.crop.zoom * factor, 1, MAX_CROP_ZOOM);
  const W = info.srcW * info.base * zoom;
  const H = info.srcH * info.base * zoom;
  const x = v.x - ((v.x - r.x) / r.w) * W;
  const y = v.y - ((v.y - r.y) / r.h) * H;
  const f = info.frame;
  return clampCrop(info, zoom, (f.x + f.w / 2 - x) / W, (f.y + f.h / 2 - y) / H);
}

/** Crop after dragging `corner` to virtual point p, keeping the opposite corner fixed. */
export function cropFromCorner(info: CropInfo, corner: string, anchor: { x: number; y: number }, p: { x: number; y: number }) {
  const aspect = info.srcW / info.srcH;
  const w = Math.max(Math.abs(p.x - anchor.x), Math.abs(p.y - anchor.y) * aspect);
  const zoom = clamp(w / info.srcW / info.base, 1, MAX_CROP_ZOOM);
  const W = info.srcW * info.base * zoom;
  const H = info.srcH * info.base * zoom;
  const x = corner.includes('l') ? anchor.x - W : anchor.x;
  const y = corner.includes('t') ? anchor.y - H : anchor.y;
  const f = info.frame;
  return clampCrop(info, zoom, (f.x + f.w / 2 - x) / W, (f.y + f.h / 2 - y) / H);
}

export function cornerAnchor(info: CropInfo, corner: string) {
  const r = info.image;
  return { x: corner.includes('l') ? r.x + r.w : r.x, y: corner.includes('t') ? r.y + r.h : r.y };
}

/** Konva elements for the crop layer (rendered above the dimmed outside-strip mask). */
export function CropLayerContent({
  info,
  zoom,
  setCursor,
  slideW,
  slideH,
  slides,
}: {
  info: CropInfo;
  zoom: number;
  setCursor: (c: string) => void;
  slideW: number;
  slideH: number;
  slides: number;
}) {
  const n = info.node;
  const f = info.frame;
  const d = displayRect(info);
  const inv = 1 / zoom;

  const draw = (c: CanvasRenderingContext2D, alpha: number, clipToFrame: boolean) => {
    const src = imageSource(n.assetId);
    if (!src) return;
    c.save();
    if (clipToFrame) {
      roundRectPath(c, f.x, f.y, f.w, f.h, n.radius);
      c.clip();
    }
    c.globalAlpha = alpha;
    c.filter = filterString(n);
    c.translate(d.x + (n.flipX ? d.w : 0), d.y + (n.flipY ? d.h : 0));
    c.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, d.w, d.h);
    c.restore();
  };
  const ctxOf = (k: Konva.Context) => (k as any)._context as CanvasRenderingContext2D;

  const hs = 9 * inv;
  const corners: [string, number, number, string][] = [
    ['tl', d.x, d.y, 'nwse-resize'],
    ['tr', d.x + d.w, d.y, 'nesw-resize'],
    ['bl', d.x, d.y + d.h, 'nesw-resize'],
    ['br', d.x + d.w, d.y + d.h, 'nwse-resize'],
  ];
  // Handle names are in display space; flips swap which virtual corner they drive.
  const virtualCorner = (c: string) => {
    let v = c;
    if (n.flipX) v = v.replace(/[lr]/, (m) => (m === 'l' ? 'r' : 'l'));
    if (n.flipY) v = v.replace(/[tb]/, (m) => (m === 't' ? 'b' : 't'));
    return v;
  };

  // Seams drawn on top: where a seam cuts the photo is the whole point of cropping a carousel.
  const top = Math.min(d.y, f.y);
  const bottom = Math.max(d.y + d.h, f.y + f.h);
  const seams: number[] = [];
  for (let k = 1; k < slides; k++) {
    const x = k * slideW;
    if (x > Math.min(d.x, f.x) && x < Math.max(d.x + d.w, f.x + f.w)) seams.push(x);
  }

  return (
    <>
      <Shape listening={false} sceneFunc={(k) => draw(ctxOf(k), 0.45, false)} />
      <Shape listening={false} sceneFunc={(k) => draw(ctxOf(k), 1, true)} />
      <Rect
        name="crop-img"
        x={d.x}
        y={d.y}
        width={d.w}
        height={d.h}
        fill="rgba(0,0,0,0)"
        stroke="#0d99ff"
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        onMouseEnter={() => setCursor('move')}
        onMouseLeave={() => setCursor('')}
      />
      <Rect x={f.x} y={f.y} width={f.w} height={f.h} cornerRadius={n.radius} stroke="#ffffff" strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
      {seams.map((x) => {
        const i = Math.round(x / slideW);
        // Keep labels near the frame when the zoomed photo runs far off the slide.
        const ly = Math.max(top, Math.min(f.y, slideH)) - 18 * inv;
        return (
          <Group key={x} listening={false}>
            <Line points={[x, top, x, bottom]} stroke="#0d99ff" opacity={0.75} strokeWidth={1} strokeScaleEnabled={false} dash={[6, 5]} />
            <Group x={x} y={ly} scaleX={inv} scaleY={inv}>
              <Rect x={-50} y={0} width={100} height={16} cornerRadius={3} fill="rgba(13,153,255,0.9)" />
              <Text x={-50} y={0} width={100} height={16} align="center" verticalAlign="middle" text={`Slide ${i} | Slide ${i + 1}`} fontSize={11} fontStyle="600" fill="#ffffff" />
            </Group>
          </Group>
        );
      })}
      {corners.map(([c, x, y, cur]) => (
        <Rect
          key={c}
          name={'crop-h-' + virtualCorner(c)}
          x={x - hs / 2}
          y={y - hs / 2}
          width={hs}
          height={hs}
          fill="#ffffff"
          stroke="#0d99ff"
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          cornerRadius={2 * inv}
          hitStrokeWidth={10 * inv}
          onMouseEnter={() => setCursor(cur)}
          onMouseLeave={() => setCursor('')}
        />
      ))}
    </>
  );
}

/** Floating zoom controls under (or above) the frame while cropping. Never clipped by panels. */
export function CropHud({ info, canvas }: { info: CropInfo; canvas: HTMLElement | null }) {
  const view = useStore((s) => s.view);
  useLayout();
  if (!canvas) return null;
  const n = info.node;
  const setZoom = (z: number) => {
    const c = clampCrop(info, z, n.crop.cx, n.crop.cy);
    useStore.getState().updateNode(n.id, (m) => {
      if (m.type === 'image') m.crop = c;
    }, cropKey());
  };
  const r = canvas.getBoundingClientRect();
  const o = activeOrigin();
  const d = displayRect(info);
  const f = info.frame;
  const z = view.zoom;
  const cx = r.left + view.panX + (o.x + f.x + f.w / 2) * z;
  const bottom = Math.max(f.y + f.h, d.y + d.h);
  const top = Math.min(f.y, d.y);
  return (
    <Floating
      x={cx}
      y={r.top + view.panY + (o.y + bottom) * z + 14}
      altY={r.top + view.panY + (o.y + top) * z - 14}
      anchor="top-center"
      bounds={canvas}
      interactive
      className="crop-hud"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <Tooltip label="Zoom out" side="top">
        <button aria-label="Zoom out" onClick={() => setZoom(n.crop.zoom / 1.2)}>
          <IconMinus />
        </button>
      </Tooltip>
      <input
        type="range"
        aria-label="Photo zoom"
        min={100}
        max={MAX_CROP_ZOOM * 100}
        value={Math.round(n.crop.zoom * 100)}
        onChange={(e) => setZoom(Number(e.target.value) / 100)}
      />
      <Tooltip label="Zoom in" side="top">
        <button aria-label="Zoom in" onClick={() => setZoom(n.crop.zoom * 1.2)}>
          <IconPlus />
        </button>
      </Tooltip>
      <span className="crop-pct">{Math.round(n.crop.zoom * 100)}%</span>
      <span className="crop-sep" />
      <Tooltip label="Reset crop" side="top">
        <button
          aria-label="Reset crop"
          onClick={() =>
            useStore.getState().updateNode(n.id, (m) => {
              if (m.type === 'image') m.crop = { zoom: 1, cx: 0.5, cy: 0.5 };
            }, cropKey())
          }
        >
          <IconReset />
        </button>
      </Tooltip>
      <Tooltip label="Apply crop" shortcut="Enter" side="top">
        <button className="crop-done" onClick={() => useStore.getState().set({ croppingId: null })}>
          <IconCheck /> Done
        </button>
      </Tooltip>
    </Floating>
  );
}
