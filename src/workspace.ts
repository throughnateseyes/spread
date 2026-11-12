import { strFromU8, unzipSync } from 'fflate';
import { produce } from 'immer';
import { create } from 'zustand';
import { extFor, getAsset, removeAsset } from './assets';
import { clipAssetIds } from './clipboard';
import { renderSlidesBase64 } from './exporter';
import { brandById } from './brand';
import { native, writeToPath, type ProjectIndex, type ProjectRecord } from './platform';
import { clearAutosave, flushSave, loadProjectBytes, readProjectFile, restoreAutosave, rewriteProjectFile, safeFileName, serializeProjectData } from './project';
import { useStore } from './store';
import { collectAssetIds, deepClone, makeDoc, makeDocumentBoard, makeEmailBoard, makeProject, migrateProject, uid, walk } from './tree';
import { adoptTokens, carriedBy, type CarriedTokens } from './tokens';
import type { AssetMeta, BoardKind, Doc, Project } from './types';

// The desktop app's projects: the Home list, its folders, and the open tabs. Every project is a
// .spread file. Tabs share this one window: switching parks the open project's state (its undo
// history and view too) and puts the other one's back, so switching is instant and nothing is lost.
// Folders only exist in the index; a project's file never moves.

export const fileName = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.spread$/i, '');

const KIND_LABEL: Record<BoardKind, string> = { carousel: 'Social', email: 'Email', document: 'Pages' };
export const kindLabel = (k?: BoardKind) => (k ? KIND_LABEL[k] : 'Project');

interface Workspace {
  ready: boolean;
  /** A project is taking a moment to read from disk. */
  loading: boolean;
  folders: ProjectIndex['folders'];
  projects: ProjectRecord[];
  hidden: string[];
  /** Open tabs, as file paths, in strip order. */
  tabs: string[];
  /** The tab whose project is loaded in the editor. */
  active: string | null;
  /** In-app Claudes working outside their own project: chat's project → the project it moved to. Not saved. */
  claude: Record<string, string>;
}

export const useWorkspace = create<Workspace>(() => ({ ready: false, loading: false, folders: [], projects: [], hidden: [], tabs: [], active: null, claude: {} }));

const PARKED = ['project', 'doc', 'past', 'future', 'lastKey', 'lastKeyAt', 'editLog', 'selection', 'traySelection', 'view', 'comments', 'changes', 'filePath', 'dirty'] as const;
type Parked = Pick<ReturnType<typeof useStore.getState>, (typeof PARKED)[number]>;
const parked = new Map<string, Parked>();

/** Old path → new, so a Claude started before a rename still finds its project. */
const renamed = new Map<string, string>();
let swapping = false;

/** Tab changes run one at a time, so a quick double switch can't interleave. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- the index on disk ----------

let writeTimer: ReturnType<typeof setTimeout> | null = null;
function writeIndex() {
  const w = useWorkspace.getState();
  return native?.projectsWrite({ version: 1, folders: w.folders, projects: w.projects, hidden: w.hidden, tabs: w.tabs, activeTab: w.active, home: useStore.getState().homeOpen });
}

function persist() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeIndex();
  }, 300);
}

function setWorkspace(patch: Partial<Workspace>) {
  useWorkspace.setState(patch);
  persist();
}

function patchRecord(path: string, patch: Partial<ProjectRecord>) {
  const { projects } = useWorkspace.getState();
  const known = projects.some((p) => p.path === path);
  setWorkspace({
    projects: known ? projects.map((p) => (p.path === path ? { ...p, ...patch } : p)) : [{ id: uid().slice(0, 8), path, folderId: null, openedAt: 0, ...patch }, ...projects],
    hidden: useWorkspace.getState().hidden.filter((h) => h !== path),
  });
}

function describe(p: Project) {
  const counts = new Map<BoardKind, number>();
  for (const b of p.boards) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  return { kinds: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k), boards: p.boards.length };
}

// ---------- thumbnails ----------

let thumbAt = 0;

/** Renders the active board's first slide for the Home card. */
async function captureThumb() {
  const s = useStore.getState();
  const path = s.filePath;
  if (!native || !path || (!s.doc.nodes.length && !s.doc.assetOrder.length)) return;
  thumbAt = Date.now();
  try {
    const [shot] = await renderSlidesBase64([0], Math.min(1, 720 / s.doc.slideWidth, 2400 / s.doc.slideHeight));
    await native.projectThumb({ path, data: Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0)) });
    patchRecord(path, { thumbV: Date.now(), updatedAt: Date.now() });
  } catch (e) {
    console.warn('Could not render the thumbnail', e);
  }
}

