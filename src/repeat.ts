import { produce } from 'immer';
import { cloneWithNewIds, deepClone, findNode, locate, makeFrame, pathTo, uid, walk } from './tree';
import { nodeLink } from './links';
import type { Doc, FrameNode, Project, RepeatBind, RepeatSpec, SceneNode } from './types';

// Repeating cards: a frame whose children are generated from a table, one card per row.
//
// The cards are ordinary layers, so the canvas, lint and every exporter treat them like anything
// else. The first card is the source: the others are copies of it with their row's values filled
// in, and their ids are derived from it so they stay the same from one rebuild to the next.
//
// syncRepeats runs on every edit. It reads what changed in a repeat frame and rebuilds it, so a
// card can be edited wherever the user happens to click: a change to a value goes to that card's
// row, and any other change goes to the first card and so to all of them.
//
//   frame (repeat) > line (a row of cards) > card

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_COLUMNS = 6;

export const cardNodeId = (id: string, row: number) => (row === 0 ? id : `${id}_r${row}`);
const cropKey = (field: string) => `${field}#crop`;

/** The real name of a field, however it was typed. */
export function fieldNamed(spec: RepeatSpec, name: string): string | undefined {
  const want = name.trim().toLowerCase();
  return spec.fields.find((f) => f.toLowerCase() === want);
}

function fill(template: string, row: Record<string, string>, spec: RepeatSpec): string {
  return template.replace(TOKEN, (whole, name) => {
    const f = fieldNamed(spec, name);
    return f ? (row[f] ?? '') : whole;
  });
}

const hasField = (text: string, spec: RepeatSpec) => [...text.matchAll(TOKEN)].some((m) => fieldNamed(spec, m[1]));

/** The field a template is nothing but, so an edit to the value can go straight to the row. */
function soleField(template: string, spec: RepeatSpec): string | undefined {
  const m = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(template);
  return m ? fieldNamed(spec, m[1]) : undefined;
}

function applyRow(card: SceneNode, row: Record<string, string>, spec: RepeatSpec) {
  walk([card], (n) => {
    const b = n.bind;
    if (!b) return;
    if (n.type === 'text' && b.text !== undefined) n.text = fill(b.text, row, spec);
    if (n.type === 'image' && b.image) {
      n.assetId = row[b.image] || null;
      const c = row[cropKey(b.image)]?.split(',').map(Number);
      n.crop = c?.length === 3 ? { zoom: c[0], cx: c[1], cy: c[2] } : { zoom: 1, cx: 0.5, cy: 0.5 };
    }
    if (b.link !== undefined) n.link = fill(b.link, row, spec);
    if (b.name !== undefined) n.name = fill(b.name, row, spec); // "Photo [alt:{{unit}}]": alt text per card
  });
}

function cardCopy(source: SceneNode, row: number, spec: RepeatSpec): SceneNode {
  const c = deepClone(source);
  walk([c], (n) => {
    n.cloneOf = n.id;
    n.id = cardNodeId(n.id, row);
    delete n.key; // keys address the first card, so one update reaches every card
  });
  applyRow(c, spec.rows[row], spec);
  return c;
}

const firstCard = (f: FrameNode): SceneNode | undefined => {
  const line = f.children[0];
  return line?.type === 'frame' ? line.children[0] : undefined;
};

/** The repeat frame a layer sits in, if any. */
export function repeatHost(nodes: SceneNode[], id: string): FrameNode | null {
  for (const pid of pathTo(nodes, id)) {
    const n = findNode(nodes, pid);
    if (n?.type === 'frame' && n.repeat) return n;
  }
  return null;
}

/** The layer in the first card that `id` is a copy of (or `id` itself). */
export function sourceLayer(frame: FrameNode, id: string): SceneNode | null {
  const n = findNode(frame.children, id);
  if (!n) return null;
  return n.cloneOf ? findNode(frame.children, n.cloneOf) : n;
}

/** Which row a layer's card belongs to. */
export function rowOf(frame: FrameNode, id: string): number {
  const m = /_r(\d+)$/.exec(id);
  return m && findNode(frame.children, id)?.cloneOf ? Number(m[1]) : 0;
}

