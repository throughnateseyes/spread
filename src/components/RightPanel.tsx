import { RepeatSection } from './RepeatDialog';
import { useMemo, useState, type ReactNode } from 'react';
import { MOD, useLayout, useStore } from '../store';
import { absoluteBox, inAutoLayout, type LayoutMap } from '../layout';
import { findNode, findParent, pathTo } from '../tree';
import { LINK_ISSUE_TEXT, collectLinks, linkIssue, nodeLink, normaliseLink, setNodeLink } from '../links';
import { getAsset } from '../assets';
import { colorBytes } from '../effects';
import { EffectsSection } from './EffectsSection';
import { GradientField } from './GradientField';
import { BUNDLED_FONTS, SYSTEM_FONTS, WEIGHTS, fontWeights, isBold, nearestWeight, queryInstalledFonts, toggleBoldSelection, uploadedFonts, type FontOption } from '../fonts';
import { pickFonts, pickReplacement } from '../importer';
import { Button, ColorField, IconButton, NumberField, Row, Section, Segmented, Select, Slider, SwatchContext, Toggle, parseColor, toColor } from '../ui/controls';
import { dotColors, resolveFamily, useActiveBrand } from '../brand';
import { SpaceFields, StylesSection, TextStyleField } from './StylesPanel';
import { Tooltip } from '../ui/Tooltip';
import {
  ICON_DENSE,
  IconAlignBottom,
  IconAlignCenterH,
  IconAlignCenterV,
  IconAlignLeft,
  IconAlignRight,
  IconAlignTop,
  IconAutoLayoutColumn,
  IconAutoLayoutRow,
  IconBold,
  IconClose,
  IconCrop,
  IconDirectionColumn,
  IconDirectionRow,
  IconDistributeH,
  IconDistributeV,
  IconEllipse,
  IconFlipH,
  IconFlipV,
  IconFrame,
  IconGapH,
  IconGapV,
  IconImage,
  IconItalic,
  IconLink,
  IconLetterSpacing,
  IconLineHeight,
  IconMinus,
  IconPaddingH,
  IconPaddingV,
  IconPlus,
  IconRadius,
  IconRect,
  IconChevronDown,
  IconChevronRight,
  IconReset,
  IconRotation,
  IconStrikethrough,
  IconText,
  IconTextAlignCenter,
  IconTextAlignJustify,
  IconTextAlignLeft,
  IconTextAlignRight,
  IconUnderline,
  IconFonts,
  IconUpload,
  type Icon,
} from '../ui/icons';
import { FORMAT_PRESETS, PAGE_PRESETS, type Box, type Doc, type FrameNode, type ImageNode, type Paint, type SceneNode, type Shadow, type ShapeNode, type Sizing, type TextNode } from '../types';
import './panels.css';

const D = ICON_DENSE;

export default function RightPanel() {
  const selection = useStore((s) => s.selection);
  const nodes = useStore((s) => s.doc.nodes);
  const selNodes = useMemo(() => selection.map((id) => findNode(nodes, id)).filter((n): n is SceneNode => !!n), [selection, nodes]);
  const brand = useActiveBrand();
  // Strong colors first, so the field's three dots show the brand, not its paper tones.
  const swatches = useMemo(() => (brand ? dotColors(brand, brand.colors.length) : []), [brand]);
  return (
    <SwatchContext.Provider value={swatches}>
      <div className="panel right">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected="true" className="on">
            Design
          </button>
        </div>
        <div className="panel-scroll design">{selNodes.length ? <SelectionPanel sel={selNodes} /> : <DocumentPanel />}</div>
      </div>
    </SwatchContext.Provider>
  );
}

// ---------------- helpers ----------------

function same<T>(list: SceneNode[], get: (n: SceneNode) => T): T | 'mixed' {
  const first = get(list[0]);
  return list.every((n) => get(n) === first) ? first : 'mixed';
}

function numOrMixed(v: unknown): number | 'mixed' {
  return typeof v === 'number' ? v : 'mixed';
}

interface Geo {
  node: SceneNode;
  abs: Box;
  box: Box;
  parent: FrameNode | null;
  auto: boolean;
}

function geometry(nodes: SceneNode[], layout: LayoutMap, sel: SceneNode[]): Geo[] {
  const out: Geo[] = [];
  for (const n of sel) {
    const abs = absoluteBox(layout, pathTo(nodes, n.id));
    const box = layout.get(n.id);
    if (!abs || !box) continue;
    const parent = findParent(nodes, n.id);
    out.push({ node: n, abs, box, parent, auto: inAutoLayout(parent) });
  }
  return out;
}

// ---------------- document ----------------

/** An email's subject and preview text: what the inbox shows before anyone opens it. */
function InboxSection() {
  const doc = useStore((s) => s.doc);
  const meta = doc.email ?? {};
  const set = (patch: Partial<NonNullable<typeof doc.email>>) => useStore.getState().updateBoard(doc.id, { email: { ...meta, ...patch } });
  const count = (v: string | undefined, max: number) => {
    const n = v?.length ?? 0;
    return <span className={`inbox-count ${n > max ? 'warn' : ''}`}>{n}/{max}</span>;
  };
  return (
    <Section title="Inbox">
      <label className="inbox-field">
        <span className="inbox-label">Subject {count(meta.subject, 60)}</span>
        <div className="field">
          <input value={meta.subject ?? ''} placeholder="What makes them open it" onChange={(e) => set({ subject: e.target.value })} />
        </div>
      </label>
      <label className="inbox-field">
        <span className="inbox-label">Preview text {count(meta.preheader, 90)}</span>
        <div className="field">
          <input value={meta.preheader ?? ''} placeholder="The line after the subject" onChange={(e) => set({ preheader: e.target.value })} />
        </div>
      </label>
    </Section>
  );
}

