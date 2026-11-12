import { create } from 'zustand';
import { produce } from 'immer';
import type { AssetMeta, CanvasComment, Doc, FrameNode, Project, SceneNode, Tool } from './types';
import type { CommentDraft } from './comments';
import { CHANGE_LIMIT, describeChanges, type ChangeEntry } from './history';
import { cloneBoard, cloneWithNewIds, collectAssetIds, deepClone, findNode, locate, makeDoc, makeFrame, makeProject, pathTo, removeNodes, uid, walk } from './tree';
import { absoluteBox, contentBottom, getLayout, inferAutoLayout } from './layout';
import { removeAsset } from './assets';
import { syncRepeats } from './repeat';
import { syncTokens } from './tokens';

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
  /** The board as Claude last left it, so its hand edits since can be described exactly. */
  claudeBoard?: Doc;
}

/** >0 while an automation (Claude) request is being applied. */
let automationDepth = 0;
/** The tool call being applied, so its changes log as one entry. */
let claudeCall = { id: 0, via: '' };
export async function asClaude<T>(fn: () => Promise<T> | T, via = ''): Promise<T> {
  if (!automationDepth) claudeCall = { id: claudeCall.id + 1, via };
  automationDepth++;
  try {
    return await fn();
  } finally {
    automationDepth--;
  }
}
/**
 * Whether this change is Claude's. A call can run for a while, and a click or keypress during it is
 * still the user's, which `window.event` tells apart. Only input counts: a picture finishing loading
 * also sets it, and Claude's call carries on from inside that event.
 */
const claudeNow = () => {
  if (!automationDepth) return false;
  const e = typeof window === 'undefined' ? undefined : window.event;
  return !(e instanceof UIEvent || e?.type === 'input' || e?.type === 'change' || e?.type === 'paste');
};
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
  modal: null | 'export' | 'pdf' | 'preview' | 'arrange' | 'shortcuts' | 'new-board' | 'claude' | 'brands' | 'library' | 'repeat' | 'styles' | 'inbox';
  leftTab: 'layers' | 'photos' | 'history';
  /** The Home screen covers the editor (desktop app). */
  homeOpen: boolean;
  /** The Claude side panel is open. */
  chatOpen: boolean;
  /** Notes pinned on the canvas. Outside `project` on purpose: no undo, no board copies, no exports. */
  comments: CanvasComment[];
  /** Who changed what, oldest first (see history.ts). */
  changes: ChangeEntry[];
  /** The note being written, if any. */
  commentDraft: CommentDraft | null;
  /** The pin whose popover is open. */
  openComment: string | null;
  showComments: boolean;
  /** Email boards: dims the design and pins every link and picture's status on the canvas (L). */
  linksMode: boolean;
  /** The link and picture entry being edited, and where its editor opened. */
  linkEdit: { boardId: string; id: string; from: 'canvas' | 'panel' } | null;

  change: (fn: (d: Doc) => void, key?: string) => void;
  changeProject: (fn: (p: Project) => void, key?: string) => void;
  undo: () => void;
  redo: () => void;
  replaceDoc: (doc: Doc, filePath?: string | null) => void;
  replaceProject: (p: Project, filePath?: string | null, comments?: CanvasComment[], changes?: ChangeEntry[]) => void;

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
  /** Turns a plain frame into auto layout that keeps its children where they are (Figma's Shift+A on a frame). */
  addAutoLayout: (frameId: string) => void;
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
function syncAutoHeight(p: Project, fontsVersion: number, everyBoard = false): Project {
  // A style change can reach boards other than the active one.
  const boards = everyBoard ? p.boards : [activeOf(p)];
  for (const b of boards) {
    if (!b?.autoHeight) continue;
    const h = Math.max(200, Math.ceil(contentBottom(b.nodes, getLayout(b.nodes, fontsVersion))));
    if (h === b.slideHeight) continue;
    p = produce(p, (d) => {
      d.boards.find((x) => x.id === b.id)!.slideHeight = h;
    });
  }
  return p;
}

function nextVariantName(p: Project, base: string) {
  const root = base.replace(/\s+[—-]\s+v\d+$/, '');
  let n = 2;
  while (p.boards.some((b) => b.name === `${root} — v${n}`)) n++;
  return `${root} — v${n}`;
}

