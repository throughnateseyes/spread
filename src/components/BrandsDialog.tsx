import { useEffect, useMemo, useState } from 'react';
import { deleteBrand, dotColors, normalizeBrand, saveBrand, setProjectBrand, slugify, useActiveBrand, useBrands, type LibraryBrand } from '../brand';
import { BUNDLED_FONTS, SYSTEM_FONTS, uploadedFonts } from '../fonts';
import { native } from '../platform';
import { useStore } from '../store';
import { uid } from '../tree';
import type { Brand, BrandRule } from '../types';
import { Button, IconButton, Modal, Segmented } from '../ui/controls';
import { ICON_DENSE, IconCheckCircle, IconClose, IconCopy, IconPlus, IconUpload } from '../ui/icons';
import './io.css';

// Brands: the library of brand kits on this computer and which one this project uses. A project
// uses one brand or none; switching changes what Claude designs with and what the layout check
// holds the design to, never the design itself. Kits are usually imported by Claude from a design
// system, DESIGN.md or brand CSS, then refined here; learned rules come from your verdicts.

const IMPORT_PROMPT = 'Import my brand into Spread from <a Claude design system, DESIGN.md, brand CSS or style guide>. Name it <brand name>.';

const list = (v: number[] | undefined) => (v ?? []).join(', ');
const parseList = (t: string) =>
  t
    .split(/[\s,/]+/)
    .map(Number)
    .filter((n) => n > 0);

