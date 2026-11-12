import { isTyping } from '../typing';
import { openSwitcher } from './Switcher';
import { useEffect, useState } from 'react';
import { useStore, boardFrames, BOARD_GAP, EMAIL_GAP, MOD } from '../store';
import { Tooltip } from '../ui/Tooltip';
import { Menu, type MenuItem } from '../ui/Menu';
import { ICON_DENSE, IconArrowUp, IconCarousel, IconCheck, IconClose, IconEmail, IconMore, IconPage, IconPlus } from '../ui/icons';
import { emailRootOf } from '../email/boards';
import type { Doc } from '../types';
import { isElectron } from '../platform';
import { askSaveToLibrary } from './LibraryDialogs';

// HTML chrome around every board on the canvas: a quiet header row (row letter, name, note,
// pick / reject, one actions menu) and, for carousels, slide numbers under the slides plus an
// "add slide" tab.

type Status = 'picked' | 'rejected';

/** Row letter shown in the header chip: A, B, … Z, AA, AB, … (by position, top row = A). */
export function rowLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : rowLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
}

/** Toggles a board's verdict (picking a rejected row un-rejects it, and vice versa). */
function toggleStatus(id: string, status: Status, announce = false) {
  const s = useStore.getState();
  const i = s.project.boards.findIndex((b) => b.id === id);
  const b = s.project.boards[i];
  if (!b) return;
  const next = b.status === status ? null : status;
  // A reason belongs to the verdict it explains.
  s.updateBoard(id, { status: next, statusReason: null });
  if (announce) {
    const L = rowLetter(i);
    s.toast(next === 'picked' ? `Picked row ${L}` : next === 'rejected' ? `Rejected row ${L}` : `Cleared ${status === 'picked' ? 'pick' : 'reject'} on row ${L}`, next === 'picked' ? 'success' : 'info');
  }
}

// One-tap reasons for a verdict. Claude reads them (get_feedback) and, when one keeps coming up,
// offers to make it a rule of the project's brand.
const REASONS: Record<Status, string[]> = {
  rejected: ['Too busy', 'Generic', 'Off-brand', 'Wrong tone', 'Hierarchy unclear', 'Type feels off', 'Weak crop'],
  picked: ['Strong idea', 'Love the type', 'Great crop', 'Right tone', 'Clear hierarchy', 'Feels like us'],
};

/** Moves a board to the top row in one undo step. Never deletes or reorders the others. */
function promote(id: string) {
  const s = useStore.getState();
  s.changeProject((p) => {
    const i = p.boards.findIndex((b) => b.id === id);
    if (i <= 0) return;
    const [b] = p.boards.splice(i, 1);
    p.boards.unshift(b);
  });
  s.setActiveBoard(id);
  requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
}

export default function SlideHeaders() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const frames = boardFrames(project);
  const multi = project.boards.length > 1;

  // Ctrl/Cmd+Enter = pick the active row, Ctrl/Cmd+Backspace = reject it (both toggle; never delete).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'Enter' && e.key !== 'Backspace') return;
      const s = useStore.getState();
      if (isTyping() || s.editingTextId || s.croppingId || s.modal) return;
      if (s.project.boards.length < 2) return;
      e.preventDefault();
      toggleStatus(s.project.activeBoardId, e.key === 'Enter' ? 'picked' : 'rejected', true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {project.boards.map((b, i) => (
        <BoardChrome
          key={b.id}
          board={b}
          index={i}
          count={project.boards.length}
          frame={frames.get(b.id)!}
          active={b.id === project.activeBoardId}
          multi={multi}
          view={view}
        />
      ))}
    </>
  );
}

