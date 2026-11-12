import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { fileName, kindLabel, sendBoardFromMenu, switchTo, useWorkspace } from '../workspace';
import { useStore } from '../store';
import type { ProjectRecord } from '../platform';
import { IconPlus } from '../ui/icons';
import { KIND_ICON } from './TabBar';

// ⌘K: jump to any project by name. Also picks where a row goes when moving or copying it to
// another project (any project on Home, open or not, or a new one).

type Send = { boardId: string; move: boolean };
const useSwitcher = create<{ open: boolean; send: Send | null }>(() => ({ open: false, send: null }));
export const openSwitcher = (send: Send | null = null) => useSwitcher.setState({ open: true, send });
const closeSwitcher = () => useSwitcher.setState({ open: false, send: null });

export default function Switcher() {
  const { open, send } = useSwitcher();
  return open ? <Panel send={send} /> : null;
}

/** A project, or null for the "New project" row at the end of the Move to / Copy to list. */
type Row = ProjectRecord | null;

function Panel({ send }: { send: Send | null }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const projects = useWorkspace((w) => w.projects);
  const tabs = useWorkspace((w) => w.tabs);
  const list = useRef<HTMLDivElement>(null);
  const current = useStore((s) => s.filePath);
  const boardName = useStore((s) => (send ? s.project.boards.find((b) => b.id === send.boardId)?.name : undefined));
  const rows = useMemo<Row[]>(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (path: string, openedAt: number) => (tabs.includes(path) ? 1e15 : 0) + openedAt;
    const found = projects
      .filter((p) => !p.missing && !(send && p.path === current) && words.every((w) => fileName(p.path).toLowerCase().includes(w)))
      .sort((a, b) => rank(b.path, b.openedAt) - rank(a.path, a.openedAt))
      .slice(0, 30);
    return send ? [...found, null] : found;
  }, [projects, tabs, q, send, current]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const newName = q.trim() || boardName || 'Untitled';
  const pick = (row: Row) => {
    closeSwitcher();
    if (send) void sendBoardFromMenu(send.boardId, row?.path ?? null, send.move, row ? undefined : newName);
    else if (row) void switchTo(row.path);
  };
  const verb = send?.move ? 'Move' : 'Copy';
  return (
    <div className="switcher-scrim" onMouseDown={closeSwitcher}>
      <div className="switcher" role="dialog" aria-label={send ? `${verb} this row to a project` : 'Go to a project'} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          spellCheck={false}
          placeholder={send ? `${verb} "${boardName ?? 'this row'}" to…` : 'Go to a project…'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') closeSwitcher();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((i) => Math.min(i + 1, rows.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter' && rows[at]) pick(rows[at]);
          }}
        />
        <div className="switcher-list" ref={list}>
          {rows.map((row, i) => {
            if (!row) {
              return (
                <button key="new" className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => pick(row)}>
                  <IconPlus size={14} />
                  <span>New project “{newName}”</span>
                  <small>Starts with this row</small>
                </button>
              );
            }
            const p = row;
            const Icon = KIND_ICON[p.kinds?.[0] ?? 'carousel'];
            return (
              <button key={p.path} className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => pick(row)}>
                <Icon size={14} />
                <span>{fileName(p.path)}</span>
                <small>{tabs.includes(p.path) ? 'Open' : kindLabel(p.kinds?.[0])}</small>
              </button>
            );
          })}
          {!send && !rows.length && <p>No projects match.</p>}
        </div>
      </div>
    </div>
  );
}