export default function BrandsDialog() {
  const brands = useBrands((s) => s.brands);
  const active = useActiveBrand();
  const toast = useStore((s) => s.toast);
  const close = () => useStore.getState().set({ modal: null });
  const [selected, setSelected] = useState<string | null>(active?.id ?? brands[0]?.id ?? null);
  const current = brands.find((b) => b.id === selected) ?? null;
  const [draft, setDraft] = useState<Brand | null>(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(current), [current]);
  const plain = (b: Brand | LibraryBrand | null) => (b ? JSON.stringify({ ...b, dir: undefined, updatedAt: 0 }) : '');
  const dirty = !!draft && plain(draft) !== plain(current);

  const newBrand = () => {
    let name = 'New brand';
    for (let i = 2; brands.some((b) => b.id === slugify(name)); i++) name = `New brand ${i}`;
    const b = normalizeBrand({ name, id: slugify(name) });
    setSelected(null);
    setDraft(b);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      // A new kit takes its id (its folder name) from the name it's first saved with.
      let id = current?.id ?? slugify(draft.name);
      for (let i = 2; !current && brands.some((b) => b.id === id); i++) id = `${slugify(draft.name)}-${i}`;
      const saved = await saveBrand(normalizeBrand({ ...draft, id }, current));
      setSelected(saved.id);
      toast(`Saved ${saved.name}`, 'success');
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current || !window.confirm(`Move the ${current.name} brand kit to the Trash? Projects that use it keep their design.`)) return;
    await deleteBrand(current.id);
    setSelected(null);
    toast(`Moved ${current.name} to the Trash`);
  };

  const inUse = !!current && active?.id === current.id;

  return (
    <Modal
      title="Brands"
      onClose={close}
      width={760}
      footer={
        <>
          <span className="muted">
            {active ? `This project uses ${active.name}.` : 'This project has no brand: Claude designs without one.'}
          </span>
          {current && (
            <Button onClick={remove} className="danger-text">
              Delete
            </Button>
          )}
          <Button primary onClick={save} disabled={!draft || !dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="brands">
        <nav className="brands-list" aria-label="Brand kits">
          <button className={`brands-item ${active ? '' : 'on-project'}`} onClick={() => setProjectBrand(null)} title="Use no brand in this project">
            <span className="brands-dots empty" />
            <span className="brands-name">No brand</span>
            {!active && <IconCheckCircle size={ICON_DENSE} weight="fill" className="brands-check" />}
          </button>
          {brands.map((b) => (
            <button key={b.id} className={`brands-item ${b.id === selected ? 'sel' : ''}`} onClick={() => setSelected(b.id)}>
              <Dots brand={b} />
              <span className="brands-name">{b.name}</span>
              {active?.id === b.id && <IconCheckCircle size={ICON_DENSE} weight="fill" className="brands-check" />}
            </button>
          ))}
          {draft && !current && (
            <button className="brands-item sel">
              <Dots brand={draft} />
              <span className="brands-name">{draft.name}</span>
            </button>
          )}
          <button className="link-btn left brands-new" onClick={newBrand}>
            <IconPlus size={ICON_DENSE} /> New brand
          </button>
        </nav>

        <div className="brands-edit">
          {draft ? (
            <Editor draft={draft} setDraft={setDraft} inUse={inUse} saved={!!current} onUse={() => setProjectBrand(inUse ? null : draft.id)} />
          ) : (
            <Empty onNew={newBrand} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function Dots({ brand }: { brand: Brand }) {
  const cs = dotColors(brand, 4);
  return (
    <span className="brands-dots">
      {cs.length ? cs.map((c, i) => <i key={i} style={{ background: c.hex }} />) : <i className="none" />}
    </span>
  );
}

function Empty({ onNew }: { onNew: () => void }) {
  const toast = useStore((s) => s.toast);
  return (
    <div className="brands-empty">
      <b>Bring in a brand</b>
      <p className="hint">The quickest way is to ask Claude. It reads your design system, DESIGN.md or brand CSS and fills in the colors, fonts, type scale and rules. Projects that don’t pick a brand stay brand-free.</p>
      <ul className="claude-examples">
        <li>
          <span>{IMPORT_PROMPT}</span>
          <IconButton
            title="Copy"
            className="small"
            onClick={() => {
              void navigator.clipboard.writeText(IMPORT_PROMPT);
              toast('Copied: paste it into Claude', 'success');
            }}
          >
            <IconCopy size={ICON_DENSE} />
          </IconButton>
        </li>
      </ul>
      <Button onClick={onNew}>
        <IconPlus size={ICON_DENSE} /> Start one by hand
      </Button>
    </div>
  );
}

function Editor({ draft, setDraft, inUse, saved, onUse }: { draft: Brand; setDraft: (b: Brand) => void; inUse: boolean; saved: boolean; onUse: () => void }) {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const up = (patch: Partial<Brand>) => setDraft({ ...draft, ...patch });
  const fontOptions = useMemo(() => [...new Set([...BUNDLED_FONTS, ...uploadedFonts(doc), ...SYSTEM_FONTS].map((f) => f.family.replace(/ Variable$/, '')))], [doc]);
  const [ruleText, setRuleText] = useState('');
  const [ruleKind, setRuleKind] = useState<'do' | 'dont'>('do');
  const [scalePx, setScalePx] = useState(list(draft.typeScale?.px));
  const [scalePt, setScalePt] = useState(list(draft.typeScale?.pt));
  useEffect(() => {
    setScalePx(list(draft.typeScale?.px));
    setScalePt(list(draft.typeScale?.pt));
  }, [draft.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const addRule = () => {
    const text = ruleText.trim();
    if (!text) return;
    const rule: BrandRule = { id: uid(), kind: ruleKind, text, source: 'brand', addedAt: Date.now() };
    up({ rules: [...draft.rules, rule] });
    setRuleText('');
  };

  const uploadFonts = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.ttf,.otf,.woff,.woff2';
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length || !native) return;
      const fonts = [...draft.fonts];
      for (const f of files) {
        await native.brandWriteFont({ id: draft.id, file: f.name, data: new Uint8Array(await f.arrayBuffer()) });
        const family = f.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').trim();
        const entry = fonts.find((x) => x.family === family);
        if (entry) entry.files = [...new Set([...(entry.files ?? []), f.name])];
        else fonts.push({ family, files: [f.name] });
      }
      up({ fonts });
      toast(`Added ${files.length} font file${files.length > 1 ? 's' : ''}; save to keep them`, 'success');
    };
    input.click();
  };

  const pickDoc = async () => {
    const f = await native?.openFile({ filters: [{ name: 'Design doc', extensions: ['md', 'markdown', 'txt'] }] });
    if (f) up({ designDoc: f.path });
  };

  return (
    <div className="brands-form">
      <div className="brands-head">
        <input className="brands-title" value={draft.name} onChange={(e) => up({ name: e.target.value })} aria-label="Brand name" spellCheck={false} />
        {saved ? (
          <Button primary={!inUse} onClick={onUse} title={inUse ? 'Stop using this brand in this project' : 'Design this project in this brand'}>
            {inUse ? 'Used in this project ✓' : 'Use in this project'}
          </Button>
        ) : (
          <span className="hint">Save to use it</span>
        )}
      </div>
      <textarea className="brands-text" rows={2} placeholder="Who the brand is and how it should feel" value={draft.description ?? ''} onChange={(e) => up({ description: e.target.value || undefined })} />
      {draft.source && <div className="hint">Imported from {draft.source}</div>}

      <div className="io-label">Colors</div>
      <div className="brands-colors">
        {draft.colors.map((c, i) => (
          <div key={i} className="brands-color">
            <label className="brands-swatch" style={{ background: c.hex }}>
              <input type="color" value={c.hex} onChange={(e) => up({ colors: draft.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value.toUpperCase() } : x)) })} aria-label={`${c.name} color`} />
            </label>
            <input className="brands-in" value={c.name} onChange={(e) => up({ colors: draft.colors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Color name" />
            <input className="brands-in role" placeholder="role" value={c.role ?? ''} onChange={(e) => up({ colors: draft.colors.map((x, j) => (j === i ? { ...x, role: e.target.value || undefined } : x)) })} aria-label="Color role" />
            <span className="brands-hex">{c.hex}</span>
            <IconButton title="Remove" className="small" onClick={() => up({ colors: draft.colors.filter((_, j) => j !== i) })}>
              <IconClose size={12} />
            </IconButton>
          </div>
        ))}
        <button className="link-btn left" onClick={() => up({ colors: [...draft.colors, { name: 'Color', hex: '#1A1A1A' }] })}>
          <IconPlus size={ICON_DENSE} /> Add color
        </button>
      </div>

      <div className="io-label">Fonts</div>
      <datalist id="brand-font-options">
        {fontOptions.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="brands-colors">
        {draft.fonts.map((f, i) => (
          <div key={i} className="brands-color">
            <input className="brands-in wide" list="brand-font-options" value={f.family} onChange={(e) => up({ fonts: draft.fonts.map((x, j) => (j === i ? { ...x, family: e.target.value } : x)) })} aria-label="Font family" style={{ fontFamily: `'${f.family}', '${f.family} Variable'` }} />
            <input className="brands-in role" placeholder="role" value={f.role ?? ''} onChange={(e) => up({ fonts: draft.fonts.map((x, j) => (j === i ? { ...x, role: e.target.value || undefined } : x)) })} aria-label="Font role" />
            <span className="brands-hex">{f.files?.length ? `${f.files.length} file${f.files.length > 1 ? 's' : ''}` : ''}</span>
            <IconButton title="Remove" className="small" onClick={() => up({ fonts: draft.fonts.filter((_, j) => j !== i) })}>
              <IconClose size={12} />
            </IconButton>
          </div>
        ))}
        <div className="row">
          <button className="link-btn left" onClick={() => up({ fonts: [...draft.fonts, { family: 'Inter', role: 'text' }] })}>
            <IconPlus size={ICON_DENSE} /> Add font
          </button>
          <button className="link-btn left" onClick={uploadFonts} disabled={!saved} title={saved ? undefined : 'Save the brand first'}>
            <IconUpload size={ICON_DENSE} /> Upload font files
          </button>
        </div>
      </div>

      <div className="grid2">
        <label className="brands-field">
          <span className="io-label">Type scale, screen (px)</span>
          <input className="brands-in" placeholder="e.g. 24, 32, 48, 96" value={scalePx} onChange={(e) => setScalePx(e.target.value)} onBlur={() => up({ typeScale: { ...draft.typeScale, px: parseList(scalePx) } })} />
        </label>
        <label className="brands-field">
          <span className="io-label">Type scale, print (pt)</span>
          <input className="brands-in" placeholder="e.g. 9.5, 11, 14, 24" value={scalePt} onChange={(e) => setScalePt(e.target.value)} onBlur={() => up({ typeScale: { ...draft.typeScale, pt: parseList(scalePt) } })} />
        </label>
      </div>

      <label className="brands-field">
        <span className="io-label">Voice</span>
        <textarea className="brands-text" rows={2} placeholder="How the copy sounds" value={draft.voice ?? ''} onChange={(e) => up({ voice: e.target.value || undefined })} />
      </label>

      <div className="brands-field">
        <span className="io-label">Design doc</span>
        <div className="row">
          {draft.designDoc ? (
            <>
              <button className="link-btn left brands-doc" onClick={() => native?.reveal(draft.designDoc!)} title={draft.designDoc}>
                {draft.designDoc.split(/[\\/]/).pop()}
              </button>
              <IconButton title="Unlink" className="small" onClick={() => up({ designDoc: undefined })}>
                <IconClose size={12} />
              </IconButton>
            </>
          ) : (
            <button className="link-btn left" onClick={pickDoc}>
              <IconPlus size={ICON_DENSE} /> Link a DESIGN.md
            </button>
          )}
        </div>
        <span className="hint">The brand’s full guidelines. Claude reads it before designing in this brand.</span>
      </div>

      <div className="io-label">Rules</div>
      <ul className="brands-rules">
        {draft.rules.map((r) => (
          <li key={r.id} className={r.kind}>
            <span className="brands-rule-kind">{r.kind === 'do' ? 'Do' : 'Don’t'}</span>
            <span className="brands-rule-text">{r.text}</span>
            {r.source === 'learned' && <span className="brands-learned" title="Learned from your picks, rejects and edits">learned</span>}
            <IconButton title="Remove rule" className="small" onClick={() => up({ rules: draft.rules.filter((x) => x.id !== r.id) })}>
              <IconClose size={12} />
            </IconButton>
          </li>
        ))}
        {!draft.rules.length && <li className="hint">No rules yet. Add your own, or give a reason when you pick or reject a row and Claude will offer to make it a rule.</li>}
      </ul>
      <div className="row">
        <Segmented value={ruleKind} onChange={setRuleKind} options={[{ value: 'do', label: 'Do' }, { value: 'dont', label: 'Don’t' }]} />
        <div className="field">
          <input placeholder="e.g. One accent per slide, never on body copy" value={ruleText} onChange={(e) => setRuleText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRule()} />
        </div>
        <Button onClick={addRule} disabled={!ruleText.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

export type { LibraryBrand };
