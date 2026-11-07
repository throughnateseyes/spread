import { useEffect, useLayoutEffect, useRef } from 'react';
import { useStore, useLayout, activeOrigin } from '../store';
import { findNode, pathTo } from '../tree';
import { absoluteBox, letterSpacingPx, textFontStyle } from '../layout';
import { boldWeightFor, fontWeights, isBold, nearestWeight } from '../fonts';
import { rangeStyles, remapSpans, richHtml, styleRange, type RunStyle } from '../richtext';
import type { TextNode } from '../types';

// In-place text editing: a contenteditable laid exactly over the canvas text (hidden meanwhile).
// It shows styled ranges as they'll render, and keeps the browser's own editing: copy, cut,
// paste, select all, undo, word and line jumps. Highlight part of the text and press ⌘B, ⌘I or
// ⌘U to style just that part; with nothing highlighted they apply to the whole layer.

/** Plain text of the editor: text nodes, <br> as a newline, and a newline between block children. */
function readText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node, first: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) out += (node as Text).data;
    else if (node.nodeName === 'BR') {
      if (!(node as HTMLElement).dataset.end) out += '\n';
    } else {
      const block = node !== el && (node.nodeName === 'DIV' || node.nodeName === 'P');
      if (block && !first && !out.endsWith('\n')) out += '\n';
      node.childNodes.forEach((c, i) => walk(c, i === 0));
    }
  };
  walk(el, true);
  return out;
}

/** Character offset of a DOM position inside the editor (same counting as readText). */
function offsetOf(el: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(el, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  const frag = document.createElement('div');
  frag.appendChild(r.cloneContents());
  return readText(frag).length;
}

function getSel(el: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return [offsetOf(el, r.startContainer, r.startOffset), offsetOf(el, r.endContainer, r.endOffset)];
}

/** Puts the selection back at character offsets after the content was rebuilt. */
function setSel(el: HTMLElement, a: number, b: number) {
  const find = (target: number): [Node, number] => {
    let left = target;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n: Node | null = walker.nextNode();
    let last: [Node, number] = [el, 0];
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) {
        const len = (n as Text).data.length;
        if (left <= len) return [n, left];
        left -= len;
        last = [n, len];
      } else if (n.nodeName === 'BR' && !(n as HTMLElement).dataset.end) {
        if (left === 0) return [n.parentNode!, Array.prototype.indexOf.call(n.parentNode!.childNodes, n)];
        left -= 1;
      }
      n = walker.nextNode();
    }
    return last;
  };
  const sel = window.getSelection();
  if (!sel) return;
  const [sn, so] = find(a);
  const [en, eo] = find(b);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Editor content for a layer: its runs, plus a closing <br> so a trailing newline shows. */
function contentHtml(n: TextNode) {
  return richHtml(n) + (n.text.endsWith('\n') || !n.text ? '<br data-end="1">' : '');
}

