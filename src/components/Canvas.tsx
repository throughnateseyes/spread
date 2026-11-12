import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva';
import Konva from 'konva';
import { useStore, useLayout, stripWidth, currentLayout, boardFrames, activeOrigin, type ViewState } from '../store';
import type { Box, Doc, FrameNode, SceneNode, Tool } from '../types';
import { cloneWithNewIds, findNode, findParent, locate, makeFrame, makeImage, makeShape, makeText, pathTo, walk } from '../tree';
import { getLayout, inAutoLayout, type LayoutMap } from '../layout';
import { absoluteBoxes, canvasRefs, clamp, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from '../render';
import { SceneNodes, type RenderState } from './NodeView';
import TextEditor from './TextEditor';
import SlideHeaders from './SlideHeaders';
import CommentPins from './CommentPins';
import LinkBadges from './LinkBadges';
import { ReferenceOverlay } from './OverlayPanel';
import { onBoard, startComment } from '../comments';
import ContextMenu, { swapPhotos, type MenuState } from './ContextMenu';
import {
  CropHud,
  CropLayerContent,
  beginCropSession,
  clampCrop,
  cornerAnchor,
  cropFromCorner,
  cropInfoFor,
  cropKey,
  cropZoomAt,
  displayRect,
  toVirtual,
  type CropInfo,
} from './CropOverlay';
import { filesFromDataTransfer } from '../assets';
import { emailTextDefaults } from '../email/templates';
import { importFiles, placeAssets } from '../importer';
import { Floating } from '../ui/Floating';
import { CANVAS_CHROME, useTheme } from '../theme';
import {
  NO_GUIDES,
  buildGuides,
  gapLabel,
  measureGuides,
  slideMeasure,
  snapMove,
  snapPoint,
  type GuideGap,
  type Guides,
  type SnapContext,
  type StrongLine,
} from './guides';

// The editing surface. Coordinates: "strip space" is document px of the active board (slide i spans
// x ∈ [i*W,(i+1)*W)); "canvas space" stacks every board (strip + board origin); "screen space" is
// px inside the canvas element: screen = canvas * zoom + pan.
//
// Performance model: the Stage's pan/zoom is applied imperatively from a store subscription (no
// React render for a pan), view writes from wheel/pan gestures are coalesced to one per frame,
// boards are memoised (an edit on the active row never re-renders the others), inactive boards
// don't listen (no hit-graph work) and are hidden when off-screen, and the content layer's hit
// graph is switched off for the duration of a wheel/pan gesture.

const ACCENT = '#0d99ff';
const GUIDE = '#f24822';
const SPACING = '#ff24bd';
const PICKED = '#14ae5c';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; panX: number; panY: number }
  | {
      kind: 'move';
      start: { x: number; y: number };
      items: { id: string; x: number; y: number }[];
      roots: string[];
      union: Box;
      autoChild: string | null;
      moved: boolean;
      key: string;
      ctx: SnapContext;
      /** Single filled photo being dragged (Shift-release on another photo swaps them). */
      image: string | null;
    }
  | { kind: 'marquee'; start: { x: number; y: number }; base: string[]; scope: string[] }
  | { kind: 'create'; tool: Tool; start: { x: number; y: number }; parentId: string | null; shift: boolean }
  | { kind: 'crop'; id: string; start: { x: number; y: number }; cx: number; cy: number; info: CropInfo }
  | { kind: 'crop-scale'; id: string; corner: string; anchor: { x: number; y: number }; info: CropInfo };

/** A photo slot under a drag (tray / OS drop target, or Shift-swap target). Canvas coords. */
interface Slot {
  boardId: string;
  id: string;
  box: Box;
}

// ---------- view: coalesced writes + animation ----------

let pendingView: ViewState | null = null;
let viewRaf = 0;
let viewTimer = 0;
/** The view as it will be after queued updates land. */
function liveView(): ViewState {
  return pendingView ?? useStore.getState().view;
}
function flushView() {
  if (viewRaf) cancelAnimationFrame(viewRaf);
  clearTimeout(viewTimer);
  viewRaf = 0;
  const p = pendingView;
  pendingView = null;
  if (p) useStore.getState().setView(p);
}
/** Queues a view change for the next frame (many wheel events per frame → one store write). */
function queueView(v: ViewState) {
  cancelViewAnim();
  pendingView = v;
  if (document.hidden) return flushView();
  if (!viewRaf) {
    viewRaf = requestAnimationFrame(flushView);
    // rAF can be throttled (occluded window): never let the view lag more than ~2 frames.
    viewTimer = window.setTimeout(flushView, 34);
  }
}

let viewAnim = 0;
let animTarget: ViewState | null = null;
export function cancelViewAnim() {
  if (viewAnim) cancelAnimationFrame(viewAnim);
  viewAnim = 0;
  animTarget = null;
}
/** Where the view is heading (the animation target, or the live view). */
function viewTarget(): ViewState {
  return animTarget ?? liveView();
}
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Eases the view to a target (ease-out). Zoom interpolates geometrically and the canvas point under
 * `anchor` (screen px; default: the canvas centre) moves linearly, so cursor-anchored zooms stay
 * pinned under the cursor. Any new input cancels it. Instant when hidden or with reduced motion.
 */
export function animateView(to: ViewState, ms = 200, anchor?: { x: number; y: number }) {
  flushView();
  const st = useStore.getState();
  const from = st.view;
  cancelViewAnim();
  if (document.hidden || ms <= 0 || reducedMotion()) return st.setView(to);
  const el = canvasEl();
  const a = anchor ?? { x: (el?.clientWidth ?? 800) / 2, y: (el?.clientHeight ?? 600) / 2 };
  const p0 = { x: (a.x - from.panX) / from.zoom, y: (a.y - from.panY) / from.zoom };
  const p1 = { x: (a.x - to.panX) / to.zoom, y: (a.y - to.panY) / to.zoom };
  animTarget = to;
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    if (k >= 1) {
      viewAnim = 0;
      animTarget = null;
      useStore.getState().setView(to);
      return;
    }
    const zoom = from.zoom * Math.pow(to.zoom / from.zoom, e);
    const px = p0.x + (p1.x - p0.x) * e;
    const py = p0.y + (p1.y - p0.y) * e;
    useStore.getState().setView({ zoom, panX: a.x - px * zoom, panY: a.y - py * zoom });
    viewAnim = requestAnimationFrame(step);
  };
  viewAnim = requestAnimationFrame(step);
  // Safety: if rAF is throttled, land on the target anyway.
  setTimeout(() => {
    if (animTarget === to) {
      cancelViewAnim();
      useStore.getState().setView(to);
    }
  }, ms + 150);
}

/** Zoom keeping the canvas point under screen (sx, sy) fixed. */
function zoomedView(v: ViewState, sx: number, sy: number, factor: number): ViewState {
  const z = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  const px = (sx - v.panX) / v.zoom;
  const py = (sy - v.panY) / v.zoom;
  return { zoom: z, panX: sx - px * z, panY: sy - py * z };
}

