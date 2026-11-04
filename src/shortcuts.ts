import { isTyping } from './typing';
import { fitVariations, useStore } from './store';
import { findNode, findParent } from './tree';
import { inAutoLayout } from './layout';
import { saveProject, openProject } from './project';
import { pasteClipboard } from './clipboard';
import { toggleBoldSelection } from './fonts';
import type { Tool } from './types';
import { isElectron } from './platform';
import { toggleChat } from './components/ClaudePanel';

// Global Figma-style keyboard shortcuts. Copy/cut/paste are DOM clipboard events (clipboard.ts).

const TOOL_KEYS: Record<string, Tool> = { v: 'move', h: 'hand', f: 'frame', p: 'image', r: 'rect', o: 'ellipse', t: 'text' };

export const SHORTCUTS: [string, string][] = [
  ['V / H', 'Move / Hand tool'],
  ['C', 'Comment: click a layer or a spot to send Claude a note'],
  ['F / P / R / O / T', 'Frame / Photo frame / Rectangle / Ellipse / Text (R and O share the Shape tool)'],
  ['Space + drag', 'Pan'],
  ['Scroll / Shift+Scroll', 'Pan vertically / horizontally'],
  ['Ctrl+Scroll / pinch', 'Zoom'],
  ['Ctrl+= / Ctrl+− / Ctrl+0', 'Zoom in / out / 100%'],
  ['Shift+0 / 1 / 2 / 3', 'Zoom 100% / fit all rows / selection / active row'],
  ['Ctrl+Alt+D', 'Duplicate board as a variation row'],
  ['Alt+↑ / Alt+↓', 'Previous / next board'],
  ['Double-click text', 'Edit text'],
  ['Ctrl+B', 'Bold selected text (fonts that have a bold weight)'],
  ['Double-click photo / Enter', 'Crop (drag to pan, scroll to zoom)'],
  ['Double-click frame', 'Select child'],
  ['Ctrl+click', 'Deep select'],
  ['Shift+click', 'Add to selection'],
  ['Enter / Shift+Enter or \\', 'Select children / parent'],
  ['Tab / Shift+Tab', 'Next / previous sibling'],
  ['Shift while resizing', 'Keep proportions'],
  ['Alt while resizing', 'Resize from the centre'],
  ['Alt+drag', 'Duplicate and drag the copy'],
  ['Ctrl while dragging', 'Suspend snapping'],
  ['Alt (hold, with a selection)', 'Measure distances (to the hovered layer or the slide)'],
  ['Shift+drop a photo on a photo', 'Swap the two photos'],
  ['Arrows / Shift+Arrows', 'Nudge 1px / 10px'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+A', 'Select all (layers on the board, or siblings of the selection)'],
  ['Ctrl+C / X / V', 'Copy / Cut / Paste onto the slide under the pointer (images & text from other apps too)'],
  ['Ctrl+Shift+V', 'Paste in place (exactly where it was copied)'],
  ['Delete', 'Delete'],
  ['Ctrl+G / Ctrl+Alt+G', 'Frame selection'],
  ['Shift+A', 'Add auto layout'],
  ['Ctrl+Shift+G', 'Ungroup / remove frame'],
  ['Ctrl+] / Ctrl+[', 'Bring forward / send backward (+Shift: to front/back)'],
  ["Ctrl+'", 'Toggle layout grid'],
  ['Ctrl+Shift+H / L', 'Hide / lock'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S / Ctrl+Shift+S / Ctrl+O', 'Save / Save as / Open'],
  ['Ctrl+Shift+E', 'Export'],
  ['Ctrl+J', 'Show / hide the Claude panel'],
  ['Esc', 'Deselect / exit crop or text'],
  ['?', 'This list'],
];

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const s = useStore.getState();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    // These work even while typing in a field.
    if (mod && k === 's') {
      e.preventDefault();
      saveProject(e.shiftKey);
      return;
    }
    if (mod && k === 'o') {
      e.preventDefault();
      openProject();
      return;
    }
    if (mod && k === 'j' && !e.shiftKey && !e.altKey && isElectron && !s.modal) {
      e.preventDefault();
      toggleChat();
      return;
    }
    // Bold also works while editing text on the canvas (it applies to the whole layer).
    if (mod && k === 'b' && !e.altKey && !s.modal && (s.editingTextId || !isTyping())) {
      if (toggleBoldSelection()) e.preventDefault();
      return;
    }
    // macOS only gives these to text fields through a menu, and the app menu leaves them out.
    if (mod && isTyping() && document.activeElement?.tagName !== 'SELECT' && (k === 'a' || k === 'z')) {
      e.preventDefault();
      document.execCommand(k === 'a' ? 'selectAll' : e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (isTyping() || s.editingTextId) return;
    if (s.modal) return;

    if (mod && k === 'z') {
      e.preventDefault();
      e.shiftKey ? s.redo() : s.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      s.redo();
      return;
    }
    if (mod && e.shiftKey && k === 'e') {
      e.preventDefault();
      s.set({ modal: 'export' });
      return;
    }
    if (mod && e.shiftKey && k === 'v') {
      // Paste in place. Chromium may also fire a paste event for this; clipboard.ts ignores it.
      if (pasteClipboard(undefined, { inPlace: true })) e.preventDefault();
      return;
    }
    if (mod && k === 'a') {
      e.preventDefault();
      // Select siblings of the current selection, else all top-level nodes.
      const p = s.selection[0] ? findParent(s.doc.nodes, s.selection[0]) : null;
      s.select((p ? p.children : s.doc.nodes).filter((n) => !n.locked && n.visible).map((n) => n.id));
      return;
    }
    if (mod && e.altKey && k === 'd') {
      // Duplicate the whole board as a variation row.
      e.preventDefault();
      s.duplicateBoard();
      fitVariations();
      return;
    }
    if (mod && k === 'd') {
      e.preventDefault();
      s.duplicateSelection();
      return;
    }
    if (mod && k === 'g') {
      e.preventDefault();
      if (e.shiftKey) {
        const f = s.selection.map((id) => findNode(s.doc.nodes, id)).find((n) => n?.type === 'frame');
        if (f) s.ungroup(f.id);
      } else s.wrapSelectionInFrame(false);
      return;
    }
    if (mod && (e.key === "'" || e.code === 'Quote')) {
      e.preventDefault();
      s.change((d) => void (d.grid.visible = !d.grid.visible));
      return;
    }
    if (mod && e.shiftKey && k === 'h') {
      e.preventDefault();
      s.updateNodes(s.selection, (n) => void (n.visible = !n.visible));
      return;
    }
    if (mod && e.shiftKey && k === 'l') {
      e.preventDefault();
      s.updateNodes(s.selection, (n) => void (n.locked = !n.locked));
      s.select([]);
      return;
    }
    if (mod && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      const up = e.code === 'BracketRight';
      const dir = e.shiftKey ? (up ? 'top' : 'bottom') : up ? 'up' : 'down';
      const ids = up ? [...s.selection].reverse() : s.selection;
      ids.forEach((id) => s.reorder(id, dir));
      return;
    }
    // Zoom: Ctrl+= / Ctrl+- step through presets, Ctrl+0 is 100% (also on the numpad).
    if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=')) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('spread:zoom-step', { detail: 1 }));
      return;
    }
    if (mod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-')) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('spread:zoom-step', { detail: -1 }));
      return;
    }
    if (mod && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('spread:zoom-to', { detail: 1 }));
      return;
    }
    if (mod) return;

    if (e.key === '?') {
      e.preventDefault();
      s.set({ modal: 'shortcuts' });
      return;
    }
    if (e.shiftKey && k === 'a') {
      e.preventDefault();
      s.wrapSelectionInFrame(true);
      return;
    }
    if (e.shiftKey && !e.altKey && (e.code === 'Digit0' || e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
      e.preventDefault();
      if (e.code === 'Digit1') window.dispatchEvent(new CustomEvent('spread:fit', { detail: 'all' }));
      else if (e.code === 'Digit2') window.dispatchEvent(new Event('spread:zoom-selection'));
      else if (e.code === 'Digit3') window.dispatchEvent(new Event('spread:fit'));
      else window.dispatchEvent(new CustomEvent('spread:zoom-to', { detail: 1 }));
      return;
    }
    // Shift+Enter / \ select the parent (Figma).
    if ((e.key === 'Enter' && e.shiftKey) || (e.code === 'Backslash' && !e.shiftKey && !e.altKey)) {
      e.preventDefault();
      if (s.croppingId) return s.set({ croppingId: null });
      const p = s.selection[0] ? findParent(s.doc.nodes, s.selection[0]) : null;
      if (p) s.select([p.id]);
      return;
    }
    // Tab / Shift+Tab: next / previous sibling (wraps, skips hidden and locked layers).
    const onCanvas = !document.activeElement || document.activeElement === document.body || !!(document.activeElement as HTMLElement).closest?.('.canvas-wrap');
    if (e.key === 'Tab' && !e.altKey && onCanvas) {
      e.preventDefault();
      const first = s.selection[0];
      const parent = first ? findParent(s.doc.nodes, first) : null;
      const list = (parent ? parent.children : s.doc.nodes).filter((n) => n.visible && !n.locked);
      if (!list.length) return;
      const cur = first ? list.findIndex((n) => n.id === (e.shiftKey ? first : s.selection[s.selection.length - 1])) : -1;
      const i = cur < 0 ? (e.shiftKey ? list.length - 1 : 0) : (cur + (e.shiftKey ? -1 : 1) + list.length) % list.length;
      s.select([list[i].id]);
      return;
    }
    if (e.key === 'Escape') {
      if (s.croppingId) s.set({ croppingId: null });
      else if (s.tool !== 'move') s.setTool('move');
      else if (s.selection.length) {
        // Figma: Esc selects the parent.
        const p = findParent(s.doc.nodes, s.selection[0]);
        s.select(p ? [p.id] : []);
      }
      return;
    }
    if (e.key === 'Enter') {
      const one = s.selection.length === 1 ? findNode(s.doc.nodes, s.selection[0]) : null;
      if (s.croppingId) s.set({ croppingId: null });
      else if (one?.type === 'text') s.set({ editingTextId: one.id });
      else if (one?.type === 'image' && one.assetId) s.set({ croppingId: one.id });
      else if (one?.type === 'frame' && one.children.length) s.select(one.children.filter((c) => c.visible && !c.locked).map((c) => c.id));
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      s.deleteSelection();
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Jump between boards (variation rows).
      e.preventDefault();
      const bs = s.project.boards;
      const i = bs.findIndex((b) => b.id === s.project.activeBoardId) + (e.key === 'ArrowDown' ? 1 : -1);
      if (i >= 0 && i < bs.length) {
        s.setActiveBoard(bs[i].id);
        window.dispatchEvent(new Event('spread:fit'));
      }
      return;
    }
    if (e.key.startsWith('Arrow') && s.selection.length) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      const movable = s.selection.filter((id) => !inAutoLayout(findParent(s.doc.nodes, id)));
      if (movable.length) {
        s.updateNodes(movable, (n) => {
          n.x += dx;
          n.y += dy;
        }, 'nudge');
      } else if (s.selection.length === 1) {
        // Inside auto layout, arrows reorder.
        s.reorder(s.selection[0], dx > 0 || dy > 0 ? 'up' : 'down');
      }
      return;
    }
    if (!e.shiftKey && !e.altKey && TOOL_KEYS[k]) {
      s.setTool(TOOL_KEYS[k]);
      return;
    }
    // Notes go to the Claude panel, which only the desktop app has.
    if (!e.shiftKey && !e.altKey && k === 'c' && isElectron) {
      s.setTool('comment');
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