export function photoFields(frame: FrameNode): string[] {
  const out = new Set<string>();
  const card = firstCard(frame);
  if (card) walk([card], (n) => void (n.bind?.image && out.add(n.bind.image)));
  return [...out];
}

function rebuild(f: FrameNode, source: SceneNode) {
  const spec = f.repeat!;
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.round(spec.columns) || 1));
  walk([source], (n) => void delete n.cloneOf);
  source.sizingH = 'fill';
  applyRow(source, spec.rows[0], spec);
  const cards = [source, ...spec.rows.slice(1).map((_, i) => cardCopy(source, i + 1, spec))];
  const lines: SceneNode[] = [];
  for (let i = 0; i < cards.length; i += columns) {
    const k = i / columns;
    const line = makeFrame(0, 0, f.w, source.h, {
      fill: null,
      clip: false,
      layout: 'row',
      gap: f.gap,
      padding: { t: 0, r: 0, b: 0, l: 0 },
      sizingH: 'fill',
      sizingV: 'hug',
      name: `Row ${k + 1}`,
      id: `${f.id}_line${k}`,
      cloneOf: f.id,
      children: cards.slice(i, i + columns),
    });
    // An empty cell keeps the last cards the same width as the ones above them.
    for (let e = line.children.length; e < columns; e++) {
      line.children.push(makeFrame(0, 0, 1, 1, { fill: null, clip: false, layout: 'column', padding: { t: 0, r: 0, b: 0, l: 0 }, sizingH: 'fill', name: 'Empty', id: `${f.id}_empty${e}`, cloneOf: f.id }));
    }
    lines.push(line);
  }
  f.layout = 'column';
  f.children = lines;
}

const NEVER_SHARED = new Set(['id', 'key', 'cloneOf', 'bind', 'children', 'repeat', 'name', 'x', 'y']);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** An edited value on a text or link: a new template, a cell, or (with no field) the same words on every card. */
function editValue(source: SceneNode, kind: 'text' | 'link', typed: string, row: Record<string, string>, spec: RepeatSpec, notes: string[]) {
  const template = source.bind?.[kind];
  if (hasField(typed, spec)) source.bind = { ...source.bind, [kind]: typed };
  else if (template === undefined) (source as any)[kind] = typed;
  else {
    const f = soleField(template, spec);
    if (f) row[f] = typed;
    else notes.push(`That ${kind === 'text' ? 'text' : 'link'} is built from ${template}. Change it in the table, or type it again with {{fields}}.`);
  }
}

function applyEdit(source: SceneNode, before: SceneNode, after: SceneNode, r: number, spec: RepeatSpec, notes: string[]) {
  const row = spec.rows[r];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = (before as any)[key];
    const now = (after as any)[key];
    if (same(was, now)) continue;
    const photo = source.bind?.image;
    if (key === 'link' && now === undefined) {
      delete source.link;
      if (source.bind) delete source.bind.link;
    } else if (key === 'text' || key === 'link') editValue(source, key, now ?? '', row, spec, notes);
    else if (key === 'name') {
      if (hasField(now, spec)) source.bind = { ...source.bind, name: now };
      else if (r === 0 && source.bind) delete source.bind.name;
    }
    else if (key === 'assetId' && photo) row[photo] = now ?? '';
    else if (key === 'crop' && photo) row[cropKey(photo)] = `${now.zoom},${now.cx},${now.cy}`;
    else if (r > 0 && !NEVER_SHARED.has(key)) {
      if (now === undefined) delete (source as any)[key];
      else (source as any)[key] = deepClone(now);
    }
  }
}

function indexOf(f: FrameNode): Map<string, SceneNode> {
  const m = new Map<string, SceneNode>();
  walk(f.children, (n) => void m.set(n.id, n));
  return m;
}

