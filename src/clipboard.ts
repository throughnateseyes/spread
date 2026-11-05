import { isTyping } from './typing';
import { useStore, currentLayout, activeOrigin } from './store';
import { cloneWithNewIds, collectAssetIds, findNode, makeText, pathTo } from './tree';
import { absoluteBox } from './layout';
import { importFiles } from './importer';
import { adoptTokens, carriedBy, type CarriedTokens } from './tokens';
import type { AssetMeta, SceneNode } from './types';

// Internal clipboard for nodes (with absolute positions so paste can land anywhere),
// plus OS clipboard integration: pasted images import, pasted text becomes a text layer.

const MARKER = '⁣spread-nodes';
let clip: { nodes: SceneNode[]; abs: { x: number; y: number }[]; assets: AssetMeta[]; tokens: CarriedTokens } | null = null;

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
  cascade = { slide: -1, n: 0 };
  navigator.clipboard?.writeText(MARKER).catch(() => {});
  return true;
}

/**
 * Pastes copied nodes as top-level nodes. With `at`, the group lands with its top-left at that point.
 * Otherwise it lands on the slide under the pointer (or in the middle of the view) at the same spot
 * within the slide, so copying from slide 1 and pasting over slide 3 puts it on slide 3. Pasting
 * again on the same slide cascades so copies don't stack exactly. `inPlace` (⌘⇧V) keeps the exact spot.
 */
let pastedInPlaceAt = 0;

export function pasteClipboard(at?: { x: number; y: number }, opts: { inPlace?: boolean } = {}) {
  if (!clip) return false;
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

/** True when copy and paste belong to text, like a field or words selected in the Claude chat. */
function onText() {
  if (useStore.getState().homeOpen) return true;
  const sel = window.getSelection();
  return isTyping() || (!!sel && !sel.isCollapsed);
}

export function installClipboard() {
  const onCopy = (e: ClipboardEvent) => {
    if (onText()) return;
    if (copySelection()) {
      e.clipboardData?.setData('text/plain', MARKER);
      e.preventDefault();
    }
  };
  const onCut = (e: ClipboardEvent) => {
    if (onText()) return;
    if (copySelection()) {
      e.clipboardData?.setData('text/plain', MARKER);
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
    if (text === MARKER || (!text && clip)) {
      e.preventDefault();
      // ⌘⇧V already pasted in place from the keydown.
      if (Date.now() - pastedInPlaceAt < 300) return;
      pasteClipboard();
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
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('pointermove', onPointer);
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
