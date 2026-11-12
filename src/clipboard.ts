import { isTyping } from './typing';
import { useStore, currentLayout, activeOrigin } from './store';
import { cloneWithNewIds, collectAssetIds, findNode, makeText, pathTo, walk } from './tree';
import { getAsset } from './assets';
import { absoluteBox } from './layout';
import { importFiles } from './importer';
import { adoptTokens, carriedBy, type CarriedTokens } from './tokens';
import type { AssetMeta, SceneNode } from './types';

// Internal clipboard for nodes (with absolute positions so paste can land anywhere),
// plus OS clipboard integration: pasted images import, pasted text becomes a text layer.
//
// Copying layers also puts them on the system clipboard: as Spread's own format (so pasting works in
// another project, or after Spread restarts) and as plain text (the words of any text layers, so
// pasting into the Claude chat, a field or another app gives the words rather than gibberish).

/** What older versions put on the clipboard; still recognised when pasting. */
const MARKER = '⁣spread-nodes';
const MIME = 'application/x-spread-nodes';
type Clip = { nodes: SceneNode[]; abs: { x: number; y: number }[]; assets: AssetMeta[]; tokens: CarriedTokens };
let clip: Clip | null = null;
/** The system clipboard copy of `clip`, to tell our own copy apart from one made in another session. */
let clipJson = '';

/** Photos the clipboard still needs after the project they came from closes. */
export const clipAssetIds = () => clip?.assets.map((a) => a.id) ?? [];
/** Where the last paste of this clip landed (slide index) and how many times, for the cascade. */
let cascade = { slide: -1, n: 0 };
/** The pointer's last position over the canvas (client px), or null once it leaves. */
let pointer: { x: number; y: number } | null = null;

export function copySelection() {
  const s = useStore.getState();
  const layout = currentLayout();
  const roots = s.selection.filter((id) => !s.selection.some((o) => o !== id && pathTo(s.doc.nodes, id).includes(o)));
  const nodes: SceneNode[] = [];
  const abs: { x: number; y: number }[] = [];
  for (const id of roots) {
    const n = findNode(s.doc.nodes, id);
    const b = absoluteBox(layout, pathTo(s.doc.nodes, id));
    if (n && b) {
      nodes.push(structuredClone(n));
      abs.push({ x: b.x, y: b.y });
    }
  }
  if (!nodes.length) return false;
  const used = collectAssetIds(nodes);
  clip = { nodes, abs, assets: Object.values(s.doc.assets).filter((a) => used.has(a.id)), tokens: carriedBy(s.project, nodes) };
  clipJson = JSON.stringify({ v: 1, ...clip });
  cascade = { slide: -1, n: 0 };
  return true;
}

/** The words in the copied layers, top to bottom as they were selected. */
function clipText(c: Clip) {
  const words: string[] = [];
  walk(c.nodes, (n) => {
    if (n.type === 'text' && n.visible && n.text.trim()) words.push(n.text);
  });
  return words.join('\n\n');
}

function putOnClipboard(dt: DataTransfer | null) {
  if (!dt || !clip) return;
  dt.setData(MIME, clipJson);
  const text = clipText(clip);
  if (text) dt.setData('text/plain', text);
}

let forceCopy = false;

/** Copy from a menu: goes through a real copy event so the system clipboard gets the layers too. */
export function copyLayers() {
  forceCopy = true;
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    forceCopy = false;
  }
  if (!ok && copySelection() && clip) navigator.clipboard?.writeText(clipText(clip)).catch(() => {});
}

/** Layers copied in another session (or Spread before a restart). Photos it can't find paste as empty frames. */
function parseClip(raw: string): Clip | null {
  try {
    const c = JSON.parse(raw) as Clip & { v?: number };
    if (!Array.isArray(c.nodes) || !Array.isArray(c.abs) || c.nodes.length !== c.abs.length) return null;
    const doc = useStore.getState().doc;
    const have = (id: string) => !!doc.assets[id] || !!getAsset(id);
    walk(c.nodes, (n) => {
      if (n.type === 'image' && n.assetId && !have(n.assetId)) n.assetId = null;
    });
    return { nodes: c.nodes, abs: c.abs, assets: (c.assets ?? []).filter((a) => have(a.id)), tokens: c.tokens ?? {} };
  } catch {
    return null;
  }
}

/**
 * Pastes copied nodes as top-level nodes. With `at`, the group lands with its top-left at that point.
 * Otherwise it lands on the slide under the pointer (or in the middle of the view) at the same spot
 * within the slide, so copying from slide 1 and pasting over slide 3 puts it on slide 3. Pasting
 * again on the same slide cascades so copies don't stack exactly. `inPlace` (⌘⇧V) keeps the exact spot.
 */
let pastedInPlaceAt = 0;

