import { create } from 'zustand';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { extFor, getAsset, registerFont, registerImage } from './assets';
import { slugify } from './brand';
import { emailRootOf, insertSectionNode } from './email/boards';
import { renderBoardStripBase64, renderSlidesBase64 } from './exporter';
import { native, type LibraryKind, type LibraryMeta } from './platform';
import { currentLayout, useStore } from './store';
import { cloneBoard, cloneWithNewIds, collectAssetIds, deepClone, findNode, uid, walk } from './tree';
import { adoptTokens, carriedBy, type CarriedTokens } from './tokens';
import type { AssetMeta, BoardKind, Doc, FrameNode, SceneNode } from './types';

// The design library: work worth keeping, saved outside any project so every new project can use
// it. Templates are boards (or single email sections) to start from; they carry their photos and
// fonts in a template.spread zip. References are designs the user rates highly: renders plus the
// board's layers and a line on why it works, which Claude looks at before designing something
// similar. Both live in ~/.spread (electron/library.cjs).

export interface TemplateMeta extends LibraryMeta {
  /** board: a whole board to start from; section: one email section to insert. */
  scope: 'board' | 'section';
  boardKind: BoardKind;
  brandId: string | null;
  description?: string;
  width: number;
  height: number;
  slideCount: number;
  /** Thumbnail file in the template's folder. */
  thumb?: string;
}

export interface ReferenceMeta extends LibraryMeta {
  boardKind: BoardKind;
  brandId: string | null;
  /** What makes it good, in the user's words. */
  why: string;
  /** The board's own note (its concept) when it was saved. */
  note?: string;
  project?: string;
  size: string;
  /** Render files in the reference's folder: the whole board first, then single slides. */
  images: string[];
}

export type Saved<T> = T & { dir: string };

export const useLibrary = create<{ templates: Saved<TemplateMeta>[]; references: Saved<ReferenceMeta>[]; loaded: boolean }>(() => ({
  templates: [],
  references: [],
  loaded: false,
}));

export async function loadLibrary() {
  if (!native) return useLibrary.setState({ loaded: true });
  try {
    const [templates, references] = await Promise.all([native.libraryList<TemplateMeta>('templates'), native.libraryList<ReferenceMeta>('references')]);
    useLibrary.setState({ templates, references, loaded: true });
  } catch (e) {
    console.warn('Could not load the library', e);
    useLibrary.setState({ loaded: true });
  }
}

function requireNative() {
  if (!native) throw new Error('The library needs the Spread desktop app');
  return native;
}

const newId = (name: string) => `${slugify(name).slice(0, 40)}-${uid().slice(0, 6).replace(/[^a-zA-Z0-9]/g, 'x')}`;
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const boardOf = (id?: string) => {
  const p = useStore.getState().project;
  const b = p.boards.find((x) => x.id === (id ?? p.activeBoardId));
  if (!b) throw new Error(`Unknown boardId "${id}"`);
  return b;
};

// ---------- templates ----------

/** The assets a set of layers needs: its photos, and the uploaded fonts its text is set in. */
function assetsFor(board: Doc, nodes: SceneNode[]): AssetMeta[] {
  const photos = collectAssetIds(nodes);
  const families = new Set<string>();
  walk(nodes, (n) => {
    if (n.type === 'text') families.add(n.fontFamily);
  });
  return Object.values(board.assets).filter((a) => (a.kind === 'font' ? families.has(a.family ?? '') : photos.has(a.id)));
}

async function packTemplate(board: Doc, nodes: SceneNode[]): Promise<Uint8Array> {
  const metas = assetsFor(board, nodes);
  const b = deepClone(board);
  b.nodes = deepClone(nodes);
  b.status = null;
  b.statusReason = null;
  b.assets = Object.fromEntries(metas.map((m) => [m.id, m]));
  b.assetOrder = metas.filter((m) => m.kind === 'image').map((m) => m.id);
  const tokens = carriedBy(useStore.getState().project, nodes);
  const files: Zippable = { 'template.json': [strToU8(JSON.stringify({ app: 'spread', version: 1, board: b, tokens })), { level: 6 }] };
  for (const m of metas) {
    const rec = getAsset(m.id);
    if (rec) files[`assets/${m.id}.${extFor(m)}`] = [new Uint8Array(await rec.blob.arrayBuffer()), { level: m.kind === 'font' ? 6 : 0 }];
  }
  return zipSync(files);
}

/**
 * Reads a template and makes its assets available in the open project. Photos listed in
 * `photoIds` replace the template's photos in order (the rest keep the template's own).
 */
