import { useEffect, useRef, useState, type DragEvent } from 'react';
import { native } from '../platform';
import { useStore } from '../store';
import { Menu, useMenuButton, type MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { IconCarousel, IconClose, IconEmail, IconHome, IconPage, IconPlus } from '../ui/icons';
import { closeTab, fileName, goHome, moveTab, newProjectOfKind, renameProject, switchTo, useWorkspace } from '../workspace';
import type { BoardKind } from '../types';
import './home.css';

export const KIND_ICON = { carousel: IconCarousel, email: IconEmail, document: IconPage } as const;

export const newProjectItems = (): MenuItem[] => [
  { label: 'Social post', fn: () => void newProjectOfKind('carousel') },
  { label: 'Email', fn: () => void newProjectOfKind('email') },
  { label: 'Pages', fn: () => void newProjectOfKind('document') },
];

/** An input that commits on Enter or blur and cancels on Escape. */
export function NameInput({ value, onDone, label }: { value: string; onDone: (name: string | null) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="name-input"
      aria-label={label}
      defaultValue={value}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value.trim() || null);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

function Tab({ path, index }: { path: string; index: number }) {
  const active = useWorkspace((w) => w.active === path);
  const atHome = useStore((s) => s.homeOpen);
  const kind = useWorkspace((w) => w.projects.find((p) => p.path === path)?.kinds?.[0]) as BoardKind | undefined;
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState(false);
  const Icon = KIND_ICON[kind ?? 'carousel'];
  const name = fileName(path);
  const onDrop = (e: DragEvent) => {
    const from = e.dataTransfer.getData('text/spread-tab');
    setOver(false);
    if (from && from !== path) moveTab(from, index);
  };
  const items: MenuItem[] = [
    { label: 'Rename', fn: () => setRenaming(true) },
    { label: 'Show in Finder', fn: () => void native?.reveal(path) },
    null,
    { label: 'Close', fn: () => void closeTab(path) },
    {
      label: 'Close other tabs',
      disabled: useWorkspace.getState().tabs.length < 2,
      fn: () => useWorkspace.getState().tabs.forEach((t) => t !== path && void closeTab(t)),
    },
  ];
  return (
    <div
      role="tab"
      aria-selected={active && !atHome}
      className={`ptab ${active && !atHome ? 'on' : ''} ${over ? 'over' : ''}`}
      draggable={!renaming}
      title={path}
      onDragStart={(e) => e.dataTransfer.setData('text/spread-tab', path)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/spread-tab')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => void switchTo(path)}
      onDoubleClick={() => setRenaming(true)}
      onAuxClick={(e) => e.button === 1 && void closeTab(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <Icon size={14} />
      {renaming ? (
        <NameInput
          value={name}
          label="Project name"
          onDone={(n) => {
            setRenaming(false);
            if (n) void renameProject(path, n);
          }}
        />
      ) : (
        <span className="ptab-name">{name}</span>
      )}
      <button
        className="ptab-close"
        aria-label={`Close ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(path);
        }}
      >
        <IconClose size={12} />
      </button>
      {menu && <Menu at={menu} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The strip above the toolbar: Home, one tab per open project, and New. */
export default function TabBar() {
  const tabs = useWorkspace((w) => w.tabs);
  const loading = useWorkspace((w) => w.loading);
  const atHome = useStore((s) => s.homeOpen);
  const { at, close, triggerProps } = useMenuButton();
  return (
    <div className="tabbar" role="tablist" aria-label="Open projects">
      <Tooltip label="Home">
        <button className={`ptab-home ${atHome ? 'on' : ''}`} aria-label="Home" onClick={() => void goHome()}>
          <IconHome size={16} />
        </button>
      </Tooltip>
      <div className="ptabs">
        {tabs.map((t, i) => (
          <Tab key={t} path={t} index={i} />
        ))}
      </div>
      <Tooltip label="New project" disabled={!!at}>
        <button className="ptab-new" aria-label="New project" {...triggerProps}>
          <IconPlus size={14} />
        </button>
      </Tooltip>
      {at && <Menu at={at} items={newProjectItems()} onClose={close} />}
      {loading && <div className="ptab-loading" role="progressbar" aria-label="Opening project" />}
    </div>
  );
}