export function pasteClipboard(at?: { x: number; y: number }, opts: { inPlace?: boolean } = {}, from: Clip | null = clip) {
  if (!from) return false;
  const clip = from;
  if (opts.inPlace) pastedInPlaceAt = Date.now();
  const s = useStore.getState();
  // Copied in another project tab: the photos join this project too, so they save with it.
  const incoming = clip.assets.filter((a) => !s.doc.assets[a.id]);
  if (incoming.length) s.addAssets(incoming);
  const d = useStore.getState().doc;
  const minX = Math.min(...clip.abs.map((a) => a.x));
  const minY = Math.min(...clip.abs.map((a) => a.y));
  let dx = 0;
  let dy = 0;
  if (at) {
    dx = at.x - minX;
    dy = at.y - minY;
  } else if (!opts.inPlace) {
    const last = d.slides.length - 1;
    const from = Math.max(0, Math.min(last, Math.floor(minX / d.slideWidth)));
    const p = pointerInStrip() ?? viewCenter();
    const to = Math.max(0, Math.min(last, Math.floor(p.x / d.slideWidth)));
    cascade = cascade.slide === to ? { slide: to, n: cascade.n + 1 } : { slide: to, n: to === from ? 1 : 0 };
    dx = (to - from) * d.slideWidth + cascade.n * 24;
    dy = cascade.n * 24;
  }
  const fresh = clip.nodes.map((n, i) => {
    const c = cloneWithNewIds(n);
    c.x = clip!.abs[i].x + dx;
    c.y = clip!.abs[i].y + dy;
    if (c.sizingH === 'fill') c.sizingH = 'fixed';
    if (c.sizingV === 'fill') c.sizingV = 'fixed';
    return c;
  });
  // Copied in another project tab: the styles come too, or join ones of the same name.
  s.changeProject((p) => adoptTokens(p, clip!.tokens, fresh));
  s.addNodes(fresh, null);
  return true;
}

/**
 * True when copy, cut and paste belong to text, not layers: a field, words highlighted anywhere, the
 * Claude panel (it takes pasted pictures itself), a dialog or the home screen. Cutting there must
 * never delete layers on the canvas behind it.
 */
function onText() {
  const s = useStore.getState();
  if (forceCopy) return false;
  if (s.homeOpen || s.modal) return true;
  if ((document.activeElement as HTMLElement | null)?.closest?.('.panel.chat, [aria-modal="true"]')) return true;
  const sel = window.getSelection();
  return isTyping() || (!!sel && !sel.isCollapsed);
}

export function installClipboard() {
  const onCopy = (e: ClipboardEvent) => {
    if (onText()) return;
    if (copySelection()) {
      putOnClipboard(e.clipboardData);
      e.preventDefault();
    }
  };
  const onCut = (e: ClipboardEvent) => {
    if (onText()) return;
    if (copySelection()) {
      putOnClipboard(e.clipboardData);
      e.preventDefault();
      useStore.getState().deleteSelection();
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    if (onText()) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files);
    if (files.length) {
      e.preventDefault();
      importFiles(files, { dropAt: viewCenter() });
      return;
    }
    const text = dt.getData('text/plain');
    const raw = dt.getData(MIME);
    if (raw || text === MARKER || (!text && clip)) {
      e.preventDefault();
      // ⌘⇧V already pasted in place from the keydown.
      if (Date.now() - pastedInPlaceAt < 300) return;
      pasteClipboard(undefined, {}, !raw || raw === clipJson ? clip : parseClip(raw));
      return;
    }
    if (text.trim()) {
      e.preventDefault();
      const p = viewCenter();
      useStore.getState().addNodes([makeText(p.x, p.y, text.trim())], null);
    }
  };
  const onPointer = (e: PointerEvent) => {
    pointer = (e.target as HTMLElement | null)?.closest?.('.canvas-wrap') ? { x: e.clientX, y: e.clientY } : null;
  };
  // Clicking the canvas leaves words highlighted elsewhere (the chat, say) highlighted, and then ⌘C
  // would copy them instead of the layers just clicked. A click on the canvas lets go of them.
  const onDown = (e: PointerEvent) => {
    if (!(e.target as HTMLElement | null)?.closest?.('.konvajs-content')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onDown, true);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onDown, true);
  };
}

/** A point in canvas client px → the active board's strip space (where node coordinates live). */
function toStrip(clientX: number, clientY: number) {
  const v = useStore.getState().view;
  const r = document.querySelector('.canvas-wrap')?.getBoundingClientRect();
  const o = activeOrigin();
  return { x: (clientX - (r?.left ?? 0) - v.panX) / v.zoom - o.x, y: (clientY - (r?.top ?? 0) - v.panY) / v.zoom - o.y };
}

function pointerInStrip() {
  return pointer ? toStrip(pointer.x, pointer.y) : null;
}

/** The middle of the visible canvas, in the active board's strip space. */
function viewCenter() {
  const r = document.querySelector('.canvas-wrap')?.getBoundingClientRect();
  const p = toStrip((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 600) / 2);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