export default function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  const doc = useStore((s) => s.doc);
  const project = useStore((s) => s.project);
  // Only zoom (not pan) re-renders the canvas: overlay stroke widths and labels depend on it.
  const zoom = useStore((s) => s.view.zoom);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const editingTextId = useStore((s) => s.editingTextId);
  const croppingId = useStore((s) => s.croppingId);
  const showSeams = useStore((s) => s.showSeams);
  const chrome = CANVAS_CHROME[useTheme().theme];
  const showIgCrop = useStore((s) => s.showIgCrop);
  const layout = useLayout();
  const abs = useMemo(() => absoluteBoxes(doc.nodes, layout), [doc.nodes, layout]);

  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [draft, setDraft] = useState<{ tool: Tool; box: Box } | null>(null);
  const [dragOffset, setDragOffset] = useState<RenderState['dragOffset']>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverBoard, setHoverBoard] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [altDown, setAltDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [viewMoving, setViewMoving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [dropSlot, setDropSlot] = useState<Slot | null>(null);
  const [swapSlot, setSwapSlot] = useState<Slot | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [cropCursor, setCropCursor] = useState('');
  const dragRef = useRef<Drag | null>(null);
  const shiftRef = useRef(false);
  const spaceRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const endDragRef = useRef<(ev: { clientX: number; clientY: number; shiftKey: boolean } | null) => void>(() => {});

  // Entering crop mode starts one undo gesture; "Fit" photos switch to "Fill" (cropping only makes
  // sense when the photo covers the frame).
  useEffect(() => {
    if (!croppingId) return setCropCursor('');
    beginCropSession(croppingId);
    const s = useStore.getState();
    const n = findNode(s.doc.nodes, croppingId);
    if (n?.type === 'image' && n.fit === 'fit') s.updateNode(n.id, { fit: 'fill' }, cropKey());
    let seen = false;
    try {
      seen = localStorage.getItem('spread.cropHint') === '1';
      localStorage.setItem('spread.cropHint', '1');
    } catch {
      // storage unavailable
    }
    if (!seen) s.toast('Crop: drag to reposition · drag corners, scroll or use the slider to zoom · Enter when done');
  }, [croppingId]);

  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const N = doc.slides.length;
  const SW = stripWidth(doc);

  // ---------- sizing & fit ----------
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /** Hides off-screen inactive boards (Konva doesn't cull). The active board is always drawn (export uses it). */
  const cull = useCallback(() => {
    const layer = contentRef.current;
    const el = wrapRef.current;
    if (!layer || !el) return;
    const s = useStore.getState();
    const v = s.view;
    const x0 = -v.panX / v.zoom;
    const y0 = -v.panY / v.zoom;
    const x1 = x0 + el.clientWidth / v.zoom;
    const y1 = y0 + el.clientHeight / v.zoom;
    const frames = boardFrames(s.project);
    for (const g of layer.getChildren()) {
      if (g.name() !== 'board') continue;
      const id = g.id().slice(6);
      const f = frames.get(id);
      // Generous margin: bleed (content past the slides) is drawn too.
      const m = f ? f.h : 0;
      const vis = id === s.project.activeBoardId || !f || (f.x - m < x1 && f.x + f.w + m > x0 && f.y - m < y1 && f.y + f.h + m > y0);
      if (g.visible() !== vis) g.visible(vis);
    }
  }, []);

  // Pan/zoom drive the Stage directly: no React render per frame.
  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const apply = (v: ViewState) => {
      stage.scale({ x: v.zoom, y: v.zoom });
      stage.position({ x: v.panX, y: v.panY });
      cull();
      stage.batchDraw();
    };
    apply(useStore.getState().view);
    canvasRefs.flushView = flushView;
    return useStore.subscribe((s, prev) => {
      if (s.view !== prev.view) apply(s.view);
    });
  }, [cull]);
  useLayoutEffect(() => cull());

  /** Zooms so a canvas-space box fills the view (with room for board headers). */
  const zoomToBox = useCallback((b: Box, pad = 120, maxZoom = 8) => {
    const el = wrapRef.current;
    if (!el) return;
    const z = clamp(Math.min((el.clientWidth - pad) / b.w, (el.clientHeight - pad - 40) / b.h), ZOOM_MIN, maxZoom);
    // Sits high: the header needs 56px above, the dock and the add-section bar need the rest below.
    const lift = (pad + 40) / 2 - 56;
    animateView({ zoom: z, panX: el.clientWidth / 2 - (b.x + b.w / 2) * z, panY: el.clientHeight / 2 - (b.y + b.h / 2) * z - lift });
  }, []);

  /** Fit the active board, its row ('row': emails side by side), or every board ('all'). */
  const fit = useCallback(
    (scope: boolean | 'row' = false) => {
      const p = useStore.getState().project;
      const frames = boardFrames(p);
      const active = frames.get(p.activeBoardId);
      const list = scope === true ? [...frames.values()] : scope === 'row' ? [...frames.values()].filter((f) => f.y === active?.y) : [active!].filter(Boolean);
      if (list.length) zoomToBox(unionBox(list), 140);
    },
    [zoomToBox],
  );

  useEffect(() => {
    const t = setTimeout(() => fit(useStore.getState().project.boards.length > 1), 30);
    const center = () => {
      const el = wrapRef.current!;
      return { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    };
    const onFit = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      fit(detail === 'all' ? true : detail === 'row' ? 'row' : false);
    };
    const onZoomSel = () => {
      const s = useStore.getState();
      const a = absoluteBoxes(s.doc.nodes, currentLayout());
      const boxes = s.selection.map((id) => a.get(id)).filter(Boolean) as Box[];
      // Nothing selected: the active row.
      if (!boxes.length) return fit(false);
      // Capped at 400% so a small caption doesn't fill the screen.
      zoomToBox(offsetBox(unionBox(boxes), activeOrigin()), 120, 4);
    };
    const onZoomSlide = (e: Event) => {
      const i = (e as CustomEvent<number>).detail;
      const d = useStore.getState().doc;
      zoomToBox(offsetBox({ x: i * d.slideWidth, y: 0, w: d.slideWidth, h: d.slideHeight }, activeOrigin()));
    };
    const onZoomBy = (e: Event) => {
      const c = center();
      animateView(zoomedView(viewTarget(), c.x, c.y, (e as CustomEvent<number>).detail), 200);
    };
    const onZoomStep = (e: Event) => {
      const dir = (e as CustomEvent<number>).detail;
      const z = viewTarget().zoom;
      const next = dir > 0 ? (ZOOM_STEPS.find((s) => s > z * 1.001) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? ZOOM_MIN);
      const c = center();
      animateView(zoomedView(viewTarget(), c.x, c.y, next / z), 200);
    };
    const onZoomTo = (e: Event) => {
      const z = (e as CustomEvent<number>).detail || 1;
      const c = center();
      animateView(zoomedView(viewTarget(), c.x, c.y, z / viewTarget().zoom), 200);
    };
    const evs: [string, EventListener][] = [
      ['spread:fit', onFit],
      ['spread:zoom-selection', onZoomSel],
      ['spread:zoom-slide', onZoomSlide],
      ['spread:zoom-by', onZoomBy],
      ['spread:zoom-step', onZoomStep],
      ['spread:zoom-to', onZoomTo],
    ];
    for (const [n, f] of evs) window.addEventListener(n, f);
    return () => {
      clearTimeout(t);
      for (const [n, f] of evs) window.removeEventListener(n, f);
    };
  }, [fit, zoomToBox]);

  useEffect(() => {
    canvasRefs.content = contentRef.current;
    canvasRefs.stage = stageRef.current;
  });

  // ---------- gesture bookkeeping ----------
  const gestureTimer = useRef(0);
  /** Wheel/pan in progress: skip hit-graph redraws and hide the size badge until it settles. */
  const markViewGesture = () => {
    const layer = contentRef.current;
    if (layer?.listening()) layer.listening(false);
    setViewMoving(true);
    clearTimeout(gestureTimer.current);
    gestureTimer.current = window.setTimeout(endViewGesture, 160);
  };
  const endViewGesture = () => {
    clearTimeout(gestureTimer.current);
    if (dragRef.current?.kind === 'pan') return;
    const layer = contentRef.current;
    if (layer && !layer.listening()) {
      layer.listening(true);
      layer.batchDraw();
    }
    setViewMoving(false);
  };

  const capturePointer = () => {
    const id = pointerIdRef.current;
    const c = stageRef.current?.content;
    try {
      if (id != null && c && !c.hasPointerCapture(id)) c.setPointerCapture(id);
    } catch {
      // pointer already gone
    }
  };

  // ---------- keyboard state: space-pan / alt-measure / ctrl deep-hover ----------
  useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey;
      if (e.code === 'Space' && !isTyping()) {
        e.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          setSpaceDown(true);
        }
      }
      if (e.key === 'Alt' && !isTyping()) {
        e.preventDefault(); // no menu-bar focus
        setAltDown(true);
      }
      if (e.key === 'Control' || e.key === 'Meta') refreshHover(true);
    };
    const up = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey;
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceDown(false);
      }
      if (e.key === 'Alt') setAltDown(false);
      if (e.key === 'Control' || e.key === 'Meta') refreshHover(false);
    };
    // Alt+Tab / losing focus never delivers keyup: reset every held-key state and end any gesture.
    const reset = () => {
      spaceRef.current = false;
      shiftRef.current = false;
      setSpaceDown(false);
      setAltDown(false);
      if (dragRef.current) endDragRef.current(null);
    };
    const onVis = () => document.hidden && reset();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // ---------- coordinate helpers ----------
  /** Client px → canvas space (all boards). */
  const toCanvas = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = liveView();
    return { x: (clientX - r.left - v.panX) / v.zoom, y: (clientY - r.top - v.panY) / v.zoom };
  };
  /** Client px → the active board's strip space (where node coordinates live). */
  const toStrip = (clientX: number, clientY: number) => {
    const c = toCanvas(clientX, clientY);
    const o = activeOrigin();
    return { x: c.x - o.x, y: c.y - o.y };
  };
  /** The board whose group contains a hit shape, if any. */
  const boardOfTarget = (t: Konva.Node | null): string | null => {
    let n: Konva.Node | null = t;
    while (n && n !== contentRef.current) {
      if (n.name() === 'board') return n.id().slice(6);
      n = n.getParent();
    }
    return null;
  };
  /** The board under a canvas point (including its header band). */
  const boardAt = (c: { x: number; y: number }): string | null => {
    for (const [id, f] of boardFrames(useStore.getState().project)) {
      if (c.x >= f.x - 40 && c.x <= f.x + f.w + 80 && c.y >= f.y - 80 && c.y <= f.y + f.h + 40) return id;
    }
    return null;
  };

  /** Node ids from top-level down to the hit shape (locked nodes cut the path, unless a note is being pinned). */
  const hitPath = (target: Konva.Node | null, locked = false): string[] => {
    const ids: string[] = [];
    let n: Konva.Node | null = target;
    while (n && n !== contentRef.current) {
      if (n.name() === 'node' && n.id()) ids.unshift(n.id());
      n = n.getParent();
    }
    const nodes = useStore.getState().doc.nodes;
    const out: string[] = [];
    for (const id of ids) {
      const node = findNode(nodes, id);
      if (!node || (node.locked && !locked)) break;
      out.push(id);
    }
    return out;
  };

  /** Figma-style selection target: stay at the depth of the current selection. */
  const resolveTarget = (path: string[], deep: boolean): string | null => {
    if (!path.length) return null;
    if (deep) return path[path.length - 1];
    const sel = useStore.getState().selection;
    for (let i = path.length - 1; i >= 0; i--) if (sel.includes(path[i])) return path[i];
    const nodes = useStore.getState().doc.nodes;
    const parentsOfSel = new Set(sel.map((id) => findParent(nodes, id)?.id).filter(Boolean) as string[]);
    for (let i = path.length - 2; i >= 0; i--) if (parentsOfSel.has(path[i])) return path[i + 1];
    return path[0];
  };

  /** Re-resolves the hover target when Ctrl is pressed/released (deep-select preview). */
  const refreshHover = (deep: boolean) => {
    const lp = lastPointer.current;
    const stage = stageRef.current;
    if (!lp || !stage || dragRef.current || useStore.getState().tool !== 'move') return;
    const r = wrapRef.current!.getBoundingClientRect();
    const t = stage.getIntersection({ x: lp.x - r.left, y: lp.y - r.top });
    setHoverId(resolveTarget(hitPath(t), deep));
  };

  const isTransformerPart = (t: Konva.Node) => {
    let p: Konva.Node | null = t;
    while (p) {
      if (p === trRef.current) return true;
      p = p.getParent();
    }
    return false;
  };

  /**
   * Snap candidates for moving/resizing `roots`: slide edges/centres/seams + grid (magnetic), plus
   * the roots' siblings and parent frame — not every nested layer — culled to the viewport.
   */
  const snapContext = (roots: string[]): SnapContext => {
    const s = useStore.getState();
    const d = s.doc;
    const W = d.slideWidth;
    const H = d.slideHeight;
    const n = d.slides.length;
    const xs: StrongLine[] = [];
    const ys: StrongLine[] = [
      { v: 0, kind: 'edge' },
      { v: H / 2, kind: 'center' },
      { v: H, kind: 'edge' },
    ];
    for (let i = 0; i <= n; i++) {
      xs.push({ v: i * W, kind: i === 0 || i === n ? 'edge' : 'seam' });
      if (i < n) xs.push({ v: i * W + W / 2, kind: 'center' });
    }
    const g = d.grid;
    if (g.visible) {
      for (let i = 0; i < n; i++) for (const x of gridLines(g.columns, W)) xs.push({ v: i * W + x, kind: 'grid' });
      for (const y of gridLines(g.rows, H)) ys.push({ v: y, kind: 'grid' });
    }
    const a = absoluteBoxes(d.nodes, currentLayout());
    const parent = roots[0] ? findParent(d.nodes, roots[0]) : null;
    const siblings = parent ? parent.children : d.nodes;
    // Viewport in strip coords (with a margin), to drop far-away candidates.
    const el = wrapRef.current;
    const v = liveView();
    const o = activeOrigin();
    const vx0 = -v.panX / v.zoom - o.x;
    const vy0 = -v.panY / v.zoom - o.y;
    const vw = (el?.clientWidth ?? 2000) / v.zoom;
    const vh = (el?.clientHeight ?? 2000) / v.zoom;
    const view = { x: vx0 - vw * 0.25, y: vy0 - vh * 0.25, w: vw * 1.5, h: vh * 1.5 };
    const boxes: Box[] = [];
    for (const c of siblings) {
      if (roots.includes(c.id) || !c.visible) continue;
      const b = a.get(c.id);
      if (b && intersects(b, view)) boxes.push(b);
    }
    if (parent) {
      const pb = a.get(parent.id);
      if (pb) boxes.push(pb);
    }
    return { xs, ys, boxes, slideW: W, slideH: H, slides: n };
  };

  /** Topmost node path under a strip point by geometry (for boards that don't listen yet). */
  const geoPath = (nodes: SceneNode[], lay: LayoutMap, p: { x: number; y: number }, locked = false) => {
    const out: string[] = [];
    let list = nodes;
    let ox = 0;
    let oy = 0;
    for (;;) {
      let hit: SceneNode | null = null;
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        const b = lay.get(n.id);
        if (!n.visible || !b) continue;
        if (p.x >= ox + b.x && p.x <= ox + b.x + b.w && p.y >= oy + b.y && p.y <= oy + b.y + b.h) {
          hit = n;
          break;
        }
      }
      if (!hit || (hit.locked && !locked)) break;
      out.push(hit.id);
      if (hit.type !== 'frame') break;
      const b = lay.get(hit.id)!;
      ox += b.x;
      oy += b.y;
      list = hit.children;
    }
    return out;
  };

  /** Topmost image node (any depth) containing strip point p, excluding `exclude` subtrees. */
  const imageAt = (nodes: SceneNode[], lay: LayoutMap, p: { x: number; y: number }, exclude: Set<string> = new Set()) => {
    const a = absoluteBoxes(nodes, lay);
    let hit: string | null = null;
    walk(nodes, (n) => {
      if (exclude.has(n.id) || !n.visible) return false;
      const b = a.get(n.id);
      if (n.type === 'image' && b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) hit = n.id;
    });
    return hit as string | null;
  };

  /** The photo slot under a client point, on any board. */
  const slotAt = (clientX: number, clientY: number): Slot | null => {
    const s = useStore.getState();
    const c = toCanvas(clientX, clientY);
    for (const b of s.project.boards) {
      const f = boardFrames(s.project).get(b.id);
      if (!f || c.x < f.x || c.x > f.x + f.w || c.y < f.y || c.y > f.y + f.h) continue;
      const lay = getLayout(b.nodes, s.fontsVersion);
      const p = { x: c.x - f.x, y: c.y - f.y };
      const id = imageAt(b.nodes, lay, p);
      if (!id) return null;
      const bx = absoluteBoxes(b.nodes, lay).get(id)!;
      return { boardId: b.id, id, box: offsetBox(bx, f) };
    }
    return null;
  };

  // ---------- pointer interactions ----------
  useEffect(() => {
    const c = stageRef.current!.content;
    const onDown = (e: PointerEvent) => {
      pointerIdRef.current = e.pointerId;
    };
    c.addEventListener('pointerdown', onDown, true);
    return () => c.removeEventListener('pointerdown', onDown, true);
  }, []);

  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const ev = e.evt;
    setMenu(null);
    if (ev.button === 2) return; // context menu handles it
    cancelViewAnim();
    let s = useStore.getState();
    if (s.editingTextId) {
      s.set({ editingTextId: null });
    }
    if (isTransformerPart(e.target)) return;

    // Pan: middle button, space, or hand tool.
    if (ev.button === 1 || spaceRef.current || s.tool === 'hand') {
      ev.preventDefault();
      flushView();
      const v = useStore.getState().view;
      dragRef.current = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, panX: v.panX, panY: v.panY };
      setPanning(true);
      capturePointer();
      return;
    }
    // A half-written note stays put: a stray click shouldn't cost the text. Otherwise, any click
    // on the canvas closes what's open.
    if (s.commentDraft?.text.trim()) {
      ev.preventDefault();
      document.querySelector<HTMLTextAreaElement>('.comment-input')?.focus();
      return;
    }
    if (s.commentDraft || s.openComment) s.set({ commentDraft: null, openComment: null });
    // Pressing on another board (a variation row) makes it the active board and, in the same
    // click, selects what was under the pointer (inactive boards don't listen: hit by geometry).
    let activated = false;
    if (!s.croppingId) {
      const hitBoard = boardOfTarget(e.target) ?? boardAt(toCanvas(ev.clientX, ev.clientY));
      if (hitBoard && hitBoard !== s.project.activeBoardId) {
        s.setActiveBoard(hitBoard);
        s = useStore.getState();
        activated = true;
      }
    }
    const p = toStrip(ev.clientX, ev.clientY);
    const noting = s.tool === 'comment';
    const path = activated ? geoPath(s.doc.nodes, currentLayout(), p, noting) : hitPath(e.target, noting);

    // Crop mode: corner handles scale the photo, dragging anywhere on the photo repositions it.
    if (s.croppingId) {
      const info = cropInfoFor(s.croppingId, s.doc.nodes, absoluteBoxes(s.doc.nodes, currentLayout()));
      const hit = e.target.name();
      if (info && hit.startsWith('crop-h-')) {
        const corner = hit.slice(7);
        dragRef.current = { kind: 'crop-scale', id: info.node.id, corner, anchor: cornerAnchor(info, corner), info };
        capturePointer();
        return;
      }
      if (info && (hit === 'crop-img' || path.includes(s.croppingId))) {
        dragRef.current = { kind: 'crop', id: info.node.id, start: p, cx: info.node.crop.cx, cy: info.node.crop.cy, info };
        capturePointer();
        return;
      }
      s.set({ croppingId: null });
    }

    // A note goes on the deepest layer under the pointer, or on the board itself.
    if (noting) {
      // Without this the press moves focus to the page, straight out of the popover's field.
      ev.preventDefault();
      if (onBoard(s.doc, p)) startComment(p, path[path.length - 1] ?? null);
      return;
    }

    if (s.tool !== 'move') {
      // Creation tools: new node goes inside the deepest frame under the pointer.
      let parentId: string | null = null;
      for (let i = path.length - 1; i >= 0; i--) {
        const n = findNode(s.doc.nodes, path[i]);
        if (n?.type === 'frame') {
          parentId = n.id;
          break;
        }
      }
      dragRef.current = { kind: 'create', tool: s.tool, start: p, parentId, shift: ev.shiftKey };
      capturePointer();
      return;
    }

    const deep = ev.ctrlKey || ev.metaKey;
    const target = resolveTarget(path, deep);
    if (!target) {
      const scope = marqueeScope(p, deep);
      if (!ev.shiftKey) s.select([]);
      dragRef.current = { kind: 'marquee', start: p, base: ev.shiftKey ? s.selection : [], scope };
      capturePointer();
      return;
    }
    let sel = s.selection;
    if (ev.shiftKey) {
      sel = sel.includes(target) ? sel.filter((x) => x !== target) : [...sel, target];
      s.select(sel);
      if (!sel.includes(target)) return;
    } else if (!sel.includes(target)) {
      sel = [target];
      s.select(sel);
    }
    startMove(sel, p);
    capturePointer();
  };

  /** Begins a move gesture for `sel` (ancestors win over their selected descendants). */
  const startMove = (sel: string[], p: { x: number; y: number }) => {
    const s = useStore.getState();
    const nodes = s.doc.nodes;
    const roots = sel.filter((id) => !sel.some((o) => o !== id && pathTo(nodes, id).includes(o)));
    const a = absoluteBoxes(nodes, currentLayout());
    const single = roots.length === 1 ? roots[0] : null;
    const autoChild = single && inAutoLayout(findParent(nodes, single)) ? single : null;
    const items = roots
      .filter((id) => !inAutoLayout(findParent(nodes, id)))
      .map((id) => {
        const n = findNode(nodes, id)!;
        return { id, x: n.x, y: n.y };
      });
    const boxes = roots.map((id) => a.get(id)).filter(Boolean) as Box[];
    const one = single ? findNode(nodes, single) : null;
    dragRef.current = {
      kind: 'move',
      start: p,
      items,
      roots,
      union: unionBox(boxes),
      autoChild,
      moved: false,
      key: `g:move-${Date.now()}`,
      ctx: snapContext(roots),
      image: one?.type === 'image' && one.assetId ? one.id : null,
    };
  };

  /** Marquee candidates: the current context (children of the selection's frame when starting inside it), or every leaf with Ctrl. */
  const marqueeScope = (p: { x: number; y: number }, deep: boolean): string[] => {
    const s = useStore.getState();
    const nodes = s.doc.nodes;
    if (deep) {
      const out: string[] = [];
      walk(nodes, (n) => {
        if (n.locked || !n.visible) return false;
        if (n.type !== 'frame' || !n.children.length) out.push(n.id);
      });
      return out;
    }
    const parent = s.selection[0] ? findParent(nodes, s.selection[0]) : null;
    if (parent) {
      const fb = absoluteBoxes(nodes, currentLayout()).get(parent.id);
      if (fb && p.x >= fb.x && p.x <= fb.x + fb.w && p.y >= fb.y && p.y <= fb.y + fb.h) {
        return parent.children.filter((c) => !c.locked && c.visible).map((c) => c.id);
      }
    }
    return nodes.filter((n) => !n.locked && n.visible).map((n) => n.id);
  };

  /** Alt-drag: clone the dragged roots in place (one undo step with the move) and drag the clones. */
  const duplicateForDrag = (d: Extract<Drag, { kind: 'move' }>) => {
    const s = useStore.getState();
    const map = new Map<string, string>();
    s.change((doc) => {
      for (const it of d.items) {
        const loc = locate(doc.nodes, it.id);
        if (!loc) continue;
        const c = cloneWithNewIds(loc.list[loc.index]);
        loc.list.splice(loc.index + 1, 0, c);
        map.set(it.id, c.id);
      }
    }, d.key);
    if (!map.size) return;
    d.items = d.items.map((it) => ({ ...it, id: map.get(it.id) ?? it.id }));
    d.roots = d.roots.map((id) => map.get(id) ?? id);
    d.image = d.image ? (map.get(d.image) ?? null) : null;
    d.ctx = snapContext(d.roots);
    useStore.getState().set({ selection: d.roots });
  };

  const onDblClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const s = useStore.getState();
    if (s.tool !== 'move') return;
    const path = hitPath(e.target);
    if (!path.length) return;
    const sel = s.selection;
    // Double-click on a frame dives one level deeper.
    const selIdx = path.findIndex((id) => sel.includes(id));
    const target = selIdx >= 0 ? path[selIdx] : path[0];
    const n = findNode(s.doc.nodes, target);
    if (!n) return;
    if (n.type === 'text') s.set({ editingTextId: n.id, selection: [n.id] });
    else if (n.type === 'image' && n.assetId) s.set({ croppingId: n.id, selection: [n.id] });
    else if (n.type === 'frame' && selIdx >= 0 && selIdx < path.length - 1) {
      const child = findNode(s.doc.nodes, path[selIdx + 1]);
      s.select([path[selIdx + 1]]);
      if (child?.type === 'text') s.set({ editingTextId: child.id });
    }
  };

  useEffect(() => {
    let swapHinted = false;
    try {
      swapHinted = localStorage.getItem('spread.swapHint') === '1';
    } catch {
      // storage unavailable
    }
    const move = (ev: PointerEvent | MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const s = useStore.getState();
      if (d.kind === 'pan') {
        markViewGesture();
        queueView({ zoom: liveView().zoom, panX: d.panX + ev.clientX - d.sx, panY: d.panY + ev.clientY - d.sy });
        return;
      }
      const p = toStrip(ev.clientX, ev.clientY);
      const z = liveView().zoom;
      if (d.kind === 'crop') {
        const { info } = d;
        const k = info.image.w / info.srcW;
        let mx = p.x - d.start.x;
        let my = p.y - d.start.y;
        if (ev.shiftKey) {
          if (Math.abs(mx) > Math.abs(my)) my = 0;
          else mx = 0;
        }
        const dx = (mx * (info.node.flipX ? -1 : 1)) / k / info.srcW;
        const dy = (my * (info.node.flipY ? -1 : 1)) / k / info.srcH;
        const c = clampCrop(info, info.node.crop.zoom, d.cx - dx, d.cy - dy);
        s.updateNode(d.id, (n) => {
          if (n.type === 'image') n.crop = c;
        }, cropKey());
        return;
      }
      if (d.kind === 'crop-scale') {
        const c = cropFromCorner(d.info, d.corner, d.anchor, toVirtual(d.info, p));
        s.updateNode(d.id, (n) => {
          if (n.type === 'image') n.crop = c;
        }, cropKey());
        return;
      }
      if (d.kind === 'marquee') {
        const b = normBox(d.start, p);
        setMarquee(b);
        const a = absoluteBoxes(s.doc.nodes, currentLayout());
        const hits = d.scope.filter((id) => intersects(a.get(id), b));
        const next = [...new Set([...d.base, ...hits])];
        if (next.length !== s.selection.length || next.some((id, i) => id !== s.selection[i])) s.set({ selection: next });
        return;
      }
      if (d.kind === 'create') {
        let b = normBox(d.start, p);
        if (ev.shiftKey) {
          const m = Math.max(b.w, b.h);
          b = { x: p.x < d.start.x ? d.start.x - m : d.start.x, y: p.y < d.start.y ? d.start.y - m : d.start.y, w: m, h: m };
        }
        setDraft({ tool: d.tool, box: b });
        return;
      }
      if (d.kind === 'move') {
        let dx = p.x - d.start.x;
        let dy = p.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
        if (!d.moved) {
          d.moved = true;
          setDragging(true);
          if (ev.altKey && !d.autoChild && d.items.length) duplicateForDrag(d);
        }
        // Photo over another photo: Shift-release swaps them.
        if (d.image) {
          const exclude = new Set<string>();
          walk([findNode(s.doc.nodes, d.image)!].filter(Boolean), (n) => void exclude.add(n.id));
          const t = imageAt(s.doc.nodes, currentLayout(), p, exclude);
          if (t && ev.shiftKey) {
            const b = absoluteBoxes(s.doc.nodes, currentLayout()).get(t)!;
            setSwapSlot((cur) => (cur?.id === t ? cur : { boardId: s.project.activeBoardId, id: t, box: offsetBox(b, activeOrigin()) }));
          } else {
            setSwapSlot(null);
            if (t && !swapHinted) {
              swapHinted = true;
              try {
                localStorage.setItem('spread.swapHint', '1');
              } catch {
                // storage unavailable
              }
              s.toast('Tip: hold Shift and release over a photo to swap the two photos');
            }
          }
        }
        let lock: 'x' | 'y' | null = null;
        if (ev.shiftKey) {
          lock = Math.abs(dx) > Math.abs(dy) ? 'y' : 'x';
          if (lock === 'y') dy = 0;
          else dx = 0;
        }
        if (d.autoChild) {
          setDragOffset({ id: d.autoChild, dx, dy });
          return;
        }
        let g = NO_GUIDES;
        // Holding Ctrl/Cmd mid-drag suspends snapping (Alt is duplicate, like Figma).
        if (s.snap && !(ev.ctrlKey || ev.metaKey)) {
          const u = d.union;
          const r = snapMove({ x: u.x + dx, y: u.y + dy, w: u.w, h: u.h }, d.ctx, z, { x: lock === 'x', y: lock === 'y' });
          dx += r.dx;
          dy += r.dy;
          g = r.guides;
        }
        setGuides(g);
        const byId = new Map(d.items.map((i) => [i.id, i]));
        s.updateNodes(d.items.map((i) => i.id), (n) => {
          const it = byId.get(n.id)!;
          n.x = Math.round(it.x + dx);
          n.y = Math.round(it.y + dy);
        }, d.key);
      }
    };
    const end = (ev: { clientX: number; clientY: number; shiftKey: boolean } | null) => {
      const d = dragRef.current;
      dragRef.current = null;
      const id = pointerIdRef.current;
      try {
        if (id != null) stageRef.current?.content.releasePointerCapture(id);
      } catch {
        // not captured
      }
      setPanning(false);
      setDragging(false);
      setGuides(NO_GUIDES);
      setMarquee(null);
      setDraft(null);
      setSwapSlot(null);
      if (!d) return;
      const s = useStore.getState();
      if (d.kind === 'pan') {
        flushView();
        endViewGesture();
      }
      if (d.kind === 'move' && d.autoChild && d.moved) {
        if (ev) {
          const p = toStrip(ev.clientX, ev.clientY);
          reorderInAutoLayout(d.autoChild, p.x - d.start.x, p.y - d.start.y);
        }
        setDragOffset(null);
      }
      if (d.kind === 'move' && d.moved && d.image && ev?.shiftKey) {
        const p = toStrip(ev.clientX, ev.clientY);
        const exclude = new Set<string>();
        walk([findNode(s.doc.nodes, d.image)!].filter(Boolean), (n) => void exclude.add(n.id));
        const t = imageAt(s.doc.nodes, currentLayout(), p, exclude);
        if (t) {
          // The dragged slot returns home; only the photos trade places (one undo step).
          const byId = new Map(d.items.map((i) => [i.id, i]));
          s.updateNodes(d.items.map((i) => i.id), (n) => {
            const it = byId.get(n.id)!;
            n.x = it.x;
            n.y = it.y;
          }, d.key);
          swapPhotos(d.image, t, d.key);
        }
      }
      if (d.kind === 'create' && ev) {
        const p = toStrip(ev.clientX, ev.clientY);
        createNode(d, p);
      }
    };
    endDragRef.current = end;
    const up = (ev: PointerEvent | MouseEvent) => end(ev);
    const cancel = () => end(null);
    const lost = () => {
      if (dragRef.current) end(null);
    };
    const content = stageRef.current!.content;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    content.addEventListener('lostpointercapture', lost);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      content.removeEventListener('lostpointercapture', lost);
    };
  }, []);

  const reorderInAutoLayout = (id: string, dx: number, dy: number) => {
    const s = useStore.getState();
    const parent = findParent(s.doc.nodes, id);
    if (!parent) return;
    const lay = currentLayout();
    const row = parent.layout === 'row';
    const me = lay.get(id)!;
    const myC = row ? me.x + me.w / 2 + dx : me.y + me.h / 2 + dy;
    const vis = parent.children.filter((c) => c.visible && c.id !== id);
    const before = vis.find((c) => {
      const b = lay.get(c.id)!;
      return (row ? b.x + b.w / 2 : b.y + b.h / 2) > myC;
    });
    s.change((d) => {
      const loc = locate(d.nodes, id);
      if (!loc) return;
      const [n] = loc.list.splice(loc.index, 1);
      const idx = before ? loc.list.findIndex((c) => c.id === before.id) : loc.list.length;
      loc.list.splice(idx < 0 ? loc.list.length : idx, 0, n);
    });
  };

  const createNode = (d: Extract<Drag, { kind: 'create' }>, p: { x: number; y: number }) => {
    const s = useStore.getState();
    let b = normBox(d.start, p);
    const clicked = b.w * s.view.zoom < 4 && b.h * s.view.zoom < 4;
    const Wd = s.doc.slideWidth;
    const Hd = s.doc.slideHeight;
    if (clicked) {
      const def =
        d.tool === 'frame' ? { w: Wd * 0.5, h: Hd * 0.3 } : d.tool === 'image' ? { w: Wd * 0.5, h: Wd * 0.625 } : { w: 240, h: 240 };
      b = { x: d.start.x, y: d.start.y, w: def.w, h: def.h };
    } else if (d.shift || shiftRef.current) {
      const m = Math.max(b.w, b.h);
      b = { ...b, w: m, h: m };
    }
    let parentAbs = { x: 0, y: 0 };
    if (d.parentId) {
      const a = absoluteBoxes(s.doc.nodes, currentLayout()).get(d.parentId);
      if (a) parentAbs = a;
    }
    const x = Math.round(b.x - parentAbs.x);
    const y = Math.round(b.y - parentAbs.y);
    const w = Math.round(b.w);
    const h = Math.round(b.h);
    let node: SceneNode;
    if (d.tool === 'text') {
      node = makeText(x, y, 'Text', s.doc.kind === 'email' ? emailTextDefaults() : {});
      if (!clicked) {
        node.sizingH = 'fixed';
        node.w = w;
      }
    } else if (d.tool === 'frame') node = makeFrame(x, y, w, h);
    else if (d.tool === 'image') node = makeImage(x, y, w, h, null, 'Photo frame');
    else node = makeShape(d.tool === 'ellipse' ? 'ellipse' : 'rect', x, y, w, h);
    s.addNodes([node], d.parentId);
    s.set({ tool: 'move' });
    if (node.type === 'text') s.set({ editingTextId: node.id });
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => handleWheel(e.evt);
  const handleWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const s = useStore.getState();
    const r = wrapRef.current!.getBoundingClientRect();
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    let dx = ev.deltaX;
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    // A mouse-wheel notch (vs. trackpad scroll / pinch, which send small fractional deltas).
    const notch = ev.deltaMode === 1 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50 && Number.isInteger(ev.deltaY));
    const pinch = mod && !notch;
    // Crop mode: a notch or pinch over the photo zooms the crop, anchored at the pointer.
    // Two-finger scrolling still pans the canvas so the next slide stays reachable.
    if (s.croppingId && ((notch && !mod) || pinch)) {
      const info = cropInfoFor(s.croppingId, s.doc.nodes, absoluteBoxes(s.doc.nodes, currentLayout()));
      const p = toStrip(ev.clientX, ev.clientY);
      const dr = info ? displayRect(info) : null;
      if (info && dr && p.x >= dr.x && p.x <= dr.x + dr.w && p.y >= dr.y && p.y <= dr.y + dr.h) {
        const factor = notch ? Math.pow(1.2, -Math.sign(dy)) : Math.exp(-dy * 0.01);
        const c = cropZoomAt(info, factor, p);
        s.updateNode(info.node.id, (m) => {
          if (m.type === 'image') m.crop = c;
        }, cropKey());
        return;
      }
    }
    markViewGesture();
    if (mod) {
      if (notch) {
        // ×1.2 per notch, animated 120ms, anchored at the cursor; quick notches compound.
        animateView(zoomedView(viewTarget(), sx, sy, Math.pow(1.2, -Math.sign(dy))), 120, { x: sx, y: sy });
      } else {
        queueView(zoomedView(liveView(), sx, sy, Math.exp(-clamp(dy, -50, 50) * 0.01)));
      }
      return;
    }
    if (ev.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    const v = liveView();
    queueView({ zoom: v.zoom, panX: v.panX - dx, panY: v.panY - dy });
  };

  const onMouseMoveStage = (e: Konva.KonvaEventObject<MouseEvent>) => {
    lastPointer.current = { x: e.evt.clientX, y: e.evt.clientY };
    if (dragRef.current) return;
    if (e.evt.altKey !== altDown) setAltDown(e.evt.altKey);
    const s = useStore.getState();
    // Inactive rows get a hover outline: clicking them activates them.
    const b = boardAt(toCanvas(e.evt.clientX, e.evt.clientY));
    const hb = b && b !== s.project.activeBoardId && s.project.boards.length > 1 ? b : null;
    if (hb !== hoverBoard) setHoverBoard(hb);
    if (s.tool === 'comment') {
      const deepest = hitPath(e.target, true).pop() ?? null;
      if (deepest !== hoverId) setHoverId(deepest);
      return;
    }
    if (s.tool !== 'move') return hoverId && setHoverId(null);
    const t = resolveTarget(hitPath(e.target), e.evt.ctrlKey || e.evt.metaKey);
    if (t !== hoverId) setHoverId(t);
  };

  const onContextMenu = (e: Konva.KonvaEventObject<PointerEvent>) => {
    e.evt.preventDefault();
    let s = useStore.getState();
    const hitBoard = boardOfTarget(e.target) ?? boardAt(toCanvas(e.evt.clientX, e.evt.clientY));
    let activated = false;
    if (hitBoard && hitBoard !== s.project.activeBoardId) {
      s.setActiveBoard(hitBoard);
      s = useStore.getState();
      activated = true;
    }
    const at = toStrip(e.evt.clientX, e.evt.clientY);
    const path = activated ? geoPath(s.doc.nodes, currentLayout(), at) : hitPath(e.target);
    const t = resolveTarget(path, e.evt.ctrlKey || e.evt.metaKey);
    if (t && !s.selection.includes(t)) s.select([t]);
    if (!t) s.select([]);
    setMenu({ x: e.evt.clientX, y: e.evt.clientY, at });
  };

  // ---------- transformer ----------
  const transformCtx = useRef<SnapContext | null>(null);
  const transformKey = useRef('g:transform');
  useEffect(() => {
    const tr = trRef.current;
    const layer = contentRef.current;
    if (!tr || !layer) return;
    // Pinning a note never resizes anything, so the handles step aside.
    const hide = editingTextId || croppingId || tool === 'comment';
    const nodes = hide ? [] : (selection.map((id) => layer.findOne((n: Konva.Node) => n.id() === id && n.name() === 'node')).filter(Boolean) as Konva.Node[]);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
    nodes.forEach((kn) => kn.on('transform.spread', () => onTransformNode(kn)));
    return () => nodes.forEach((kn) => kn.off('.spread'));
  }, [selection, editingTextId, croppingId, doc.nodes, tool]);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    tr.on('transformstart.spread', () => {
      transformKey.current = `g:transform-${Date.now()}`;
      transformCtx.current = snapContext(useStore.getState().selection);
      setRotating(!!tr.getActiveAnchor()?.startsWith('rotater'));
      capturePointer();
    });
    tr.on('transformend.spread', () => {
      transformCtx.current = null;
      setRotating(false);
      setGuides(NO_GUIDES);
    });
    return () => void tr.off('.spread');
  }, []);

  useEffect(() => {
    trRef.current?.forceUpdate();
  }, [layout]);

  const onTransformNode = (kn: Konva.Node) => {
    const s = useStore.getState();
    const id = kn.id();
    const box = currentLayout().get(id);
    if (!box) return;
    const sx = kn.scaleX();
    const sy = kn.scaleY();
    kn.scale({ x: 1, y: 1 });
    const w = Math.max(1, Math.round(box.w * sx));
    const h = Math.max(1, Math.round(box.h * sy));
    const chW = Math.abs(sx - 1) > 1e-4;
    const chH = Math.abs(sy - 1) > 1e-4;
    const auto = inAutoLayout(findParent(s.doc.nodes, id));
    const x = kn.x();
    const y = kn.y();
    const rot = kn.rotation();
    s.updateNode(id, (n) => {
      if (!auto) {
        n.x = Math.round(x);
        n.y = Math.round(y);
        n.rotation = Math.round(rot * 100) / 100;
      }
      if (n.type === 'text') {
        if (chW) {
          n.w = w;
          n.sizingH = 'fixed';
        }
        if (chH) {
          n.h = h;
          n.sizingV = 'fixed';
          if (!chW && n.sizingH === 'hug') {
            n.w = box.w;
            n.sizingH = 'fixed';
          }
        }
        return;
      }
      if (chW) {
        n.w = w;
        n.sizingH = 'fixed';
      }
      if (chH) {
        n.h = h;
        n.sizingV = 'fixed';
      }
    }, transformKey.current);
  };

  /** Resize snapping (with guides). Ctrl/Cmd suspends it; rotated selections don't snap. */
  const anchorDragBoundFunc = (_old: Konva.Vector2d, pos: Konva.Vector2d, ev?: MouseEvent) => {
    const s = useStore.getState();
    const tr = trRef.current;
    const ctx = transformCtx.current;
    const name = tr?.getActiveAnchor() ?? '';
    if (!s.snap || !tr || !ctx || ev?.ctrlKey || ev?.metaKey || name.startsWith('rotater') || Math.abs(tr.rotation() % 90) > 0.01) {
      setGuides(NO_GUIDES);
      return pos;
    }
    const v = liveView();
    const o = activeOrigin();
    const p = { x: (pos.x - v.panX) / v.zoom - o.x, y: (pos.y - v.panY) / v.zoom - o.y };
    const axes = { x: !name.includes('center'), y: !name.startsWith('middle') };
    const r = snapPoint(p, axes, ctx, v.zoom);
    setGuides(r.snappedX || r.snappedY ? buildGuides({ x: r.x, y: r.y, w: 0, h: 0 }, ctx, false) : NO_GUIDES);
    return { x: (r.x + o.x) * v.zoom + v.panX, y: (r.y + o.y) * v.zoom + v.panY };
  };

  /** Figma-like handles: corner squares only; edges are invisible 8px hit zones; tiny boxes hide them. */
  const styleAnchor = (anchor: Konva.Rect) => {
    const tr = anchor.getParent() as Konva.Transformer | null;
    if (!tr) return;
    const name = anchor.name().split(' ')[0];
    const w = tr.width();
    const h = tr.height();
    const small = Math.min(w, h) < 24;
    if (name === 'top-center' || name === 'bottom-center') {
      const len = Math.max(0, w - 12);
      anchor.setAttrs({ width: len, height: 8, offsetX: len / 2, offsetY: 4, fill: 'transparent', strokeEnabled: false, visible: !small && len > 0 });
    } else if (name === 'middle-left' || name === 'middle-right') {
      const len = Math.max(0, h - 12);
      anchor.setAttrs({ width: 8, height: len, offsetX: 4, offsetY: len / 2, fill: 'transparent', strokeEnabled: false, visible: !small && len > 0 });
    } else if (Math.min(w, h) < 12) {
      // Very small objects: corners move outside the box so they don't cover it.
      const ox = name.includes('left') ? 8 : 0;
      const oy = name.includes('top') ? 8 : 0;
      anchor.setAttrs({ offsetX: ox, offsetY: oy });
    }
  };

  const selNode = selection.length === 1 ? findNode(doc.nodes, selection[0]) : null;
  const selInAuto = selNode ? inAutoLayout(findParent(doc.nodes, selNode.id)) : false;

  // ---------- drag & drop from OS / Photos tray ----------
  const isPhotoDrag = (dt: DataTransfer) => dt.types.includes('Files') || dt.types.includes('application/x-spread-assets');
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isPhotoDrag(e.dataTransfer)) return;
    // dragover is already rate-limited by the browser and the hit test is a cheap geometric walk.
    // Over a photo slot: outline that slot (dropping replaces its photo) instead of the whole-canvas overlay.
    const slot = slotAt(e.clientX, e.clientY);
    setDropSlot((cur) => (cur?.id === slot?.id && cur?.boardId === slot?.boardId ? cur : slot));
    setDropHover(!slot && e.dataTransfer.types.includes('Files'));
  };
  const clearDrop = () => {
    setDropHover(false);
    setDropSlot(null);
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    clearDrop();
    const slot = slotAt(e.clientX, e.clientY);
    // Dropping onto another board activates it first.
    const dropBoard = slot?.boardId ?? boardAt(toCanvas(e.clientX, e.clientY));
    if (dropBoard) useStore.getState().setActiveBoard(dropBoard);
    const p = toStrip(e.clientX, e.clientY);
    const s = useStore.getState();
    const imgId = slot?.id ?? null;

    const trayData = e.dataTransfer.getData('application/x-spread-assets');
    if (trayData) {
      const ids: string[] = JSON.parse(trayData);
      if (imgId && ids.length === 1) {
        s.updateNode(imgId, (n) => {
          if (n.type === 'image') {
            n.assetId = ids[0];
            n.crop = { zoom: 1, cx: 0.5, cy: 0.5 };
          }
        });
        s.select([imgId]);
      } else placeAssets(ids, p);
      return;
    }
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) await importFiles(files, { dropAt: p, targetImageId: imgId ?? undefined });
  };

  // ---------- overlay geometry ----------
  const inv = 1 / zoom;
  const big = 1e6;
  const grid = doc.grid;
  const colLines = grid.visible ? gridBands(grid.columns, W) : [];
  const rowBands = grid.visible ? gridBands(grid.rows, H) : [];
  const hoverBox = hoverId && !selection.includes(hoverId) ? abs.get(hoverId) : null;
  const hoverNode = hoverId ? findNode(doc.nodes, hoverId) : null;
  const multiOutlines = selection.length > 1 ? (selection.map((id) => abs.get(id)).filter(Boolean) as Box[]) : [];
  const igCrop = showIgCrop ? igCropBands(W, H) : null;

  const frames = boardFrames(project);
  const origin = frames.get(project.activeBoardId) ?? { x: 0, y: 0, w: SW, h: H };
  const cropInfo = croppingId ? cropInfoFor(croppingId, doc.nodes, abs) : null;
  const renderState = useMemo<RenderState>(() => ({ layout, editingTextId, croppingId, dragOffset }), [layout, editingTextId, croppingId, dragOffset]);

  // Alt held with a selection: red distances to the hovered layer, or to the slide's edges.
  const measured = useMemo(() => {
    if (!altDown || dragging || !selection.length || editingTextId) return null;
    const boxes = selection.map((id) => abs.get(id)).filter(Boolean) as Box[];
    if (!boxes.length) return null;
    const S = unionBox(boxes);
    const T = hoverId && !selection.includes(hoverId) ? abs.get(hoverId) : null;
    return T ? measureGuides(S, T) : slideMeasure(S, W, H, N);
  }, [altDown, dragging, selection, hoverId, abs, W, H, N, editingTextId]);

  const cursor = panning
    ? 'grabbing'
    : spaceDown || tool === 'hand'
      ? 'grab'
      : tool === 'move'
        ? (cropInfo && cropCursor) || 'default'
        : 'crosshair';

  // Row titles, size badges and other HTML overlays sit on top of the Konva stage and would swallow
  // the wheel, leaving dead spots where the canvas won't scroll. Catch the wheel on the wrapper too.
  const wheelRef = useRef(handleWheel);
  wheelRef.current = handleWheel;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onNativeWheel = (ev: WheelEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t || t.closest('.konvajs-content, .ctx-menu, .crop-hud, [data-own-wheel]')) return;
      wheelRef.current(ev);
    };
    // Clicking the canvas takes focus from the chat box or a panel field, so ⌘A, ⌘Z and the other
    // canvas shortcuts act on the canvas again (they're skipped while typing in a field).
    const onPointerDown = (ev: PointerEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && !el.contains(a) && (ev.target as HTMLElement | null)?.closest?.('.konvajs-content')) a.blur();
    };
    el.addEventListener('wheel', onNativeWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      el.removeEventListener('wheel', onNativeWheel);
      el.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap ${dropHover ? 'drop-hover' : ''}`}
      style={{ cursor }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) clearDrop();
      }}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        onMouseDown={onMouseDown}
        onDblClick={onDblClick}
        onWheel={onWheel}
        onMouseMove={onMouseMoveStage}
        onMouseLeave={() => {
          setHoverId(null);
          setHoverBoard(null);
        }}
        onContextMenu={onContextMenu}
      >
        <Layer ref={contentRef}>
          {project.boards.map((b) => {
            const f = frames.get(b.id)!;
            const active = b.id === project.activeBoardId;
            return <BoardView key={b.id} board={b} x={f.x} y={f.y} active={active} state={active ? renderState : null} />;
          })}
        </Layer>
        <Layer listening={false}>
          {/* Dim everything outside the boards so bleed is visible but clearly off-slide. */}
          <Shape
            sceneFunc={(kctx) => {
              const c = (kctx as any)._context as CanvasRenderingContext2D;
              c.beginPath();
              c.rect(-big, -big, big * 2, big * 2);
              for (const f of frames.values()) c.rect(f.x + f.w, f.y, -f.w, f.h); // reversed = hole
              c.fillStyle = chrome.dim;
              c.fill('evenodd');
            }}
          />
          {project.boards.map((b) => {
            const f = frames.get(b.id)!;
            const active = b.id === project.activeBoardId && project.boards.length > 1;
            const hovered = b.id === hoverBoard;
            return (
              <Group key={b.id}>
                {b.status === 'picked' && (
                  <Rect x={f.x - 4 * inv} y={f.y - 4 * inv} width={f.w + 8 * inv} height={f.h + 8 * inv} stroke={PICKED} strokeWidth={2} strokeScaleEnabled={false} cornerRadius={2 * inv} />
                )}
                <Rect
                  x={f.x}
                  y={f.y}
                  width={f.w}
                  height={f.h}
                  stroke={active ? 'rgba(13,153,255,0.55)' : hovered ? chrome.outlineHover : chrome.outline}
                  strokeWidth={active ? 2 : 1}
                  strokeScaleEnabled={false}
                />
              </Group>
            );
          })}
          <Group x={origin.x} y={origin.y}>
            {doc.slides.map((sl, i) => (
              <Group key={sl.id}>
                {colLines.map((b, j) => (
                  <Rect key={'c' + j} x={i * W + b.a} y={0} width={b.b - b.a} height={H} fill={grid.color} />
                ))}
                {rowBands.map((b, j) => (
                  <Rect key={'r' + j} x={i * W} y={b.a} width={W} height={b.b - b.a} fill={grid.color} />
                ))}
              </Group>
            ))}
            {showSeams &&
              doc.slides.slice(1).map((sl, i) => (
                <Line key={sl.id} points={[(i + 1) * W, 0, (i + 1) * W, H]} stroke={ACCENT} opacity={0.75} strokeWidth={1} strokeScaleEnabled={false} dash={[6, 5]} />
              ))}
            {igCrop && (
              <>
                <Rect x={0} y={0} width={igCrop.side} height={H} fill="rgba(151,71,255,0.28)" />
                <Rect x={W - igCrop.side} y={0} width={igCrop.side} height={H} fill="rgba(151,71,255,0.28)" />
                {igCrop.top > 0 && <Rect x={0} y={0} width={W} height={igCrop.top} fill="rgba(151,71,255,0.28)" />}
                {igCrop.top > 0 && <Rect x={0} y={H - igCrop.top} width={W} height={igCrop.top} fill="rgba(151,71,255,0.28)" />}
                <Text x={igCrop.side + 10 * inv} y={(igCrop.top || 0) + 10 * inv} text="Profile grid (3:4)" fontSize={12 * inv} fill="#9747ff" fontStyle="600" />
              </>
            )}
            {hoverBox && hoverNode && (
              <Rect x={hoverBox.x} y={hoverBox.y} width={hoverBox.w} height={hoverBox.h} rotation={hoverNode.rotation} stroke={ACCENT} strokeWidth={1.5} strokeScaleEnabled={false} />
            )}
            {multiOutlines.map((b, i) => (
              <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} stroke={ACCENT} strokeWidth={1} strokeScaleEnabled={false} />
            ))}
            <GuideShapes g={guides} inv={inv} />
            {measured && <GuideShapes g={measured} inv={inv} />}
            {marquee && <Rect {...boxProps(marquee)} fill="rgba(13,153,255,0.08)" stroke={ACCENT} strokeWidth={1} strokeScaleEnabled={false} />}
            {draft && (
              <Rect
                {...boxProps(draft.box)}
                cornerRadius={0}
                stroke={ACCENT}
                strokeWidth={1}
                strokeScaleEnabled={false}
                fill={draft.tool === 'frame' ? 'rgba(255,255,255,0.5)' : 'rgba(13,153,255,0.06)'}
              />
            )}
          </Group>
          {/* Photo-slot targets (canvas coords: may be on any board). */}
          {[dropSlot, swapSlot].map(
            (sl, i) => sl && <Rect key={i} {...boxProps(sl.box)} stroke={ACCENT} strokeWidth={2} strokeScaleEnabled={false} fill="rgba(13,153,255,0.12)" />,
          )}
        </Layer>
        {cropInfo && (
          <Layer>
            <Group x={origin.x} y={origin.y}>
              <CropLayerContent info={cropInfo} zoom={zoom} setCursor={setCropCursor} slideW={W} slideH={H} slides={N} />
            </Group>
          </Layer>
        )}
        <Layer>
          <Transformer
            ref={trRef}
            rotateEnabled={!selInAuto}
            rotateMode="corners"
            keepRatio={false}
            flipEnabled={false}
            ignoreStroke
            borderStroke={ACCENT}
            borderStrokeWidth={1}
            anchorStroke={ACCENT}
            anchorStrokeWidth={1}
            anchorFill="#ffffff"
            anchorSize={8}
            anchorCornerRadius={1}
            rotationSnaps={[0, 90, 180, 270]}
            rotationSnapTolerance={3}
            anchorStyleFunc={styleAnchor}
            anchorDragBoundFunc={anchorDragBoundFunc}
            boundBoxFunc={(oldB, newB) => (Math.abs(newB.width) < 2 || Math.abs(newB.height) < 2 ? oldB : newB)}
          />
        </Layer>
      </Stage>
      <ReferenceOverlay />
      <SlideHeaders />
      <LinkBadges />
      <CommentPins wrap={wrapRef.current} />
      {editingTextId && <TextEditor />}
      {cropInfo && <CropHud info={cropInfo} canvas={wrapRef.current} />}
      {selection.length > 0 && !editingTextId && !cropInfo && !viewMoving && <SizeBadge wrap={wrapRef.current} rotating={rotating} />}
      {(dropSlot || swapSlot) && <SlotPill slot={(swapSlot ?? dropSlot)!} label={swapSlot ? 'Swap photos' : 'Replace photo'} wrap={wrapRef.current} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** One board (a row on the canvas): slide backgrounds + its nodes, offset to its origin. */
const BoardView = memo(function BoardView({ board, x, y, active, state }: { board: Doc; x: number; y: number; active: boolean; state: RenderState | null }) {
  const fv = useStore((s) => s.fontsVersion);
  const own = useMemo<RenderState | null>(
    () => (state ? null : { layout: getLayout(board.nodes, fv), editingTextId: null, croppingId: null, dragOffset: null }),
    [state, board.nodes, fv],
  );
  const st = state ?? own!;
  const W = board.slideWidth;
  // Rejected rows recede (only while inactive, so editing / exporting one renders it normally).
  const dim = !active && board.status === 'rejected';
  return (
    <Group id={'board:' + board.id} name="board" x={x} y={y} listening={active} opacity={dim ? 0.45 : 1}>
      {board.slides.map((sl, i) => (
        <Rect key={sl.id} x={i * W} y={0} width={W} height={board.slideHeight} fill={sl.background ?? board.background} name="slide-bg" perfectDrawEnabled={false} />
      ))}
      <SceneNodes nodes={board.nodes} state={st} />
    </Group>
  );
});

// ---------- guides rendering ----------

let measureCtx: CanvasRenderingContext2D | null = null;
function labelWidth(t: string) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return t.length * 7;
  measureCtx.font = '600 11px "Inter Variable", sans-serif';
  return Math.ceil(measureCtx.measureText(t).width);
}

/** A screen-sized label pill (11px, white on colour) centred at a canvas point. */
function Pill({ x, y, text, color, inv }: { x: number; y: number; text: string; color: string; inv: number }) {
  const w = labelWidth(text) + 8;
  const h = 18;
  return (
    <Group x={x} y={y} scaleX={inv} scaleY={inv} listening={false}>
      <Rect x={-w / 2} y={-h / 2} width={w} height={h} cornerRadius={3} fill={color} />
      <Text x={-w / 2} y={-h / 2} width={w} height={h} align="center" verticalAlign="middle" text={text} fontSize={11} fontStyle="600" fontFamily='"Inter Variable", sans-serif' fill="#ffffff" />
    </Group>
  );
}

function GapShape({ g, inv }: { g: GuideGap; inv: number }) {
  const color = g.kind === 'spacing' ? SPACING : GUIDE;
  const horiz = Math.abs(g.y2 - g.y1) < Math.abs(g.x2 - g.x1);
  const t = 4 * inv;
  const ticks = horiz
    ? [g.x1, g.y1 - t, g.x1, g.y1 + t, g.x2, g.y2 - t, g.x2, g.y2 + t]
    : [g.x1 - t, g.y1, g.x1 + t, g.y1, g.x2 - t, g.y2, g.x2 + t, g.y2];
  return (
    <Group listening={false}>
      {g.ext?.map((e, i) => (
        <Line key={i} points={[e.x1, e.y1, e.x2, e.y2]} stroke={color} strokeWidth={1} strokeScaleEnabled={false} dash={[3, 3]} />
      ))}
      <Line points={[g.x1, g.y1, g.x2, g.y2]} stroke={color} strokeWidth={1} strokeScaleEnabled={false} />
      <Line points={ticks.slice(0, 4)} stroke={color} strokeWidth={1} strokeScaleEnabled={false} />
      <Line points={ticks.slice(4)} stroke={color} strokeWidth={1} strokeScaleEnabled={false} />
      <Pill x={(g.x1 + g.x2) / 2} y={(g.y1 + g.y2) / 2} text={gapLabel(g.value)} color={color} inv={inv} />
    </Group>
  );
}

function GuideShapes({ g, inv }: { g: Guides; inv: number }) {
  if (!g.lines.length && !g.gaps.length) return null;
  const m = 3 * inv;
  return (
    <Group listening={false}>
      {g.lines.map((l, i) => (
        <Group key={'l' + i}>
          <Line points={[l.x1, l.y1, l.x2, l.y2]} stroke={l.kind === 'seam' ? ACCENT : GUIDE} strokeWidth={1} strokeScaleEnabled={false} />
          {l.marks.length > 0 && (
            <Shape
              stroke={GUIDE}
              strokeWidth={1}
              strokeScaleEnabled={false}
              sceneFunc={(ctx, shape) => {
                ctx.beginPath();
                for (const p of l.marks) {
                  ctx.moveTo(p.x - m, p.y - m);
                  ctx.lineTo(p.x + m, p.y + m);
                  ctx.moveTo(p.x + m, p.y - m);
                  ctx.lineTo(p.x - m, p.y + m);
                }
                ctx.strokeShape(shape);
              }}
            />
          )}
        </Group>
      ))}
      {g.gaps.map((gp, i) => (
        <GapShape key={'g' + i} g={gp} inv={inv} />
      ))}
    </Group>
  );
}

// ---------- DOM overlays ----------

function SizeBadge({ wrap, rotating }: { wrap: HTMLElement | null; rotating: boolean }) {
  const sel = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  useStore((s) => s.project);
  const layout = useLayout();
  if (!wrap) return null;
  const a = absoluteBoxes(doc.nodes, layout);
  const boxes = sel.map((id) => a.get(id)).filter(Boolean) as Box[];
  if (!boxes.length) return null;
  const u = offsetBox(unionBox(boxes), activeOrigin());
  const r = wrap.getBoundingClientRect();
  const x = r.left + view.panX + (u.x + u.w / 2) * view.zoom;
  const top = r.top + view.panY + u.y * view.zoom;
  const bottom = r.top + view.panY + (u.y + u.h) * view.zoom;
  // Selection scrolled out of view: no badge pinned to the edge.
  if (x < r.left || x > r.right || bottom < r.top || top > r.bottom) return null;
  const one = sel.length === 1 ? findNode(doc.nodes, sel[0]) : null;
  const text = rotating && one ? `${Math.round(one.rotation * 10) / 10}°` : `${Math.round(u.w)} × ${Math.round(u.h)}`;
  return (
    <Floating x={x} y={bottom + 8} altY={top - 8} anchor="top-center" bounds={wrap} className="size-badge">
      {text}
    </Floating>
  );
}

function SlotPill({ slot, label, wrap }: { slot: Slot; label: string; wrap: HTMLElement | null }) {
  const view = useStore((s) => s.view);
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  const b = slot.box;
  return (
    <Floating
      x={r.left + view.panX + (b.x + b.w / 2) * view.zoom}
      y={r.top + view.panY + (b.y + b.h / 2) * view.zoom}
      anchor="center"
      bounds={wrap}
      className="slot-pill"
    >
      {label}
    </Floating>
  );
}

export function offsetBox(b: Box, o: { x: number; y: number }): Box {
  return { x: b.x + o.x, y: b.y + o.y, w: b.w, h: b.h };
}

function canvasEl() {
  return document.querySelector('.canvas-wrap') as HTMLElement | null;
}

// ---------- geometry utils ----------

function normBox(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function unionBox(bs: Box[]): Box {
  const x0 = Math.min(...bs.map((b) => b.x));
  const y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w));
  const y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersects(a: Box | undefined, b: Box) {
  return !!a && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function boxProps(b: Box) {
  return { x: b.x, y: b.y, width: b.w, height: b.h };
}

/** Column/row bands [a,b) inside one slide for a layout grid axis. */
export function gridBands(axis: { count: number; gutter: number; margin: number }, size: number) {
  if (axis.count <= 0) return [];
  const inner = size - axis.margin * 2;
  const cw = (inner - axis.gutter * (axis.count - 1)) / axis.count;
  if (cw <= 0) return [];
  return Array.from({ length: axis.count }, (_, i) => {
    const a = axis.margin + i * (cw + axis.gutter);
    return { a, b: a + cw };
  });
}

function gridLines(axis: { count: number; gutter: number; margin: number }, size: number) {
  const out: number[] = [];
  for (const b of gridBands(axis, size)) out.push(b.a, b.b);
  if (axis.count > 0) out.push(axis.margin, size - axis.margin);
  return out;
}

/** The IG profile grid shows a centred 3:4 crop of the first slide. */
function igCropBands(W: number, H: number) {
  const target = 3 / 4;
  if (W / H > target) return { side: (W - H * target) / 2, top: 0 };
  return { side: 0, top: (H - W / target) / 2 };
}

export type { FrameNode };
