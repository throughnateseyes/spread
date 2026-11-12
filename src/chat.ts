import { create } from 'zustand';
import { activeBrand, useBrands } from './brand';
import { getLayout } from './layout';
import { findNode, walk } from './tree';
import { homeDir, native, type ChatState } from './platform';
import { useLibrary } from './library';
import { absoluteBoxes } from './render';
import { currentLayout, useStore } from './store';
import { patchComment, pinLabel, pinnedNode, pinPoint, reconcileNotes } from './comments';
import { claudeChatIn, steerClaude, useWorkspace } from './workspace';
import type { CanvasComment, SceneNode } from './types';

// The Claude side panel's renderer half: which conversation belongs to the open project, and the
// <spread-context> block that rides along with every message so Claude always knows what the user
// is looking at (the active row, the selection, picks, the brand and its design doc).

export const useChat = create<{ state: ChatState | null }>(() => ({ state: null }));

const UNSAVED = 'unsaved';

/** One conversation per project file; unsaved work shares one until it's saved. */
export const chatKey = (filePath: string | null) => filePath ?? UNSAVED;

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

/** Claude Code runs in the project's folder, so that folder's CLAUDE.md applies. */
export const chatCwd = () => {
  const fp = useStore.getState().filePath;
  return fp ? dirOf(fp) : (homeDir ?? undefined);
};

/** Notes on their way to the chat, which can't know about them yet. */
const sending = new Set<string>();

/**
 * The conversation the panel shows: the open project's own, unless a Claude from another project's
 * chat moved itself here (open_project, new_project), in which case the panel stays with that
 * Claude so its turn doesn't vanish mid-way.
 */
const panelKeyFor = (filePath: string | null) => claudeChatIn(filePath) ?? chatKey(filePath);
let panelKey = chatKey(null);

/** Pins follow the conversation the panel shows. */
function syncPins() {
  const state = useChat.getState().state;
  if (state && state.key === panelKey) reconcileNotes(state.notes ?? {}, sending);
}

export function installChat() {
  if (!native) return () => {};
  const n = native;
  panelKey = panelKeyFor(useStore.getState().filePath);
  const offPins = useChat.subscribe(syncPins);
  const load = () => n.chatOpen(panelKey).then((state) => useChat.setState({ state }));
  void load();
  const offUpdate = n.onChatUpdate((u) => {
    if (u.key === panelKey) useChat.setState({ state: u });
  });
  const follow = () => {
    const next = panelKeyFor(useStore.getState().filePath);
    if (next === panelKey) return;
    panelKey = next;
    void load();
  };
  const offStore = useStore.subscribe((s, prev) => {
    if (s.comments !== prev.comments) syncPins();
    if (s.filePath === prev.filePath) return;
    // Saving an unsaved project keeps its conversation; opening another project switches to that one.
    const saved = prev.filePath === null && !!s.filePath && s.project.boards[0]?.id === prev.project.boards[0]?.id;
    if (saved && panelKey === UNSAVED) void n.chatRename({ from: UNSAVED, to: chatKey(s.filePath) });
    follow();
  });
  const offClaude = useWorkspace.subscribe((w, prev) => void (w.claude !== prev.claude && follow()));
  return () => {
    offPins();
    offUpdate();
    offStore();
    offClaude();
  };
}

export const currentChatKey = () => panelKey;

/** A new message: this conversation's Claude works in the project the user is looking at. */
function aimClaude() {
  const fp = useStore.getState().filePath;
  if (fp) steerClaude(panelKey, fp);
}

/** Row letter by position: A, B, … (matches the board header chips). */
export const rowLetter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : rowLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const quote = (s: string) => `"${clip(s.replace(/\s+/g, ' ').trim(), 60)}"`;

/** What the composer shows above the input: the parts of the canvas the next message refers to. */
export function contextChips() {
  const s = useStore.getState();
  const p = s.project;
  const i = p.boards.findIndex((b) => b.id === p.activeBoardId);
  const brand = activeBrand();
  return {
    row: i >= 0 ? `Row ${rowLetter(i)} · ${p.boards[i].name}` : null,
    selection: s.selection.length ? `${s.selection.length} layer${s.selection.length > 1 ? 's' : ''}` : null,
    photos: s.traySelection.length ? `${s.traySelection.length} photo${s.traySelection.length > 1 ? 's' : ''}` : null,
    brand: brand ? brand.name : 'No brand',
  };
}

