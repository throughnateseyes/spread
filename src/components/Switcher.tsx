import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { copyBoardTo, fileName, kindLabel, switchTo, useWorkspace } from '../workspace';
import { useStore } from '../store';
import { KIND_ICON } from './TabBar';

// ⌘K: jump to any project by name. Also picks where a board goes when copying it to another project.

const useSwitcher = create<{ open: boolean; copyBoard: string | null }>(() => ({ open: false, copyBoard: null }));
export const openSwitcher = (copyBoard: string | null = null) => useSwitcher.setState({ open: true, copyBoard });
const closeSwitcher = () => useSwitcher.setState({ open: false, copyBoard: null });

export default function Switcher() {
  const { open, copyBoard } = useSwitcher();
  return open ? <Panel copyBoard={copyBoard} /> : null;
}

function Panel({ copyBoard }: { copyBoard: string | null }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const projects = useWorkspace((w) => w.projects);
  const tabs = useWorkspace((w) => w.tabs);
  const list = useRef<HTMLDivElement>(null);
  const current = useStore((s) => s.filePath);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (path: string, openedAt: number) => (tabs.includes(path) ? 1e15 : 0) + openedAt;
    return projects
      .filter((p) => !p.missing && !(copyBoard && p.path === current) && words.every((w) => fileName(p.path).toLowerCase().includes(w)))
      .sort((a, b) => rank(b.path, b.openedAt) - rank(a.path, a.openedAt))
      .slice(0, 30);
  }, [projects, tabs, q, copyBoard, current]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const pick = (path: string) => {
    closeSwitcher();
    if (copyBoard) void copyBoardTo(copyBoard, path);
    else void switchTo(path);
  };
  return (
    <div className="switcher-scrim" onMouseDown={closeSwitcher}>
      <div className="switcher" role="dialog" aria-label={copyBoard ? 'Copy board to a project' : 'Go to a project'} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          spellCheck={false}
          placeholder={copyBoard ? 'Copy this board to…' : 'Go to a project…'}
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
            if (e.key === 'Enter' && rows[at]) pick(rows[at].path);
          }}
        />
        <div className="switcher-list" ref={list}>
          {rows.map((p, i) => {
            const Icon = KIND_ICON[p.kinds?.[0] ?? 'carousel'];
            return (
              <button key={p.path} className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => pick(p.path)}>
                <Icon size={14} />
                <span>{fileName(p.path)}</span>
                <small>{tabs.includes(p.path) ? 'Open' : kindLabel(p.kinds?.[0])}</small>
              </button>
            );
          })}
          {!rows.length && <p>No projects match.</p>}
        </div>
      </div>
    </div>
  );
}
