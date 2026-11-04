import { create } from 'zustand';
import { produce } from 'immer';
import type { AssetMeta, CanvasComment, Doc, FrameNode, Project, SceneNode, Tool } from './types';
import type { CommentDraft } from './comments';
import { cloneBoard, cloneWithNewIds, collectAssetIds, deepClone, findNode, locate, makeDoc, makeFrame, makeProject, pathTo, removeNodes, uid, walk } from './tree';
import { absoluteBox, contentBottom, getLayout } from './layout';
import { removeAsset } from './assets';

// Single app store. The project (several boards stacked as rows) is immutable (immer).
// `doc` is always the ACTIVE board — most code only ever touches that. Every edit goes
// through `change()` (active board) or `changeProject()` (board-level), which record undo
// history. Pass a `key` to coalesce rapid changes (slider drags, nudges, live drags).

const HISTORY_LIMIT = 150;

export interface BoardEditLog {
  claudeAt: number | null;
  userEditsSinceClaude: number;
  /** Layers the user had selected while editing by hand (best-effort). */
  userTouchedIds: string[];
}

/** >0 while an automation (Claude) request is being applied. */
let automationDepth = 0;
export async function asClaude<T>(fn: () => Promise<T> | T): Promise<T> {
  automationDepth++;
  try {
    return await fn();
  } finally {
    automationDepth--;
  }
}
const COALESCE_MS = 800;

