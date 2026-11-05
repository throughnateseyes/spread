import { strFromU8, unzipSync } from 'fflate';
import { create } from 'zustand';
import { extFor, getAsset, removeAsset } from './assets';
import { clipAssetIds } from './clipboard';
import { renderSlidesBase64 } from './exporter';
import { native, type ProjectIndex, type ProjectRecord } from './platform';
import { clearAutosave, flushSave, loadProjectBytes, restoreAutosave, safeFileName } from './project';
import { useStore } from './store';
import { cloneBoard, collectAssetIds, makeDoc, makeDocumentBoard, makeEmailBoard, makeProject, migrateProject, uid } from './tree';
import { adoptTokens, carriedBy } from './tokens';
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
}

export const useWorkspace = create<Workspace>(() => ({ ready: false, loading: false, folders: [], projects: [], hidden: [], tabs: [], active: null }));

const PARKED = ['project', 'doc', 'past', 'future', 'lastKey', 'lastKeyAt', 'editLog', 'selection', 'traySelection', 'view', 'comments', 'filePath', 'dirty'] as const;
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
    projects: known ? projects.map((p) => (p.path === path ? { ...p, ...patch } : p)) : [{ path, folderId: null, openedAt: 0, ...patch }, ...projects],
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

/** Copies a board, with its photos, into another project and goes there. */
export async function copyBoardTo(boardId: string, path: string) {
  const s = useStore.getState();
  const src = s.project.boards.find((b) => b.id === boardId);
  if (!src) return;
  const board = cloneBoard(src, src.name);
  const used = collectAssetIds(board.nodes);
  const metas: AssetMeta[] = Object.values(src.assets).filter((m) => m.kind === 'font' || used.has(m.id));
  const tokens = carriedBy(s.project, board.nodes);
  if (!(await switchTo(path))) return;
  const t = useStore.getState();
  t.changeProject((p) => adoptTokens(p, tokens, board.nodes));
  t.addAssets(metas.filter((m) => getAsset(m.id)));
  t.addBoard(board, t.project.activeBoardId);
  t.toast(`Copied "${src.name}" here`, 'success');
  fit();
}

// ---------- Claude ----------

export function projectsForClaude() {
  const { projects, folders } = useWorkspace.getState();
  return projects
    .filter((p) => !p.missing)
    .map((p) => ({ name: fileName(p.path), path: p.path, kinds: p.kinds ?? [], boards: p.boards ?? null, folder: folders.find((f) => f.id === p.folderId)?.name ?? null, updatedAt: p.updatedAt ?? null }));
}

/** Before Claude acts: its edits land in its own project, and never in a hidden or missing one. */
export async function focusForClaude(project: string | null, readOnly: boolean) {
  if (!native) return;
  const path = project ? (renamed.get(project) ?? project) : null;
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
