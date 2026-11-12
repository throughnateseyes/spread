import { isTyping } from './typing';
import { fitVariations, useStore } from './store';
import { findNode, findParent } from './tree';
import { inAutoLayout } from './layout';
import { saveProject, openProject } from './project';
import { closeTab, cycleTab, switchTo, useWorkspace } from './workspace';
import { openSwitcher } from './components/Switcher';
import { pasteClipboard } from './clipboard';
import { toggleBoldSelection, toggleStyleSelection } from './fonts';
import type { Tool } from './types';
import { isElectron, native } from './platform';
import { toggleChat } from './components/ClaudePanel';

// Global Figma-style keyboard shortcuts. Copy/cut/paste are DOM clipboard events (clipboard.ts).

const TOOL_KEYS: Record<string, Tool> = { v: 'move', h: 'hand', f: 'frame', p: 'image', r: 'rect', o: 'ellipse', t: 'text' };

export const SHORTCUTS: [string, string][] = [
  ['V / H', 'Move / Hand tool'],
  ['C', 'Comment: click a layer or a spot to send Claude a note'],
  ['L', 'Links mode on email boards: every link and picture, and what still needs one'],
  ['F / P / R / O / T', 'Frame / Photo frame / Rectangle / Ellipse / Text (R and O share the Shape tool)'],
  ['Space + drag', 'Pan'],
  ['Scroll / Shift+Scroll', 'Pan vertically / horizontally'],
  ['Ctrl+Scroll / pinch', 'Zoom'],
  ['Ctrl+= / Ctrl+− / Ctrl+0', 'Zoom in / out / 100%'],
  ['Shift+0 / 1 / 2 / 3', 'Zoom 100% / fit all rows / selection / active row'],
  ['Ctrl+Alt+D', 'Duplicate board as a variation row'],
  ['Alt+↑ / Alt+↓', 'Previous / next board'],
  ['Double-click text', 'Edit text'],
  ['Ctrl+B / I / U', 'Bold / italic / underline: the highlighted words while editing text, else the whole layer'],
  ['Ctrl+C / X / V / A / Z (editing text)', 'Copy, cut, paste, select all and undo inside the text'],
  ['Ctrl+A (in the Claude chat)', 'Select the whole conversation, to copy it'],
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
  ['Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y', 'Undo / redo'],
  ['Ctrl+S / Ctrl+Shift+S / Ctrl+O', 'Save / Save as / Open'],
  ['Ctrl+Shift+E', 'Export'],
  ['Ctrl+J', 'Show / hide the Claude panel'],
  ['Ctrl+K', 'Go to a project'],
  ['Ctrl+W, Ctrl+Tab, Ctrl+1–9', 'Close, next and jump to a project tab'],
  ['Esc', 'Deselect / exit crop or text'],
  ['?', 'This list'],
];

/** Read-only text where ⌘A means its words: the Claude transcript, layout checks and the like. */
const SCOPE = '[data-select-scope], .lint-list, .em-warnings, .send-detail';

function selectScope(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  const focused = a?.closest?.<HTMLElement>(SCOPE);
  if (focused) return focused;
  // Text highlighted with the mouse somewhere that doesn't take focus (a dialog's list, say).
  const sel = window.getSelection();
  const at = sel && !sel.isCollapsed ? sel.anchorNode : null;
  const el = at ? (at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement) : null;
  return el?.closest<HTMLElement>(SCOPE) ?? null;
}

/**
 * Select all, undo and redo, for the keys and for the macOS Edit menu. A focused field gets the
 * browser's own (inside a text layer that's just its words); read-only text marked as a scope gets
 * its words selected; otherwise they mean the canvas: every layer beside the selection (or on the
 * board), and the design's history. In a dialog or on the home screen they never touch the canvas.
 */