function BoardChrome({
  board,
  index,
  count,
  frame,
  active,
  multi,
  view,
}: {
  board: Doc;
  index: number;
  count: number;
  frame: { x: number; y: number; w: number; h: number };
  active: boolean;
  multi: boolean;
  view: { zoom: number; panX: number; panY: number };
}) {
  const s = useStore.getState;
  const [editing, setEditing] = useState<null | 'name' | 'note' | 'reason'>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number }>(null);
  const [reasonMenu, setReasonMenu] = useState<null | { x: number; y: number }>(null);
  const z = view.zoom;
  const left = view.panX + frame.x * z;
  const top = view.panY + frame.y * z;
  const W = board.slideWidth;
  const isEmail = board.kind === 'email';
  const unit = board.kind === 'document' ? 'page' : 'slide';
  // Slide labels need vertical room; when zoomed far out with several rows, show only the board header.
  const slideLabels = !isEmail && (!multi || BOARD_GAP * z >= 64);
  // The button needs its own height plus the next row's header, or the two collide.
  const addSection = isEmail && !!emailRootOf(board) && (!multi || BOARD_GAP * z >= 96);
  const KindIcon = isEmail ? IconEmail : board.kind === 'document' ? IconPage : IconCarousel;
  const n = board.slides.length;
  const meta = isEmail ? `Email · ${W} wide` : board.kind === 'document' ? `Pages · ${n}` : `Carousel · ${n} slide${n === 1 ? '' : 's'}`;
  const letter = rowLetter(index);
  const status = board.status ?? null;

  const activate = () => s().setActiveBoard(board.id);
  const zoomTo = () => {
    activate();
    requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
  };
  const openMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
  };

  const commitText = (field: 'name' | 'note' | 'reason', value: string) => {
    const v = value.trim();
    if (field === 'reason') s().updateBoard(board.id, { statusReason: v || null });
    else if (field === 'name') s().updateBoard(board.id, { name: v || board.name });
    else if (v !== (board.note ?? '')) s().updateBoard(board.id, { note: v || undefined });
    setEditing(null);
  };
  const editKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') setEditing(null);
  };

  const reasonItems: MenuItem[] = status
    ? [
        ...REASONS[status].map((r) => ({ label: r, checked: board.statusReason === r, fn: () => s().updateBoard(board.id, { statusReason: r }) })),
        null,
        { label: 'In my own words…', fn: () => setEditing('reason') },
        ...(board.statusReason ? [{ label: 'Clear reason', fn: () => s().updateBoard(board.id, { statusReason: null }) }] : []),
      ]
    : [];

  const menuItems: MenuItem[] = [
    { label: 'Zoom to row', kbd: 'Shift+3', fn: zoomTo },
    ...(board.kind === 'carousel' ? [{ label: 'Preview', fn: () => (activate(), s().set({ modal: 'preview' })) }] : []),
    { label: 'Duplicate as variation', kbd: `${MOD}+Alt+D`, fn: () => s().duplicateBoard(board.id) },
    ...(isElectron ? [{ label: 'Copy to another project…', fn: () => openSwitcher(board.id) }] : []),
    null,
    { label: 'Rename', fn: () => setEditing('name') },
    { label: board.note ? 'Edit note' : 'Add note', fn: () => setEditing('note') },
    null,
    ...(multi
      ? [
          { label: 'Move to top', fn: () => promote(board.id), disabled: index === 0 },
          { label: 'Move up', fn: () => s().moveBoard(board.id, -1), disabled: index === 0 },
          { label: 'Move down', fn: () => s().moveBoard(board.id, 1), disabled: index === count - 1 },
          null,
        ]
      : []),
    { label: 'Export this row…', fn: () => (activate(), s().set({ modal: 'export' })) },
    ...(board.kind === 'email' && isElectron ? [{ label: 'Save as PDF…', fn: () => (activate(), s().set({ modal: 'pdf' })) }] : []),
    ...(isElectron
      ? [
          { label: 'Save as template…', fn: () => askSaveToLibrary({ kind: 'template', boardId: board.id, name: board.name }) },
          { label: 'Save as reference…', fn: () => askSaveToLibrary({ kind: 'reference', boardId: board.id, name: board.name }) },
        ]
      : []),
    {
      label: 'Copy row reference for Claude',
      fn: () => {
        void navigator.clipboard?.writeText(`row ${letter} "${board.name}" (boardId ${board.id})`);
        s().toast(`Copied a reference to row ${letter}`, 'success');
      },
    },
    ...(multi ? [null, { label: 'Delete row', fn: () => s().deleteBoard(board.id), danger: true }] : []),
  ];

  return (
    <>
      <div
        className={`board-header ${active ? 'active' : ''} ${multi ? '' : 'solo'} ${isEmail ? 'beside' : ''} ${isEmail && (frame.w + EMAIL_GAP) * z < 280 ? 'tight' : ''} ${status ?? ''}`}
        style={{ left, top: top - 32, width: isEmail ? (frame.w + EMAIL_GAP) * z - 16 : Math.max(frame.w * z, multi ? 360 : 240) }}
        onMouseDown={activate}
      >
        {multi ? (
          <Tooltip label={status === 'picked' ? `Row ${letter} · picked` : status === 'rejected' ? `Row ${letter} · rejected` : `Row ${letter}`}>
            <span className="board-letter" aria-label={`Row ${letter}`}>
              {status === 'picked' && <IconCheck size={11} weight="bold" />}
              {letter}
            </span>
          </Tooltip>
        ) : null}
        <span className="board-kind">
          <KindIcon size={ICON_DENSE} />
        </span>
        {editing === 'name' ? (
          <input className="board-name-input" autoFocus defaultValue={board.name} onBlur={(e) => commitText('name', e.target.value)} onKeyDown={editKeys} />
        ) : (
          <Tooltip label="Double-click to rename" delay={900}>
            <span className="board-name" onDoubleClick={() => setEditing('name')}>
              {board.name}
            </span>
          </Tooltip>
        )}
        <span className="board-meta">{meta}</span>
        {editing === 'note' ? (
          <input
            className="board-note-input"
            autoFocus
            placeholder="What is this row trying? (Enter to save)"
            defaultValue={board.note ?? ''}
            onBlur={(e) => commitText('note', e.target.value)}
            onKeyDown={editKeys}
          />
        ) : board.note ? (
          <Tooltip label={`${board.note}\n\nDouble-click to edit`} delay={400}>
            <span className="board-note" onDoubleClick={() => setEditing('note')}>
              {board.note}
            </span>
          </Tooltip>
        ) : (
          <span className="board-spacer" />
        )}
        {multi &&
          status &&
          (editing === 'reason' ? (
            <input className="board-note-input board-reason-input" autoFocus placeholder="Why? (Enter to save)" defaultValue={board.statusReason ?? ''} onBlur={(e) => commitText('reason', e.target.value)} onKeyDown={editKeys} />
          ) : (
            <Tooltip label={board.statusReason ? 'Change the reason' : `Tell Claude why you ${status === 'picked' ? 'picked' : 'rejected'} it`} disabled={!!reasonMenu}>
              <button
                className={`board-reason ${status} ${board.statusReason ? 'set' : ''} ${reasonMenu ? 'open' : ''}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setReasonMenu(reasonMenu ? null : { x: r.left, y: r.bottom + 4 });
                }}
              >
                {board.statusReason ?? 'Why?'}
              </button>
            </Tooltip>
          ))}
        {multi && status === 'picked' && index > 0 && (
          <Tooltip label="Move this row to the top. Other rows stay.">
            <button className="board-promote" onClick={() => promote(board.id)}>
              <IconArrowUp size={12} weight="bold" />
              Promote
            </button>
          </Tooltip>
        )}
        {multi && (
          <span className="board-status">
            <Tooltip label={status === 'picked' ? 'Unpick' : 'Pick this row'} shortcut={`${MOD}+Enter`}>
              <button className={`pick ${status === 'picked' ? 'on' : ''}`} aria-label="Pick" aria-pressed={status === 'picked'} onClick={() => toggleStatus(board.id, 'picked')}>
                <IconCheck size={ICON_DENSE} weight={status === 'picked' ? 'bold' : 'regular'} />
              </button>
            </Tooltip>
            <Tooltip label={status === 'rejected' ? 'Unreject' : 'Reject this row (keeps it)'} shortcut={`${MOD}+Backspace`}>
              <button className={`reject ${status === 'rejected' ? 'on' : ''}`} aria-label="Reject" aria-pressed={status === 'rejected'} onClick={() => toggleStatus(board.id, 'rejected')}>
                <IconClose size={ICON_DENSE} weight={status === 'rejected' ? 'bold' : 'regular'} />
              </button>
            </Tooltip>
          </span>
        )}
        <Tooltip label="Row actions" disabled={!!menu}>
          <button aria-label="Row actions" className={`board-more ${menu ? 'open' : ''}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => (activate(), openMenu(e))}>
            <IconMore size={ICON_DENSE} />
          </button>
        </Tooltip>
      </div>
      {menu && <Menu at={menu} items={menuItems} onClose={() => setMenu(null)} className="board-menu" />}
      {reasonMenu && <Menu at={reasonMenu} items={reasonItems} onClose={() => setReasonMenu(null)} className="board-menu" />}
      {/* Slide numbers sit under the slides; slide actions live in the canvas right-click menu. */}
      {slideLabels &&
        board.slides.map((sl, i) => (
          <div key={sl.id} className="slide-header" style={{ left: left + i * W * z, top: top + frame.h * z + 8, width: W * z }}>
            <Tooltip label={`Double-click to zoom to this ${unit}`} delay={900}>
              <span
                className="slide-label"
                onDoubleClick={() => {
                  activate();
                  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('spread:zoom-slide', { detail: i })));
                }}
              >
                {i + 1}
              </span>
            </Tooltip>
          </div>
        ))}
      {addSection && (
        <button
          className="add-section"
          style={{ left, top: top + frame.h * z + 12, width: frame.w * z }}
          onClick={() => {
            activate();
            window.dispatchEvent(new Event('spread:sections'));
          }}
        >
          <IconPlus size={ICON_DENSE} />
          {frame.w * z >= 120 && 'Add section'}
        </button>
      )}
      {!isEmail && (
        <Tooltip label={`Add ${unit}`} side="right">
          <button
            className="add-slide"
            aria-label={`Add ${unit}`}
            style={{ left: left + frame.w * z + 16, top, height: frame.h * z }}
            onClick={() => {
              activate();
              s().insertSlide(s().doc.slides.length - 1);
            }}
          >
            <IconPlus size={18} />
          </button>
        </Tooltip>
      )}
    </>
  );
}