/** Every link on the email in one place, and the tracking tags they all share. */
function LinksSection() {
  const doc = useStore((s) => s.doc);
  const select = useStore((s) => s.select);
  const links = useMemo(() => collectLinks(doc.nodes), [doc.nodes]);
  const open = links.filter((l) => l.issue).length;
  const setTracking = (tracking: string) => useStore.getState().updateBoard(doc.id, { email: { ...doc.email, tracking } });
  return (
    <Section title="Links" actions={open > 0 ? <span className="link-count warn">{open} to fix</span> : undefined}>
      {links.length === 0 && <p className="link-empty">Select a layer to give it a link.</p>}
      {links.length > 0 && (
        <ul className="link-list">
          {links.map((l) => (
            <li key={l.id}>
              <button className={`link-row ${l.issue ? 'warn' : ''}`} title={l.issue ? LINK_ISSUE_TEXT[l.issue] : l.url} onClick={() => select([l.id])}>
                <span className="link-row-name ellipsis">{l.name}</span>
                <span className="link-row-url ellipsis">{l.issue ? LINK_ISSUE_TEXT[l.issue] : l.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="inbox-field">
        <span className="inbox-label">Tracking tags</span>
        <div className="field">
          <input value={doc.email?.tracking ?? ''} placeholder="utm_source=…&utm_campaign=…" spellCheck={false} onChange={(e) => setTracking(e.target.value)} />
        </div>
      </label>
    </Section>
  );
}

/** The link on the selected layers. Email only: nothing else exports links. */
function LinkSection({ sel, upd }: { sel: SceneNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const nodes = useStore((s) => s.doc.nodes);
  const value = same(sel, (n) => nodeLink(n));
  const on = value !== undefined;
  const mixed = value === 'mixed';
  const url = mixed || value === undefined ? '' : value;
  const issue = on && !mixed ? linkIssue(url) : null;
  const set = (v: string | null, key?: string) => upd((n) => setNodeLink(n, v), key);
  // A link on a frame covers everything inside it, so say so rather than offer an empty field.
  const inherited = !on && sel.length === 1 ? pathTo(nodes, sel[0].id).slice(0, -1).reverse().map((id) => findNode(nodes, id)!).find((p) => nodeLink(p)) : undefined;
  return (
    <Section
      title="Link"
      actions={
        on ? (
          <IconButton className="small" title="Remove link" onClick={() => set(null)}>
            <IconMinus size={D} />
          </IconButton>
        ) : (
          <IconButton className="small" title="Add link" onClick={() => set('')}>
            <IconPlus size={D} />
          </IconButton>
        )
      }
    >
      {on && (
        <>
          <div className="field">
            <IconLink size={D} />
            <input
              value={url}
              placeholder={mixed ? 'Mixed' : 'https://…'}
              spellCheck={false}
              onChange={(e) => set(e.target.value, 'link')}
              onBlur={(e) => {
                const next = normaliseLink(e.target.value);
                if (next !== e.target.value) set(next, 'link');
              }}
            />
          </div>
          {issue && <p className="link-issue">{LINK_ISSUE_TEXT[issue]}</p>}
        </>
      )}
      {inherited && <p className="link-empty">Linked through {inherited.name.replace(/\s*\[[^\]]*\]/g, '').trim()}.</p>}
    </Section>
  );
}

function DocumentPanel() {
  const doc = useStore((s) => s.doc);
  const change = useStore((s) => s.change);
  const setSlideCount = useStore((s) => s.setSlideCount);
  const [perSlideOpen, setPerSlideOpen] = useState(false);
  const preset = FORMAT_PRESETS.find((p) => p.w === doc.slideWidth && p.h === doc.slideHeight)?.id ?? 'custom';
  const g = doc.grid;
  const email = doc.kind === 'email';
  // Per-slide backgrounds stay folded away until asked for, or while any slide has one.
  const overridden = doc.slides.some((sl) => sl.background);
  const perSlide = doc.slides.length > 1 && (perSlideOpen || overridden);

  const unitLabel = doc.kind === 'document' ? 'Page' : 'Slide';

  return (
    <>
      {doc.kind === 'document' ? (
        <PageSection />
      ) : email ? (
        <Section title="Email">
          <div className="grid2">
            <div className="field read" title="Email width, fixed so it fits every inbox">
              <span className="field-label">W</span>
              <span>{doc.slideWidth}</span>
            </div>
            <div className="field read" title="Height follows the sections">
              <span className="field-label">H</span>
              <span>Auto</span>
            </div>
          </div>
          <Button className="block" onClick={() => void window.dispatchEvent(new Event('spread:sections'))}>
            <IconPlus size={ICON_DENSE} /> Add section
          </Button>
        </Section>
      ) : (
      <Section title="Carousel">
        <Select
          title="Format"
          value={preset}
          options={[...FORMAT_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.w}×${p.h}` })), { value: 'custom', label: 'Custom' }]}
          onChange={(v) => {
            const p = FORMAT_PRESETS.find((x) => x.id === v);
            if (p)
              change((d) => {
                d.slideWidth = p.w;
                d.slideHeight = p.h;
              });
          }}
        />
        <div className="grid2">
          <NumberField label="W" title="Slide width" value={doc.slideWidth} min={100} max={4000} precision={0} onChange={(v, k) => change((d) => void (d.slideWidth = Math.round(v)), k ?? 'doc-w')} />
          <NumberField label="H" title="Slide height" value={doc.slideHeight} min={100} max={4000} precision={0} onChange={(v, k) => change((d) => void (d.slideHeight = Math.round(v)), k ?? 'doc-h')} />
        </div>
        <NumberField label="Slides" title="Number of slides" value={doc.slides.length} min={1} max={40} precision={0} onChange={(v) => setSlideCount(Math.round(v))} />
        {doc.slides.length > 20 && <div className="hint warn">Instagram carousels max out at 20 slides.</div>}
      </Section>
      )}

      {email && <InboxSection />}
      {email && <LinksSection />}

      <Section title="Background">
        <ColorField value={doc.background} onChange={(c, k) => change((d) => void (d.background = c), k ?? 'doc-bg')} />
        {doc.slides.length > 1 && !overridden && (
          <button className="link-btn left muted-link" onClick={() => setPerSlideOpen((o) => !o)}>
            {perSlideOpen ? `Hide per-${unitLabel.toLowerCase()} backgrounds` : `Per-${unitLabel.toLowerCase()} backgrounds`}
          </button>
        )}
        {perSlide && (
          <div className="slide-bgs">
            {doc.slides.map((sl, i) => (
              <div key={sl.id} className="slide-bg-row">
                <span className="muted">
                  {unitLabel} {i + 1}
                </span>
                {sl.background ? (
                  <>
                    <ColorField value={sl.background} onChange={(c, k) => change((d) => void (d.slides[i].background = c), k ?? 'slide-bg-' + i)} />
                    <IconButton className="small" title="Use the default background" onClick={() => change((d) => void (d.slides[i].background = null))}>
                      <IconClose size={12} />
                    </IconButton>
                  </>
                ) : (
                  <Tooltip label="Give this slide its own background" side="left">
                    <button className="link-btn" onClick={() => change((d) => void (d.slides[i].background = doc.background))}>
                      Default · override
                    </button>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {!email && (
        <Section title="Layout grid" actions={<Toggle checked={g.visible} onChange={(v) => change((d) => void (d.grid.visible = v))} title="Show layout grid" shortcut={`${MOD}+'`} />}>
          {g.visible && <LayoutGridFields />}
        </Section>
      )}
      <StylesSection />
    </>
  );
}

/** Page size, count, margins and baseline grid for document boards (any medium). */
function PageSection() {
  const doc = useStore((s) => s.doc);
  const change = useStore((s) => s.change);
  const setSlideCount = useStore((s) => s.setSlideCount);
  const page = doc.page ?? { units: 'pt' as const, margins: { t: 54, r: 54, b: 54, l: 54 }, baseline: 0 };
  const u = page.units;
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const preset = PAGE_PRESETS.find((p) => (p.w === W && p.h === H) || (p.w === H && p.h === W))?.id ?? 'custom';
  const inches = u === 'pt' ? ` · ${+(W / 72).toFixed(2)} × ${+(H / 72).toFixed(2)} in` : '';
  const setPage = (fn: (p: NonNullable<Doc['page']>) => void, key?: string) =>
    change((d) => {
      const p = d.page ?? { units: 'pt', margins: { t: 54, r: 54, b: 54, l: 54 }, baseline: 0 };
      fn(p);
      d.page = p;
      // The layout grid shows the margins.
      d.grid.columns.margin = p.margins.l;
      d.grid.rows.margin = p.margins.t;
    }, key);
  const margin = (side: 't' | 'r' | 'b' | 'l', title: string) => (
    <NumberField label={side.toUpperCase()} title={`${title} margin (${u})`} value={page.margins[side]} min={0} max={Math.min(W, H) / 2} precision={1} onChange={(v, k) => setPage((p) => void (p.margins[side] = v), k ?? 'pm-' + side)} />
  );
  return (
    <Section title="Pages">
      <Select
        title="Page size"
        value={preset}
        options={[...PAGE_PRESETS.map((p) => ({ value: p.id, label: `${p.label} · ${p.size}` })), { value: 'custom', label: 'Custom' }]}
        onChange={(v) => {
          const p = PAGE_PRESETS.find((x) => x.id === v);
          if (!p) return;
          const land = W > H;
          change((d) => {
            [d.slideWidth, d.slideHeight] = land && p.h > p.w ? [p.h, p.w] : [p.w, p.h];
            d.page = { ...(d.page ?? page), units: p.group === 'Print' ? 'pt' : 'px' };
          });
        }}
      />
      <div className="grid2">
        <NumberField label="W" title={`Page width (${u})`} value={W} min={36} max={4000} precision={1} onChange={(v, k) => change((d) => void (d.slideWidth = v), k ?? 'doc-w')} />
        <NumberField label="H" title={`Page height (${u})`} value={H} min={36} max={4000} precision={1} onChange={(v, k) => change((d) => void (d.slideHeight = v), k ?? 'doc-h')} />
      </div>
      <div className="grid2">
        <NumberField label="Pages" title="Number of pages" value={doc.slides.length} min={1} max={40} precision={0} onChange={(v) => setSlideCount(Math.round(v))} />
        <Button onClick={() => change((d) => void ([d.slideWidth, d.slideHeight] = [d.slideHeight, d.slideWidth]))} title="Swap width and height">
          {W > H ? 'Landscape' : 'Portrait'} ⇄
        </Button>
      </div>
      {u === 'pt' && <div className="hint">Points, 72 per inch{inches}</div>}
      <div className="sub-label">Margins</div>
      <div className="grid2">
        {margin('t', 'Top')}
        {margin('b', 'Bottom')}
        {margin('l', 'Left')}
        {margin('r', 'Right')}
      </div>
      <NumberField label="Baseline" title={`Baseline grid step (${u}); 0 = off. The layout check flags text that starts off it.`} value={page.baseline} min={0} max={48} precision={1} onChange={(v, k) => setPage((p) => void (p.baseline = v), k ?? 'pb')} />
    </Section>
  );
}

/** Column / row settings, shown only while the layout grid is on. */
function LayoutGridFields() {
  const g = useStore((s) => s.doc.grid);
  const change = useStore((s) => s.change);
  return (
    <>
      <div className="sub-label">
        <IconAutoLayoutRow size={12} /> Columns
      </div>
      <div className="grid3">
        <NumberField label="#" title="Columns" value={g.columns.count} min={0} max={48} precision={0} onChange={(v, k) => change((d) => void (d.grid.columns.count = Math.round(v)), k ?? 'gc')} />
        <NumberField label={<IconGapH size={D} />} title="Gutter" value={g.columns.gutter} min={0} precision={0} onChange={(v, k) => change((d) => void (d.grid.columns.gutter = v), k ?? 'gg')} />
        <NumberField label={<IconPaddingH size={D} />} title="Margin" value={g.columns.margin} min={0} precision={0} onChange={(v, k) => change((d) => void (d.grid.columns.margin = v), k ?? 'gm')} />
      </div>
      <div className="sub-label">
        <IconAutoLayoutColumn size={12} /> Rows
      </div>
      <div className="grid3">
        <NumberField label="#" title="Rows" value={g.rows.count} min={0} max={48} precision={0} onChange={(v, k) => change((d) => void (d.grid.rows.count = Math.round(v)), k ?? 'rc')} />
        <NumberField label={<IconGapV size={D} />} title="Gutter" value={g.rows.gutter} min={0} precision={0} onChange={(v, k) => change((d) => void (d.grid.rows.gutter = v), k ?? 'rg')} />
        <NumberField label={<IconPaddingV size={D} />} title="Margin" value={g.rows.margin} min={0} precision={0} onChange={(v, k) => change((d) => void (d.grid.rows.margin = v), k ?? 'rm')} />
      </div>
      <ColorField value={g.color} onChange={(c, k) => change((d) => void (d.grid.color = c), k ?? 'grid-color')} />
    </>
  );
}

// ---------------- selection ----------------

const TYPE_LABEL: Record<SceneNode['type'], string> = { image: 'Photo', text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', frame: 'Frame' };
const TYPE_ICON: Record<SceneNode['type'], Icon> = { image: IconImage, text: IconText, rect: IconRect, ellipse: IconEllipse, frame: IconFrame };

function SelectionPanel({ sel }: { sel: SceneNode[] }) {
  const nodes = useStore((s) => s.doc.nodes);
  const doc = useStore((s) => s.doc);
  const updateNodes = useStore((s) => s.updateNodes);
  const wrap = useStore((s) => s.wrapSelectionInFrame);
  const ungroup = useStore((s) => s.ungroup);
  const layout = useLayout();
  const geo = useMemo(() => geometry(nodes, layout, sel), [nodes, layout, sel]);
  const ids = sel.map((n) => n.id);
  const upd = (fn: (n: SceneNode) => void, key?: string) => updateNodes(ids, fn, key);
  const type = same(sel, (n) => n.type);
  const single = sel.length === 1 ? sel[0] : null;
  const isAutoFrame = single?.type === 'frame' && single.layout !== 'none';
  const title = sel.length > 1 ? `${sel.length} layers` : isAutoFrame ? 'Auto layout frame' : TYPE_LABEL[single!.type];
  const TitleIcon = single ? (isAutoFrame ? (single.type === 'frame' && single.layout === 'column' ? IconAutoLayoutColumn : IconAutoLayoutRow) : TYPE_ICON[single.type]) : null;

  return (
    <>
      <Section
        title={
          <span className="selection-head-title">
            {TitleIcon && <TitleIcon size={D} />}
            <span className="ellipsis">{single?.name && single.name !== TYPE_LABEL[single.type] ? single.name.replace(/\s*\[[^\]]*\]/g, '').trim() || title : title}</span>
          </span>
        }
        actions={
          <>
            <IconButton className="small" title="Frame selection" shortcut={`${MOD}+Alt+G`} onClick={() => wrap(false)}>
              <IconFrame size={D} />
            </IconButton>
            <IconButton className="small" title="Add auto layout" shortcut="Shift+A" onClick={() => wrap(true)}>
              <IconAutoLayoutRow size={D} />
            </IconButton>
            {single?.type === 'frame' && (
              <Tooltip label="Ungroup" shortcut={`${MOD}+Shift+G`}>
                <button className="link-btn" onClick={() => ungroup(single.id)}>
                  Ungroup
                </button>
              </Tooltip>
            )}
          </>
        }
      />
      {single && <RepeatSection node={single} />}
      <AlignSection geo={geo} doc={doc} />
      <LayoutSection geo={geo} upd={upd} />
      {type === 'text' && <TextSection sel={sel as TextNode[]} upd={upd} doc={doc} />}
      {type === 'image' && <ImageSection sel={sel as ImageNode[]} geo={geo} upd={upd} doc={doc} />}
      {(type === 'rect' || type === 'ellipse') && <ShapeSection sel={sel} upd={upd} />}
      {type === 'frame' && <FrameSection sel={sel as FrameNode[]} upd={upd} />}
      {doc.kind === 'email' && <LinkSection sel={sel} upd={upd} />}
      <AppearanceSection sel={sel} upd={upd} />
      <ShadowSection sel={sel} upd={upd} />
    </>
  );
}

function AlignSection({ geo, doc }: { geo: Geo[]; doc: Doc }) {
  const updateNodes = useStore((s) => s.updateNodes);
  const free = geo.filter((g) => !g.auto);
  // Keep the bar's height when everything is in auto layout so the panel doesn't jump.
  const disabled = !free.length;
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  let target: Box = { x: 0, y: 0, w: W, h: H };
  if (free.length === 1) {
    const a = free[0].abs;
    const i = Math.max(0, Math.min(doc.slides.length - 1, Math.floor((a.x + a.w / 2) / W)));
    target = { x: i * W, y: 0, w: W, h: H };
  } else if (free.length > 1) {
    const x0 = Math.min(...free.map((g) => g.abs.x));
    const y0 = Math.min(...free.map((g) => g.abs.y));
    const x1 = Math.max(...free.map((g) => g.abs.x + g.abs.w));
    const y1 = Math.max(...free.map((g) => g.abs.y + g.abs.h));
    target = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const deltas = (f: (g: Geo) => { dx?: number; dy?: number }) => {
    const m = new Map(free.map((g) => [g.node.id, f(g)]));
    updateNodes([...m.keys()], (n) => {
      const d = m.get(n.id)!;
      n.x += d.dx ?? 0;
      n.y += d.dy ?? 0;
    });
  };
  const align = (k: 'l' | 'ch' | 'r' | 't' | 'cv' | 'b') =>
    deltas((g) => {
      const a = g.abs;
      if (k === 'l') return { dx: target.x - a.x };
      if (k === 'ch') return { dx: target.x + target.w / 2 - (a.x + a.w / 2) };
      if (k === 'r') return { dx: target.x + target.w - (a.x + a.w) };
      if (k === 't') return { dy: target.y - a.y };
      if (k === 'cv') return { dy: target.y + target.h / 2 - (a.y + a.h / 2) };
      return { dy: target.y + target.h - (a.y + a.h) };
    });
  const distribute = (axis: 'x' | 'y') => {
    const dim = axis === 'x' ? 'w' : 'h';
    const sorted = [...free].sort((a, b) => a.abs[axis] - b.abs[axis]);
    const first = sorted[0].abs;
    const last = sorted[sorted.length - 1].abs;
    const total = last[axis] + last[dim] - first[axis];
    const sizes = sorted.reduce((s, g) => s + g.abs[dim], 0);
    const gap = (total - sizes) / (sorted.length - 1);
    let cursor = first[axis];
    const m = new Map<string, number>();
    for (const g of sorted) {
      m.set(g.node.id, cursor - g.abs[axis]);
      cursor += g.abs[dim] + gap;
    }
    updateNodes([...m.keys()], (n) => {
      if (axis === 'x') n.x += m.get(n.id)!;
      else n.y += m.get(n.id)!;
    });
  };
  const to = free.length === 1 ? ' to slide' : '';
  const btn = (t: string, I: Icon, fn: () => void, off = false) => (
    <IconButton title={t} disabled={disabled || off} onClick={fn}>
      <I />
    </IconButton>
  );
  return (
    <div className="align-bar" role="toolbar" aria-label="Align">
      {btn(`Align left${to}`, IconAlignLeft, () => align('l'))}
      {btn(`Align horizontal centers${to}`, IconAlignCenterH, () => align('ch'))}
      {btn(`Align right${to}`, IconAlignRight, () => align('r'))}
      {btn(`Align top${to}`, IconAlignTop, () => align('t'))}
      {btn(`Align vertical centers${to}`, IconAlignCenterV, () => align('cv'))}
      {btn(`Align bottom${to}`, IconAlignBottom, () => align('b'))}
      <span className="sep" />
      {btn('Distribute horizontal spacing', IconDistributeH, () => distribute('x'), free.length < 3)}
      {btn('Distribute vertical spacing', IconDistributeV, () => distribute('y'), free.length < 3)}
    </div>
  );
}

const SIZING_LABEL: Record<'H' | 'V', Record<Sizing, string>> = {
  H: { fixed: 'Fixed width', hug: 'Hug width', fill: 'Fill width' },
  V: { fixed: 'Fixed height', hug: 'Hug height', fill: 'Fill height' },
};

function sizingOptions(n: SceneNode, auto: boolean, axis: 'H' | 'V') {
  const opts: { value: Sizing; label: string }[] = [{ value: 'fixed', label: SIZING_LABEL[axis].fixed }];
  if (n.type === 'text' || (n.type === 'frame' && n.layout !== 'none')) opts.push({ value: 'hug', label: SIZING_LABEL[axis].hug });
  if (auto) opts.push({ value: 'fill', label: SIZING_LABEL[axis].fill });
  // Never render a select whose value isn't among its options (e.g. 'fill' after leaving auto layout).
  const cur = axis === 'H' ? n.sizingH : n.sizingV;
  if (!opts.some((o) => o.value === cur)) opts.push({ value: cur, label: SIZING_LABEL[axis][cur] });
  return opts;
}

function LayoutSection({ geo, upd }: { geo: Geo[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  if (!geo.length) return null;
  const allAuto = geo.every((g) => g.auto);
  const sameV = (f: (g: Geo) => number): number | 'mixed' => {
    const v = f(geo[0]);
    return geo.every((g) => Math.abs(f(g) - v) < 0.01) ? v : 'mixed';
  };
  const absOf = new Map(geo.map((g) => [g.node.id, g]));
  const setAbs = (axis: 'x' | 'y', v: number, k?: string) =>
    upd((n) => {
      const g = absOf.get(n.id);
      if (!g || g.auto) return;
      n[axis] += v - g.abs[axis];
    }, k);
  const setSize = (dim: 'w' | 'h', v: number, k?: string) =>
    upd((n) => {
      n[dim] = Math.max(1, v);
      if (dim === 'w') n.sizingH = 'fixed';
      else n.sizingV = 'fixed';
    }, k);
  const g0 = geo[0];
  const single = geo.length === 1;
  const setSizing = (axis: 'H' | 'V', v: Sizing) =>
    upd((n) => {
      const g = absOf.get(n.id);
      if (axis === 'H') {
        if (v === 'fixed' && g) n.w = g.box.w;
        n.sizingH = v;
      } else {
        if (v === 'fixed' && g) n.h = g.box.h;
        n.sizingV = v;
      }
    });
  return (
    <Section title="Layout">
      <div className="grid2">
        <NumberField label="X" title={allAuto ? 'X, set by auto layout' : 'X position'} value={allAuto ? 'mixed' : sameV((g) => g.abs.x)} mixedLabel={allAuto ? 'Auto' : 'Mixed'} onChange={(v, k) => setAbs('x', v, k ?? 'pos-x')} />
        <NumberField label="Y" title={allAuto ? 'Y, set by auto layout' : 'Y position'} value={allAuto ? 'mixed' : sameV((g) => g.abs.y)} mixedLabel={allAuto ? 'Auto' : 'Mixed'} onChange={(v, k) => setAbs('y', v, k ?? 'pos-y')} />
        <NumberField label="W" title="Width" value={sameV((g) => g.box.w)} min={1} onChange={(v, k) => setSize('w', v, k ?? 'size-w')} />
        <NumberField label="H" title="Height" value={sameV((g) => g.box.h)} min={1} onChange={(v, k) => setSize('h', v, k ?? 'size-h')} />
      </div>
      {single && (
        <div className="grid2">
          <Select title="Horizontal resizing" value={g0.node.sizingH} options={sizingOptions(g0.node, g0.auto, 'H')} onChange={(v) => setSizing('H', v)} />
          <Select title="Vertical resizing" value={g0.node.sizingV} options={sizingOptions(g0.node, g0.auto, 'V')} onChange={(v) => setSizing('V', v)} />
        </div>
      )}
      <div className="grid2">
        <NumberField
          label={<IconRotation size={D} />}
          title="Rotation"
          value={numOrMixed(same(geo.map((g) => g.node), (n) => n.rotation))}
          suffix="°"
          onChange={(v, k) => upd((n) => void (n.rotation = ((v % 360) + 360) % 360), k ?? 'rot')}
        />
        {allAuto && <span className="hint">Position set by auto layout</span>}
      </div>
    </Section>
  );
}

// ---------------- text ----------------

let installedCache: FontOption[] = [];

function TextSection({ sel, upd, doc }: { sel: TextNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void; doc: Doc }) {
  const [installed, setInstalled] = useState<FontOption[]>(installedCache);
  const brand = useActiveBrand();
  const t = (fn: (n: TextNode) => void, key?: string) => upd((n) => n.type === 'text' && fn(n), key);
  const family = same(sel, (n) => (n as TextNode).fontFamily);
  const fontOpts = useMemo(() => {
    const opts: { value: string; label: string; group: string }[] = [];
    const seen = new Set<string>();
    const add = (list: FontOption[], group: string) =>
      list.forEach((f) => {
        if (seen.has(f.family)) return;
        seen.add(f.family);
        opts.push({ value: f.family, label: f.label, group });
      });
    // The project's brand fonts come first.
    if (brand) add(brand.fonts.map((f) => ({ family: resolveFamily(f.family), label: f.role ? `${f.family} · ${f.role}` : f.family, source: 'uploaded' as const })), brand.name);
    add(BUNDLED_FONTS, 'Bundled');
    add(uploadedFonts(doc), 'Uploaded');
    add(SYSTEM_FONTS, 'System');
    add(installed, 'Installed');
    if (family !== 'mixed' && !seen.has(family)) opts.unshift({ value: family, label: family, group: 'Current' });
    if (family === 'mixed') opts.unshift({ value: 'mixed', label: 'Mixed', group: 'Current' });
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.assets, installed, family, brand]);
  const loadInstalled = async () => {
    const list = await queryInstalledFonts();
    installedCache = list;
    setInstalled(list);
    if (!list.length) useStore.getState().toast('Installed fonts aren’t available here. Upload font files instead.', 'error');
  };
  const v = <K extends keyof TextNode>(k: K) => same(sel, (n) => (n as TextNode)[k]);
  const weight = v('fontWeight');
  const italic = v('italic') === true;
  const bold = sel.every((n) => isBold((n as TextNode).fontWeight));
  // Only offer weights the font really has; a weight it lacks (set before) stays listed, flagged.
  const available = family === 'mixed' ? null : fontWeights(family as string, doc);
  const weightOpts = WEIGHTS.filter((w) => !available || available.includes(w.value));
  if (typeof weight === 'number' && !weightOpts.some((w) => w.value === weight)) {
    const known = WEIGHTS.find((w) => w.value === weight);
    weightOpts.push({ value: weight, label: `${known?.label ?? weight} (not in this font)` });
    weightOpts.sort((a, b) => a.value - b.value);
  }
  const single = sel.length === 1 ? sel[0] : null;
  const lh = v('lineHeight');

  return (
    <Section
      title="Text"
      actions={
        <>
          {!installed.length && (
            <IconButton className="small" title="Load installed fonts" onClick={loadInstalled}>
              <IconFonts size={D} />
            </IconButton>
          )}
          <IconButton className="small" title="Upload font files" onClick={pickFonts}>
            <IconUpload size={D} />
          </IconButton>
        </>
      }
    >
      <TextStyleField sel={sel} />
      <Select
        title="Font family"
        value={family as string}
        options={fontOpts}
        onChange={(f) =>
          f !== 'mixed' &&
          t((n) => {
            n.fontFamily = f;
            n.fontWeight = nearestWeight(fontWeights(f, doc), n.fontWeight);
          })
        }
      />
      <Row>
        <Select
          title="Font weight"
          value={weight === 'mixed' ? 'mixed' : (weight as number)}
          options={weight === 'mixed' ? [{ value: 'mixed' as const, label: 'Mixed' }, ...weightOpts] : weightOpts}
          onChange={(w) => w !== 'mixed' && t((n) => void (n.fontWeight = w))}
        />
        <IconButton title="Bold" shortcut={`${MOD}+B`} active={bold} onClick={toggleBoldSelection}>
          <IconBold size={D} />
        </IconButton>
        <IconButton title="Italic" active={italic} onClick={() => t((n) => void (n.italic = !italic))}>
          <IconItalic size={D} />
        </IconButton>
      </Row>
      <div className="grid3">
        <NumberField label={<IconText size={D} />} title="Font size" value={numOrMixed(v('fontSize'))} min={1} precision={1} onChange={(x, k) => t((n) => void (n.fontSize = x), k ?? 'fs')} />
        <NumberField
          label={<IconLineHeight size={D} />}
          title="Line height"
          value={typeof lh === 'number' ? Math.round(lh * 100) : 'mixed'}
          suffix="%"
          min={30}
          precision={0}
          onChange={(x, k) => t((n) => void (n.lineHeight = x / 100), k ?? 'lh')}
        />
        <NumberField label={<IconLetterSpacing size={D} />} title="Letter spacing" value={numOrMixed(v('letterSpacing'))} suffix="%" step={0.5} precision={1} onChange={(x, k) => t((n) => void (n.letterSpacing = x), k ?? 'ls')} />
      </div>
      <Segmented
        value={v('align') === 'mixed' ? null : (v('align') as TextNode['align'])}
        onChange={(a) => t((n) => void (n.align = a))}
        options={[
          { value: 'left', label: <IconTextAlignLeft size={D} />, title: 'Align left' },
          { value: 'center', label: <IconTextAlignCenter size={D} />, title: 'Align center' },
          { value: 'right', label: <IconTextAlignRight size={D} />, title: 'Align right' },
          { value: 'justify', label: <IconTextAlignJustify size={D} />, title: 'Justify' },
        ]}
      />
      <Row>
        <Segmented
          value={v('uppercase') === 'mixed' ? null : v('uppercase') ? 'upper' : 'normal'}
          onChange={(c) => t((n) => void (n.uppercase = c === 'upper'))}
          options={[
            { value: 'normal', label: 'Aa', title: 'As typed' },
            { value: 'upper', label: 'AA', title: 'Uppercase' },
          ]}
        />
        <Segmented
          value={v('decoration') === 'mixed' ? null : (v('decoration') as TextNode['decoration'])}
          onChange={(d) => t((n) => void (n.decoration = d))}
          options={[
            { value: 'none', label: <IconMinus size={D} />, title: 'No decoration' },
            { value: 'underline', label: <IconUnderline size={D} />, title: 'Underline' },
            { value: 'line-through', label: <IconStrikethrough size={D} />, title: 'Strikethrough' },
          ]}
        />
      </Row>
      <ColorField value={v('fill') === 'mixed' ? '#888888' : (v('fill') as string)} onChange={(c, k) => t((n) => void (n.fill = c), k ?? 'text-fill')} />
      {single && (
        <textarea
          className="text-area"
          aria-label="Text content"
          value={single.text}
          rows={Math.min(8, single.text.split('\n').length + 1)}
          onChange={(e) => t((n) => void (n.text = e.target.value), 'text-content')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </Section>
  );
}

// ---------------- image ----------------

function ImageSection({ sel, geo, upd, doc }: { sel: ImageNode[]; geo: Geo[]; upd: (fn: (n: SceneNode) => void, key?: string) => void; doc: Doc }) {
  const set = useStore((s) => s.set);
  const im = (fn: (n: ImageNode) => void, key?: string) => upd((n) => n.type === 'image' && fn(n), key);
  const single = sel.length === 1 ? sel[0] : null;
  const asset = single?.assetId ? doc.assets[single.assetId] : null;
  const thumb = single?.assetId ? getAsset(single.assetId)?.thumbUrl : undefined;
  const fit = same(sel, (n) => (n as ImageNode).fit);
  const zoom = same(sel, (n) => (n as ImageNode).crop.zoom);
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const geoById = new Map(geo.map((g) => [g.node.id, g]));
  const flipX = same(sel, (n) => (n as ImageNode).flipX) === true;
  const flipY = same(sel, (n) => (n as ImageNode).flipY) === true;

  const place = (span: 1 | 2 | 'all') =>
    im((n) => {
      const g = geoById.get(n.id);
      if (!g || g.auto) return;
      const slides = doc.slides.length;
      let i = Math.max(0, Math.min(slides - 1, Math.floor((g.abs.x + g.abs.w / 2) / W)));
      let count = span === 'all' ? slides : span;
      if (span === 2 && i + 2 > slides) i = Math.max(0, slides - 2);
      if (span === 'all') i = 0;
      count = Math.min(count, slides - i);
      n.x += i * W - g.abs.x;
      n.y += 0 - g.abs.y;
      n.w = count * W;
      n.h = H;
      n.rotation = 0;
      n.sizingH = 'fixed';
      n.sizingV = 'fixed';
    });

  return (
    <>
    <Section title="Photo">
      {single && (
        <div className="image-card">
          {thumb ? <img src={thumb} alt="" /> : <div className="photo-missing" />}
          <div className="image-card-meta">
            <Tooltip label={asset?.name} side="left" delay={700}>
              <div className="ellipsis image-card-name">{asset?.name ?? 'Empty placeholder'}</div>
            </Tooltip>
            {asset && (
              <div className="hint">
                {asset.width} × {asset.height}
              </div>
            )}
            <button className="link-btn left" onClick={() => pickReplacement(single.id)}>
              {asset ? 'Replace…' : 'Choose photo…'}
            </button>
          </div>
        </div>
      )}
      <Row>
        <Segmented
          value={fit === 'mixed' ? null : (fit as 'fill' | 'fit')}
          onChange={(f) => im((n) => void (n.fit = f))}
          options={[
            { value: 'fill', label: 'Fill', title: 'Cover the frame (crop)' },
            { value: 'fit', label: 'Fit', title: 'Show the whole photo' },
          ]}
        />
        {single && (
          <IconButton title="Edit crop" shortcut="Enter" disabled={!single.assetId} onClick={() => set({ croppingId: single.id, editingTextId: null })}>
            <IconCrop size={D} />
          </IconButton>
        )}
        <IconButton title="Reset crop" onClick={() => im((n) => void (n.crop = { zoom: 1, cx: 0.5, cy: 0.5 }))}>
          <IconReset size={D} />
        </IconButton>
      </Row>
      <Slider label="Zoom" value={zoom === 'mixed' ? 1 : (zoom as number)} min={1} max={5} step={0.01} reset={1} onChange={(z, k) => im((n) => void (n.crop.zoom = Math.max(1, z)), k ?? 'crop-zoom')} />
      <Row>
        <IconButton title="Flip horizontal" active={flipX} onClick={() => im((n) => void (n.flipX = !flipX))}>
          <IconFlipH size={D} />
        </IconButton>
        <IconButton title="Flip vertical" active={flipY} onClick={() => im((n) => void (n.flipY = !flipY))}>
          <IconFlipV size={D} />
        </IconButton>
        <NumberField label={<IconRadius size={D} />} title="Corner radius" value={numOrMixed(same(sel, (n) => (n as ImageNode).radius))} min={0} precision={0} onChange={(x, k) => im((n) => void (n.radius = x), k ?? 'img-radius')} />
      </Row>
      <StrokeFields stroke={single ? single.stroke : null} width={single ? single.strokeWidth : 0} onChange={(s, w, k) => im((n) => ((n.stroke = s), (n.strokeWidth = w)), k)} />
      {geo.some((g) => !g.auto) && (
        <>
          <div className="sub-label">Place</div>
          <div className="grid3">
            <Button onClick={() => place(1)} title="Full-bleed on the slide it's on">
              Fit slide
            </Button>
            <Button onClick={() => place(2)} title="Span this slide and the next">
              Span 2
            </Button>
            <Button onClick={() => place('all')} title="One panorama across every slide">
              Span all
            </Button>
          </div>
        </>
      )}
    </Section>
    <AdjustSection sel={sel} im={im} />
    <EffectsSection sel={sel} im={im} />
    </>
  );
}

// ---------------- shapes & frames ----------------

/** Closed until it's wanted: most photos never need these three sliders. */
function AdjustSection({ sel, im }: { sel: ImageNode[]; im: (fn: (n: ImageNode) => void, key?: string) => void }) {
  const [open, setOpen] = useState(false);
  const keys = ['brightness', 'contrast', 'saturation'] as const;
  const changed = sel.some((n) => keys.some((k) => n.adjust[k] !== 0));
  return (
    <Section
      title={
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          Adjust
          {changed && !open && <span className="section-note">Edited</span>}
        </button>
      }
      actions={
        changed ? (
          <IconButton className="small" title="Reset adjustments" onClick={() => im((n) => void (n.adjust = { brightness: 0, contrast: 0, saturation: 0 }))}>
            <IconReset size={D} />
          </IconButton>
        ) : undefined
      }
    >
      {open &&
        keys.map((k) => {
          const val = same(sel, (n) => (n as ImageNode).adjust[k]);
          return (
            <Slider
              key={k}
              label={k[0].toUpperCase() + k.slice(1)}
              value={val === 'mixed' ? 0 : Math.round((val as number) * 100)}
              min={-100}
              max={100}
              reset={0}
              onChange={(x, key) => im((n) => void (n.adjust[k] = x / 100), key ?? 'adj-' + k)}
            />
          );
        })}
    </Section>
  );
}

function StrokeFields({ stroke, width, onChange }: { stroke: string | null; width: number; onChange: (s: string | null, w: number, key?: string) => void }) {
  if (!stroke)
    return (
      <Button className="block" onClick={() => onChange('#000000', Math.max(1, width || 2))}>
        <IconPlus size={ICON_DENSE} /> Add stroke
      </Button>
    );
  return (
    <Row>
      <ColorField value={stroke} onChange={(c, k) => onChange(c, width, k ?? 'stroke-c')} />
      <NumberField className="w-60" title="Stroke weight" value={width} min={0} precision={1} onChange={(w, k) => onChange(stroke, w, k ?? 'stroke-w')} />
      <IconButton className="small" title="Remove stroke" onClick={() => onChange(null, 0)}>
        <IconMinus size={D} />
      </IconButton>
    </Row>
  );
}

function PaintField({ paint, onChange }: { paint: Paint; onChange: (p: Paint, key?: string) => void }) {
  return (
    <>
      <Segmented
        value={paint.kind === 'solid' ? 'solid' : 'gradient'}
        onChange={(k) => {
          if (k === 'gradient' && paint.kind === 'solid') {
            const { hex } = parseColor(paint.color);
            onChange({ kind: 'linear', angle: 180, from: toColor(hex, 0), to: toColor(hex, 0.85) });
          } else if (k === 'solid' && paint.kind !== 'solid') {
            onChange({ kind: 'solid', color: paint.kind === 'mesh' ? paint.points[0].color : paint.to });
          }
        }}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'gradient', label: 'Gradient' },
        ]}
      />
      {paint.kind === 'solid' ? <ColorField value={paint.color} onChange={(c, k) => onChange({ kind: 'solid', color: c }, k ?? 'paint')} /> : <GradientField paint={paint} onChange={onChange} />}
    </>
  );
}

function ShapeSection({ sel, upd }: { sel: SceneNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const first = sel[0];
  if (first.type !== 'rect' && first.type !== 'ellipse') return null;
  const sh = (fn: (n: SceneNode & { type: 'rect' | 'ellipse' }) => void, key?: string) => upd((n) => (n.type === 'rect' || n.type === 'ellipse') && fn(n), key);
  return (
    <Section title="Fill">
      <PaintField paint={first.fill} onChange={(p, k) => sh((n) => void (n.fill = structuredClone(p)), k)} />
      <StrokeFields stroke={first.stroke} width={first.strokeWidth} onChange={(s, w, k) => sh((n) => ((n.stroke = s), (n.strokeWidth = w)), k)} />
      {first.type === 'rect' && (
        <div className="grid2">
          <NumberField label={<IconRadius size={D} />} title="Corner radius" value={numOrMixed(same(sel, (n) => (n as any).radius))} min={0} precision={0} onChange={(x, k) => sh((n) => void (n.radius = x), k ?? 'shape-radius')} />
        </div>
      )}
    </Section>
  );
}

function FrameSection({ sel, upd }: { sel: FrameNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const f0 = sel[0];
  const fr = (fn: (n: FrameNode) => void, key?: string) => upd((n) => n.type === 'frame' && fn(n), key);
  const auto = f0.layout !== 'none';
  const row = f0.layout === 'row';
  const [expandPad, setExpandPad] = useState(false);
  const p = f0.padding;
  const padIndividual = expandPad || p.l !== p.r || p.t !== p.b;
  return (
    <>
      <Section
        title="Auto layout"
        actions={
          auto ? (
            <IconButton className="small" title="Remove auto layout" onClick={() => fr((n) => void ((n.layout = 'none'), n.sizingH === 'hug' && (n.sizingH = 'fixed'), n.sizingV === 'hug' && (n.sizingV = 'fixed')))}>
              <IconMinus size={D} />
            </IconButton>
          ) : (
            <IconButton
              className="small"
              title="Add auto layout"
              shortcut="Shift+A"
              onClick={() =>
                fr((n) => {
                  n.layout = 'row';
                  if (n.children.length) {
                    n.sizingH = 'hug';
                    n.sizingV = 'hug';
                  }
                })
              }
            >
              <IconPlus size={D} />
            </IconButton>
          )
        }
      >
        {auto ? (
          <>
            <div className="auto-grid">
              <AlignMatrix frame={f0} onChange={(justify, alignItems) => fr((n) => ((n.justify = justify), (n.alignItems = alignItems)))} />
              <div className="auto-grid-side">
                <Segmented
                  value={f0.layout as 'row' | 'column'}
                  onChange={(l) => fr((n) => void (n.layout = l))}
                  options={[
                    { value: 'row', label: <IconDirectionRow size={D} />, title: 'Horizontal' },
                    { value: 'column', label: <IconDirectionColumn size={D} />, title: 'Vertical' },
                  ]}
                />
                <NumberField
                  label={row ? <IconGapH size={D} /> : <IconGapV size={D} />}
                  title={row ? 'Horizontal gap between items' : 'Vertical gap between items'}
                  value={f0.justify === 'between' ? 'mixed' : f0.gap}
                  mixedLabel="Auto"
                  min={0}
                  precision={0}
                  onChange={(x, k) => fr((n) => ((n.gap = x), n.justify === 'between' && (n.justify = 'start')), k ?? 'gap')}
                />
              </div>
            </div>
            <Toggle checked={f0.justify === 'between'} onChange={(b) => fr((n) => void (n.justify = b ? 'between' : 'start'))} label="Space between" />
            {padIndividual ? (
              <div className="grid2">
                <NumberField label="T" title="Top padding" value={p.t} min={0} precision={0} onChange={(x, k) => fr((n) => void (n.padding.t = x), k ?? 'pt')} />
                <NumberField label="R" title="Right padding" value={p.r} min={0} precision={0} onChange={(x, k) => fr((n) => void (n.padding.r = x), k ?? 'pr')} />
                <NumberField label="B" title="Bottom padding" value={p.b} min={0} precision={0} onChange={(x, k) => fr((n) => void (n.padding.b = x), k ?? 'pb')} />
                <NumberField label="L" title="Left padding" value={p.l} min={0} precision={0} onChange={(x, k) => fr((n) => void (n.padding.l = x), k ?? 'pl')} />
              </div>
            ) : (
              <div className="grid2">
                <NumberField label={<IconPaddingH size={D} />} title="Horizontal padding" value={p.l} min={0} precision={0} onChange={(x, k) => fr((n) => ((n.padding.l = x), (n.padding.r = x)), k ?? 'ph')} />
                <NumberField label={<IconPaddingV size={D} />} title="Vertical padding" value={p.t} min={0} precision={0} onChange={(x, k) => fr((n) => ((n.padding.t = x), (n.padding.b = x)), k ?? 'pv')} />
              </div>
            )}
            <button
              className="link-btn left muted-link"
              onClick={() => {
                if (padIndividual) {
                  // Collapse back to uniform: left → both sides, top → top & bottom.
                  fr((n) => ((n.padding.r = n.padding.l), (n.padding.b = n.padding.t)));
                  setExpandPad(false);
                } else setExpandPad(true);
              }}
            >
              {padIndividual ? 'Uniform padding' : 'Individual padding'}
            </button>
            <SpaceFields sel={sel} fr={fr} />
          </>
        ) : (
          <div className="hint">Auto layout stacks children in a row or column with gap and padding, like Figma.</div>
        )}
      </Section>
      <Section
        title="Frame fill"
        actions={
          f0.fill ? (
            <IconButton className="small" title="Remove fill" onClick={() => fr((n) => void (n.fill = null))}>
              <IconMinus size={D} />
            </IconButton>
          ) : (
            <IconButton className="small" title="Add fill" onClick={() => fr((n) => void (n.fill = { kind: 'solid', color: '#FFFFFF' }))}>
              <IconPlus size={D} />
            </IconButton>
          )
        }
      >
        {f0.fill && <PaintField paint={f0.fill} onChange={(pt, k) => fr((n) => void (n.fill = structuredClone(pt)), k)} />}
        <StrokeFields stroke={f0.stroke} width={f0.strokeWidth} onChange={(s, w, k) => fr((n) => ((n.stroke = s), (n.strokeWidth = w)), k)} />
        <div className="grid2">
          <NumberField label={<IconRadius size={D} />} title="Corner radius" value={numOrMixed(same(sel, (n) => (n as FrameNode).radius))} min={0} precision={0} onChange={(x, k) => fr((n) => void (n.radius = x), k ?? 'frame-radius')} />
          <Toggle checked={f0.clip} onChange={(c) => fr((n) => void (n.clip = c))} label="Clip content" />
        </div>
      </Section>
    </>
  );
}

/** Figma-style 3×3 alignment pad: column = main/cross depending on direction. */
function AlignMatrix({ frame, onChange }: { frame: FrameNode; onChange: (j: FrameNode['justify'], a: FrameNode['alignItems']) => void }) {
  const pos: ('start' | 'center' | 'end')[] = ['start', 'center', 'end'];
  const row = frame.layout === 'row';
  const names = { start: row ? 'left' : 'top', center: 'center', end: row ? 'right' : 'bottom' };
  const cross = { start: row ? 'top' : 'left', center: 'center', end: row ? 'bottom' : 'right' };
  return (
    <div className={`align-matrix ${row ? '' : 'col'}`} role="group" aria-label="Alignment">
      {pos.map((vy) =>
        pos.map((vx) => {
          const main = row ? vx : vy;
          const crossV = row ? vy : vx;
          const on = (frame.justify === main || frame.justify === 'between') && frame.alignItems === crossV;
          const label = frame.justify === 'between' ? `Align ${cross[crossV]}` : main === 'center' && crossV === 'center' ? 'Align center' : `Align ${cross[crossV]} ${names[main]}`;
          return (
            <Tooltip key={vx + vy} label={label} delay={700}>
              <button className={on ? 'on' : ''} aria-label={label} aria-pressed={on} onClick={() => onChange(frame.justify === 'between' ? 'between' : main, crossV)}>
                <span />
              </button>
            </Tooltip>
          );
        }),
      )}
    </div>
  );
}

// ---------------- appearance & effects ----------------

function AppearanceSection({ sel, upd }: { sel: SceneNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const op = same(sel, (n) => n.opacity);
  const blurrable = sel.every((n) => n.type === 'rect' || n.type === 'ellipse' || n.type === 'frame');
  const blur = same(sel, (n) => (n as ShapeNode | FrameNode).backdropBlur ?? 0);
  // Only shows through a see-through fill, so a solid one would look like the slider does nothing.
  const covered = sel.every((n) => {
    const fill = (n as ShapeNode | FrameNode).fill;
    return fill?.kind === 'solid' && colorBytes(fill.color)[3] === 255;
  });
  return (
    <Section title="Layer">
      <Slider label="Opacity" value={op === 'mixed' ? 100 : Math.round((op as number) * 100)} min={0} max={100} suffix="%" reset={100} onChange={(x, k) => upd((n) => void (n.opacity = x / 100), k ?? 'opacity')} />
      {blurrable && (
        <Slider
          label="Blur behind"
          value={blur === 'mixed' ? 0 : (blur as number)}
          min={0}
          max={120}
          reset={0}
          onChange={(x, k) => upd((n) => void ((n as ShapeNode | FrameNode).backdropBlur = x), k ?? 'backdrop-blur')}
        />
      )}
      {blurrable && blur !== 0 && covered && <div className="hint">Lower the fill's opacity to see the blur.</div>}
    </Section>
  );
}

function ShadowSection({ sel, upd }: { sel: SceneNode[]; upd: (fn: (n: SceneNode) => void, key?: string) => void }) {
  const sh = sel[0].shadow;
  const on = !!sh?.enabled;
  const setSh = (p: Partial<Shadow>, key?: string) =>
    upd((n) => {
      n.shadow = { ...(n.shadow ?? { enabled: true, color: '#00000040', x: 0, y: 8, blur: 24 }), ...p };
    }, key);
  return (
    <Section
      title="Drop shadow"
      actions={
        on ? (
          <IconButton className="small" title="Remove shadow" onClick={() => setSh({ enabled: false })}>
            <IconMinus size={D} />
          </IconButton>
        ) : (
          <IconButton className="small" title="Add drop shadow" onClick={() => setSh({ enabled: true })}>
            <IconPlus size={D} />
          </IconButton>
        )
      }
    >
      {on && sh && (
        <>
          <ColorField value={sh.color} onChange={(c, k) => setSh({ color: c }, k ?? 'sh-c')} />
          <div className="grid3">
            <NumberField label="X" title="Shadow X offset" value={sh.x} precision={0} onChange={(x, k) => setSh({ x }, k ?? 'sh-x')} />
            <NumberField label="Y" title="Shadow Y offset" value={sh.y} precision={0} onChange={(y, k) => setSh({ y }, k ?? 'sh-y')} />
            <NumberField label="Blur" title="Shadow blur" value={sh.blur} min={0} precision={0} onChange={(blur, k) => setSh({ blur }, k ?? 'sh-b')} />
          </div>
        </>
      )}
    </Section>
  );
}
