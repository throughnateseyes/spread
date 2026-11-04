import { nanoid } from 'nanoid';
import { current, isDraft } from 'immer';
import type { Doc, FrameNode, ImageNode, PageSetup, Project, SceneNode, ShapeNode, TextNode } from './types';

export const uid = () => nanoid(10);

/** Depth-first walk over every node. Return false from `fn` to skip a node's children. */
export function walk(nodes: SceneNode[], fn: (n: SceneNode, parent: FrameNode | null) => void | false, parent: FrameNode | null = null) {
  for (const n of nodes) {
    if (fn(n, parent) === false) continue;
    if (n.type === 'frame') walk(n.children, fn, n);
  }
}

export function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  let found: SceneNode | null = null;
  walk(nodes, (n) => {
    if (found) return false;
    if (n.id === id) found = n;
  });
  return found;
}

/** The parent frame of `id`, or null if top-level (or not found). */
export function findParent(nodes: SceneNode[], id: string): FrameNode | null {
  let found: FrameNode | null = null;
  walk(nodes, (n, p) => {
    if (found) return false;
    if (n.id === id) found = p;
  });
  return found;
}

/** The array that contains `id` (doc.nodes or a frame's children) plus its index. */
export function locate(nodes: SceneNode[], id: string): { list: SceneNode[]; index: number; parent: FrameNode | null } | null {
  const i = nodes.findIndex((n) => n.id === id);
  if (i >= 0) return { list: nodes, index: i, parent: null };
  for (const n of nodes) {
    if (n.type === 'frame') {
      const r = locate(n.children, id);
      if (r) return r.parent ? r : { ...r, parent: n };
    }
  }
  return null;
}

/** Ids from the top-level ancestor down to `id` (inclusive). Empty if not found. */
export function pathTo(nodes: SceneNode[], id: string): string[] {
  for (const n of nodes) {
    if (n.id === id) return [n.id];
    if (n.type === 'frame') {
      const p = pathTo(n.children, id);
      if (p.length) return [n.id, ...p];
    }
  }
  return [];
}

export function isAncestor(nodes: SceneNode[], ancestorId: string, id: string): boolean {
  const p = pathTo(nodes, id);
  return p.indexOf(ancestorId) >= 0 && p[p.length - 1] !== ancestorId;
}

/** Deep clone with fresh ids (for duplicate / paste). */
export function cloneWithNewIds<T extends SceneNode>(n: T): T {
  const c = deepClone(n);
  const reid = (x: SceneNode) => {
    x.id = uid();
    if (x.type === 'frame') x.children.forEach(reid);
  };
  reid(c);
  return c;
}

/** Removes the given ids from the tree (mutates; use inside an immer producer). */
export function removeNodes(nodes: SceneNode[], ids: Set<string>) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (ids.has(n.id)) nodes.splice(i, 1);
    else if (n.type === 'frame') removeNodes(n.children, ids);
  }
}

export function collectAssetIds(nodes: SceneNode[]): Set<string> {
  const s = new Set<string>();
  walk(nodes, (n) => {
    if (n.type === 'image' && n.assetId) s.add(n.assetId);
  });
  return s;
}

// ---------- factories ----------

const base = (name: string, x: number, y: number, w: number, h: number) => ({
  id: uid(),
  name,
  x,
  y,
  w,
  h,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  sizingH: 'fixed' as const,
  sizingV: 'fixed' as const,
});

export function makeImage(x: number, y: number, w: number, h: number, assetId: string | null, name = 'Photo'): ImageNode {
  return {
    ...base(name, x, y, w, h),
    type: 'image',
    assetId,
    fit: 'fill',
    crop: { zoom: 1, cx: 0.5, cy: 0.5 },
    radius: 0,
    flipX: false,
    flipY: false,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    stroke: null,
    strokeWidth: 0,
  };
}

export function makeText(x: number, y: number, text = 'Text', patch: Partial<TextNode> = {}): TextNode {
  return {
    ...base('Text', x, y, 200, 60),
    sizingH: 'hug',
    sizingV: 'hug',
    type: 'text',
    text,
    fontFamily: 'Inter Variable',
    fontWeight: 600,
    italic: false,
    fontSize: 64,
    lineHeight: 1.1,
    letterSpacing: -2,
    align: 'left',
    fill: '#111111',
    uppercase: false,
    decoration: 'none',
    ...patch,
  };
}

export function makeShape(type: 'rect' | 'ellipse', x: number, y: number, w: number, h: number): ShapeNode {
  return {
    ...base(type === 'rect' ? 'Rectangle' : 'Ellipse', x, y, w, h),
    type,
    fill: { kind: 'solid', color: '#D9D9D9' },
    stroke: null,
    strokeWidth: 0,
    radius: 0,
  };
}

