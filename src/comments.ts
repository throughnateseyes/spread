import { absoluteBoxes } from './render';
import { getLayout } from './layout';
import { boardFrames, currentLayout, useStore } from './store';
import { findNode, uid, walk } from './tree';
import type { CanvasComment, CommentStatus, Doc, Project, SceneNode } from './types';

// Canvas comments: notes pinned to a layer or a spot on a board, sent to Claude through the same
// path as the composer (chat.ts). They live beside the project, not inside a board, so they stay out
// of undo, board copies, templates and everything that renders a board. A pin can't reach an export
// because exports never see it. Saved in project.json next to the project.

/** The note being written: a pin on the canvas with a popover, not yet a comment. */
export interface CommentDraft {
  boardId: string;
  nodeId: string | null;
  nodeKey: string | null;
  fx: number;
  fy: number;
  x: number;
  y: number;
  text: string;
}

/** Sent, and Claude hasn't finished with it. */
export const inFlight = (s: CommentStatus) => s === 'waiting' || s === 'working';

export const STATUS_TEXT: Record<CommentStatus, string> = {
  waiting: 'Waiting for Claude',
  working: 'Claude is working on this',
  done: 'Done',
  stopped: 'Stopped before Claude finished',
};

/** The layer a pin is on: by id, or by key if Claude rebuilt the layer. */
export function pinnedNode(b: Doc | undefined, c: Pick<CanvasComment, 'nodeId' | 'nodeKey'>): SceneNode | null {
  if (!b) return null;
  const byId = c.nodeId ? findNode(b.nodes, c.nodeId) : null;
  if (byId || !c.nodeKey) return byId;
  let hit: SceneNode | null = null;
  walk(b.nodes, (n) => {
    if (!hit && n.key === c.nodeKey) hit = n;
  });
  return hit;
}

/** Where a pin sits in its board's strip space: it follows its layer, and otherwise stays on the board. */
export function pinPoint(b: Doc, c: Pick<CanvasComment, 'nodeId' | 'nodeKey' | 'fx' | 'fy' | 'x' | 'y'>, fontsVersion: number) {
  const n = pinnedNode(b, c);
  const box = n ? absoluteBoxes(b.nodes, getLayout(b.nodes, fontsVersion)).get(n.id) : null;
  if (box) return { x: box.x + c.fx * box.w, y: box.y + c.fy * box.h };
  return { x: Math.min(c.x, b.slideWidth * b.slides.length), y: Math.min(c.y, b.slideHeight) };
}

const pageWord = (b: Doc) => (b.kind === 'document' ? 'Page' : b.kind === 'email' ? 'Section' : 'Slide');

/** What a pin is on, in a few words: the layer's name, or the page it's on. */
export function pinLabel(b: Doc | undefined, c: Pick<CanvasComment, 'nodeId' | 'nodeKey' | 'fx' | 'fy' | 'x' | 'y'>, fontsVersion: number) {
  if (!b) return 'A deleted row';
  const n = pinnedNode(b, c);
  if (n) return n.name;
  return `${pageWord(b)} ${Math.floor(pinPoint(b, c, fontsVersion).x / b.slideWidth) + 1}`;
}

/** Starts a note at a strip point on the active board, on a layer if one's under it. */
export function startComment(p: { x: number; y: number }, nodeId: string | null) {
  const s = useStore.getState();
  const d = s.doc;
  const n = nodeId ? findNode(d.nodes, nodeId) : null;
  const box = n ? absoluteBoxes(d.nodes, currentLayout()).get(n.id) : null;
  s.set({
    openComment: null,
    commentDraft: {
      boardId: d.id,
      nodeId: n && box ? n.id : null,
      nodeKey: (n && box && n.key) || null,
      fx: box && box.w ? (p.x - box.x) / box.w : 0,
      fy: box && box.h ? (p.y - box.y) / box.h : 0,
      x: p.x,
      y: p.y,
      text: '',
    },
  });
}

/** Turns the draft into a comment. Sending it is the caller's next step (see sendNote). */
export function commitDraft(): CanvasComment | null {
  const s = useStore.getState();
  const d = s.commentDraft;
  const text = d?.text.trim();
  if (!d || !text) return null;
  const c: CanvasComment = { ...d, id: uid(), n: s.comments.reduce((m, x) => Math.max(m, x.n), 0) + 1, text, status: 'waiting', at: Date.now() };
  s.set({ comments: [...s.comments, c], commentDraft: null, dirty: true });
  return c;
}

export function patchComment(id: string, patch: Partial<CanvasComment>, dirty = true) {
  const s = useStore.getState();
  s.set({ comments: s.comments.map((c) => (c.id === id ? { ...c, ...patch } : c)), ...(dirty ? { dirty: true } : {}) });
}

export function removeComments(ids: string[]) {
  const s = useStore.getState();
  const gone = new Set(ids);
  s.set({ comments: s.comments.filter((c) => !gone.has(c.id)), openComment: null, dirty: true });
}

/**
 * Brings pins in line with what the chat knows (it's the source of truth for anything sent). A pin
 * still marked in flight that the chat has no record of can't be answered any more: a project opened
 * on another computer, say. `sending` holds notes the chat hasn't been told about yet.
 */
export function reconcileNotes(notes: Record<string, CommentStatus>, sending: Set<string>) {
  const s = useStore.getState();
  let changed = false;
  const next = s.comments.map((c) => {
    if (sending.has(c.id)) return c;
    const status = notes[c.id] ?? (inFlight(c.status) ? 'stopped' : c.status);
    if (status === c.status) return c;
    changed = true;
    return { ...c, status };
  });
  if (changed) s.set({ comments: next });
}

const STATUSES = new Set<CommentStatus>(['waiting', 'working', 'done', 'stopped']);

/** Comments from a project file: whatever's well-formed and on a board that still exists. */
export function readComments(raw: unknown, p: Project): CanvasComment[] {
  if (!Array.isArray(raw)) return [];
  const boards = new Set(p.boards.map((b) => b.id));
  return raw.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && boards.has(c.boardId) && Number.isFinite(c.x) && Number.isFinite(c.y) && STATUSES.has(c.status));
}

/** Comments worth saving: a pin on a deleted row only matters until the undo history is gone. */
export const savableComments = (p: Project, comments: CanvasComment[]) => comments.filter((c) => p.boards.some((b) => b.id === c.boardId));

/** Is a strip point on this board? Pins go on boards, not on the canvas around them. */
export function onBoard(b: Doc, p: { x: number; y: number }) {
  const f = boardFrames(useStore.getState().project).get(b.id);
  return !!f && p.x >= 0 && p.y >= 0 && p.x <= f.w && p.y <= f.h;
}
