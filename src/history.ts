import type { Doc, Paint, PhotoEffect, Project, SceneNode, TextStyle } from './types';

// The change log: who changed what, in plain words. It isn't written by each action. It compares
// the project before and after a change, so anything that goes through the store is covered,
// however it got there. It lives beside the project like comments do: out of undo, board copies
// and templates, and saved in project.json.

export const CHANGE_LIMIT = 1000;
const LINE_LIMIT = 30;
const IDS_PER_LINE = 200;

export interface ChangeLine {
  /** Which layers, in words: “Body” or “Body” and 5 more. */
  layer?: string;
  what: string;
  ids?: string[];
}

export interface ChangeEntry {
  id: string;
  at: number;
  who: 'you' | 'claude';
  /** The tool Claude used. */
  via?: string;
  /** Null when it's about the whole project, like a text style. */
  boardId: string | null;
  boardName: string;
  lines: ChangeLine[];
  /** Lines left out of a very big change. */
  more?: number;
  undo?: 'undo' | 'redo';
}

const quote = (s: string, max = 48) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};
const round = (n: number) => Math.round(n * 100) / 100;
const from = (label: string, a: unknown, b: unknown) => `${label} ${a ?? 'none'} → ${b ?? 'none'}`;

function paintWord(p: Paint | string | null | undefined): string {
  if (!p) return 'none';
  if (typeof p === 'string') return p;
  return p.kind === 'solid' ? p.color : `${p.kind} gradient`;
}

const effectName = (e: PhotoEffect) => e.name ?? e.type.charAt(0).toUpperCase() + e.type.slice(1);

function effectLines(a: PhotoEffect[] = [], b: PhotoEffect[] = []): string[] {
  const out: string[] = [];
  const old = new Map(a.map((e) => [e.id, e]));
  const now = new Set(b.map((e) => e.id));
  for (const e of b) {
    const was = old.get(e.id);
    if (!was) out.push(`Added ${effectName(e)} effect`);
    else if (was.enabled !== e.enabled) out.push(`Turned ${e.enabled ? 'on' : 'off'} ${effectName(e)} effect`);
    else if (JSON.stringify(was) !== JSON.stringify(e)) out.push(`Changed ${effectName(e)} effect`);
  }
  for (const e of a) if (!now.has(e.id)) out.push(`Removed ${effectName(e)} effect`);
  return out;
}

/** Settings worth naming. Anything else that changes still shows, under `Changed <setting>`. */
const SIMPLE: Record<string, string> = {
  fontFamily: 'Font',
  fontWeight: 'Weight',
  fontSize: 'Size',
  lineHeight: 'Line height',
  letterSpacing: 'Letter spacing',
  align: 'Align',
  decoration: 'Decoration',
  rotation: 'Rotation',
  radius: 'Corners',
  strokeWidth: 'Border width',
  gap: 'Gap',
  layout: 'Layout',
  justify: 'Distribute',
  alignItems: 'Align items',
  fit: 'Fit',
  sizingH: 'Width sizing',
  sizingV: 'Height sizing',
};
/** Bookkeeping, or covered by something else. */
const QUIET = new Set(['id', 'key', 'type', 'children', 'cloneOf', 'bind']);

