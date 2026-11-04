import { useEffect, useState } from 'react';
import { fitVariations, useStore } from '../store';
import { makeDoc, makeDocumentBoard, uid } from '../tree';
import { FORMAT_PRESETS, PAGE_PRESETS, type BoardKind, type Tool } from '../types';
import { Button, Modal, NumberField, Segmented, Select } from '../ui/controls';
import { Tooltip } from '../ui/Tooltip';
import { IconCopy, IconEmail, IconPlus } from '../ui/icons';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES } from '../email/templates';
import { createEmailBoard, emailRootOf, insertEmailSection } from '../email/boards';
import { createFromTemplate, insertSavedSection, useLibrary } from '../library';
import { consumeStarter, keepStarter } from '../workspace';
import { LibraryThumb } from './LibraryDialogs';
import './library.css';
import './newboard.css';

// Adding boards: a floating dock at the bottom of the canvas (new carousel, new email,
// duplicate as variation, insert email section) and the "New board" dialog.

const START_KEYS: { tool: Tool; key: string; label: string }[] = [
  { tool: 'text', key: 'T', label: 'Text' },
  { tool: 'image', key: 'P', label: 'Photo' },
  { tool: 'frame', key: 'F', label: 'Frame' },
];

export function CanvasDock() {
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const [sections, setSections] = useState(false);
  const s = useStore.getState;
  const isEmail = doc.kind === 'email' && !!emailRootOf(doc);
  const templates = useLibrary((l) => l.templates);
  const brandId = useStore((st) => st.project.brandId ?? null);
  const savedSections = templates.filter((t) => t.scope === 'section' && t.boardKind === 'email' && (t.brandId === null || t.brandId === brandId));
  // The "Add section" buttons (under the email, in the panel) open this same menu.
  useEffect(() => {
    const open = () => setSections(true);
    const outside = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.dock-menu-wrap')) setSections(false);
    };
    window.addEventListener('spread:sections', open);
    window.addEventListener('mousedown', outside);
    return () => {
      window.removeEventListener('spread:sections', open);
      window.removeEventListener('mousedown', outside);
    };
  }, []);
  return (
    <div className="canvas-dock" onMouseDown={(e) => e.stopPropagation()}>
      <Tooltip label="New board: carousel, pages or email" side="top">
        <button onClick={() => s().set({ modal: 'new-board' })}>
          <IconPlus size={16} />
          <span>New</span>
        </button>
      </Tooltip>
      <Tooltip label="Duplicate as a variation row" shortcut="Ctrl+Alt+D" side="top">
        <button
          onClick={() => {
            s().duplicateBoard();
            fitVariations();
          }}
        >
          <IconCopy size={16} />
          <span>Variation</span>
        </button>
      </Tooltip>
      {/* A fresh board stays clean: the ways to start live here, and leave once there's content. */}
      {doc.kind !== 'email' && doc.nodes.length === 0 && (
        <>
          <span className="dock-sep" />
          {START_KEYS.map((k) => (
            <button
              key={k.key}
              className={`dock-key ${tool === k.tool ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} // keeps keyboard focus on the canvas
              onClick={() => s().setTool(k.tool)}
            >
              <span className="keycap">{k.key}</span>
              <span>{k.label}</span>
            </button>
          ))}
        </>
      )}
      {isEmail && (
        <div className="dock-menu-wrap">
          <Tooltip label="Insert an email section" side="top">
            <button className={sections ? 'on' : ''} onClick={() => setSections((v) => !v)}>
              <IconEmail size={16} />
              <span>Section</span>
            </button>
          </Tooltip>
          {sections && (
            <div className="dock-menu">
              {savedSections.length > 0 && <div className="dock-group">Your sections</div>}
              {savedSections.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setSections(false);
                    insertSavedSection(t.id, { afterSelection: true, photoIds: s().traySelection }).catch((e) => s().toast((e as Error).message, 'error'));
                  }}
                >
                  <strong>{t.name}</strong>
                  {t.description && <span>{t.description}</span>}
                </button>
              ))}
              {savedSections.length > 0 && <div className="dock-group">Built in</div>}
              {EMAIL_SECTIONS.map((sec) => (
                <button
                  key={sec.id}
                  onClick={() => {
                    insertEmailSection(sec.id, undefined, undefined, true);
                    setSections(false);
                  }}
                >
                  <strong>{sec.name}</strong>
                  <span>{sec.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const KINDS: { id: BoardKind; name: string; line: string }[] = [
  { id: 'carousel', name: 'Carousel', line: 'Slides side by side. Anything can run across the seams.' },
  { id: 'email', name: 'Email', line: '600 wide. Grows taller as you add sections.' },
  { id: 'document', name: 'Pages', line: 'Fixed sizes for print and screen. Exports to PDF.' },
];

/** How each kind of board is shaped: the difference you pick between. */
function KindArt({ kind }: { kind: BoardKind }) {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 };
  const block = { fill: 'currentColor', opacity: 0.35 };
  return (
    <svg className="nb-art" viewBox="0 0 160 64" preserveAspectRatio="xMinYMid meet" aria-hidden>
      {kind === 'carousel' && (
        <>
          <rect x="1" y="8" width="144" height="48" rx="2" {...line} />
          <path d="M49 8v48M97 8v48" {...line} strokeDasharray="3 3" />
          <rect x="29" y="20" width="88" height="24" rx="1" {...block} />
        </>
      )}
      {kind === 'email' && (
        <>
          <path d="M1 64V3a2 2 0 0 1 2-2h60a2 2 0 0 1 2 2v61" {...line} />
          <rect x="9" y="9" width="48" height="20" rx="1" {...block} />
          <rect x="9" y="35" width="48" height="4" rx="1" {...block} />
          <rect x="9" y="43" width="32" height="4" rx="1" {...block} />
          <rect x="9" y="55" width="22" height="9" rx="1" {...block} />
        </>
      )}
      {kind === 'document' && (
        <>
          <rect x="1" y="4" width="44" height="56" rx="2" {...line} />
          <rect x="57" y="4" width="44" height="56" rx="2" {...line} />
          <rect x="9" y="12" width="28" height="4" rx="1" {...block} />
          <rect x="9" y="20" width="20" height="4" rx="1" {...block} />
          <rect x="65" y="12" width="28" height="24" rx="1" {...block} />
        </>
      )}
    </svg>
  );
}

export function NewBoardDialog() {
  const close = () => {
    keepStarter();
    useStore.getState().set({ modal: null });
  };
  // Starts on the kind you're working in: the next email from an email, the next carousel from a carousel.
  const [kind, setKind] = useState<BoardKind>(() => useStore.getState().doc.kind ?? 'carousel');
  const [page, setPage] = useState(PAGE_PRESETS[0].id);
  const [landscape, setLandscape] = useState(false);
  const [pages, setPages] = useState(1);
  const [preset, setPreset] = useState(FORMAT_PRESETS[0].id);
  const [slides, setSlides] = useState(5);
  const [template, setTemplate] = useState(EMAIL_TEMPLATES[0].id);
  const traySel = useStore((s) => s.traySelection.length);
  const brandId = useStore((s) => s.project.brandId ?? null);
  const [saved, setSaved] = useState<string | null>(null);
  const yours = useLibrary((l) => l.templates).filter((t) => t.scope === 'board' && t.boardKind === kind && (t.brandId === null || t.brandId === brandId));
  const pickKind = (k: typeof kind) => {
    setKind(k);
    setSaved(null);
  };

  const create = (savedId = saved) => {
    const s = useStore.getState();
    if (savedId) {
      createFromTemplate(savedId, { photoIds: s.traySelection })
        .then(() => {
          consumeStarter();
          close();
        })
        .catch((e) => s.toast(`Couldn't use the template: ${(e as Error).message}`, 'error'));
      return;
    }
    if (kind === 'email') createEmailBoard(template);
    else if (kind === 'document') {
      const p = PAGE_PRESETS.find((f) => f.id === page)!;
      const [w, h] = landscape ? [p.h, p.w] : [p.w, p.h];
      const b = makeDocumentBoard({ name: p.label, w, h, units: p.group === 'Print' ? 'pt' : 'px', pages });
      s.addBoard(b, s.project.activeBoardId);
      requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
    } else {
      const p = FORMAT_PRESETS.find((f) => f.id === preset)!;
      const b = makeDoc();
      b.slideWidth = p.w;
      b.slideHeight = p.h;
      b.slides = Array.from({ length: slides }, () => ({ id: uid(), background: null }));
      s.addBoard(b, s.project.activeBoardId);
      requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
    }
    consumeStarter();
    close();
  };

  return (
    <Modal
      title="New board"
      onClose={close}
      width={640}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={() => create()}>
            Create {kind === 'email' ? 'email' : kind === 'document' ? 'pages' : 'carousel'}
          </Button>
        </>
      }
    >
      <div className="nb-kinds" role="radiogroup" aria-label="Board type">
        {KINDS.map((k) => (
          <button key={k.id} role="radio" aria-checked={kind === k.id} className={`nb-kind ${kind === k.id ? 'on' : ''}`} onClick={() => pickKind(k.id)}>
            <KindArt kind={k.id} />
            <strong>{k.name}</strong>
            <span>{k.line}</span>
          </button>
        ))}
      </div>
      {yours.length > 0 && (
        <>
          <div className="em-label nb-group">Your templates</div>
          <div className="nb-templates">
            {yours.map((t) => (
              <button key={t.id} className={`nb-card ${saved === t.id ? 'on' : ''}`} onClick={() => setSaved(saved === t.id ? null : t.id)} onDoubleClick={() => create(t.id)}>
                <LibraryThumb path={t.thumb ? `${t.dir}/${t.thumb}` : undefined} />
                <strong>{t.name}</strong>
                {t.description && <span>{t.description}</span>}
              </button>
            ))}
          </div>
          {!saved && kind !== 'email' && <div className="em-label nb-group">Or start fresh</div>}
          {saved && (
            <p className="hint">
              Starts from your template{traySel ? `, with your ${traySel} selected photo${traySel > 1 ? 's' : ''} swapped in` : ' with its own photos (select photos in the tray to swap them in)'}.
            </p>
          )}
        </>
      )}
      {kind === 'document' && !saved && (
        <>
          <div className="grid2">
            <Select
              value={page}
              onChange={setPage}
              options={PAGE_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.size}` }))}
            />
            <NumberField label="Pages" value={pages} min={1} max={40} precision={0} onChange={(v) => setPages(Math.round(v))} />
          </div>
          <Segmented
            value={landscape ? 'landscape' : 'portrait'}
            onChange={(v) => setLandscape(v === 'landscape')}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
          <p className="hint">Any medium: resumes, flyers, posters, one-pagers, decks, banners. Print sizes are in points and export to PDF with real text; screen sizes are in px.</p>
        </>
      )}
      {kind === 'document' || (saved && kind !== 'email') ? null : kind === 'carousel' ? (
        <div className="grid2">
          <Select value={preset} onChange={setPreset} options={FORMAT_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.w}×${p.h}` }))} />
          <NumberField label="Slides" value={slides} min={1} max={20} precision={0} onChange={(v) => setSlides(Math.round(v))} />
        </div>
      ) : (
        <>
          <div className="nb-templates">
            {yours.length > 0 && <div className="em-label nb-group" style={{ gridColumn: '1 / -1' }}>Built in</div>}
            {[...EMAIL_TEMPLATES, { id: 'blank', name: 'Blank', description: 'An empty 600 wide column. Build it up with Add section.' }].map((t) => (
              <button key={t.id} className={`nb-card ${!saved && template === t.id ? 'on' : ''}`} onClick={() => (setTemplate(t.id), setSaved(null))} onDoubleClick={() => create(null)}>
                <strong>{t.name}</strong>
                <span>{t.description}</span>
              </button>
            ))}
          </div>
          <p className="hint">
            {traySel ? `Uses your ${traySel} selected photo${traySel > 1 ? 's' : ''}.` : 'Photos fill in from the tray, in order.'} {'{{TOKENS}}'} mark the facts to replace before sending.
          </p>
        </>
      )}
    </Modal>
  );
}
