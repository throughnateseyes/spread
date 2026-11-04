import { useEffect, useState } from 'react';
import { native, setFolderPrompt } from '../platform';
import { Button, IconButton, Modal } from '../ui/controls';
import { ICON_DENSE, IconArrowLeft, IconFolder, IconPlus } from '../ui/icons';
import './io.css';

// Spread's own folder browser, used for "Save to → Change…". The macOS folder panel can fail to
// appear for this app (the export then hangs), so choosing a folder never depends on it.

type Listing = Awaited<ReturnType<NonNullable<typeof native>['listDir']>>;

/** Mount once (App). Answers chooseExportFolder() with a folder or null. */
export default function FolderPickerHost() {
  const [ask, setAsk] = useState<{ start: string | null; resolve: (dir: string | null) => void } | null>(null);
  useEffect(() => {
    setFolderPrompt((start) => new Promise((resolve) => setAsk({ start, resolve })));
    return () => setFolderPrompt(null);
  }, []);
  if (!ask) return null;
  const finish = (dir: string | null) => {
    ask.resolve(dir);
    setAsk(null);
  };
  return <FolderPicker start={ask.start} onDone={finish} />;
}

function FolderPicker({ start, onDone }: { start: string | null; onDone: (dir: string | null) => void }) {
  const [list, setList] = useState<Listing | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (dir: string | null) => {
    if (!native) return;
    setNaming(null);
    setError(null);
    setList(await native.listDir(dir));
  };
  useEffect(() => {
    void go(start);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes only this browser, not the export dialog underneath.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest?.('.fp-new')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onDone(null);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onDone]);

  const create = async () => {
    if (!native || !list || !naming?.trim()) return;
    try {
      await go(await native.makeDir({ dir: list.dir, name: naming }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const crumbs = list ? list.dir.split(/[\\/]/).filter(Boolean) : [];
  return (
    <Modal
      title="Choose a folder"
      onClose={() => onDone(null)}
      width={560}
      footer={
        <>
          <span className="muted ellipsis" title={list?.dir}>
            {list?.dir ?? 'Loading…'}
          </span>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button primary disabled={!list} onClick={() => list && onDone(list.dir)}>
            Use this folder
          </Button>
        </>
      }
    >
      <div className="fp">
        <ul className="fp-places">
          {list?.places.map((p) => (
            <li key={p.path}>
              <button className={list.dir === p.path ? 'on' : ''} onClick={() => go(p.path)}>
                {p.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="fp-main">
          <div className="fp-bar">
            <IconButton title="Up one folder" className="small" disabled={!list?.parent} onClick={() => go(list!.parent)}>
              <IconArrowLeft size={ICON_DENSE} />
            </IconButton>
            <span className="fp-crumbs ellipsis">{crumbs.slice(-3).join(' / ')}</span>
            <IconButton title="New folder" className="small" disabled={!list} onClick={() => setNaming('')}>
              <IconPlus size={ICON_DENSE} />
            </IconButton>
          </div>
          {naming !== null && (
            <div className="fp-new">
              <input
                autoFocus
                placeholder="New folder name"
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create();
                  if (e.key === 'Escape') {
                    // Handled here: the dialogs underneath skip a prevented Escape.
                    e.preventDefault();
                    setNaming(null);
                  }
                }}
              />
              <Button primary disabled={!naming.trim()} onClick={create}>
                Create
              </Button>
            </div>
          )}
          {(error || list?.error) && <div className="hint warn">{error || list?.error}</div>}
          <ul className="fp-list">
            {list?.entries.map((d) => (
              <li key={d.path}>
                <button onClick={() => go(d.path)}>
                  <IconFolder size={ICON_DENSE} /> <span className="ellipsis">{d.name}</span>
                </button>
              </li>
            ))}
            {list && !list.entries.length && !list.error && <li className="hint fp-empty">No folders inside. Use this one, or make a new folder.</li>}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