/** What differs between two versions of a layer. `free` says its x and y mean something. */
function layerChanges(a: SceneNode, b: SceneNode, free: boolean, styleName: (id?: string) => string | undefined): string[] {
  const out: string[] = [];
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const p = x[k];
    const q = y[k];
    // Syncing rebuilds fills and padding with the same values, which is nothing to report.
    if (p === q || QUIET.has(k) || JSON.stringify(p) === JSON.stringify(q)) continue;
    if (k === 'x' || k === 'y') {
      if (free && !out.includes('Moved')) out.push('Moved');
    } else if (k === 'w' || k === 'h') {
      // Hug and fill sizes are worked out by layout, so they move without anyone asking.
      const fixed = (k === 'w' ? b.sizingH : b.sizingV) === 'fixed';
      const line = `Resized to ${Math.round(b.w)}×${Math.round(b.h)}`;
      if (fixed && !out.includes(line)) out.push(line);
    } else if (k === 'name') out.push(`Renamed to ${quote(String(q))}`);
    else if (k === 'text') out.push(`Text ${quote(String(q))}`);
    else if (k === 'opacity') out.push(from('Opacity', `${Math.round(Number(p) * 100)}%`, `${Math.round(Number(q) * 100)}%`));
    else if (k === 'visible') out.push(q ? 'Showed' : 'Hid');
    else if (k === 'locked') out.push(q ? 'Locked' : 'Unlocked');
    else if (k === 'link') out.push(q ? `Link ${String(q)}` : 'Removed the link');
    else if (k === 'fill') out.push(from('Fill', paintWord(p as Paint), paintWord(q as Paint)));
    else if (k === 'stroke') out.push(from('Border', p, q));
    else if (k === 'effects') out.push(...effectLines(p as PhotoEffect[] | undefined, q as PhotoEffect[] | undefined));
    else if (k === 'assetId') out.push(q ? 'Swapped the photo' : 'Removed the photo');
    else if (k === 'crop') out.push('Changed the crop');
    else if (k === 'adjust') out.push('Adjusted the photo');
    else if (k === 'shadow') out.push(q ? 'Changed the shadow' : 'Removed the shadow');
    else if (k === 'padding') {
      const pad = (v: unknown) => {
        const x = v as { t: number; r: number; b: number; l: number } | undefined;
        if (!x) return 'none';
        return x.t === x.b && x.l === x.r ? (x.t === x.l ? `${round(x.t)}` : `${round(x.t)}/${round(x.l)}`) : `${round(x.t)} ${round(x.r)} ${round(x.b)} ${round(x.l)}`;
      };
      out.push(from('Padding', pad(p), pad(q)));
    } else if (k === 'spans') out.push(q ? 'Styled part of the text' : 'Cleared the styled words');
    else if (k === 'space') out.push('Changed spacing tokens');
    else if (k === 'repeat') out.push(q ? 'Changed the card table' : 'Stopped repeating');
    else if (k === 'uppercase') out.push(q ? 'Uppercase on' : 'Uppercase off');
    else if (k === 'italic') out.push(q ? 'Italic on' : 'Italic off');
    else if (k === 'textStyle') out.push(q ? `Linked to style ${quote(styleName(String(q)) ?? 'unknown')}` : 'Unlinked from its style');
    else if (SIMPLE[k]) out.push(from(SIMPLE[k], typeof p === 'number' ? round(p) : p, typeof q === 'number' ? round(q) : q));
    else out.push(`Changed ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
  }
  return out;
}

interface Placed {
  node: SceneNode;
  parent: SceneNode | null;
}

function flatten(nodes: SceneNode[], parent: SceneNode | null = null, out = new Map<string, Placed>()) {
  for (const node of nodes) {
    out.set(node.id, { node, parent });
    if (node.type === 'frame') flatten(node.children, node, out);
  }
  return out;
}

const layerName = (n: SceneNode) => n.name.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim() || n.type;

function nodeLines(a: Doc, b: Doc, styleName: (id?: string) => string | undefined): ChangeLine[] {
  if (a.nodes === b.nodes) return [];
  const was = flatten(a.nodes);
  const now = flatten(b.nodes);
  const raw: { id: string; name: string; what: string }[] = [];
  for (const [id, { node, parent }] of now) {
    const old = was.get(id);
    if (!old) {
      // One line for a new group, not one per layer inside it.
      if (!parent || was.has(parent.id)) raw.push({ id, name: layerName(node), what: 'Added' });
      continue;
    }
    if (old.parent?.id !== parent?.id) raw.push({ id, name: layerName(node), what: parent ? `Moved into ${quote(layerName(parent))}` : 'Moved out to the top level' });
    if (old.node === node) continue;
    const free = !parent || (parent.type === 'frame' && parent.layout === 'none');
    for (const what of layerChanges(old.node, node, free, styleName)) raw.push({ id, name: layerName(node), what });
  }
  for (const [id, { node, parent }] of was) {
    if (!now.has(id) && (!parent || now.has(parent.id))) raw.push({ id, name: layerName(node), what: 'Deleted' });
  }
  const order = (list: SceneNode[]) => list.map((n) => n.id).join();
  const reordered = (x: SceneNode[], y: SceneNode[]) => order(x) !== order(y) && order([...x].sort((p, q) => p.id.localeCompare(q.id))) === order([...y].sort((p, q) => p.id.localeCompare(q.id)));
  const lines: ChangeLine[] = [];
  if (reordered(a.nodes, b.nodes)) lines.push({ what: 'Changed the layer order' });
  for (const [id, { node }] of now) {
    const old = was.get(id)?.node;
    if (old?.type === 'frame' && node.type === 'frame' && old.children !== node.children && reordered(old.children, node.children)) lines.push({ layer: quote(layerName(node)), what: 'Changed the layer order', ids: [id] });
  }
  // Six cards changing the same way is one line.
  const byWhat = new Map<string, { names: string[]; ids: string[] }>();
  for (const r of raw) {
    const g = byWhat.get(r.what) ?? { names: [], ids: [] };
    g.names.push(r.name);
    g.ids.push(r.id);
    byWhat.set(r.what, g);
  }
  for (const [what, g] of byWhat) {
    const others = new Set(g.ids).size - 1;
    lines.push({ layer: `${quote(g.names[0])}${others > 0 ? ` and ${others} more` : ''}`, what, ids: [...new Set(g.ids)].slice(0, IDS_PER_LINE) });
  }
  return lines;
}

function boardLines(a: Doc, b: Doc, activeBoard: boolean, styleName: (id?: string) => string | undefined): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const say = (what: string) => lines.push({ what });
  if (a.name !== b.name) say(`Renamed the board to ${quote(b.name)}`);
  if (a.status !== b.status) say(b.status ? `Marked ${b.status}` : 'Cleared the pick');
  if (a.note !== b.note) say('Changed the note');
  if (a.background !== b.background) say(from('Background', a.background, b.background));
  if (a.slides.length !== b.slides.length) say(`${b.kind === 'document' ? 'Pages' : 'Slides'} ${a.slides.length} → ${b.slides.length}`);
  else if (a.slides !== b.slides && a.slides.some((s, i) => s.background !== b.slides[i].background)) say('Changed a slide background');
  if (a.slideWidth !== b.slideWidth || (a.slideHeight !== b.slideHeight && !b.autoHeight)) say(`Size ${b.slideWidth}×${b.slideHeight}`);
  if (a.email?.subject !== b.email?.subject) say(`Subject ${quote(b.email?.subject ?? '')}`);
  if (a.email?.preheader !== b.email?.preheader) say(`Preview text ${quote(b.email?.preheader ?? '')}`);
  if (a.email?.tracking !== b.email?.tracking) say('Changed the tracking tags');
  if (a.overlay?.assetId !== b.overlay?.assetId) say(b.overlay ? `Added reference ${quote(b.overlay.name)}` : 'Removed the reference');
  // The tray is shared, so every board gains the photos. Say it once.
  if (activeBoard && a.assetOrder !== b.assetOrder) {
    const added = b.assetOrder.filter((id) => !a.assetOrder.includes(id)).length;
    const removed = a.assetOrder.filter((id) => !b.assetOrder.includes(id)).length;
    if (added) say(`Added ${added} photo${added === 1 ? '' : 's'} to the tray`);
    if (removed) say(`Removed ${removed} photo${removed === 1 ? '' : 's'} from the tray`);
  }
  lines.push(...nodeLines(a, b, styleName));
  return lines;
}

const STYLE_WORDS: [keyof TextStyle, string][] = [
  ['fontFamily', 'Font'],
  ['fontWeight', 'Weight'],
  ['fontSize', 'Size'],
  ['lineHeight', 'Line height'],
  ['letterSpacing', 'Letter spacing'],
  ['italic', 'Italic'],
  ['uppercase', 'Uppercase'],
];

function projectLines(a: Project, b: Project): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const say = (what: string) => lines.push({ what });
  if ((a.brandId ?? null) !== (b.brandId ?? null)) say(b.brandId ? 'Changed the brand' : 'Removed the brand');
  if (a.textStyles !== b.textStyles) {
    const old = new Map((a.textStyles ?? []).map((s) => [s.id, s]));
    for (const s of b.textStyles ?? []) {
      const was = old.get(s.id);
      old.delete(s.id);
      if (!was) say(`Added text style ${quote(s.name)}`);
      else if (was !== s) {
        const parts = STYLE_WORDS.filter(([k]) => was[k] !== s[k]).map(([k, label]) => from(label, was[k], s[k]));
        if (was.name !== s.name) parts.unshift(`renamed from ${quote(was.name)}`);
        if (parts.length) say(`Text style ${quote(s.name)}: ${parts.join(', ')}`);
      }
    }
    for (const s of old.values()) say(`Deleted text style ${quote(s.name)}`);
  }
  if (a.spacing !== b.spacing) {
    const old = new Map((a.spacing ?? []).map((s) => [s.id, s]));
    for (const s of b.spacing ?? []) {
      const was = old.get(s.id);
      old.delete(s.id);
      if (!was) say(`Added spacing token ${quote(s.name)}`);
      else if (was.value !== s.value) say(`Spacing token ${quote(s.name)}: ${was.value} → ${s.value}`);
      else if (was.name !== s.name) say(`Renamed spacing token to ${quote(s.name)}`);
    }
    for (const s of old.values()) say(`Deleted spacing token ${quote(s.name)}`);
  }
  return lines;
}

type Described = Pick<ChangeEntry, 'boardId' | 'boardName' | 'lines' | 'more'>;

function capped(boardId: string | null, boardName: string, lines: ChangeLine[]): Described {
  const more = lines.length - LINE_LIMIT;
  return { boardId, boardName, lines: lines.slice(0, LINE_LIMIT), ...(more > 0 ? { more } : {}) };
}

/** What changed between two versions of a project, one group per board. Empty when nothing did. */
export function describeChanges(prev: Project, next: Project): Described[] {
  if (prev === next) return [];
  const out: Described[] = [];
  const styles = new Map((next.textStyles ?? []).map((s) => [s.id, s.name]));
  const styleName = (id?: string) => (id ? styles.get(id) : undefined);
  const project = projectLines(prev, next);
  const ids = (p: Project) => p.boards.map((b) => b.id).join();
  const removed = prev.boards.filter((b) => !next.boards.some((x) => x.id === b.id));
  const added = next.boards.filter((b) => !prev.boards.some((x) => x.id === b.id));
  if (!added.length && !removed.length && ids(prev) !== ids(next)) project.push({ what: 'Changed the board order' });
  if (project.length) out.push(capped(null, next.name, project));
  for (const b of removed) out.push(capped(b.id, b.name, [{ what: 'Deleted this board' }]));
  for (const b of next.boards) {
    const old = prev.boards.find((x) => x.id === b.id);
    if (!old) {
      out.push(capped(b.id, b.name, [{ what: 'Added this board' }]));
      continue;
    }
    if (old === b) continue;
    const lines = boardLines(old, b, b.id === next.activeBoardId, styleName);
    if (lines.length) out.push(capped(b.id, b.name, lines));
  }
  return out;
}

/**
 * A board's net changes from `a` to `b` as plain lines ("“Title block”: Gap 16 → 12"). Spread uses
 * it to show Claude what the user changed by hand after Claude's last edit, so it can learn from it.
 */
export function describeBoardEdits(a: Doc, b: Doc, max = 60): string[] {
  const lines = boardLines(a, b, true, (id) => id).map((l) => (l.layer ? `${l.layer}: ${l.what}` : l.what));
  return lines.length > max ? [...lines.slice(0, max), `…and ${lines.length - max} more`] : lines;
}

/** Anything from a project file that looks like a log. */
export function readChanges(raw: unknown): ChangeEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e.at === 'number' && Array.isArray(e.lines)).slice(-CHANGE_LIMIT);
}

export interface ChangeFilter {
  who?: 'you' | 'claude';
  boardId?: string;
  layerIds?: string[];
  query?: string;
}

/** Newest first. */
export function filterChanges(log: ChangeEntry[], f: ChangeFilter): ChangeEntry[] {
  const q = f.query?.trim().toLowerCase();
  const ids = f.layerIds ? new Set(f.layerIds) : null;
  const out: ChangeEntry[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    let e = log[i];
    if (f.who && e.who !== f.who) continue;
    if (f.boardId && e.boardId !== f.boardId) continue;
    if (ids || q) {
      const lines = e.lines.filter((l) => (!ids || l.ids?.some((id) => ids.has(id))) && (!q || `${l.layer ?? ''} ${l.what}`.toLowerCase().includes(q)));
      if (!lines.length) continue;
      e = { ...e, lines };
    }
    out.push(e);
  }
  return out;
}

export function timeAgo(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