export default function TextEditor() {
  const id = useStore((s) => s.editingTextId)!;
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const layout = useLayout();
  useStore((s) => s.project);
  const origin = activeOrigin();
  const ref = useRef<HTMLDivElement>(null);
  const node = findNode(doc.nodes, id) as TextNode | null;
  const box = node ? absoluteBox(layout, pathTo(doc.nodes, id)) : null;
  const originalText = useRef(node?.text ?? '');
  /** What the editor's DOM currently shows, so outside edits (Claude, the panel) can be told apart. */
  const shown = useRef<{ text: string; spans: TextNode['spans'] } | null>(null);

  const render = (n: TextNode) => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = contentHtml(n);
    shown.current = { text: n.text, spans: n.spans };
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !node) return;
    render(node);
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change that didn't come from typing here (undo, Claude, the panel): show it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !node || !shown.current) return;
    if (shown.current.text === node.text && shown.current.spans === node.spans) return;
    const at = getSel(el);
    render(node);
    if (at) setSel(el, Math.min(at[0], node.text.length), Math.min(at[1], node.text.length));
  });

  const finish = () => {
    const s = useStore.getState();
    const n = findNode(s.doc.nodes, id);
    s.set({ editingTextId: null });
    if (n?.type === 'text' && !n.text.trim()) {
      s.select([id]);
      s.deleteSelection();
    }
  };

  const onInput = () => {
    const el = ref.current;
    const s = useStore.getState();
    const n = findNode(s.doc.nodes, id);
    if (!el || n?.type !== 'text') return;
    const text = readText(el);
    if (text === n.text) return;
    const spans = remapSpans(n.text, text, n.spans);
    shown.current = { text, spans };
    s.updateNode(id, { text, spans }, 'text-' + id);
  };

  /** ⌘B / ⌘I / ⌘U on highlighted text: style just that range. False when nothing is highlighted. */
  const styleSelection = (kind: 'b' | 'i' | 'u'): boolean => {
    const el = ref.current;
    const s = useStore.getState();
    const n = findNode(s.doc.nodes, id);
    if (!el || n?.type !== 'text') return false;
    const at = getSel(el);
    if (!at || at[0] === at[1]) return false;
    const [a, b] = at[0] < at[1] ? at : [at[1], at[0]];
    if (a === 0 && b >= n.text.length) return false; // everything: style the layer itself
    const styles = rangeStyles(n, a, b);
    let patch: Partial<RunStyle>;
    if (kind === 'b') {
      const weights = fontWeights(n.fontFamily, s.doc);
      const allBold = styles.every((x) => isBold(x.fontWeight));
      const bold = boldWeightFor(weights);
      if (!allBold && bold === null) {
        s.toast(`${n.fontFamily.replace(/ Variable$/, '')} only comes in one weight.`);
        return true;
      }
      patch = { fontWeight: allBold ? nearestWeight(weights, isBold(n.fontWeight) ? 400 : n.fontWeight) : bold! };
    } else if (kind === 'i') patch = { italic: !styles.every((x) => x.italic) };
    else patch = { decoration: styles.every((x) => x.decoration === 'underline') ? 'none' : 'underline' };
    const spans = styleRange(n, a, b, patch);
    s.updateNode(id, { spans });
    const next = findNode(useStore.getState().doc.nodes, id) as TextNode;
    render(next);
    setSel(el, a, b);
    return true;
  };

  if (!node || node.type !== 'text' || !box) return null;
  const z = view.zoom;
  const hug = node.sizingH === 'hug';
  return (
    <div
      ref={ref}
      className="text-editor"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-multiline
      onInput={onInput}
      onBlur={finish}
      onKeyDown={(e) => {
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
        if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape' && !node.text.trim() && originalText.current) {
            useStore.getState().updateNode(id, { text: originalText.current });
          }
          (e.target as HTMLElement).blur();
          return;
        }
        if (e.key === 'Enter' && !mod) {
          // A plain newline, never a <div>, so the text reads back exactly.
          e.preventDefault();
          document.execCommand('insertText', false, '\n');
          return;
        }
        if (mod && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) {
          if (styleSelection(k as 'b' | 'i' | 'u')) {
            e.preventDefault();
            e.stopPropagation();
          }
          // Nothing highlighted: the global shortcut styles the whole layer.
        }
        // Everything else (copy, cut, paste, select all, undo, arrows) is the browser's own.
      }}
      style={{
        left: view.panX + (box.x + origin.x) * z,
        top: view.panY + (box.y + origin.y) * z,
        width: hug ? 'auto' : box.w * z,
        minWidth: hug ? Math.max(box.w * z, 24) : undefined,
        minHeight: node.fontSize * node.lineHeight * z,
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        transformOrigin: '0 0',
        font: `${textFontStyle(node)} ${node.fontSize * z}px "${node.fontFamily}"`,
        lineHeight: node.lineHeight,
        letterSpacing: letterSpacingPx(node) * z + 'px',
        color: node.fill,
        caretColor: node.fill,
        textAlign: node.align === 'justify' ? 'justify' : node.align,
        textTransform: node.uppercase ? 'uppercase' : 'none',
        textDecoration: node.decoration === 'none' ? 'none' : node.decoration,
        whiteSpace: hug ? 'pre' : 'pre-wrap',
        overflowWrap: hug ? 'normal' : 'break-word',
      }}
    />
  );
}