/** One selected layer: enough to act on "make this bigger" without another get_state. */
function nodeLine(n: SceneNode, box: { x: number; y: number; w: number; h: number } | undefined, slideW: number) {
  const bits: string[] = [n.type];
  if (n.key) bits.push(`key ${n.key}`);
  bits.push(`id ${n.id}`);
  if (box) bits.push(`slide ${Math.floor(box.x / slideW) + 1}`, `box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}×${Math.round(box.h)}`);
  if (n.type === 'text') bits.push(`${n.fontFamily} ${n.fontWeight} ${n.fontSize}`);
  return `- ${quote(n.name)} (${bits.join(', ')})${n.type === 'text' ? ` ${quote(n.text)}` : ''}`;
}

/** What a pinned note is about. Read from the pin's own row, which isn't always the active one. */
function noteLines(c: CanvasComment) {
  const s = useStore.getState();
  const i = s.project.boards.findIndex((b) => b.id === c.boardId);
  const b = s.project.boards[i];
  if (!b) return [`Pinned note ${c.n}: its row has been deleted.`];
  const at = pinPoint(b, c, s.fontsVersion);
  const page = b.kind === 'document' ? 'page' : b.kind === 'email' ? 'section' : 'slide';
  const lines = [`Pinned note ${c.n}, on row ${rowLetter(i)} ${quote(b.name)} (id ${b.id}, ${b.kind}), ${page} ${Math.floor(at.x / b.slideWidth) + 1}, at ${Math.round(at.x)},${Math.round(at.y)}:`];
  const n = pinnedNode(b, c);
  if (n) lines.push(nodeLine(n, absoluteBoxes(b.nodes, getLayout(b.nodes, s.fontsVersion)).get(n.id), b.slideWidth));
  else lines.push(c.nodeId ? `- The layer it was on is gone (it was id ${c.nodeId}${c.nodeKey ? `, key ${c.nodeKey}` : ''}).` : '- No layer: an empty spot on the board.');
  return lines;
}

