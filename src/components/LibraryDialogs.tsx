import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useBrands } from '../brand';
import { createFromTemplate, deleteLibraryItem, insertSavedSection, saveReference, saveTemplate, useLibrary, type ReferenceMeta, type Saved, type TemplateMeta } from '../library';
import { native } from '../platform';
import { useStore } from '../store';
import { Button, EmptyState, IconButton, Modal, Segmented } from '../ui/controls';
import { IconBookmark, IconFolder, IconImage, IconTrash } from '../ui/icons';
import './library.css';

// Saving to the design library (a board or email section as a template, a board as a reference)
// and the Library dialog that lists what's saved. See src/library.ts.

type Prompt = { kind: 'template' | 'section' | 'reference'; boardId: string; sectionId?: string; name: string };

export const useLibraryPrompt = create<{ prompt: Prompt | null }>(() => ({ prompt: null }));
export const askSaveToLibrary = (prompt: Prompt) => useLibraryPrompt.setState({ prompt });

const KIND_NAMES = { carousel: 'Carousel', email: 'Email', document: 'Pages' };
const TITLES = { template: 'Save as template', section: 'Save section as template', reference: 'Save as reference' };

export function SaveToLibraryDialog() {
  const prompt = useLibraryPrompt((s) => s.prompt);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(prompt?.name ?? '');
    setText('');
    setError(null);
  }, [prompt]);
  if (!prompt) return null;
  const close = () => useLibraryPrompt.setState({ prompt: null });
  const isRef = prompt.kind === 'reference';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isRef) await saveReference({ boardId: prompt.boardId, name, why: text });
      else await saveTemplate({ boardId: prompt.boardId, sectionId: prompt.sectionId, name, description: text });
      useStore.getState().toast(isRef ? `Saved “${name}” as a reference` : `Saved “${name}” to your templates`, 'success');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={TITLES[prompt.kind]}
      onClose={close}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={save} disabled={busy || !name.trim() || (isRef && !text.trim())}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <label className="lib-field">
        <span className="em-label">Name</span>
        <div className="field">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !isRef && name.trim() && void save()} />
        </div>
      </label>
      <label className="lib-field">
        <span className="em-label">{isRef ? 'What makes it good?' : 'Description (optional)'}</span>
        <textarea
          className="brands-text"
          rows={isRef ? 4 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            isRef
              ? 'e.g. Photo cover with the hook set low, calendar-style dates on grain paper, a dark finale with a soft CTA.'
              : prompt.kind === 'section'
                ? 'When to use this section'
                : 'When to start from this'
          }
        />
      </label>
      <p className="hint">
        {isRef
          ? 'Claude looks at your references before designing something similar, and follows what you say makes them work.'
          : prompt.kind === 'section'
            ? 'It will be in the Section menu of every email, and Claude can use it. Its photos and fonts are saved with it.'
            : 'It will be in New board for every project, and Claude can start from it. Its photos and fonts are saved with it.'}
      </p>
      {error && <div className="hint em-error">{error}</div>}
    </Modal>
  );
}

const thumbs = new Map<string, Promise<string | null>>();

/** A picture from the library folder, read through the desktop app. */
export function LibraryThumb({ path, className = '' }: { path?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !native) return;
    let live = true;
    if (!thumbs.has(path)) {
      thumbs.set(
        path,
        native
          .readFile(path)
          .then((f) => URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/jpeg' })))
          .catch(() => null),
      );
    }
    void thumbs.get(path)!.then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [path]);
  return <div className={`lib-thumb ${className}`}>{url ? <img src={url} alt="" /> : <IconImage size={16} />}</div>;
}

export function LibraryDialog() {
  const close = () => useStore.getState().set({ modal: null });
  const [tab, setTab] = useState<'templates' | 'references'>('templates');
  const { templates, references } = useLibrary();
  const onEmail = useStore((s) => s.doc.kind === 'email');
  const brands = useBrands((s) => s.brands);
  const brandName = (id: string | null) => (id ? (brands.find((b) => b.id === id)?.name ?? id) : 'No brand');
  const items: (Saved<TemplateMeta> | Saved<ReferenceMeta>)[] = tab === 'templates' ? templates : references;

  const use = async (id: string) => {
    const s = useStore.getState();
    try {
      await createFromTemplate(id, { photoIds: s.traySelection });
      close();
    } catch (e) {
      s.toast(`Couldn't use the template: ${(e as Error).message}`, 'error');
    }
  };

  const insert = async (id: string) => {
    const s = useStore.getState();
    try {
      await insertSavedSection(id, { afterSelection: true, photoIds: s.traySelection });
      close();
    } catch (e) {
      s.toast(`Couldn't insert the section: ${(e as Error).message}`, 'error');
    }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Move “${name}” to the Trash?`)) return;
    try {
      await deleteLibraryItem(tab, id);
    } catch (e) {
      useStore.getState().toast(`Couldn't delete: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <Modal title="Library" onClose={close} width={720}>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'templates', label: `Templates (${templates.length})` },
          { value: 'references', label: `References (${references.length})` },
        ]}
      />
      {items.length === 0 ? (
        <EmptyState icon={<IconBookmark size={28} weight="light" />} title={tab === 'templates' ? 'No templates yet' : 'No references yet'}>
          {tab === 'templates'
            ? 'Open a board’s ⋯ menu and choose Save as template. Email sections save from their right-click menu.'
            : 'When a design comes out right, open its ⋯ menu, choose Save as reference and say why it works.'}
        </EmptyState>
      ) : (
        <div className="lib-grid">
          {items.map((it) => {
            const t = tab === 'templates' ? (it as Saved<TemplateMeta>) : null;
            const r = tab === 'references' ? (it as Saved<ReferenceMeta>) : null;
            const thumb = t ? (t.thumb ? `${t.dir}/${t.thumb}` : undefined) : `${r!.dir}/${r!.images[0]}`;
            return (
              <div key={it.id} className="lib-card">
                {t?.scope === 'section' ? <div className="lib-thumb lib-section">Section</div> : <LibraryThumb path={thumb} />}
                <div className="lib-meta">
                  <strong>{it.name}</strong>
                  <span>
                    {KIND_NAMES[it.boardKind]} · {brandName(it.brandId)} · {new Date(it.createdAt).toLocaleDateString()}
                  </span>
                  {(t?.description || r?.why) && <p>{t?.description ?? r?.why}</p>}
                </div>
                <div className="lib-actions">
                  {native && (
                    <IconButton title="Show in Finder" onClick={() => void native!.reveal(it.dir)}>
                      <IconFolder size={16} />
                    </IconButton>
                  )}
                  <IconButton title="Move to Trash" onClick={() => void remove(it.id, it.name)}>
                    <IconTrash size={16} />
                  </IconButton>
                  {t?.scope === 'board' && <Button onClick={() => void use(t.id)}>Use</Button>}
                  {t?.scope === 'section' && (
                    <Button disabled={!onEmail} title={onEmail ? 'Add it to this email' : 'Select an email board first'} onClick={() => void insert(t.id)}>
                      Insert
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="hint lib-note">
        <IconBookmark size={12} /> Saved in your Spread folder (~/.spread), so every project can use them.
      </p>
    </Modal>
  );
}