export const useStore = create<State>((set, get) => {
  /** The stretch of edits being logged as one: a drag, or everything in one Claude call. */
  let run: { id: string; base: Project; start: number; at: number; last: Project } | null = null;
  /** The log with this change in it. A run keeps rewriting its own entries, so a drag reads start to finish. */
  const logChange = (prev: Project, next: Project, runId: string | null, join: boolean, undo?: ChangeEntry['undo']): ChangeEntry[] => {
    const log = get().changes;
    const open = join && runId && run?.id === runId && run.last === prev ? run : null;
    const kept = open ? log.slice(0, open.start) : log.length < CHANGE_LIMIT ? log : log.slice(-CHANGE_LIMIT + 1);
    const base = open?.base ?? prev;
    const at = open?.at ?? Date.now();
    run = runId ? { id: runId, base, start: kept.length, at, last: next } : null;
    const byClaude = claudeNow();
    const entries = describeChanges(base, next).map((d) => ({ ...d, id: uid(), at, who: byClaude ? ('claude' as const) : ('you' as const), ...(byClaude && claudeCall.via ? { via: claudeCall.via } : {}), ...(undo ? { undo } : {}) }));
    return entries.length || open ? [...kept, ...entries] : kept;
  };
  /** Applies a new project version with undo history. */
  const commit = (next: Project, key?: string) => {
    const s = get();
    if (next === s.project) return;
    const tokens = syncTokens(next, s.project);
    const repeats = syncRepeats(tokens.project, s.project);
    next = syncAutoHeight(repeats.project, s.fontsVersion, tokens.moved);
    const now = Date.now();
    const byClaude = claudeNow();
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
      if (byClaude) editLog[b.id] = { claudeAt: now, userEditsSinceClaude: 0, userTouchedIds: [], claudeBoard: b };
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
      changes: logChange(s.project, next, byClaude ? `claude:${claudeCall.id}` : key ? `you:${key}` : null, byClaude || coalesce),
      // A repeat can drop cards, so the selection may point at layers that are gone.
      ...(repeats.changed ? { selection: validSel(activeOf(next), s.selection) } : {}),
    });
    for (const note of repeats.notes) get().toast(note);
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
  changes: [],
  commentDraft: null,
  openComment: null,
  showComments: true,
  linksMode: false,
  linkEdit: null,

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
    set({ project: prev, doc: d, past: s.past.slice(0, -1), future: [s.project, ...s.future], lastKey: null, selection: validSel(d, s.selection), dirty: true, changes: logChange(s.project, prev, null, false, 'undo') });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    const d = activeOf(next);
    set({ project: next, doc: d, past: [...s.past, s.project], future: s.future.slice(1), lastKey: null, selection: validSel(d, s.selection), dirty: true, changes: logChange(s.project, next, null, false, 'redo') });
  },
  replaceDoc: (doc, filePath = null) => get().replaceProject(makeProject(doc), filePath),
  replaceProject: (project, filePath = null, comments = [], changes = []) =>
    set({
      project,
      comments,
      changes,
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

  select: (ids) => {
    const { croppingId, linkEdit } = get();
    set({
      selection: ids,
      editingTextId: null,
      croppingId: croppingId && ids.includes(croppingId) ? croppingId : null,
      // Selecting something else closes the link editor.
      linkEdit: linkEdit && ids.includes(linkEdit.id) ? linkEdit : null,
    });
  },
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
    const s = get();
    // One plain frame selected: Shift+A gives it auto layout instead of wrapping it in another frame.
    if (auto && s.selection.length === 1) {
      const only = findNode(s.doc.nodes, s.selection[0]);
      if (only?.type === 'frame' && only.layout === 'none' && !only.repeat) {
        s.addAutoLayout(only.id);
        return;
      }
    }
    const id = s.wrapNodes(s.selection, auto);
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
    let order: string[] | null = null;
    if (auto) {
      // Keep the arrangement: direction, spacing and shared edge come from where the layers sit now.
      const force = patch?.layout === 'row' || patch?.layout === 'column' ? patch.layout : undefined;
      const inferred = inferAutoLayout(
        siblings.map((id) => ({ id, ...layout.get(id)! })).filter((b) => b.w !== undefined),
        force,
      );
      frame.layout = inferred.layout;
      frame.gap = inferred.gap;
      frame.alignItems = inferred.alignItems;
      frame.sizingH = 'hug';
      frame.sizingV = 'hug';
      order = inferred.order;
    }
    Object.assign(frame, patch);
    s.change((d) => {
      const loc = locate(d.nodes, sel[0])!;
      const picked = loc.list
        .filter((n) => siblings.includes(n.id))
        .sort((a, b) => (order ? order.indexOf(a.id) - order.indexOf(b.id) : 0));
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
  addAutoLayout: (frameId) => {
    const s = get();
    const layout = getLayout(s.doc.nodes, s.fontsVersion);
    const f0 = findNode(s.doc.nodes, frameId);
    const fb = layout.get(frameId);
    if (!f0 || f0.type !== 'frame' || f0.layout !== 'none' || !fb) return;
    const kids = f0.children.filter((c) => c.visible && layout.get(c.id));
    const boxes = kids.map((c) => ({ id: c.id, ...layout.get(c.id)! }));
    const inferred = inferAutoLayout(boxes);
    s.change((d) => {
      const f = findNode(d.nodes, frameId) as FrameNode | null;
      if (!f || f.type !== 'frame') return;
      f.layout = inferred.layout;
      if (boxes.length) {
        // Padding is the space the children already leave inside the frame, so it keeps its size.
        const cx0 = Math.min(...boxes.map((b) => b.x));
        const cy0 = Math.min(...boxes.map((b) => b.y));
        const cx1 = Math.max(...boxes.map((b) => b.x + b.w));
        const cy1 = Math.max(...boxes.map((b) => b.y + b.h));
        const r = (v: number) => Math.max(0, Math.round(v * 2) / 2);
        f.padding = { t: r(cy0), r: r(fb.w - cx1), b: r(fb.h - cy1), l: r(cx0) };
        f.gap = inferred.gap;
        f.alignItems = inferred.alignItems;
        f.sizingH = 'hug';
        f.sizingV = 'hug';
        const rank = (id: string) => {
          const i = inferred.order.indexOf(id);
          return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        };
        f.children.sort((a, b) => rank(a.id) - rank(b.id));
      }
    });
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