export function editCommand(cmd: 'undo' | 'redo' | 'selectAll') {
  const s = useStore.getState();
  const a = document.activeElement as HTMLElement | null;
  if (isTyping()) {
    if (a?.tagName !== 'SELECT') document.execCommand(cmd);
    return;
  }
  if (cmd === 'selectAll') {
    const scope = selectScope();
    if (scope) return void window.getSelection()?.selectAllChildren(scope);
  }
  if (s.editingTextId || s.modal || s.homeOpen || a?.closest?.('[aria-modal="true"]')) return;
  if (cmd === 'undo') return s.undo();
  if (cmd === 'redo') return s.redo();
  // In the Claude panel, select all is about its text, never the layers.
  if (a?.closest?.('.panel.chat')) return;
  // Select siblings of the current selection, else all top-level layers on the active board.
  window.getSelection()?.removeAllRanges();
  const p = s.selection[0] ? findParent(s.doc.nodes, s.selection[0]) : null;
  s.select((p ? p.children : s.doc.nodes).filter((n) => !n.locked && n.visible).map((n) => n.id));
}

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
    // While editing text on the canvas, app-level combos (tabs, switcher) stay out of the way.
    if (isElectron && !s.modal && !s.editingTextId) {
      if (mod && (k === 'k' || k === 't')) {
        e.preventDefault();
        openSwitcher();
        return;
      }
      if (mod && k === 'w' && !e.shiftKey) {
        e.preventDefault();
        const { active } = useWorkspace.getState();
        if (active && !s.homeOpen) void closeTab(active);
        return;
      }
      if (e.ctrlKey && k === 'tab') {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(k)) {
        const { tabs } = useWorkspace.getState();
        const t = k === '9' ? tabs[tabs.length - 1] : tabs[Number(k) - 1];
        if (t) {
          e.preventDefault();
          void switchTo(t);
        }
        return;
      }
    }
    if (mod && k === 'j' && !e.shiftKey && !e.altKey && isElectron && !s.modal) {
      e.preventDefault();
      toggleChat();
      return;
    }
    // Bold, italic and underline. While editing text, highlighted words are styled by the text
    // editor itself; what reaches here (nothing highlighted, or layers selected) styles whole layers.
    if (mod && !e.altKey && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u') && !s.modal && (s.editingTextId || !isTyping())) {
      const done = k === 'b' ? toggleBoldSelection() : toggleStyleSelection(k === 'i' ? 'italic' : 'underline');
      if (done) e.preventDefault();
      return;
    }
    // Select all, undo and redo belong to whatever has focus (see editCommand). Ctrl+Y is redo too.
    if (mod && !e.altKey && (k === 'a' || k === 'z' || (k === 'y' && !e.shiftKey))) {
      e.preventDefault();
      editCommand(k === 'a' ? 'selectAll' : k === 'y' || e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (isTyping() || s.editingTextId) return;
    if (s.modal || s.homeOpen) return;

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
      else if (s.linkEdit) s.set({ linkEdit: null });
      else if (s.tool !== 'move') s.setTool('move');
      else if (s.selection.length) {
        // Figma: Esc selects the parent.
        const p = findParent(s.doc.nodes, s.selection[0]);
        s.select(p ? [p.id] : []);
      } else if (s.linksMode) s.set({ linksMode: false });
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
    // Links mode: every link and picture on email boards, pinned on the canvas.
    if (!e.shiftKey && !e.altKey && !mod && k === 'l' && s.project.boards.some((b) => b.kind === 'email')) {
      s.set({ linksMode: !s.linksMode, linkEdit: s.linksMode ? null : s.linkEdit });
      return;
    }
    // Notes go to the Claude panel, which only the desktop app has.
    if (!e.shiftKey && !e.altKey && k === 'c' && isElectron) {
      s.setTool('comment');
      return;
    }
  };
  window.addEventListener('keydown', onKey);
  const offMenu = native?.onEditCommand?.(editCommand);
  return () => {
    window.removeEventListener('keydown', onKey);
    offMenu?.();
  };
}