/** After an autosave: refresh the card's details, and its picture every so often. */
export function noteSaved() {
  const s = useStore.getState();
  if (!s.filePath) return;
  patchRecord(s.filePath, { ...describe(s.project), updatedAt: Date.now() });
  if (Date.now() - thumbAt > 15_000) void captureThumb();
}

/** Fills in cards for files that were never opened here, from the file itself. */
async function backfill() {
  for (const p of [...useWorkspace.getState().projects]) {
    if (p.kinds || p.missing || !native) continue;
    try {
      const { data } = await native.readFile(p.path);
      const raw = unzipSync(data, { filter: (f) => f.name === 'project.json' })['project.json'];
      const json = JSON.parse(strFromU8(raw));
      const project = migrateProject(json.project ?? json.doc);
      const patch: Partial<ProjectRecord> = describe(project);
      const board = project.boards.find((b) => b.id === project.activeBoardId) ?? project.boards[0];
      const meta = board?.assetOrder.map((id) => board.assets[id]).find((m) => m?.kind === 'image');
      if (meta) {
        const name = `assets/${meta.id}.${extFor(meta)}`;
        const bytes = unzipSync(data, { filter: (f) => f.name === name })[name];
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: meta.mime }), { resizeWidth: 720, resizeQuality: 'medium' });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (jpeg) {
          await native.projectThumb({ path: p.path, data: new Uint8Array(await jpeg.arrayBuffer()) });
          patch.thumbV = Date.now();
        }
      }
      patchRecord(p.path, patch);
    } catch (e) {
      console.warn('Could not read', p.path, e);
      patchRecord(p.path, { kinds: [], boards: 0 });
    }
  }
}

// ---------- tabs ----------

function park() {
  const s = useStore.getState();
  if (!s.filePath) return;
  parked.set(s.filePath, Object.fromEntries(PARKED.map((k) => [k, s[k]])) as Parked);
}

function fit() {
  requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
}

const drafts = { commentDraft: null, openComment: null, editingTextId: null, croppingId: null, modal: null };