/** Works out what changed in a repeat frame and returns it rebuilt. `frame` and `prev` are read, never written. */
function reconcile(board: Doc, frame: FrameNode, prev: FrameNode | null, notes: string[]): FrameNode {
  const f = deepClone(frame);
  const spec = f.repeat!;
  const prevSource = prev && firstCard(prev);
  if (!prev || !prevSource) {
    const source = firstCard(f);
    if (source) rebuild(f, source);
    return f;
  }

  const now = indexOf(frame);
  const was = indexOf(prev);
  const work = indexOf(f);
  const goneRows = new Set<number>();
  const goneLayers = new Set<string>();

  // The first card is deleted: the card after it takes its place, so it comes back with the next row's values.
  let source = work.get(prevSource.id);
  if (!source) {
    goneRows.add(0);
    if (spec.rows.length > 1) source = findNode(board.nodes, prevSource.id) ? cloneWithNewIds(deepClone(prevSource)) : deepClone(prevSource);
  }
  if (!source) {
    delete f.repeat;
    f.children = [];
    return f;
  }

  const sourceIds: string[] = [];
  walk([prevSource], (n) => void sourceIds.push(n.id));
  for (const id of sourceIds) {
    const target = id === prevSource.id ? source : findNode([source], id);
    if (!target) continue;
    for (let r = 0; r < spec.rows.length; r++) {
      const nodeId = cardNodeId(id, r);
      const before = was.get(nodeId);
      const after = now.get(nodeId);
      if (!before) continue;
      if (!after) {
        if (r === 0 || goneRows.has(r)) continue;
        if (id === prevSource.id) goneRows.add(r);
        else goneLayers.add(id);
      } else if (after !== before) applyEdit(target, before, after, r, spec, notes);
    }
  }

  if (goneLayers.size) {
    const drop = (list: SceneNode[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (goneLayers.has(n.id)) list.splice(i, 1);
        else if (n.type === 'frame') drop(n.children);
      }
    };
    if (source.type === 'frame') drop(source.children);
  }
  spec.rows = spec.rows.filter((_, r) => !goneRows.has(r));
  if (!spec.rows.length) {
    delete f.repeat;
    f.children = [];
    return f;
  }
  rebuild(f, source);
  return f;
}

function repeatFrames(nodes: SceneNode[]): FrameNode[] {
  const out: FrameNode[] = [];
  walk(nodes, (n) => {
    if (n.type === 'frame' && n.repeat) {
      out.push(n);
      return false;
    }
  });
  return out;
}

/** Copies dragged or pasted out of a repeat become plain layers, so their ids can't clash with a rebuild. */
function strays(nodes: SceneNode[]): boolean {
  let found = false;
  walk(nodes, (n) => {
    if (n.type === 'frame' && n.repeat) return false;
    if (n.cloneOf) found = true;
  });
  return found;
}

function release(nodes: SceneNode[]) {
  walk(nodes, (n) => {
    if (n.type === 'frame' && n.repeat) return false;
    if (n.cloneOf) {
      n.id = uid();
      delete n.cloneOf;
      delete n.bind;
    }
  });
}

/** Keeps every repeat on the changed boards in step with its table. Part of the same undo step as the edit. */
export function syncRepeats(next: Project, prev: Project): { project: Project; notes: string[]; changed: boolean } {
  const notes: string[] = [];
  let project = next;
  for (const board of next.boards) {
    const old = prev.boards.find((b) => b.id === board.id);
    if (old?.nodes === board.nodes) continue;
    const before = new Map(old ? repeatFrames(old.nodes).map((f) => [f.id, f]) : []);
    const edits = repeatFrames(board.nodes)
      .filter((f) => before.get(f.id) !== f)
      .map((f) => ({ id: f.id, frame: reconcile(board, f, before.get(f.id) ?? null, notes) }));
    const loose = strays(board.nodes);
    if (!edits.length && !loose) continue;
    project = produce(project, (p) => {
      const b = p.boards.find((x) => x.id === board.id)!;
      if (loose) release(b.nodes);
      for (const e of edits) {
        const at = locate(b.nodes, e.id);
        if (at) at.list[at.index] = e.frame;
      }
    });
  }
  return { project, notes, changed: project !== next };
}

// ---------- starting, changing and stopping a repeat ----------