/** The block Spread prepends to each message. Plain text, a few lines, built fresh every send. */
export async function buildContext(files: string[], note?: CanvasComment) {
  const s = useStore.getState();
  const p = s.project;
  const lines: string[] = [];
  lines.push(`Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  lines.push(`Project: ${quote(p.name)}${s.filePath ? ` (${s.filePath})` : ' (not saved yet)'}${s.dirty ? ', unsaved changes' : ''}`);

  const brand = activeBrand();
  if (brand) {
    lines.push(`Brand: ${brand.name} (id ${brand.id}, updated ${new Date(brand.updatedAt).toISOString().slice(0, 16)}). Fonts, colors and scale come from spread_get_brand.`);
    if (brand.designDoc) lines.push(`Brand design doc: ${brand.designDoc}`);
  } else {
    const n = useBrands.getState().brands.length;
    lines.push(`Brand: none (a personal project: no brand's fonts, colors or rules${n ? '; switch only if asked' : ''}).`);
  }
  if (s.filePath && native) {
    const docs = await native.chatDesignDocs(dirOf(s.filePath)).catch(() => []);
    for (const d of docs) lines.push(`Project design doc: ${d}`);
  }

  const d = s.doc;
  const ai = p.boards.findIndex((b) => b.id === p.activeBoardId);
  const units = d.page?.units ?? 'px';
  const pages = d.kind === 'document' ? 'page' : d.kind === 'email' ? 'section' : 'slide';
  lines.push(`Active row: ${rowLetter(ai)} ${quote(d.name)} (id ${d.id}, ${d.kind}, ${d.slideWidth}×${d.slideHeight}${units}, ${d.slides.length} ${pages}${d.slides.length > 1 ? 's' : ''})`);
  if (d.kind === 'email') lines.push(`Inbox: ${d.email?.subject ? `subject ${quote(d.email.subject)}` : 'no subject yet'} · ${d.email?.preheader ? `preview ${quote(d.email.preheader)}` : 'no preview text yet'}`);

  const lib = useLibrary.getState();
  const mine = <T extends { brandId: string | null }>(xs: T[]) => xs.filter((x) => x.brandId === null || x.brandId === (p.brandId ?? null));
  const refs = mine(lib.references);
  const tpls = mine(lib.templates);
  if (refs.length || tpls.length) {
    const sameKind = refs.filter((r) => r.boardKind === d.kind).length;
    lines.push(`Library: ${tpls.length} saved template${tpls.length === 1 ? '' : 's'}, ${refs.length} reference${refs.length === 1 ? '' : 's'}${sameKind ? ` (${sameKind} for ${d.kind}s)` : ''}. spread_list_library lists them.`);
  }

  const sel = s.selection.map((id) => findNode(d.nodes, id)).filter(Boolean) as SceneNode[];
  if (sel.length) {
    lines.push(`Selected on row ${rowLetter(ai)} (${sel.length}):`);
    const boxes = absoluteBoxes(d.nodes, currentLayout());
    for (const n of sel.slice(0, 8)) lines.push(nodeLine(n, boxes.get(n.id), d.slideWidth));
    if (sel.length > 8) lines.push(`- …and ${sel.length - 8} more`);
  } else {
    lines.push('Selection: nothing selected');
  }

  const photos = d.assetOrder.filter((id) => d.assets[id]?.kind !== 'font');
  if (photos.length) {
    const placed = new Set<string>();
    walk(d.nodes, (n) => {
      if (n.type === 'image' && n.assetId) placed.add(n.assetId);
    });
    const picked = s.traySelection.filter((id) => d.assets[id]).map((id) => `${d.assets[id].name} (${id})`);
    lines.push(`Photo tray: ${photos.length} photos, ${photos.filter((id) => placed.has(id)).length} placed on this row${picked.length ? `. Selected: ${picked.slice(0, 12).join(', ')}${picked.length > 12 ? ` and ${picked.length - 12} more` : ''}` : ''}`);
  }

  if (p.boards.length > 1 || p.boards[0]?.status) {
    lines.push('Rows:');
    p.boards.forEach((b, i) => {
      const log = s.editLog[b.id];
      const bits = [b.status ? `${b.status}${b.statusReason ? ` (${b.statusReason})` : ''}` : null, log?.userEditsSinceClaude ? `${log.userEditsSinceClaude} hand edits since Claude` : null].filter(Boolean);
      const note = b.note ? ` · note ${quote(b.note)}` : '';
      lines.push(`- ${rowLetter(i)} ${quote(b.name)} (id ${b.id}, ${b.kind}, ${b.slides.length} ${b.kind === 'document' ? 'pages' : 'slides'})${b.id === p.activeBoardId ? ' [active]' : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}${note}`);
    });
  }
  if (files.length) {
    lines.push('Attached by the user:');
    for (const f of files) lines.push(`- ${f}`);
  }
  if (note) lines.push(...noteLines(note));
  return `<spread-context>\n${lines.join('\n')}\n</spread-context>`;
}

/** Sends a message with the current canvas context. */
export async function sendChat(text: string, files: string[] = []) {
  if (!native) return;
  const chips = contextChips();
  const label = [chips.row, chips.selection, chips.photos, ...files.map((f) => f.split(/[\\/]/).pop())].filter(Boolean).join(' · ');
  const content = `${await buildContext(files)}\n\n${text}`;
  aimClaude();
  await native.chatSend({ key: currentChatKey(), cwd: chatCwd(), text, content, label });
}

/** Sends a canvas comment, down the same path as the composer but with its pin's layer attached. */
export async function sendNote(id: string) {
  const s = useStore.getState();
  const c = s.comments.find((x) => x.id === id);
  if (!native || !c) return;
  const i = s.project.boards.findIndex((b) => b.id === c.boardId);
  const label = [`Note ${c.n}`, i >= 0 ? `Row ${rowLetter(i)}` : null, pinLabel(s.project.boards[i], c, s.fontsVersion)].filter(Boolean).join(' · ');
  sending.add(id);
  patchComment(id, { status: 'waiting' }, false);
  try {
    const content = `${await buildContext([], c)}\n\n${c.text}`;
    aimClaude();
    await native.chatSend({ key: currentChatKey(), cwd: chatCwd(), text: c.text, content, label, noteId: id });
    sending.delete(id);
    syncPins();
  } catch {
    sending.delete(id);
    patchComment(id, { status: 'stopped' }, false);
  }
}