/** Loads a project into the editor: from its parked state, else from its file. */
async function bring(path: string): Promise<boolean> {
  const snap = parked.get(path);
  swapping = true;
  try {
    if (snap) {
      useStore.setState({ ...snap, ...drafts });
      parked.delete(path);
      return true;
    }
    const slow = setTimeout(() => useWorkspace.setState({ loading: true }), 150);
    try {
      const { data } = await native!.readFile(path);
      return await loadProjectBytes(data, path);
    } finally {
      clearTimeout(slow);
      useWorkspace.setState({ loading: false });
    }
  } catch (e) {
    useStore.getState().toast(`Couldn't open ${fileName(path)}: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    swapping = false;
  }
}

function showEditor() {
  if (useStore.getState().homeOpen) useStore.setState({ homeOpen: false });
}

async function activate(path: string): Promise<boolean> {
  const w = useWorkspace.getState();
  if (w.active === path && useStore.getState().filePath === path) {
    showEditor();
    persist();
    return true;
  }
  await flushSave();
  if (useStore.getState().filePath) {
    if (Date.now() - thumbAt > 15_000 && useStore.getState().past.length) await captureThumb();
    park();
  }
  if (!(await bring(path))) {
    // Back to whatever was open.
    const back = useStore.getState().filePath;
    if (back) parked.delete(back);
    return false;
  }
  const { project } = useStore.getState();
  patchRecord(path, { ...describe(project), openedAt: Date.now() });
  setWorkspace({ active: path, tabs: w.tabs.includes(path) ? w.tabs : [...w.tabs, path] });
  showEditor();
  return true;
}

export const switchTo = (path: string) => serial(() => activate(path));
export const openInTab = switchTo;

/** Moves through the tabs: +1 next, -1 previous. */
export function cycleTab(by: number) {
  const { tabs, active } = useWorkspace.getState();
  if (tabs.length < 1) return;
  const i = tabs.indexOf(active ?? '');
  void switchTo(tabs[(i + by + tabs.length) % tabs.length]);
}

export function moveTab(path: string, to: number) {
  const tabs = useWorkspace.getState().tabs.filter((t) => t !== path);
  tabs.splice(to, 0, path);
  setWorkspace({ tabs });
}

function dropAssets(project: Project | undefined) {
  if (!project) return;
  const live = new Set<string>(clipAssetIds());
  const open = [...parked.values()].map((p) => p.project);
  if (useStore.getState().filePath) open.push(useStore.getState().project);
  for (const p of open) for (const b of p.boards) for (const id of Object.keys(b.assets)) live.add(id);
  for (const b of project.boards) for (const id of Object.keys(b.assets)) if (!live.has(id)) removeAsset(id);
}

function clearEditor() {
  swapping = true;
  useStore.getState().replaceProject(makeProject(), null);
  swapping = false;
}

export const closeTab = (path: string) =>
  serial(async () => {
    const w = useWorkspace.getState();
    const i = w.tabs.indexOf(path);
    if (i < 0) return;
    const tabs = w.tabs.filter((t) => t !== path);
    if (useStore.getState().filePath === path) {
      await flushSave();
      if (useStore.getState().past.length) await captureThumb();
      const closing = useStore.getState().project;
      const next = tabs[Math.min(i, tabs.length - 1)];
      const atHome = useStore.getState().homeOpen;
      if (next && !atHome) {
        await bring(next);
        setWorkspace({ tabs, active: next });
      } else {
        clearEditor();
        useStore.setState({ homeOpen: true });
        setWorkspace({ tabs, active: null });
      }
      dropAssets(closing);
    } else {
      const closing = parked.get(path)?.project;
      parked.delete(path);
      setWorkspace({ tabs });
      dropAssets(closing);
    }
  });

/** Shows Home. The open project stays loaded underneath. */
export const goHome = () =>
  serial(async () => {
    await flushSave();
    if (useStore.getState().filePath && Date.now() - thumbAt > 5_000 && useStore.getState().past.length) await captureThumb();
    useStore.setState({ homeOpen: true, ...drafts });
    persist();
    void refreshHome();
  });

/** Re-reads file dates and picks up files added to the default folder. */
export async function refreshHome() {
  if (!native) return;
  // A change still waiting to be written would otherwise come back from the old index.
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    await writeIndex();
  }
  const idx = await native.projectsRead();
  const w = useWorkspace.getState();
  const mine = new Map(w.projects.map((p) => [p.path, p]));
  useWorkspace.setState({ projects: idx.projects.map((p) => ({ ...p, ...mine.get(p.path), updatedAt: p.updatedAt, missing: p.missing, thumbPath: p.thumbPath })) });
  void backfill();
}

// ---------- making projects ----------

const NEW_NAME: Record<BoardKind, string> = { carousel: 'Untitled social post', email: 'Untitled email', document: 'Untitled pages' };

/** The blank board a new project starts on, until the New board dialog replaces it. */
let starter: { path: string; boardId: string } | null = null;

export function newProjectOfKind(kind: BoardKind, opts: { name?: string; dialog?: boolean } = {}) {
  return serial(async () => {
    if (!native) return;
    const name = safeFileName(opts.name ?? NEW_NAME[kind]);
    const path = await native.projectFreePath({ name });
    await flushSave();
    if (useStore.getState().filePath) park();
    const board: Doc = kind === 'email' ? makeEmailBoard(name) : kind === 'document' ? makeDocumentBoard({ name }) : { ...makeDoc(), name };
    swapping = true;
    useStore.getState().replaceProject(makeProject(board), path);
    useStore.setState({ dirty: true });
    swapping = false;
    await flushSave();
    patchRecord(path, { ...describe(useStore.getState().project), openedAt: Date.now(), updatedAt: Date.now() });
    setWorkspace({ tabs: [...useWorkspace.getState().tabs, path], active: path });
    showEditor();
    fit();
    if (opts.dialog !== false) {
      starter = { path, boardId: board.id };
      useStore.setState({ modal: 'new-board' });
    }
  });
}

/** The New board dialog made the real first board: the blank starter can go. */
export function consumeStarter() {
  const s = useStore.getState();
  if (starter && s.filePath === starter.path) {
    const blank = s.project.boards.find((b) => b.id === starter!.boardId);
    if (blank && !blank.nodes.length && s.project.boards.length > 1) {
      s.deleteBoard(blank.id);
      useStore.setState({ past: [], future: [] });
    }
  }
  starter = null;
}

export const keepStarter = () => void (starter = null);

// ---------- Home actions ----------

export function createFolder(name: string) {
  const id = uid();
  setWorkspace({ folders: [...useWorkspace.getState().folders, { id, name }] });
  return id;
}

export function renameFolder(id: string, name: string) {
  setWorkspace({ folders: useWorkspace.getState().folders.map((f) => (f.id === id ? { ...f, name } : f)) });
}

/** Its projects stay on Home, just outside any folder. */
export function deleteFolder(id: string) {
  const w = useWorkspace.getState();
  setWorkspace({ folders: w.folders.filter((f) => f.id !== id), projects: w.projects.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)) });
}

export const moveToFolder = (path: string, folderId: string | null) => patchRecord(path, { folderId });

export const renameProject = (path: string, rawName: string) =>
  serial(async () => {
    const name = safeFileName(rawName);
    if (!native || !name || name === fileName(path)) return;
    const live = useStore.getState().filePath === path;
    if (live) await flushSave();
    try {
      const to = await native.projectRename({ from: path, name });
      await native.chatRename({ from: path, to }).catch(() => {});
      renamed.set(path, to);
      const w = useWorkspace.getState();
      const snap = parked.get(path);
      if (snap) {
        parked.delete(path);
        parked.set(to, { ...snap, filePath: to });
      }
      swapping = true;
      if (live) useStore.setState({ filePath: to });
      swapping = false;
      setWorkspace({
        projects: w.projects.map((p) => (p.path === path ? { ...p, path: to, thumbV: Date.now() } : p)),
        tabs: w.tabs.map((t) => (t === path ? to : t)),
        active: w.active === path ? to : w.active,
        claude: Object.fromEntries(Object.entries(w.claude).map(([home, at]) => [home === path ? to : home, at === path ? to : at])),
      });
      void refreshHome();
    } catch (e) {
      useStore.getState().toast((e as Error).message, 'error');
    }
  });

export async function duplicateProject(path: string) {
  if (!native) return;
  try {
    const to = await native.projectDuplicate(path);
    const src = useWorkspace.getState().projects.find((p) => p.path === path);
    patchRecord(to, { folderId: src?.folderId ?? null, kinds: src?.kinds, boards: src?.boards, thumbV: Date.now(), openedAt: Date.now() });
    await refreshHome();
  } catch (e) {
    useStore.getState().toast(`Couldn't duplicate: ${(e as Error).message}`, 'error');
  }
}

/** Takes it off Home. The file stays where it is. */
export async function removeFromHome(path: string) {
  await closeTab(path);
  const w = useWorkspace.getState();
  setWorkspace({ projects: w.projects.filter((p) => p.path !== path), hidden: [...w.hidden, path] });
}

export async function trashProject(path: string) {
  await closeTab(path);
  try {
    await native?.projectTrash(path);
    setWorkspace({ projects: useWorkspace.getState().projects.filter((p) => p.path !== path) });
    useStore.getState().toast(`Moved ${fileName(path)} to the Trash`);
  } catch (e) {
    useStore.getState().toast(`Couldn't move it to the Trash: ${(e as Error).message}`, 'error');
  }
}

// ---------- moving and copying a row to another project ----------

// A row goes over whole: layers, slides, settings, email lines, note and status, plus the photos
// and uploaded fonts it uses and the styles it follows. Ids stay, so Claude's references still
// work; only a board id the other project already has gets a new one. The other project can be
// parked in a tab (its state is updated and saved, never overwritten from an old copy), closed on
// disk (the file is rewritten in place, after a safety copy), or new.

/** What leaves with a row. */
interface Outgoing {
  board: Doc;
  /** Photos its layers show and uploaded fonts its text uses: they join the other project's tray. */
  tray: AssetMeta[];
  /** The comparison picture laid over it, which stays out of the tray. */
  overlay: AssetMeta | null;
  tokens: CarriedTokens;
}

function outgoing(p: Project, src: Doc): Outgoing {
  const board = deepClone(src);
  const tokens = carriedBy(p, board.nodes);
  const images = collectAssetIds(board.nodes);
  const families = new Set<string>((tokens.textStyles ?? []).map((t) => t.fontFamily));
  walk(board.nodes, (n) => void (n.type === 'text' && families.add(n.fontFamily)));
  const tray = Object.values(src.assets).filter((m) => (m.kind === 'font' ? families.has(m.family ?? m.name.replace(/\.[^.]+$/, '')) : images.has(m.id)));
  const overlay = (board.overlay && src.assets[board.overlay.assetId]) || null;
  board.assets = {};
  board.assetOrder = [];
  return { board, tray, overlay, tokens };
}

type Bytes = Blob | Uint8Array;
const sizeOf = (b: Bytes) => (b instanceof Blob ? b.size : b.byteLength);
async function digest(b: Bytes) {
  const buf = b instanceof Blob ? await b.arrayBuffer() : b;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Adds the row to `target` as its bottom row (and its active one). A photo the target already has,
 * by id or by identical bytes, is reused rather than added twice.
 */
async function mergeInto(target: Project, out: Outgoing, theirBytes: (id: string) => Bytes | undefined) {
  const have = new Map<string, AssetMeta>();
  for (const b of target.boards) for (const m of Object.values(b.assets)) have.set(m.id, m);
  const hashes = new Map<string, Promise<string>>();
  const hashOf = (key: string, b: Bytes) => hashes.get(key) ?? (hashes.set(key, digest(b)), hashes.get(key)!);
  const remap = new Map<string, string>();
  const added: AssetMeta[] = [];
  let reused = 0;
  for (const m of [...out.tray, ...(out.overlay ? [out.overlay] : [])]) {
    if (have.has(m.id)) {
      reused++;
      continue;
    }
    const mine = getAsset(m.id)?.blob;
    let twin: AssetMeta | undefined;
    if (mine) {
      for (const t of have.values()) {
        const theirs = t.kind === m.kind ? theirBytes(t.id) : undefined;
        if (theirs && sizeOf(theirs) === mine.size && (await hashOf(`t:${t.id}`, theirs)) === (await hashOf(`m:${m.id}`, mine))) {
          twin = t;
          break;
        }
      }
    }
    if (twin) {
      remap.set(m.id, twin.id);
      reused++;
    } else added.push(m);
  }
  const final = (m: AssetMeta) => have.get(remap.get(m.id) ?? m.id) ?? m;
  const board = out.board;
  const idChanged = target.boards.some((b) => b.id === board.id);
  if (idChanged) board.id = uid();
  walk(board.nodes, (n) => {
    if (n.type === 'image' && n.assetId && remap.has(n.assetId)) n.assetId = remap.get(n.assetId)!;
  });
  const tray = out.tray.map(final);
  const trayBoard = target.boards.find((b) => b.id === target.activeBoardId) ?? target.boards[0];
  board.assets = { ...trayBoard?.assets };
  board.assetOrder = [...(trayBoard?.assetOrder ?? [])];
  for (const m of tray) {
    board.assets[m.id] = m;
    if (m.kind === 'image' && !board.assetOrder.includes(m.id)) board.assetOrder.push(m.id);
  }
  if (board.overlay && out.overlay) {
    const o = final(out.overlay);
    board.overlay.assetId = o.id;
    board.assets[o.id] = o;
  }
  const project = produce(target, (p) => {
    adoptTokens(p, out.tokens, board.nodes);
    for (const d of p.boards) {
      for (const m of tray) {
        d.assets[m.id] = m;
        if (m.kind === 'image' && !d.assetOrder.includes(m.id)) d.assetOrder.push(m.id);
      }
    }
    p.boards.push(board);
    p.activeBoardId = board.id;
  });
  return { project, boardId: board.id, added, reused, idChanged };
}

const brandLabel = (id: string | null | undefined) => (id ? `the ${brandById(id)?.name ?? id} brand` : 'no brand');
const recordOf = (path: string) => useWorkspace.getState().projects.find((p) => p.path === path);
const projectRef = (path: string) => ({ id: recordOf(path)?.id ?? null, name: fileName(path), path });

export interface SentBoard {
  moved: boolean;
  board: { id: string; name: string; idChanged: boolean };
  from: { name: string; path: string | null };
  to: { id: string | null; name: string; path: string; was: 'open in a tab' | 'closed' | 'new' };
  photos: { added: number; reused: number };
  /** Set when the row's brand differs from the other project's. */
  brand?: string;
  activated: boolean;
}

/**
 * Moves (or copies) a row of the open project to another project: `to` is a project's path, or
 * null for a new project called `newName`. A move takes the row out of this project as one undo
 * step. `activate` then goes to the other project with the row selected.
 */
export function sendBoard(opts: { boardId: string; to: string | null; newName?: string; move: boolean; activate?: boolean; caller?: string | null }): Promise<SentBoard> {
  return serial(async () => {
    if (!native) throw new Error('Moving rows between projects needs the desktop app.');
    const s = useStore.getState();
    const from = s.filePath;
    const src = s.project.boards.find((b) => b.id === opts.boardId);
    if (!src) throw new Error(`There's no row "${opts.boardId}" in ${from ? fileName(from) : 'this project'}.`);
    if (opts.move && s.project.boards.length <= 1) throw new Error(`"${src.name}" is the only row in ${from ? fileName(from) : 'this project'}, so it can't move out. Copy it instead, or add another row here first.`);
    const out = outgoing(s.project, src);
    let path: string;
    let was: SentBoard['to']['was'];
    let result: { project: Project; boardId: string; added: AssetMeta[]; reused: number; idChanged: boolean };

    if (opts.to === null) {
      path = await native.projectFreePath({ name: safeFileName(opts.newName?.trim() || src.name) });
      const board = out.board;
      const tray = out.tray;
      for (const m of tray) board.assets[m.id] = m;
      board.assetOrder = tray.filter((m) => m.kind === 'image').map((m) => m.id);
      if (out.overlay) board.assets[out.overlay.id] = out.overlay;
      const project: Project = { ...makeProject(board), brandId: s.project.brandId ?? null, ...out.tokens };
      await writeToPath(path, await serializeProjectData({ project }));
      was = 'new';
      result = { project, boardId: board.id, added: [...tray, ...(out.overlay ? [out.overlay] : [])], reused: 0, idChanged: false };
      patchRecord(path, { ...describe(project), openedAt: Date.now(), updatedAt: Date.now() });
    } else {
      path = renamed.get(opts.to) ?? opts.to;
      if (path === from) throw new Error(`"${src.name}" is already in ${fileName(path)}.`);
      const snap = parked.get(path);
      if (snap) {
        // Open in another tab: change its live state, so nothing there is lost, then save it.
        result = await mergeInto(snap.project, out, (id) => getAsset(id)?.blob);
        await writeToPath(path, await serializeProjectData({ project: result.project, comments: snap.comments, changes: snap.changes }));
        const doc = result.project.boards.find((b) => b.id === result.boardId)!;
        parked.set(path, { ...snap, project: result.project, doc, past: [...snap.past, snap.project], future: [], lastKey: null, selection: [], dirty: false });
        was = 'open in a tab';
      } else {
        let data: Uint8Array;
        try {
          data = (await native.readFile(path)).data;
        } catch (e) {
          throw new Error(`Couldn't read ${fileName(path)}: ${(e as Error).message}`);
        }
        const file = readProjectFile(data);
        result = await mergeInto(file.project, out, (id) => file.assets.get(id));
        await native.projectBackup(path).catch(() => {});
        await writeToPath(path, await rewriteProjectFile(file, result.project, result.added));
        was = 'closed';
      }
      patchRecord(path, { ...describe(result.project), updatedAt: Date.now() });
    }

    // Only once the other project has it safely: take it out of this one (undo puts it back).
    if (opts.move && useStore.getState().filePath === from) useStore.getState().deleteBoard(src.id);
    const fromBrand = s.project.brandId ?? null;
    const toBrand = result.project.brandId ?? null;
    let activated = false;
    if (opts.activate) {
      // Steer first, so the chat panel stays on this Claude's conversation through the switch.
      const before = useWorkspace.getState().claude;
      steerClaude(opts.caller ?? null, path);
      activated = await activate(path);
      if (activated) {
        useStore.getState().setActiveBoard(result.boardId);
        fit();
      } else useWorkspace.setState({ claude: before });
    }
    return {
      moved: opts.move,
      board: { id: result.boardId, name: src.name, idChanged: result.idChanged },
      from: { name: from ? fileName(from) : 'this project', path: from },
      to: { ...projectRef(path), was },
      photos: { added: result.added.length, reused: result.reused },
      ...(fromBrand !== toBrand ? { brand: `This row was made with ${brandLabel(fromBrand)}, and ${fileName(path)} uses ${brandLabel(toBrand)}. Its fonts and colors weren't changed.` } : {}),
      activated,
    };
  });
}

/** The row menu's Move to / Copy to: does it and says what happened. */
export async function sendBoardFromMenu(boardId: string, to: string | null, move: boolean, newName?: string) {
  const { toast } = useStore.getState();
  try {
    const r = await sendBoard({ boardId, to, move, newName });
    toast(`${r.moved ? 'Moved' : 'Copied'} "${r.board.name}" to ${r.to.was === 'new' ? 'a new project, ' : ''}${r.to.name}`, 'success');
    if (r.brand) toast(r.brand);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------- Claude ----------

/**
 * Where each Claude in Spread's own chat is working, when it moved itself to another project
 * (open_project, new_project, move_board with activate). Keyed by the project its chat belongs to,
 * which is what its tool calls carry. Without this, every next call pulled Claude back to its home
 * project, so work meant for the project it had just opened landed in the old one.
 */
export function steerClaude(home: string | null, path: string) {
  if (!home) return;
  const h = renamed.get(home) ?? home;
  const { claude } = useWorkspace.getState();
  const { [h]: _was, ...rest } = claude;
  useWorkspace.setState({ claude: h === path ? rest : { ...rest, [h]: path } });
}

/** The project a Claude's calls act on. */
function claudePath(home: string | null) {
  if (!home) return null;
  const h = renamed.get(home) ?? home;
  const at = useWorkspace.getState().claude[h];
  return at ? (renamed.get(at) ?? at) : h;
}

/** The chat whose Claude moved itself into this project, if one did: the panel stays on that conversation. */
export function claudeChatIn(path: string | null) {
  if (!path) return null;
  const hit = Object.entries(useWorkspace.getState().claude).find(([home, at]) => at === path && home !== path);
  return hit?.[0] ?? null;
}

/** The project in the editor, which every board tool acts on. */
export function currentProjectForClaude() {
  const path = useStore.getState().filePath;
  return path ? projectRef(path) : null;
}

/** active: the project this Claude's board tools act on (its chat's, or where it moved itself; else the editor's). */
export function projectsForClaude(caller: string | null = null) {
  const { projects, folders, tabs } = useWorkspace.getState();
  const open = claudePath(caller) ?? useStore.getState().filePath;
  return projects
    .filter((p) => !p.missing)
    .map((p) => ({
      id: p.id ?? null,
      name: fileName(p.path),
      path: p.path,
      active: p.path === open,
      open: tabs.includes(p.path),
      kinds: p.kinds ?? [],
      boards: p.boards ?? null,
      folder: folders.find((f) => f.id === p.folderId)?.name ?? null,
      updatedAt: p.updatedAt ?? null,
    }));
}

/** A project's path from its id, name or path. Names match whole first, then in part; more than one match is an error. */
export function resolveProject(ref: string): string {
  const want = ref.trim();
  if (!want) throw new Error('Pass a project: its id, name or path (spread_list_projects lists them).');
  const all = useWorkspace.getState().projects.filter((p) => !p.missing);
  const path = renamed.get(want) ?? want;
  const exact = all.find((p) => p.id === want || p.path === path);
  if (exact) return exact.path;
  if (/[\\/]/.test(want)) return path; // a file that isn't on Home yet
  const name = want.replace(/\.spread$/i, '').toLowerCase();
  const whole = all.filter((p) => fileName(p.path).toLowerCase() === name);
  const part = whole.length ? whole : all.filter((p) => fileName(p.path).toLowerCase().includes(name));
  if (part.length === 1) return part[0].path;
  const list = (ps: ProjectRecord[]) => ps.slice(0, 12).map((p) => `"${fileName(p.path)}" (${p.id ?? p.path})`).join(', ');
  if (part.length > 1) throw new Error(`Several projects match "${want}": ${list(part)}. Pass the id.`);
  throw new Error(`No project matches "${want}". Projects: ${list(all) || 'none yet'}.`);
}

/** Switches the editor to a project and waits until it's loaded. Claude's next calls act on it. */
export async function openProjectForClaude(ref: string, caller: string | null) {
  const path = resolveProject(ref);
  // Steer first, so the chat panel stays on this Claude's conversation through the switch.
  const before = useWorkspace.getState().claude;
  steerClaude(caller, path);
  if (!(await switchTo(path)) || useStore.getState().filePath !== path) {
    useWorkspace.setState({ claude: before });
    throw new Error(`Couldn't open ${fileName(path)}. Spread showed why; ${currentProjectForClaude() ? `${currentProjectForClaude()!.name} is still the open project.` : 'no project is open.'}`);
  }
  return currentProjectForClaude()!;
}

/** A new project in its own tab, made the one Claude works in. */
export async function newProjectForClaude(name: string | undefined, caller: string | null) {
  await newProjectOfKind('carousel', { name, dialog: false });
  const now = currentProjectForClaude();
  if (now) steerClaude(caller, now.path);
  return now;
}

/** Before Claude acts: its edits land in its own project, and never in a hidden or missing one. */
export async function focusForClaude(project: string | null, readOnly: boolean) {
  if (!native) return;
  const path = claudePath(project);
  if (path && useWorkspace.getState().projects.some((p) => p.path === path) && useStore.getState().filePath !== path) {
    await switchTo(path);
    useStore.getState().toast(`Claude is working in ${fileName(path)}`);
  }
  if (readOnly) return;
  if (!useStore.getState().filePath) await newProjectOfKind('carousel', { dialog: false });
  showEditor();
}

// ---------- start up ----------

export async function initWorkspace() {
  if (!native) return;
  const idx = await native.projectsRead();
  useWorkspace.setState({ folders: idx.folders, projects: idx.projects, hidden: idx.hidden, tabs: idx.tabs.filter((t) => idx.projects.some((p) => p.path === t && !p.missing)) });
  // Work left in the old browser-storage autosave moves into a file, once.
  const restored = await restoreAutosave();
  if (restored) {
    const s = useStore.getState();
    const path = s.filePath ?? (await native.projectFreePath({ name: safeFileName(s.project.boards[0]?.name ?? 'Recovered') }));
    useStore.setState({ filePath: path, dirty: s.dirty || !s.filePath });
    await flushSave();
    patchRecord(path, { ...describe(s.project), openedAt: Date.now() });
    const { tabs } = useWorkspace.getState();
    setWorkspace({ active: path, tabs: tabs.includes(path) ? tabs : [...tabs, path] });
    useStore.setState({ homeOpen: idx.home });
    fit();
  } else {
    useStore.setState({ homeOpen: true });
    if (!idx.home && idx.activeTab && useWorkspace.getState().tabs.includes(idx.activeTab)) await switchTo(idx.activeTab);
  }
  await clearAutosave();
  useWorkspace.setState({ ready: true });
  useStore.subscribe((s, prev) => {
    // Save As gave the open project a new file.
    if (swapping || s.filePath === prev.filePath || !s.filePath || !prev.filePath) return;
    const w = useWorkspace.getState();
    patchRecord(s.filePath, { ...describe(s.project), openedAt: Date.now() });
    setWorkspace({ tabs: w.tabs.map((t) => (t === prev.filePath ? s.filePath! : t)), active: s.filePath });
  });
  void backfill();
}