const plainName = (n: SceneNode, fallback: string) => {
  const name = n.name.replace(/\s*\[[^\]]*\]/g, '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  return n.key || (name && name.length <= 24 && !(n.type === 'text' && n.text.startsWith(name)) ? name : fallback);
};

function freeField(spec: RepeatSpec, name: string): string {
  let out = name;
  for (let i = 2; fieldNamed(spec, out); i++) out = `${name} ${i}`;
  return out;
}

/** Makes a layer in the first card change per card, taking its current value into every row. */
export function bindLayer(spec: RepeatSpec, n: SceneNode, name?: string): string | null {
  if (n.type !== 'text' && n.type !== 'image') return null;
  const field = name ? (fieldNamed(spec, name) ?? name) : freeField(spec, plainName(n, n.type === 'image' ? 'Photo' : 'Text'));
  if (!spec.fields.includes(field)) spec.fields.push(field);
  const value = n.type === 'text' ? n.text : (n.assetId ?? '');
  for (const row of spec.rows) row[field] ??= value;
  if (n.type === 'image') {
    for (const row of spec.rows) row[cropKey(field)] ??= `${n.crop.zoom},${n.crop.cx},${n.crop.cy}`;
    n.bind = { ...n.bind, image: field };
  } else n.bind = { ...n.bind, text: `{{${field}}}` };
  return field;
}

/** Back to one shared value. A field nothing uses any more leaves the table. */
export function unbindLayer(frame: FrameNode, n: SceneNode) {
  const b: RepeatBind = { ...n.bind };
  delete b.text;
  delete b.image;
  if (Object.keys(b).length) n.bind = b;
  else delete n.bind;
  const spec = frame.repeat!;
  const card = firstCard(frame);
  const used = new Set<string>();
  if (card)
    walk([card], (x) => {
      if (x.bind?.image) used.add(x.bind.image);
      for (const t of [x.bind?.text, x.bind?.link, x.bind?.name]) for (const m of (t ?? '').matchAll(TOKEN)) used.add(fieldNamed(spec, m[1]) ?? m[1]);
    });
  for (const f of spec.fields.filter((x) => !used.has(x))) {
    spec.fields = spec.fields.filter((x) => x !== f);
    for (const row of spec.rows) {
      delete row[f];
      delete row[cropKey(f)];
    }
  }
}

/** Text and links already written with {{fields}} add those columns and fill from them. */
function bindTokens(card: SceneNode, spec: RepeatSpec) {
  walk([card], (n) => {
    const values: ['text' | 'link' | 'name', string | undefined][] = [['text', n.type === 'text' ? n.text : undefined], ['link', nodeLink(n)], ['name', n.name]];
    for (const [kind, value] of values) {
      const tokens = [...(value ?? '').matchAll(TOKEN)].map((m) => m[1]);
      if (!tokens.length) continue;
      for (const t of tokens) {
        if (!fieldNamed(spec, t)) spec.fields.push(t);
        for (const row of spec.rows) row[fieldNamed(spec, t)!] ??= '';
      }
      n.bind = { ...n.bind, [kind]: value };
    }
  });
}

function bindCard(card: SceneNode, spec: RepeatSpec) {
  const urls = new Map<string, string>();
  walk([card], (n) => {
    if (n.bind?.text === undefined) bindLayer(spec, n);
    const url = nodeLink(n);
    if (url === undefined || n.bind?.link !== undefined) return;
    // Layers that share a link share a column.
    let field = urls.get(url);
    if (!field) {
      field = freeField(spec, 'Link');
      urls.set(url, field);
      spec.fields.push(field);
      for (const row of spec.rows) row[field] = url;
    }
    n.bind = { ...n.bind, link: `{{${field}}}` };
  });
}

export interface StartRepeat {
  columns?: number;
  gap?: number;
  /** Which layers fill from which column: { field: layer }. Leaves every other layer the same on all cards. */
  fields?: Record<string, SceneNode>;
  links?: Record<string, SceneNode>;
}

