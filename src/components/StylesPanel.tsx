import { useMemo, useState } from 'react';
import { useActiveBrand, resolveFamily } from '../brand';
import { BUNDLED_FONTS, SYSTEM_FONTS, WEIGHTS, fontWeights, nearestWeight, uploadedFonts } from '../fonts';
import { useStore } from '../store';
import { STYLE_LABEL, addSpace, addTextStyle, applyStyle, freeName, linkMatches, linkSpace, slotValue, styleDiffs, styleUses, styleValues, tokenAt, unlinkedMatches, unstyledGroups, type UnstyledGroup } from '../tokens';
import { findNode, makeText } from '../tree';
import type { FrameNode, Project, SceneNode, SpaceSlot, SpaceToken, TextNode, TextStyle } from '../types';
import { Button, IconButton, Modal, NumberField, Section, Select } from '../ui/controls';
import { IconMinus } from '../ui/icons';
import './panels.css';

const NEW = '__new';
const MANAGE = '__manage';
const NONE = '__none';
const MIXED = '__mixed';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const openStyles = () => useStore.getState().set({ modal: 'styles' });

/** A one-line name field that replaces a dropdown while something new gets named. */
function NameField({ placeholder, onDone }: { placeholder: string; onDone: (name: string | null) => void }) {
  return (
    <input
      className="token-name"
      autoFocus
      placeholder={placeholder}
      aria-label={placeholder}
      spellCheck={false}
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = '';
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** The style picker at the top of the Text section. */
export function TextStyleField({ sel }: { sel: TextNode[] }) {
  const project = useStore((s) => s.project);
  const [naming, setNaming] = useState(false);
  const styles = project.textStyles ?? [];
  const ids = new Set(sel.map((n) => (styles.some((s) => s.id === n.textStyle) ? n.textStyle! : NONE)));
  const value = ids.size > 1 ? MIXED : [...ids][0];
  const style = styles.find((s) => s.id === value);
  const diffs = style ? [...new Set(sel.flatMap((n) => styleDiffs(n, style)))] : [];
  const more = useMemo(() => (style ? unlinkedMatches(project, style).length : 0), [project, style]);
  const layerIds = sel.map((n) => n.id);
  const updateNodes = useStore((s) => s.updateNodes);

  const apply = (s: TextStyle) => updateNodes(layerIds, (n) => n.type === 'text' && applyStyle(n, s));
  const create = (name: string | null) => {
    setNaming(false);
    if (!name) return;
    useStore.getState().changeProject((p) => {
      const s = addTextStyle(p, name, styleValues(sel[0]));
      const board = p.boards.find((b) => b.id === p.activeBoardId)!;
      for (const id of layerIds) {
        const n = findNode(board.nodes, id);
        if (n?.type === 'text') applyStyle(n, s);
      }
    });
  };
  const pick = (v: string) => {
    if (v === NEW) setNaming(true);
    else if (v === MANAGE) openStyles();
    else if (v === NONE) updateNodes(layerIds, (n) => void (n.type === 'text' && delete n.textStyle));
    else if (v !== MIXED) apply(styles.find((s) => s.id === v)!);
  };
  const updateStyle = () =>
    useStore.getState().changeProject((p) => {
      const s = p.textStyles?.find((x) => x.id === style!.id);
      if (s) Object.assign(s, styleValues(sel[0]));
    });
  const linkOthers = () =>
    useStore.getState().changeProject((p) => {
      const s = p.textStyles?.find((x) => x.id === style!.id);
      if (s) linkMatches(p, s);
    });

  if (naming) return <NameField placeholder="Style name, like Body" onDone={create} />;
  return (
    <>
      <Select
        title="Text style"
        value={value}
        onChange={pick}
        options={[
          ...(value === MIXED ? [{ value: MIXED, label: 'Mixed styles' }] : []),
          { value: NONE, label: 'No style' },
          ...styles.map((s) => ({ value: s.id, label: s.name })),
          { value: NEW, label: 'New style from this text…' },
          { value: MANAGE, label: 'Manage styles…' },
        ]}
      />
      {style && diffs.length > 0 && (
        <div className="token-note">
          <span>Differs from {style.name}: {diffs.map((k) => STYLE_LABEL[k]).join(', ')}</span>
          <div className="token-actions">
            <Button onClick={() => apply(style)} title={`Set this text back to ${style.name}`}>
              Reset
            </Button>
            <Button onClick={updateStyle} title={`Change ${style.name} to match, along with the layers that follow it`}>
              Update style
            </Button>
          </div>
        </div>
      )}
      {style && more > 0 && (
        <Button className="block" onClick={linkOthers} title={`Text that already looks like ${style.name} will follow it from now on`}>
          Link {plural(more, 'matching layer')}
        </Button>
      )}
    </>
  );
}

const SPACE_ROWS: { label: string; slots: SpaceSlot[] }[] = [
  { label: 'Gap', slots: ['gap'] },
  { label: 'Padding X', slots: ['l', 'r'] },
  { label: 'Padding Y', slots: ['t', 'b'] },
];

function SpaceRow({ label, slots, sel, fr, tokens }: { label: string; slots: SpaceSlot[]; sel: FrameNode[]; fr: (fn: (n: FrameNode) => void, key?: string) => void; tokens: SpaceToken[] }) {
  const [naming, setNaming] = useState(false);
  const at = sel.flatMap((f) => slots.map((s) => tokenAt(f, s, tokens)?.id ?? NONE));
  const value = new Set(at).size === 1 ? at[0] : NONE;
  const current = slotValue(sel[0], slots[0]);
  const link = (t: SpaceToken | null) =>
    fr((n) => {
      for (const s of slots) linkSpace(n, s, t);
      if (t && slots[0] === 'gap' && n.justify === 'between') n.justify = 'start';
    });
  const create = (name: string | null) => {
    setNaming(false);
    if (!name) return;
    useStore.getState().changeProject((p) => {
      const t = addSpace(p, name, current);
      const board = p.boards.find((b) => b.id === p.activeBoardId)!;
      for (const f of sel) {
        const n = findNode(board.nodes, f.id);
        if (n?.type === 'frame') for (const s of slots) linkSpace(n, s, t);
      }
    });
  };
  const pick = (v: string) => {
    if (v === NEW) setNaming(true);
    else if (v === MANAGE) openStyles();
    else link(tokens.find((t) => t.id === v) ?? null);
  };
  return (
    <div className="token-row">
      <span className="token-label">{label}</span>
      {naming ? (
        <NameField placeholder="Token name" onDone={create} />
      ) : (
        <Select
          title={`${label} token`}
          value={value}
          onChange={pick}
          options={[
            { value: NONE, label: 'Custom' },
            ...tokens.map((t) => ({ value: t.id, label: `${t.name} · ${t.value}` })),
            { value: NEW, label: `Save ${current} as a token…` },
            { value: MANAGE, label: 'Manage tokens…' },
          ]}
        />
      )}
    </div>
  );
}

/** Spacing tokens for an auto layout frame. Typing a number in the fields above goes back to Custom. */
export function SpaceFields({ sel, fr }: { sel: FrameNode[]; fr: (fn: (n: FrameNode) => void, key?: string) => void }) {
  const tokens = useStore((s) => s.project.spacing) ?? [];
  return (
    <div className="token-rows">
      {SPACE_ROWS.map((r) => (
        <SpaceRow key={r.label} {...r} sel={sel} fr={fr} tokens={tokens} />
      ))}
    </div>
  );
}

/** The Styles entry on the document panel, for when nothing is selected. */
export function StylesSection() {
  const texts = useStore((s) => s.project.textStyles?.length ?? 0);
  const spaces = useStore((s) => s.project.spacing?.length ?? 0);
  return (
    <Section title="Styles">
      {(texts > 0 || spaces > 0) && <p className="link-empty">{plural(texts, 'text style')}, {plural(spaces, 'spacing token')}</p>}
      <Button className="block" onClick={openStyles} title="Named type and spacing shared by every board in this project">
        Manage styles
      </Button>
    </Section>
  );
}

// ---------- the dialog ----------

const edit = (fn: (p: Project) => void, key?: string) => useStore.getState().changeProject(fn, key);

function rename<T extends { id: string; name: string }>(list: T[] | undefined, id: string, name: string) {
  const item = list?.find((x) => x.id === id);
  if (!item || !name.trim() || name.trim() === item.name) return;
  item.name = freeName(list!.filter((x) => x.id !== id), name);
}

function StyleRow({ s, uses, families }: { s: TextStyle; uses: number; families: { value: string; label: string; group: string }[] }) {
  const doc = useStore((st) => st.doc);
  const patch = (fn: (x: TextStyle) => void, key?: string) =>
    edit((p) => {
      const x = p.textStyles?.find((y) => y.id === s.id);
      if (x) fn(x);
    }, key);
  const available = fontWeights(s.fontFamily, doc);
  const weights = WEIGHTS.filter((w) => !available || available.includes(w.value) || w.value === s.fontWeight);
  const options = families.some((f) => f.value === s.fontFamily) ? families : [{ value: s.fontFamily, label: s.fontFamily, group: 'Current' }, ...families];
  return (
    <tr>
      <td>
        <input key={s.name} className="token-cell" defaultValue={s.name} aria-label="Style name" spellCheck={false} onBlur={(e) => edit((p) => rename(p.textStyles, s.id, e.target.value))} />
      </td>
      <td>
        <Select
          title="Font"
          value={s.fontFamily}
          options={options}
          onChange={(f) =>
            patch((x) => {
              x.fontFamily = f;
              x.fontWeight = nearestWeight(fontWeights(f, doc), x.fontWeight);
            })
          }
        />
      </td>
      <td>
        <Select title="Weight" value={s.fontWeight} options={weights} onChange={(w) => patch((x) => void (x.fontWeight = w))} />
      </td>
      <td>
        <NumberField label="" title="Size" value={s.fontSize} min={1} precision={1} onChange={(v, k) => patch((x) => void (x.fontSize = v), k ?? `style-size:${s.id}`)} />
      </td>
      <td>
        <NumberField label="" title="Line height" value={Math.round(s.lineHeight * 100)} suffix="%" min={30} precision={0} onChange={(v, k) => patch((x) => void (x.lineHeight = v / 100), k ?? `style-lh:${s.id}`)} />
      </td>
      <td>
        <NumberField label="" title="Letter spacing" value={s.letterSpacing} suffix="%" step={0.5} precision={1} onChange={(v, k) => patch((x) => void (x.letterSpacing = v), k ?? `style-ls:${s.id}`)} />
      </td>
      <td>
        <IconButton className="small" title="Uppercase" active={s.uppercase} onClick={() => patch((x) => void (x.uppercase = !x.uppercase))}>
          AA
        </IconButton>
      </td>
      <td className="token-uses">{uses}</td>
      <td>
        <IconButton className="small" title="Delete style. Its layers keep how they look." onClick={() => edit((p) => void (p.textStyles = p.textStyles?.filter((x) => x.id !== s.id)))}>
          <IconMinus size={14} />
        </IconButton>
      </td>
    </tr>
  );
}

function UnstyledRow({ g }: { g: UnstyledGroup }) {
  const [name, setName] = useState('');
  const make = () => {
    if (!name.trim()) return;
    edit((p) => {
      const { layers: _l, sample: _s, ...values } = g;
      linkMatches(p, addTextStyle(p, name, values));
    });
  };
  return (
    <tr>
      <td className="token-sample" title={g.sample}>
        {g.sample || 'Empty text'}
      </td>
      <td className="token-look">
        {g.fontFamily.replace(/ Variable$/, '')} {g.fontWeight} · {g.fontSize}
        {g.uppercase ? ' · caps' : ''}
      </td>
      <td className="token-uses">{g.layers}</td>
      <td>
        <input className="token-cell" value={name} placeholder="Name it" aria-label="Style name" spellCheck={false} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && make()} />
      </td>
      <td>
        <Button onClick={make} disabled={!name.trim()}>
          Make style
        </Button>
      </td>
    </tr>
  );
}

export default function StylesDialog() {
  const project = useStore((s) => s.project);
  const doc = useStore((s) => s.doc);
  const close = () => useStore.getState().set({ modal: null });
  const brand = useActiveBrand();
  const styles = project.textStyles ?? [];
  const spacing = project.spacing ?? [];
  const uses = useMemo(() => styleUses(project), [project]);
  const groups = useMemo(() => unstyledGroups(project), [project]);
  const families = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string; group: string }[] = [];
    const add = (list: { family: string; label?: string }[], group: string) =>
      list.forEach((f) => {
        if (seen.has(f.family)) return;
        seen.add(f.family);
        out.push({ value: f.family, label: f.label ?? f.family, group });
      });
    if (brand) add(brand.fonts.map((f) => ({ family: resolveFamily(f.family) })), brand.name);
    add(BUNDLED_FONTS, 'Bundled');
    add(uploadedFonts(doc), 'Uploaded');
    add(SYSTEM_FONTS, 'System');
    return out;
  }, [brand, doc.assets]);

  const addStyle = () => {
    const t = makeText(0, 0);
    edit((p) => void addTextStyle(p, 'New style', { ...styleValues(t), fontWeight: 400, fontSize: doc.kind === 'carousel' ? 40 : 16 }));
  };

  return (
    <Modal
      title="Styles"
      width={860}
      onClose={close}
      footer={
        <Button primary onClick={close}>
          Done
        </Button>
      }
    >
      <p className="repeat-hint">Shared by every board in this project. A change here reaches every layer that follows the style, except values set by hand on a layer.</p>
      <div className="token-head">
        <h3>Text styles</h3>
        <Button onClick={addStyle}>Add style</Button>
      </div>
      {styles.length > 0 ? (
        <table className="token-table token-styles">
          <thead>
            <tr>
              <th>Name</th>
              <th>Font</th>
              <th>Weight</th>
              <th>Size</th>
              <th>Line</th>
              <th>Letter</th>
              <th />
              <th className="token-uses">Layers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {styles.map((s) => (
              <StyleRow key={s.id} s={s} uses={uses.get(s.id) ?? 0} families={families} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="link-empty">No text styles yet. Add one here, name a look from the list below, or pick New style from this text on any text layer.</p>
      )}
      {groups.length > 0 && (
        <>
          <div className="token-head">
            <h3>Text without a style</h3>
          </div>
          <div className="token-scroll">
            <table className="token-table">
              <tbody>
                {groups.map((g) => (
                  <UnstyledRow key={JSON.stringify([g.fontFamily, g.fontWeight, g.italic, g.fontSize, g.lineHeight, g.letterSpacing, g.uppercase])} g={g} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="token-head">
        <h3>Spacing tokens</h3>
        <Button onClick={() => edit((p) => void addSpace(p, 'New spacing', 16))}>Add token</Button>
      </div>
      {spacing.length > 0 ? (
        <table className="token-table token-narrow">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th className="token-uses">Frames</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {spacing.map((t) => (
              <tr key={t.id}>
                <td>
                  <input key={t.name} className="token-cell" defaultValue={t.name} aria-label="Token name" spellCheck={false} onBlur={(e) => edit((p) => rename(p.spacing, t.id, e.target.value))} />
                </td>
                <td>
                  <NumberField
                    label=""
                    title="Value"
                    value={t.value}
                    min={0}
                    precision={0}
                    onChange={(v, k) =>
                      edit((p) => {
                        const x = p.spacing?.find((y) => y.id === t.id);
                        if (x) x.value = v;
                      }, k ?? `space:${t.id}`)
                    }
                  />
                </td>
                <td className="token-uses">{uses.get(t.id) ?? 0}</td>
                <td>
                  <IconButton className="small" title="Delete token. Its frames keep their spacing." onClick={() => edit((p) => void (p.spacing = p.spacing?.filter((x) => x.id !== t.id)))}>
                    <IconMinus size={14} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="link-empty">No spacing tokens yet. Add one here, or save a gap from any auto layout frame.</p>
      )}
    </Modal>
  );
}