async function unpackTemplate(t: Saved<TemplateMeta>, photoIds: string[] = []): Promise<Doc> {
  const entries = unzipSync((await requireNative().readFile(`${t.dir}/template.spread`)).data);
  const { board, tokens } = JSON.parse(strFromU8(entries['template.json'])) as { board: Doc; tokens?: CarriedTokens };
  useStore.getState().changeProject((p) => adoptTokens(p, tokens, board.nodes));
  const tray = useStore.getState().doc.assets;
  const swap = photoIds.filter((id) => tray[id]?.kind === 'image');
  let i = 0;
  walk(board.nodes, (n) => {
    if (n.type === 'image' && i < swap.length) n.assetId = swap[i++];
  });
  const keep = new Set([...collectAssetIds(board.nodes)]);
  const added: AssetMeta[] = [];
  for (const m of Object.values(board.assets)) {
    if (m.kind === 'image' && !keep.has(m.id)) {
      delete board.assets[m.id];
      continue;
    }
    if (tray[m.id] && getAsset(m.id)) continue;
    const name = Object.keys(entries).find((k) => k.startsWith(`assets/${m.id}.`));
    if (!name) continue;
    const blob = new Blob([entries[name] as BlobPart], { type: m.mime });
    if (!getAsset(m.id)) {
      if (m.kind === 'font') await registerFont(blob, m.name, m.id, m.family);
      else await registerImage(blob, m.name, m.id);
    }
    added.push(m);
  }
  board.assetOrder = board.assetOrder.filter((id) => board.assets[id]);
  if (added.length) {
    const s = useStore.getState();
    s.addAssets(added);
    if (added.some((m) => m.kind === 'font')) s.bumpFonts();
  }
  return board;
}

/** Saves a whole board, or one email section (sectionId), as a template. */
export async function saveTemplate(opts: { boardId?: string; sectionId?: string; name: string; description?: string }): Promise<Saved<TemplateMeta>> {
  const n = requireNative();
  const board = boardOf(opts.boardId);
  const name = opts.name.trim() || board.name;
  const brandId = useStore.getState().project.brandId ?? null;
  const base = { id: newId(name), name, createdAt: Date.now(), brandId, ...(opts.description?.trim() ? { description: opts.description.trim() } : {}) };
  let meta: TemplateMeta;
  const files: { name: string; data: Uint8Array }[] = [];
  if (opts.sectionId) {
    const node = findNode(board.nodes, opts.sectionId);
    if (!node || node.type !== 'frame') throw new Error('Pick a section (a frame) to save as a template.');
    const box = board.id === useStore.getState().project.activeBoardId ? currentLayout().get(node.id) : undefined;
    const section: FrameNode = { ...deepClone(node), x: 0, y: 0 };
    files.push({ name: 'template.spread', data: await packTemplate(board, [section]) });
    meta = { ...base, scope: 'section', boardKind: board.kind, width: Math.round(box?.w ?? node.w), height: Math.round(box?.h ?? node.h), slideCount: 1 };
  } else {
    files.push({ name: 'template.spread', data: await packTemplate(board, board.nodes) });
    const thumb = await renderBoardStripBase64(board.id, 900);
    files.push({ name: 'thumb.jpg', data: bytesOf(thumb.base64) });
    meta = { ...base, scope: 'board', boardKind: board.kind, width: board.slideWidth, height: board.slideHeight, slideCount: board.slides.length, thumb: 'thumb.jpg' };
  }
  const saved = await n.librarySave({ kind: 'templates', meta, files });
  useLibrary.setState((s) => ({ templates: [saved, ...s.templates.filter((x) => x.id !== saved.id)] }));
  return saved;
}

const templateById = (id: string) => {
  const t = useLibrary.getState().templates.find((x) => x.id === id.replace(/^saved:/, ''));
  if (!t) throw new Error(`Unknown template "${id}". Saved templates: ${useLibrary.getState().templates.map((x) => x.id).join(', ') || 'none'}`);
  return t;
};

/** Adds a board from a saved template below the active one and makes it active. Returns its id. */
export async function createFromTemplate(id: string, opts: { name?: string; note?: string; photoIds?: string[] } = {}): Promise<string> {
  const t = templateById(id);
  if (t.scope !== 'board') throw new Error(`"${t.name}" is a section; insert it into an email board instead.`);
  const board = cloneBoard(await unpackTemplate(t, opts.photoIds), opts.name ?? t.name);
  board.statusReason = null;
  if (opts.note !== undefined) board.note = opts.note;
  const s = useStore.getState();
  const boardId = s.addBoard(board, s.project.activeBoardId);
  requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
  return boardId;
}

