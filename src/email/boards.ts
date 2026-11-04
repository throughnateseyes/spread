import { useStore } from '../store';
import { findNode, makeEmailBoard } from '../tree';
import type { Doc, FrameNode } from '../types';
import { EMAIL_SECTIONS, EMAIL_STYLE, EMAIL_TEMPLATES, makeEmailRoot } from './templates';

// Glue between the email engine and the board model: an email board holds exactly one
// top-level auto-layout column (the "root"); sections are its children.

export function emailRootOf(doc: Doc): FrameNode | null {
  if (doc.kind !== 'email') return null;
  const r = doc.nodes.find((n) => n.type === 'frame');
  return r && r.type === 'frame' ? r : null;
}

/** Photos to feed templates: the tray selection, else the whole tray, in order. */
export function trayPhotos(): string[] {
  const s = useStore.getState();
  return s.traySelection.length ? s.traySelection : s.doc.assetOrder;
}

/** Adds a new email board from a template (or blank) below the active board. Returns its id. */
export function createEmailBoard(templateId: string | 'blank', name?: string, photoIds?: string[]): string {
  const t = EMAIL_TEMPLATES.find((x) => x.id === templateId);
  const board = makeEmailBoard(name ?? (t ? t.name : 'Untitled email'));
  board.background = EMAIL_STYLE.ground;
  const root = t ? t.build(photoIds ?? trayPhotos()) : makeEmailRoot([]);
  root.x = 0;
  root.y = 0;
  board.nodes = [root];
  const s = useStore.getState();
  const id = s.addBoard(board, s.project.activeBoardId);
  requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
  return id;
}

/**
 * Where a new section goes when no index is given: after the section holding the selection (when
 * the user is working inside the email), otherwise just above the footer, otherwise at the end.
 */
export function defaultSectionIndex(root: FrameNode, selection: string[], afterSelection: boolean): number {
  if (afterSelection) {
    const i = root.children.findIndex((c) => selection.some((id) => c.id === id || (c.type === 'frame' && !!findNode(c.children, id))));
    if (i >= 0) return i + 1;
  }
  const last = root.children[root.children.length - 1];
  return last && /footer/i.test(last.name) ? root.children.length - 1 : root.children.length;
}

/** Inserts a built section into the active email board's root and selects it. */
export function insertSectionNode(section: FrameNode, index?: number, afterSelection = false): string | null {
  const s = useStore.getState();
  const root = emailRootOf(s.doc);
  if (!root) return null;
  const at = index ?? defaultSectionIndex(root, s.selection, afterSelection);
  s.change((d) => {
    const r = emailRootOf(d);
    if (!r) return;
    r.children.splice(Math.max(0, Math.min(at, r.children.length)), 0, section);
  });
  s.select([section.id]);
  return section.id;
}

/** Inserts a built-in section (at `index`, or the default place) into the active email board. */
export function insertEmailSection(sectionId: string, index?: number, photoIds?: string[], afterSelection = false): string | null {
  const def = EMAIL_SECTIONS.find((x) => x.id === sectionId);
  if (!def || !emailRootOf(useStore.getState().doc)) return null;
  return insertSectionNode(def.build(photoIds ?? trayPhotos()), index, afterSelection);
}
