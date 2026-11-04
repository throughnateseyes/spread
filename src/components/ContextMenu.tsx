import { useEffect, useRef } from 'react';
import { MOD, useStore, currentLayout } from '../store';
import { findNode, findParent } from '../tree';
import { inAutoLayout } from '../layout';
import { copySelection, pasteClipboard } from '../clipboard';
import { absoluteBoxes } from '../render';
import { Floating } from '../ui/Floating';
import type { SceneNode } from '../types';
import { emailRootOf } from '../email/boards';
import { isElectron } from '../platform';
import { askSaveToLibrary } from './LibraryDialogs';

export interface MenuState {
  x: number;
  y: number;
  at: { x: number; y: number };
}

type Item = { label: string; kbd?: string; fn: () => void; disabled?: boolean };

/** Swaps two image nodes' photos and crops (the slots stay put). */
export function swapPhotos(a: string, b: string, key?: string) {
  useStore.getState().change((d) => {
    const x = findNode(d.nodes, a);
    const y = findNode(d.nodes, b);
    if (x?.type !== 'image' || y?.type !== 'image') return;
    [x.assetId, y.assetId] = [y.assetId, x.assetId];
    [x.crop, y.crop] = [y.crop, x.crop];
  }, key);
}

export default function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const s = useStore();
  const sel = s.selection;
  const one = sel.length === 1 ? findNode(s.doc.nodes, sel[0]) : null;
  const selNodes = sel.map((id) => findNode(s.doc.nodes, id)).filter((n): n is SceneNode => !!n);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Focus the menu so arrow keys / Enter work without touching the mouse.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const fitToSlide = () => {
    if (!one) return;
    const a = absoluteBoxes(s.doc.nodes, currentLayout()).get(one.id);
    if (!a || inAutoLayout(findParent(s.doc.nodes, one.id))) return;
    const W = s.doc.slideWidth;
    const i = Math.max(0, Math.min(s.doc.slides.length - 1, Math.floor((a.x + a.w / 2) / W)));
    const parentOffset = { x: a.x - one.x, y: a.y - one.y };
    s.updateNode(one.id, (n) => {
      n.x = i * W - parentOffset.x;
      n.y = -parentOffset.y;
      n.w = W;
      n.h = s.doc.slideHeight;
      n.rotation = 0;
      n.sizingH = 'fixed';
      n.sizingV = 'fixed';
    });
  };

  // Multi-selection toggles act uniformly (like Figma): if any layer is visible, hide them all.
  const anyVisible = selNodes.some((n) => n.visible);
  const anyUnlocked = selNodes.some((n) => !n.locked);

  // Slide actions for the slide under the cursor (carousels only).
  const slideIndex = Math.floor(menu.at.x / s.doc.slideWidth);
  const onSlide = s.doc.kind !== 'email' && slideIndex >= 0 && slideIndex < s.doc.slides.length && menu.at.y >= 0 && menu.at.y <= s.doc.slideHeight;
  const slideItems: (null | Item)[] = onSlide
    ? [
        null,
        { label: `Insert slide after ${slideIndex + 1}`, fn: () => s.insertSlide(slideIndex) },
        { label: `Delete slide ${slideIndex + 1}`, fn: () => s.deleteSlide(slideIndex), disabled: s.doc.slides.length <= 1 },
      ]
    : [];

  // In an email, the section (top-level block) holding the selection can be saved for reuse.
  const emailRoot = emailRootOf(s.doc);
  const section = emailRoot && one ? emailRoot.children.find((c) => c.id === one.id || (c.type === 'frame' && !!findNode(c.children, one.id))) : null;
  const sectionItems: (null | Item)[] =
    section && isElectron
      ? [null, { label: 'Save section as template…', fn: () => askSaveToLibrary({ kind: 'section', boardId: s.doc.id, sectionId: section.id, name: section.name.replace(/^section\s*\/\s*/i, '') }) }]
      : [];

  const items: (null | Item)[] = sel.length
    ? [
        { label: 'Copy', kbd: `${MOD}+C`, fn: copySelection },
        { label: 'Paste', kbd: `${MOD}+V`, fn: () => pasteClipboard(menu.at) },
        { label: 'Duplicate', kbd: `${MOD}+D`, fn: s.duplicateSelection },
        { label: 'Delete', kbd: 'Del', fn: s.deleteSelection },
        null,
        { label: 'Bring to front', kbd: `${MOD}+Shift+]`, fn: () => sel.forEach((id) => s.reorder(id, 'top')) },
        { label: 'Bring forward', kbd: `${MOD}+]`, fn: () => sel.forEach((id) => s.reorder(id, 'up')) },
        { label: 'Send backward', kbd: `${MOD}+[`, fn: () => sel.forEach((id) => s.reorder(id, 'down')) },
        { label: 'Send to back', kbd: `${MOD}+Shift+[`, fn: () => sel.forEach((id) => s.reorder(id, 'bottom')) },
        null,
        { label: 'Frame selection', kbd: `${MOD}+Alt+G`, fn: () => s.wrapSelectionInFrame(false) },
        { label: 'Add auto layout', kbd: 'Shift+A', fn: () => s.wrapSelectionInFrame(true) },
        { label: 'Ungroup', kbd: `${MOD}+Shift+G`, fn: () => one && s.ungroup(one.id), disabled: one?.type !== 'frame' },
        null,
        ...(one?.type === 'image'
          ? [
              { label: 'Edit crop', kbd: 'Enter', fn: () => s.set({ croppingId: one.id }), disabled: !one.assetId },
              { label: 'Fit to slide (full bleed)', fn: fitToSlide },
            ]
          : []),
        ...(selNodes.length === 2 && selNodes.every((n) => n.type === 'image')
          ? [{ label: 'Swap photos', kbd: 'Shift+drag', fn: () => swapPhotos(selNodes[0].id, selNodes[1].id) }]
          : []),
        { label: anyVisible ? 'Hide' : 'Show', kbd: `${MOD}+Shift+H`, fn: () => s.updateNodes(sel, (n) => void (n.visible = !anyVisible)) },
        { label: anyUnlocked ? 'Lock' : 'Unlock', kbd: `${MOD}+Shift+L`, fn: () => s.updateNodes(sel, (n) => void (n.locked = anyUnlocked)) },
        ...slideItems,
        ...sectionItems,
      ]
    : [
        { label: 'Paste here', kbd: `${MOD}+V`, fn: () => pasteClipboard(menu.at) },
        { label: 'Select all', kbd: `${MOD}+A`, fn: () => s.select(s.doc.nodes.filter((n) => !n.locked).map((n) => n.id)) },
        null,
        { label: 'Zoom to fit all', kbd: 'Shift+1', fn: () => window.dispatchEvent(new CustomEvent('spread:fit', { detail: 'all' })) },
        { label: 'Zoom to row', kbd: 'Shift+3', fn: () => window.dispatchEvent(new Event('spread:fit')) },
        ...(onSlide ? [{ label: `Zoom to slide ${slideIndex + 1}`, fn: () => window.dispatchEvent(new CustomEvent('spread:zoom-slide', { detail: slideIndex })) }] : []),
        ...slideItems,
      ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i <= 0 ? btns.length : i) - 1;
    btns[next].focus();
  };

  return (
    <Floating x={menu.x} y={menu.y} anchor="top-left" interactive zIndex={150} margin={8}>
      <div className="ctx-menu" role="menu" tabIndex={-1} ref={box} style={{ position: 'static' }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
        {items.map((it, i) =>
          it ? (
            <button key={i} role="menuitem" onClick={run(it.fn)} disabled={it.disabled}>
              <span>{it.label}</span>
              {it.kbd && <span className="kbd">{it.kbd}</span>}
            </button>
          ) : (
            <hr key={i} />
          ),
        )}
      </div>
    </Floating>
  );
}