export interface Toast {
  id: string;
  text: string;
  kind?: 'info' | 'error' | 'success';
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface State {
  project: Project;
  /** The active board (derived from project). */
  doc: Doc;
  past: Project[];
  future: Project[];
  lastKey: string | null;
  lastKeyAt: number;
  /** Per board: when Claude last changed it and what the user has done by hand since. */
  editLog: Record<string, BoardEditLog>;

  selection: string[];
  /** Photos selected in the Photos tray (asset ids). */
  traySelection: string[];
  tool: Tool;
  view: ViewState;
  editingTextId: string | null;
  croppingId: string | null;
  snap: boolean;
  showSeams: boolean;
  showIgCrop: boolean;
  fontsVersion: number;
  /** Path on disk of the open project (Electron), or null. */
  filePath: string | null;
  dirty: boolean;
  toasts: Toast[];
  /** Modal currently open. */
  modal: null | 'export' | 'preview' | 'arrange' | 'shortcuts' | 'new-board' | 'claude' | 'brands' | 'library';
  leftTab: 'layers' | 'photos';
  /** The Home screen covers the editor (desktop app). */
  homeOpen: boolean;
  /** The Claude side panel is open. */
  chatOpen: boolean;
  /** Notes pinned on the canvas. Outside `project` on purpose: no undo, no board copies, no exports. */
  comments: CanvasComment[];
  /** The note being written, if any. */
  commentDraft: CommentDraft | null;
  /** The pin whose popover is open. */
  openComment: string | null;
  showComments: boolean;

  change: (fn: (d: Doc) => void, key?: string) => void;
  changeProject: (fn: (p: Project) => void, key?: string) => void;
  undo: () => void;
  redo: () => void;
  replaceDoc: (doc: Doc, filePath?: string | null) => void;
  replaceProject: (p: Project, filePath?: string | null, comments?: CanvasComment[]) => void;

  // boards
  setActiveBoard: (id: string) => void;
  addBoard: (board: Doc, afterId?: string) => string;
  duplicateBoard: (id?: string, name?: string, note?: string) => string;
  deleteBoard: (id: string) => void;
  moveBoard: (id: string, dir: -1 | 1) => void;
  updateBoard: (id: string, patch: Partial<Pick<Doc, 'name' | 'note' | 'status' | 'statusReason' | 'email'>>) => void;

  select: (ids: string[]) => void;
  setTool: (t: Tool) => void;
  setView: (v: Partial<ViewState>) => void;
  set: (patch: Partial<State>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  bumpFonts: () => void;

  // node operations
  updateNode: (id: string, patch: Partial<SceneNode> | ((n: SceneNode) => void), key?: string) => void;
  updateNodes: (ids: string[], fn: (n: SceneNode) => void, key?: string) => void;
  addNodes: (nodes: SceneNode[], parentId?: string | null, select?: boolean) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  reorder: (id: string, dir: 'up' | 'down' | 'top' | 'bottom') => void;
  moveNode: (id: string, targetParentId: string | null, index: number) => void;
  wrapSelectionInFrame: (auto: boolean) => void;
  /** Wraps sibling layers in a new frame and returns its id. `patch` overrides the frame's defaults. */
  wrapNodes: (ids: string[], auto: boolean, patch?: Partial<FrameNode>) => string | null;
  ungroup: (id: string) => void;
  addAssets: (metas: AssetMeta[]) => void;
  removeTrayAssets: (ids: string[]) => void;

  // slides
  insertSlide: (afterIndex: number) => void;
  deleteSlide: (index: number) => void;
  setSlideCount: (n: number) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

const initialProject = makeProject(makeDoc());

export function activeOf(p: Project): Doc {
  return p.boards.find((b) => b.id === p.activeBoardId) ?? p.boards[0];
}

/** Email boards grow with their content. */
function syncAutoHeight(p: Project, fontsVersion: number): Project {
  const b = activeOf(p);
  if (!b?.autoHeight) return p;
  const h = Math.max(200, Math.ceil(contentBottom(b.nodes, getLayout(b.nodes, fontsVersion))));
  if (h === b.slideHeight) return p;
  return produce(p, (d) => {
    activeOf(d).slideHeight = h;
  });
}

function nextVariantName(p: Project, base: string) {
  const root = base.replace(/\s+[—-]\s+v\d+$/, '');
  let n = 2;
  while (p.boards.some((b) => b.name === `${root} — v${n}`)) n++;
  return `${root} — v${n}`;
}

export const useStore = create<State>((set, get) => {
  /** Applies a new project version with undo history. */
  const commit = (next: Project, key?: string) => {
    const s = get();
    if (next === s.project) return;
    next = syncAutoHeight(next, s.fontsVersion);
    const now = Date.now();
    // Keys starting with "g:" name one gesture (a drag, a scrub): merge it however slow it is.
    // Other keys merge only when repeated within COALESCE_MS (nudges, typing).
    const coalesce = !!key && key === s.lastKey && (key.startsWith('g:') || now - s.lastKeyAt < COALESCE_MS);
    // Track who touched each board so Claude can see the user's hand edits since its last change.
    const editLog = { ...s.editLog };
    for (const b of next.boards) {
      const old = s.project.boards.find((x) => x.id === b.id);
      if (old === b) continue;
      // Only design changes count: picking, rejecting, renaming or noting a row is not a hand edit.
      if (old && old.nodes === b.nodes && old.slides === b.slides && old.background === b.background) continue;
      const e = editLog[b.id] ?? { claudeAt: null, userEditsSinceClaude: 0, userTouchedIds: [] };
      if (automationDepth > 0) editLog[b.id] = { claudeAt: now, userEditsSinceClaude: 0, userTouchedIds: [] };
      else {
        const touched = new Set(e.userTouchedIds);
        for (const id of s.selection) touched.add(id);
        editLog[b.id] = { ...e, userEditsSinceClaude: e.userEditsSinceClaude + (coalesce ? 0 : 1), userTouchedIds: [...touched].slice(-50) };
      }
    }
    set({
      project: next,
      doc: activeOf(next),
      past: coalesce ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
      future: [],
      lastKey: key ?? null,
      lastKeyAt: now,
      dirty: true,
      editLog,
    });
  };
  return {
  project: initialProject,
  doc: initialProject.boards[0],
  past: [],
  future: [],
  lastKey: null,
  lastKeyAt: 0,
  editLog: {},

  selection: [],
  traySelection: [],
  tool: 'move',
  view: { zoom: 0.4, panX: 80, panY: 80 },
  editingTextId: null,
  croppingId: null,
  snap: true,
  showSeams: true,
  showIgCrop: false,
  fontsVersion: 0,
  filePath: null,
  dirty: false,
  homeOpen: false,
  toasts: [],
  modal: null,
  leftTab: 'photos',
  chatOpen: false,
  comments: [],
  commentDraft: null,
  openComment: null,
  showComments: true,

  change: (fn, key) => {
    commit(
      produce(get().project, (p) => {
        fn(activeOf(p));
      }),
      key,
    );
  },
  changeProject: (fn, key) => commit(produce(get().project, fn), key),
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    const d = activeOf(prev);
    set({ project: prev, doc: d, past: s.past.slice(0, -1), future: [s.project, ...s.future], lastKey: null, selection: validSel(d, s.selection), dirty: true });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    const d = activeOf(next);
    set({ project: next, doc: d, past: [...s.past, s.project], future: s.future.slice(1), lastKey: null, selection: validSel(d, s.selection), dirty: true });
  },
  replaceDoc: (doc, filePath = null) => get().replaceProject(makeProject(doc), filePath),
  replaceProject: (project, filePath = null, comments = []) =>
    set({
      project,
      comments,
      commentDraft: null,
      openComment: null,
      doc: activeOf(project),
      past: [],
      future: [],
      selection: [],
      traySelection: [],
      filePath,
      dirty: false,
      editingTextId: null,
      croppingId: null,
    }),

  setActiveBoard: (id) => {
    const s = get();
    if (s.project.activeBoardId === id || !s.project.boards.some((b) => b.id === id)) return;
    const project = produce(s.project, (p) => {
      p.activeBoardId = id;
    });
    set({ project, doc: activeOf(project), selection: [], editingTextId: null, croppingId: null });
  },
  addBoard: (board, afterId) => {
    get().changeProject((p) => {
      const i = afterId ? p.boards.findIndex((b) => b.id === afterId) : p.boards.length - 1;
      // New boards share the project's photo tray.
      const tray = activeOf(p);
      board.assets = { ...tray.assets, ...board.assets };
      board.assetOrder = [...new Set([...tray.assetOrder, ...board.assetOrder])];
      p.boards.splice(i + 1, 0, board);
      p.activeBoardId = board.id;
    });
    set({ selection: [], editingTextId: null, croppingId: null });
    return board.id;
  },
  duplicateBoard: (id, name, note) => {
    const s = get();
    const src = s.project.boards.find((b) => b.id === (id ?? s.project.activeBoardId));
    if (!src) return '';
    const copy = cloneBoard(src, name ?? nextVariantName(s.project, src.name));
    if (note !== undefined) copy.note = note;
    return get().addBoard(copy, src.id);
  },
  deleteBoard: (id) => {
    const s = get();
    if (s.project.boards.length <= 1) return;
    const idx = s.project.boards.findIndex((b) => b.id === id);
    if (idx < 0) return;
    get().changeProject((p) => {
      p.boards.splice(idx, 1);
      if (p.activeBoardId === id) p.activeBoardId = p.boards[Math.max(0, idx - 1)].id;
    });
    set({ selection: [], editingTextId: null, croppingId: null });
  },
  moveBoard: (id, dir) =>
    get().changeProject((p) => {
      const i = p.boards.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.boards.length) return;
      const [b] = p.boards.splice(i, 1);
      p.boards.splice(j, 0, b);
    }),
  updateBoard: (id, patch) =>
    get().changeProject((p) => {
      const b = p.boards.find((x) => x.id === id);
      if (b) Object.assign(b, patch);
    }, 'board-' + id),

  select: (ids) => set({ selection: ids, editingTextId: null, croppingId: get().croppingId && ids.includes(get().croppingId!) ? get().croppingId : null }),
  setTool: (tool) => set({ tool, editingTextId: null, croppingId: null, commentDraft: null, openComment: null }),
  setView: (v) => set({ view: { ...get().view, ...v } }),
  set: (patch) => set(patch),
  toast: (text, kind = 'info') => {
    const t = { id: uid(), text, kind };
    set({ toasts: [...get().toasts, t] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? 6000 : 3200);
  },
  bumpFonts: () => set({ fontsVersion: get().fontsVersion + 1 }),

  updateNode: (id, patch, key) =>
    get().change((d) => {
      const n = findNode(d.nodes, id);
      if (!n) return;
      if (typeof patch === 'function') patch(n);
      else Object.assign(n, patch);
    }, key),
  updateNodes: (ids, fn, key) =>
    get().change((d) => {
      for (const id of ids) {
        const n = findNode(d.nodes, id);
        if (n) fn(n);
      }
    }, key),
  addNodes: (nodes, parentId = null, select = true) => {
    get().change((d) => {
      const parent = parentId ? (findNode(d.nodes, parentId) as FrameNode | null) : null;
      (parent && parent.type === 'frame' ? parent.children : d.nodes).push(...nodes);
    });
    if (select) set({ selection: nodes.map((n) => n.id) });
  },
  deleteSelection: () => {
    const ids = new Set(get().selection);
    if (!ids.size) return;
    get().change((d) => removeNodes(d.nodes, ids));
    set({ selection: [], editingTextId: null, croppingId: null });
  },
  duplicateSelection: () => {
    const sel = get().selection;
    if (!sel.length) return;
    const newIds: string[] = [];
    get().change((d) => {
      for (const id of sel) {
        const loc = locate(d.nodes, id);
        if (!loc) continue;
        const c = cloneWithNewIds(loc.list[loc.index]);
        if (!loc.parent || loc.parent.layout === 'none') {
          c.x += 20;
          c.y += 20;
        }
        loc.list.splice(loc.index + 1, 0, c);
        newIds.push(c.id);
      }
    });
    set({ selection: newIds });
  },
  reorder: (id, dir) =>
    get().change((d) => {
      const loc = locate(d.nodes, id);
      if (!loc) return;
      const [n] = loc.list.splice(loc.index, 1);
      const to =
        dir === 'up' ? Math.min(loc.list.length, loc.index + 1) : dir === 'down' ? Math.max(0, loc.index - 1) : dir === 'top' ? loc.list.length : 0;
      loc.list.splice(to, 0, n);
    }),
  moveNode: (id, targetParentId, index) => {
    const s = get();
    if (targetParentId && (targetParentId === id || pathTo(s.doc.nodes, targetParentId).includes(id))) return;
    const layout = getLayout(s.doc.nodes, s.fontsVersion);
    const fromAbs = absoluteBox(layout, pathTo(s.doc.nodes, id));
    const parentAbs = targetParentId ? absoluteBox(layout, pathTo(s.doc.nodes, targetParentId)) : { x: 0, y: 0, w: 0, h: 0 };
    s.change((d) => {
      const loc = locate(d.nodes, id);
      if (!loc) return;
      const [n] = loc.list.splice(loc.index, 1);
      const target = targetParentId ? (findNode(d.nodes, targetParentId) as FrameNode | null) : null;
      const list = target ? target.children : d.nodes;
      // Keep the node visually in place when it changes parent.
      if (fromAbs && parentAbs && loc.parent?.id !== (target?.id ?? undefined)) {
        n.x = fromAbs.x - parentAbs.x;
        n.y = fromAbs.y - parentAbs.y;
      }
      if (!target || target.layout === 'none') {
        if (n.sizingH === 'fill') n.sizingH = 'fixed';
        if (n.sizingV === 'fill') n.sizingV = 'fixed';
      }
      const i = Math.max(0, Math.min(index - (loc.list === list && loc.index < index ? 1 : 0), list.length));
      list.splice(i, 0, n);
    });
  },
  wrapSelectionInFrame: (auto) => {
    const id = get().wrapNodes(get().selection, auto);
    if (id) set({ selection: [id] });
  },
  wrapNodes: (sel, auto, patch) => {
    const s = get();
    if (!sel.length) return null;
    const layout = getLayout(s.doc.nodes, s.fontsVersion);
    const first = locate(s.doc.nodes, sel[0]);
    if (!first) return null;
    // Only wrap siblings of the first selected node.
    const siblings = sel.filter((id) => first.list.some((n) => n.id === id));
    const boxes = siblings.map((id) => layout.get(id)!).filter(Boolean);
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const frame = makeFrame(x0, y0, x1 - x0, y1 - y0, {
      name: auto ? 'Auto layout' : 'Group',
      fill: null,
      clip: false,
      padding: auto ? { t: 0, r: 0, b: 0, l: 0 } : { t: 24, r: 24, b: 24, l: 24 },
    });
    if (auto) {
      const horiz = x1 - x0 >= y1 - y0;
      frame.layout = horiz ? 'row' : 'column';
      frame.sizingH = 'hug';
      frame.sizingV = 'hug';
    }
    Object.assign(frame, patch);
    s.change((d) => {
      const loc = locate(d.nodes, sel[0])!;
      const picked = loc.list
        .filter((n) => siblings.includes(n.id))
        .sort((a, b) => {
          if (!auto) return 0;
          const ba = layout.get(a.id)!;
          const bb = layout.get(b.id)!;
          return frame.layout === 'row' ? ba.x - bb.x : ba.y - bb.y;
        });
      const insertAt = Math.max(...siblings.map((id) => loc.list.findIndex((n) => n.id === id)));
      const f = structuredClone(frame);
      for (const p of picked) {
        const c = deepClone(p) as SceneNode;
        const b = layout.get(p.id)!;
        c.x = b.x - x0;
        c.y = b.y - y0;
        f.children.push(c);
      }
      // Remove the wrapped nodes from this list only (not recursively — the frame now holds copies).
      const at = loc.list.slice(0, insertAt + 1).filter((n) => !siblings.includes(n.id)).length;
      for (let i = loc.list.length - 1; i >= 0; i--) if (siblings.includes(loc.list[i].id)) loc.list.splice(i, 1);
      loc.list.splice(at, 0, f as FrameNode);
    });
    return frame.id;
  },
  ungroup: (id) => {
    const s = get();
    const layout = getLayout(s.doc.nodes, s.fontsVersion);
    const fb = layout.get(id);
    const kids: string[] = [];
    s.change((d) => {
      const loc = locate(d.nodes, id);
      if (!loc) return;
      const f = loc.list[loc.index];
      if (f.type !== 'frame' || !fb) return;
      const lifted = f.children.map((c) => {
        const b = layout.get(c.id)!;
        const copy = deepClone(c) as SceneNode;
        copy.x = fb.x + b.x;
        copy.y = fb.y + b.y;
        copy.w = b.w;
        copy.h = b.h;
        if (copy.sizingH === 'fill') copy.sizingH = 'fixed';
        if (copy.sizingV === 'fill') copy.sizingV = 'fixed';
        kids.push(copy.id);
        return copy;
      });
      loc.list.splice(loc.index, 1, ...lifted);
    });
    set({ selection: kids });
  },
  addAssets: (metas) =>
    // The photo tray is project-wide: every board carries the same asset table.
    get().changeProject((p) => {
      for (const d of p.boards) {
        for (const m of metas) {
          d.assets[m.id] = m;
          if (m.kind === 'image' && !d.assetOrder.includes(m.id)) d.assetOrder.push(m.id);
        }
      }
    }),
  removeTrayAssets: (ids) => {
    const used = new Set<string>();
    for (const b of get().project.boards) for (const a of collectAssetIds(b.nodes)) used.add(a);
    get().changeProject((p) => {
      for (const d of p.boards) {
        d.assetOrder = d.assetOrder.filter((a) => !ids.includes(a));
        for (const id of ids) if (!used.has(id)) delete d.assets[id];
      }
    });
    for (const id of ids) if (!used.has(id)) removeAsset(id);
    set({ traySelection: get().traySelection.filter((a) => !ids.includes(a)) });
  },

  insertSlide: (afterIndex) =>
    get().change((d) => {
      const W = d.slideWidth;
      const cut = (afterIndex + 1) * W;
      // Shift everything that starts right of the cut.
      for (const n of d.nodes) if (n.x >= cut - 0.5) n.x += W;
      d.slides.splice(afterIndex + 1, 0, { id: uid(), background: null });
    }),
  deleteSlide: (index) => {
    const s = get();
    if (s.doc.slides.length <= 1) return;
    const layout = getLayout(s.doc.nodes, s.fontsVersion);
    s.change((d) => {
      const W = d.slideWidth;
      const x0 = index * W;
      const x1 = x0 + W;
      const doomed = new Set<string>();
      for (const n of d.nodes) {
        const b = layout.get(n.id);
        if (!b) continue;
        if (b.x >= x0 - 0.5 && b.x + b.w <= x1 + 0.5) doomed.add(n.id);
        else if (b.x >= x1 - 0.5) n.x -= W;
      }
      removeNodes(d.nodes, doomed);
      d.slides.splice(index, 1);
    });
    set({ selection: [] });
  },
  setSlideCount: (n) =>
    get().change((d) => {
      n = Math.max(1, Math.min(40, Math.round(n)));
      while (d.slides.length < n) d.slides.push({ id: uid(), background: null });
      if (d.slides.length > n) d.slides.length = n;
    }, 'slide-count'),
  };
});

function validSel(doc: Doc, sel: string[]) {
  return sel.filter((id) => !!findNode(doc.nodes, id));
}

/** Current layout map (hook). */
export function useLayout() {
  const nodes = useStore((s) => s.doc.nodes);
  const fv = useStore((s) => s.fontsVersion);
  return getLayout(nodes, fv);
}

/** Non-hook access to current layout. */
export function currentLayout() {
  const s = useStore.getState();
  return getLayout(s.doc.nodes, s.fontsVersion);
}

/** Strip width in px. */
export function stripWidth(doc: Doc) {
  return doc.slideWidth * doc.slides.length;
}

/** Every node id in the doc (top-down), for select-all etc. */
export function allIds(doc: Doc) {
  const ids: string[] = [];
  walk(doc.nodes, (n) => {
    ids.push(n.id);
  });
  return ids;
}

// ---------- board geometry ----------

/** Vertical space between stacked boards (room for the board header + slide labels). */
export const BOARD_GAP = 400;
/** Space between emails sitting side by side (room for each board's header). */
export const EMAIL_GAP = 160;

export interface BoardFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

let framesFor: Project | null = null;
let framesCache = new Map<string, BoardFrame>();
/** Where each board sits on the canvas. Boards stack top-to-bottom in project order, except that
 *  emails next to each other share a row, top-aligned, so variations of any height compare easily. */
export function boardFrames(p: Project): Map<string, BoardFrame> {
  if (p === framesFor) return framesCache;
  const m = new Map<string, BoardFrame>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let prev: Doc | null = null;
  for (const b of p.boards) {
    if (prev && !(prev.kind === 'email' && b.kind === 'email')) {
      x = 0;
      y += rowH + BOARD_GAP;
      rowH = 0;
    }
    const f = { x, y, w: b.slideWidth * b.slides.length, h: b.slideHeight };
    m.set(b.id, f);
    x += f.w + EMAIL_GAP;
    rowH = Math.max(rowH, f.h);
    prev = b;
  }
  framesFor = p;
  framesCache = m;
  return m;
}

/** Canvas-space origin of the active board (all editing coordinates are relative to it). */
export function activeOrigin(): { x: number; y: number } {
  const p = useStore.getState().project;
  return boardFrames(p).get(p.activeBoardId) ?? { x: 0, y: 0 };
}

/** After adding a variation: emails show their row, to compare them; anything else shows every board. */
export function fitVariations() {
  const detail = useStore.getState().doc.kind === 'email' ? 'row' : 'all';
  window.dispatchEvent(new CustomEvent('spread:fit', { detail }));
}

export function useBoardFrames() {
  return boardFrames(useStore((s) => s.project));
}