/** Turns a layer into the first card of a repeat, in the same spot. Returns the new frame's id. Use inside `change()`. */
export function startRepeat(d: Doc, cardId: string, opts: StartRepeat = {}): string {
  if (repeatHost(d.nodes, cardId)) throw new Error('That layer is already in a repeat.');
  const at = locate(d.nodes, cardId);
  if (!at) throw new Error('Layer not found.');
  const card = at.list[at.index];
  let nested = false;
  walk([card], (n) => void (n.type === 'frame' && n.repeat && (nested = true)));
  if (nested) throw new Error("A repeat can't go inside another repeat.");

  const columns = opts.columns ?? 1;
  const gap = opts.gap ?? 16;
  const spec: RepeatSpec = { fields: [], rows: [{}], columns };
  if (opts.fields || opts.links) {
    for (const [field, n] of Object.entries(opts.fields ?? {})) bindLayer(spec, n, field);
    for (const [field, n] of Object.entries(opts.links ?? {})) {
      if (!spec.fields.includes(field)) spec.fields.push(field);
      spec.rows[0][field] = nodeLink(n) ?? '';
      n.bind = { ...n.bind, link: `{{${field}}}` };
    }
    bindTokens(card, spec);
  } else {
    bindTokens(card, spec);
    bindCard(card, spec);
  }

  const inAuto = !!at.parent && at.parent.layout !== 'none';
  const frame = makeFrame(card.x, card.y, card.w * columns + gap * (columns - 1), card.h, {
    id: uid(),
    name: `Repeat / ${plainName(card, 'Card')}`,
    fill: null,
    clip: false,
    layout: 'column',
    gap,
    padding: { t: 0, r: 0, b: 0, l: 0 },
    sizingH: inAuto ? 'fill' : 'fixed',
    sizingV: 'hug',
    repeat: spec,
    children: [makeFrame(0, 0, card.w, card.h, { id: uid(), layout: 'row', children: [card] })],
  });
  at.list[at.index] = frame;
  return frame.id;
}

/** Keeps the cards as plain layers and forgets the table. Use inside `change()`. */
export function stopRepeat(f: FrameNode) {
  delete f.repeat;
  walk(f.children, (n) => {
    delete n.cloneOf;
    delete n.bind;
  });
}

/** Replaces the table. Cells are matched to fields by name; columns left out keep the first row's value. */
export function setRows(spec: RepeatSpec, rows: Record<string, string>[]) {
  const first = spec.rows[0] ?? {};
  spec.rows = rows.map((row) => {
    const out: Record<string, string> = {};
    for (const f of spec.fields) out[f] = first[f] ?? '';
    for (const [k, v] of Object.entries(row)) {
      const f = fieldNamed(spec, k);
      if (f) out[f] = String(v ?? '');
    }
    return out;
  });
}

/** Renames a column everywhere it's used. Use inside `change()`. */
export function renameField(f: FrameNode, from: string, to: string) {
  const spec = f.repeat!;
  const name = to.trim();
  if (!name || /[{}#]/.test(name) || (fieldNamed(spec, name) && fieldNamed(spec, name) !== from)) return;
  spec.fields = spec.fields.map((x) => (x === from ? name : x));
  for (const row of spec.rows) {
    row[name] = row[from] ?? '';
    if (name !== from) delete row[from];
    if (row[cropKey(from)] !== undefined) {
      const crop = row[cropKey(from)];
      delete row[cropKey(from)];
      row[cropKey(name)] = crop;
    }
  }
  const swap = (t: string) => t.replace(TOKEN, (whole, n) => (n.toLowerCase() === from.toLowerCase() ? `{{${name}}}` : whole));
  const card = firstCard(f);
  if (!card) return;
  walk([card], (n) => {
    if (!n.bind) return;
    n.bind = {
      ...n.bind,
      ...(n.bind.text !== undefined ? { text: swap(n.bind.text) } : {}),
      ...(n.bind.link !== undefined ? { link: swap(n.bind.link) } : {}),
      ...(n.bind.name !== undefined ? { name: swap(n.bind.name) } : {}),
      ...(n.bind.image === from ? { image: name } : {}),
    };
  });
}

/** Tab-separated text, as spreadsheets copy it. */
export function parseTable(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.split('\t').map((c) => c.trim()));
}