/** Inserts a saved section into the active email board. Returns the new section's id. */
export async function insertSavedSection(id: string, opts: { index?: number; photoIds?: string[]; afterSelection?: boolean } = {}): Promise<string> {
  const t = templateById(id);
  if (t.scope !== 'section') throw new Error(`"${t.name}" is a whole board, not a section.`);
  if (!emailRootOf(useStore.getState().doc)) throw new Error('Sections go into an email board. Make an email row active first.');
  const board = await unpackTemplate(t, opts.photoIds);
  const node = board.nodes[0];
  if (!node || node.type !== 'frame') throw new Error(`Template "${t.name}" is empty.`);
  const sectionId = insertSectionNode(cloneWithNewIds(node), opts.index, opts.afterSelection);
  if (!sectionId) throw new Error('Could not insert the section.');
  return sectionId;
}

// ---------- references ----------

/** Saves a board as a reference: renders, its layers, and why it's good. */
export async function saveReference(opts: { boardId?: string; name?: string; why: string }): Promise<Saved<ReferenceMeta>> {
  const n = requireNative();
  const board = boardOf(opts.boardId);
  const s = useStore.getState();
  const name = opts.name?.trim() || board.name;
  const files: { name: string; data: Uint8Array }[] = [];
  const images: string[] = [];
  const strip = await renderBoardStripBase64(board.id, 2400);
  files.push({ name: 'board.jpg', data: bytesOf(strip.base64) });
  images.push('board.jpg');
  if (board.slides.length > 1) {
    const shots = await renderSlidesBase64([...board.slides.keys()].slice(0, 12), Math.min(1, 900 / board.slideWidth), board.id);
    for (const shot of shots) {
      const file = `slide-${String(shot.index + 1).padStart(2, '0')}.jpg`;
      files.push({ name: file, data: bytesOf(shot.base64) });
      images.push(file);
    }
  }
  const layers = { name: board.name, kind: board.kind, note: board.note ?? null, slideWidth: board.slideWidth, slideHeight: board.slideHeight, slideCount: board.slides.length, background: board.background, page: board.page ?? null, email: board.email ?? null, nodes: board.nodes };
  files.push({ name: 'board.json', data: strToU8(JSON.stringify(layers, null, 1)) });
  const units = board.page?.units ?? 'px';
  const meta: ReferenceMeta = {
    id: newId(name),
    name,
    createdAt: Date.now(),
    boardKind: board.kind,
    brandId: s.project.brandId ?? null,
    why: opts.why.trim(),
    ...(board.note ? { note: board.note } : {}),
    project: s.filePath?.split(/[\\/]/).pop()?.replace(/\.spread$/i, '') ?? undefined,
    size: `${board.slideWidth}×${board.kind === 'email' ? 'auto' : board.slideHeight}${units}, ${board.slides.length} ${board.kind === 'document' ? 'page' : board.kind === 'email' ? 'email' : 'slide'}${board.slides.length > 1 ? 's' : ''}`,
    images,
  };
  const saved = await n.librarySave({ kind: 'references', meta, files });
  useLibrary.setState((st) => ({ references: [saved, ...st.references.filter((x) => x.id !== saved.id)] }));
  return saved;
}

export async function deleteLibraryItem(kind: LibraryKind, id: string) {
  await requireNative().libraryDelete({ kind, id });
  useLibrary.setState((s) => (kind === 'templates' ? { templates: s.templates.filter((x) => x.id !== id) } : { references: s.references.filter((x) => x.id !== id) }));
}

/** What Claude gets from spread_list_library: absolute paths, so it can open the renders. */
export function libraryForClaude(filter: { boardKind?: BoardKind } = {}) {
  const { templates, references } = useLibrary.getState();
  const brandId = useStore.getState().project.brandId ?? null;
  const fits = (x: { boardKind: BoardKind; brandId: string | null }) => (!filter.boardKind || x.boardKind === filter.boardKind) && (x.brandId === null || x.brandId === brandId);
  return {
    templates: templates.filter(fits).map((t) => ({
      id: `saved:${t.id}`,
      name: t.name,
      scope: t.scope,
      boardKind: t.boardKind,
      brandId: t.brandId,
      description: t.description ?? null,
      size: `${t.width}×${t.boardKind === 'email' ? 'auto' : t.height}`,
      ...(t.thumb ? { thumb: `${t.dir}/${t.thumb}` } : {}),
    })),
    references: references.filter(fits).map((r) => ({
      id: r.id,
      name: r.name,
      boardKind: r.boardKind,
      brandId: r.brandId,
      why: r.why,
      note: r.note ?? null,
      size: r.size,
      images: r.images.map((f) => `${r.dir}/${f}`),
      layers: `${r.dir}/board.json`,
    })),
    note: 'Templates and references from other brands are left out. Open a reference\'s images with Read before designing something similar; layers has exact fonts, sizes and spacing.',
  };
}