export function makeFrame(x: number, y: number, w: number, h: number, patch: Partial<FrameNode> = {}): FrameNode {
  return {
    ...base('Frame', x, y, w, h),
    type: 'frame',
    fill: { kind: 'solid', color: '#FFFFFF' },
    stroke: null,
    strokeWidth: 0,
    radius: 0,
    clip: true,
    layout: 'none',
    gap: 16,
    padding: { t: 24, r: 24, b: 24, l: 24 },
    alignItems: 'start',
    justify: 'start',
    children: [],
    ...patch,
  };
}

export function makeProject(board: Doc = makeDoc()): Project {
  return { version: 2, name: board.name, boards: [board], activeBoardId: board.id };
}

/** Blank email board: 600px wide, height follows content. */
export function makeEmailBoard(name = 'Untitled email'): Doc {
  return {
    ...makeDoc(),
    kind: 'email',
    name,
    slideWidth: 600,
    slideHeight: 900,
    slides: [{ id: uid(), background: null }],
    background: '#FFFFFF',
    autoHeight: true,
  };
}

/**
 * Blank document board (resume, flyer, poster): pages in points, side by side like slides but
 * never bleeding into each other. The layout grid starts on, showing the margins.
 */
export function makeDocumentBoard(opts: { name?: string; w?: number; h?: number; units?: 'pt' | 'px'; pages?: number; margins?: Partial<PageSetup['margins']>; baseline?: number } = {}): Doc {
  const w = Math.round(opts.w ?? 612);
  const h = Math.round(opts.h ?? 792);
  const units = opts.units ?? 'pt';
  // 0.75in on paper; about 6% of the short side on screen.
  const d = units === 'pt' ? 54 : Math.round(Math.min(w, h) * 0.06);
  const m = { t: d, r: d, b: d, l: d, ...opts.margins };
  return {
    ...makeDoc(),
    kind: 'document',
    name: opts.name ?? 'Untitled document',
    slideWidth: w,
    slideHeight: h,
    slides: Array.from({ length: Math.max(1, Math.min(40, Math.round(opts.pages ?? 1))) }, () => ({ id: uid(), background: null })),
    background: '#FFFFFF',
    page: { units, margins: m, baseline: opts.baseline ?? 0 },
    // One faint band per axis marks the live area inside the margins; switch to 12 columns when you need them.
    grid: { visible: true, columns: { count: 1, gutter: 12, margin: m.l }, rows: { count: 1, gutter: 12, margin: m.t }, color: '#FF00000A' },
  };
}

/** Copy of a board with fresh ids (a variation). Assets are shared, so the tray carries over. */
export function cloneBoard(b: Doc, name?: string): Doc {
  const c = deepClone(b);
  c.id = uid();
  c.name = name ?? b.name;
  c.status = null; // a copy starts undecided
  c.slides = c.slides.map((s) => ({ ...s, id: uid() }));
  c.nodes = c.nodes.map((n) => cloneWithNewIds(n));
  return c;
}

/** Accepts a v2 project or a legacy single-doc file and returns a project. */
export function migrateProject(raw: any): Project {
  if (raw && raw.version === 2 && Array.isArray(raw.boards)) {
    const p = raw as Project;
    p.boards.forEach(normaliseBoard);
    if (!p.boards.some((b) => b.id === p.activeBoardId)) p.activeBoardId = p.boards[0]?.id;
    return p;
  }
  const d = normaliseBoard(raw as Doc);
  return makeProject(d);
}

function normaliseBoard(d: Doc): Doc {
  if (!d.id) d.id = uid();
  if (!d.kind) d.kind = 'carousel';
  if (!d.assets) d.assets = {};
  if (!d.assetOrder) d.assetOrder = [];
  return d;
}

export function makeDoc(): Doc {
  return {
    version: 1,
    id: uid(),
    kind: 'carousel',
    name: 'Untitled carousel',
    slideWidth: 1080,
    slideHeight: 1350,
    slides: Array.from({ length: 3 }, () => ({ id: uid(), background: null })),
    background: '#FFFFFF',
    grid: {
      visible: false,
      columns: { count: 12, gutter: 20, margin: 60 },
      rows: { count: 0, gutter: 20, margin: 60 },
      color: '#FF000019',
    },
    nodes: [],
    assets: {},
    assetOrder: [],
  };
}

/** structuredClone that also works on immer drafts (proxies can't be cloned directly). */
export function deepClone<T>(v: T): T {
  return structuredClone(isDraft(v) ? current(v as any) : v);
}
