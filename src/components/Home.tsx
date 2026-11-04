import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { isElectron, native, type ProjectRecord } from '../platform';
import { useStore } from '../store';
import { Menu, useMenuButton, type MenuItem } from '../ui/Menu';
import { IconFolderSimple, IconMore, IconPlus, IconSearch } from '../ui/icons';
import { KIND_ICON, NameInput, newProjectItems } from './TabBar';
import {
  createFolder,
  deleteFolder,
  duplicateProject,
  fileName,
  kindLabel,
  moveToFolder,
  newProjectOfKind,
  openInTab,
  removeFromHome,
  renameFolder,
  renameProject,
  trashProject,
  useWorkspace,
} from '../workspace';
import type { BoardKind } from '../types';
import './home.css';

const DRAG = 'text/spread-project';

function ago(ms?: number) {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'Edited just now';
  if (min < 60) return `Edited ${min}m ago`;
  if (min < 60 * 24) return `Edited ${Math.round(min / 60)}h ago`;
  if (min < 60 * 24 * 7) return `Edited ${Math.round(min / 1440)}d ago`;
  return `Edited ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

const urls = new Map<string, Promise<string | null>>();

function useThumb(p: ProjectRecord) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!p.thumbPath || !native) return;
    const key = `${p.thumbPath}|${p.thumbV ?? 0}`;
    if (!urls.has(key)) {
      urls.set(
        key,
        native.readFile(p.thumbPath).then(
          (f) => URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/jpeg' })),
          () => null,
        ),
      );
    }
    let live = true;
    void urls.get(key)!.then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [p.thumbPath, p.thumbV]);
  return url;
}

function Card({ p, onNewFolder }: { p: ProjectRecord; onNewFolder: (path: string) => void }) {
  const url = useThumb(p);
  const folders = useWorkspace((w) => w.folders);
  const open = useWorkspace((w) => w.tabs.includes(p.path));
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const name = fileName(p.path);
  const kind = p.kinds?.[0];
  const Icon = KIND_ICON[kind ?? 'carousel'];
  const items: MenuItem[] = [
    { label: 'Rename', disabled: p.missing, fn: () => setRenaming(true) },
    { label: 'Duplicate', disabled: p.missing, fn: () => void duplicateProject(p.path) },
    { label: 'Show in Finder', disabled: p.missing, fn: () => void native?.reveal(p.path) },
    null,
    ...folders.filter((f) => f.id !== p.folderId).map((f) => ({ label: `Move to ${f.name}`, fn: () => moveToFolder(p.path, f.id) })),
    { label: 'Move to new folder', fn: () => onNewFolder(p.path) },
    ...(p.folderId ? [{ label: 'Take out of folder', fn: () => moveToFolder(p.path, null) }] : []),
    null,
    { label: 'Remove from Home', fn: () => void removeFromHome(p.path) },
    { label: 'Move to Trash', danger: true, disabled: p.missing, fn: () => void trashProject(p.path) },
  ];
  const openIt = () => {
    if (p.missing) useStore.getState().toast(`${name} isn't at ${p.path} any more. Remove it from Home, or put the file back.`, 'error');
    else void openInTab(p.path);
  };
  return (
    <article
      className={`hp-card ${p.missing ? 'missing' : ''}`}
      draggable={!renaming}
      onDragStart={(e) => e.dataTransfer.setData(DRAG, p.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button className="hp-thumb" aria-label={`Open ${name}`} onClick={openIt}>
        {url ? <img src={url} alt="" draggable={false} /> : <Icon size={24} />}
      </button>
      <button
        className="hp-more"
        aria-label={`More for ${name}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((m) => (m ? null : { x: r.left, y: r.bottom + 4 }));
        }}
      >
        <IconMore size={16} />
      </button>
      <div className="hp-info">
        {renaming ? (
          <NameInput
            value={name}
            label="Project name"
            onDone={(n) => {
              setRenaming(false);
              if (n) void renameProject(p.path, n);
            }}
          />
        ) : (
          <strong title={name} onDoubleClick={() => setRenaming(true)}>
            {name}
          </strong>
        )}
        <span>{p.missing ? 'File not found' : [kindLabel(kind), open ? 'Open' : ago(p.updatedAt)].filter(Boolean).join(' · ')}</span>
      </div>
      {menu && <Menu at={menu} items={items} onClose={() => setMenu(null)} />}
    </article>
  );
}

function RailItem({ on, count, onClick, onDropProject, onMenu, children }: { on: boolean; count: number; onClick: () => void; onDropProject: (path: string) => void; onMenu?: (x: number, y: number) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <button
      className={`hp-rail-item ${on ? 'on' : ''} ${over ? 'over' : ''}`}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const path = e.dataTransfer.getData(DRAG);
        if (path) onDropProject(path);
      }}
    >
      {children}
      <small>{count || ''}</small>
    </button>
  );
}

type Filter = 'all' | BoardKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'carousel', label: 'Social' },
  { id: 'email', label: 'Email' },
  { id: 'document', label: 'Pages' },
];

/** Everything you've made. Covers the editor, which stays loaded underneath. */
export default function Home() {
  const { projects, folders, ready } = useWorkspace();
  const [folder, setFolder] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const moveNext = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const { at, close, triggerProps } = useMenuButton();
  const set = useStore((s) => s.set);

  const addFolder = (path?: string) => {
    moveNext.current = path ?? null;
    const id = createFolder('New folder');
    if (path) moveToFolder(path, id);
    setEditing(id);
  };

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return projects
      .filter((p) => (folder === null || p.folderId === folder) && (filter === 'all' || p.kinds?.includes(filter)) && words.every((w) => fileName(p.path).toLowerCase().includes(w)))
      .sort((a, b) => Math.max(b.openedAt, b.updatedAt ?? 0) - Math.max(a.openedAt, a.updatedAt ?? 0));
  }, [projects, folder, filter, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'f')) && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onFiles = async (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of [...e.dataTransfer.files]) if (f.name.toLowerCase().endsWith('.spread') && native) await openInTab(native.pathForFile(f));
  };

  const title = folder ? (folders.find((f) => f.id === folder)?.name ?? 'Folder') : 'All projects';
  const none = ready && !projects.length;
  return (
    <div className="home" onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()} onDrop={onFiles}>
      <nav className="hp-rail" aria-label="Folders">
        <RailItem on={folder === null} count={projects.length} onClick={() => setFolder(null)} onDropProject={(p) => moveToFolder(p, null)}>
          <span>All projects</span>
        </RailItem>
        <div className="hp-rail-head">
          <span>Folders</span>
          <button aria-label="New folder" onClick={() => addFolder()}>
            <IconPlus size={14} />
          </button>
        </div>
        {folders.map((f) =>
          editing === f.id ? (
            <div key={f.id} className="hp-rail-item editing">
              <IconFolderSimple size={16} />
              <NameInput
                value={f.name}
                label="Folder name"
                onDone={(n) => {
                  if (n) renameFolder(f.id, n);
                  setEditing(null);
                }}
              />
            </div>
          ) : (
            <RailItem
              key={f.id}
              on={folder === f.id}
              count={projects.filter((p) => p.folderId === f.id).length}
              onClick={() => setFolder(f.id)}
              onDropProject={(p) => moveToFolder(p, f.id)}
              onMenu={(x, y) => setFolderMenu({ id: f.id, x, y })}
            >
              <IconFolderSimple size={16} />
              <span>{f.name}</span>
            </RailItem>
          ),
        )}
        {!folders.length && <p className="hp-rail-hint">Group work by client, campaign or anything else.</p>}
        <div className="hp-rail-foot">
          {isElectron && (
            <>
              <button onClick={() => set({ modal: 'library' })}>Library</button>
              <button onClick={() => set({ modal: 'brands' })}>Brands</button>
            </>
          )}
        </div>
      </nav>

      <main className="hp-main">
        <header className="hp-head">
          <h1>{title}</h1>
          <label className="hp-search">
            <IconSearch size={14} />
            <input ref={search} value={q} placeholder="Search" spellCheck={false} aria-label="Search projects" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          </label>
          <button className="btn primary" {...triggerProps}>
            <IconPlus size={14} /> New project
          </button>
        </header>

        {none ? (
          <div className="hp-empty">
            <h2>Make your first project</h2>
            <div className="hp-starts">
              {(['carousel', 'email', 'document'] as const).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <button key={k} onClick={() => void newProjectOfKind(k)}>
                    <Icon size={24} />
                    {k === 'carousel' ? 'Social post' : kindLabel(k)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="hp-filters" role="tablist" aria-label="Project type">
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            {shown.length ? (
              <div className="hp-grid">
                {shown.map((p) => (
                  <Card key={p.path} p={p} onNewFolder={addFolder} />
                ))}
              </div>
            ) : (
              <p className="hp-none">{q ? `Nothing called "${q}".` : folder ? 'Drag projects here, or use a project’s menu.' : 'Nothing of this type yet.'}</p>
            )}
          </>
        )}
      </main>
      {at && <Menu at={at} items={newProjectItems()} onClose={close} />}
      {folderMenu && (
        <Menu
          at={folderMenu}
          onClose={() => setFolderMenu(null)}
          items={[
            { label: 'Rename', fn: () => setEditing(folderMenu.id) },
            {
              label: 'Delete folder',
              danger: true,
              fn: () => {
                if (folder === folderMenu.id) setFolder(null);
                deleteFolder(folderMenu.id);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
