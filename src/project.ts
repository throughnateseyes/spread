import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { del, get, keys, set } from 'idb-keyval';
import { brandById, installBrandFromProject } from './brand';
import { clearAssets, extFor, getAsset, registerFont, registerImage } from './assets';
import { isElectron, native, openProjectFile, saveBytes, setDirtyFlag, writeToPath } from './platform';
import { newProjectOfKind, noteSaved, openInTab } from './workspace';
import { useStore } from './store';
import { makeProject, migrateProject } from './tree';
import { readComments, savableComments } from './comments';
import { readChanges, type ChangeEntry } from './history';
import type { AssetMeta, Brand, CanvasComment, Doc, Project } from './types';

// .spread project files are zips: project.json + assets/<id>.<ext>, plus brand.json (a copy of the
// project's brand kit, so the file opens on-brand on a computer that doesn't have the kit yet).
// A project holds one or more boards (carousel variations, emails). Version 1 files held a
// single board under `doc`; they still open (migrated to a one-board project).
// In the desktop app every project has a file, and changes are written to it a moment after they
// happen (workspace.ts keeps the tabs and the Home list). In the browser there's no file, so the
// working session is autosaved to IndexedDB instead.

interface ProjectJson {
  app: 'spread';
  version: 1 | 2;
  doc?: Doc;
  project?: Project;
  /** Notes pinned on the canvas (see comments.ts). */
  comments?: CanvasComment[];
  /** Who changed what (see history.ts). */
  changes?: ChangeEntry[];
}

const DOC_KEY = 'spread.doc';
const ASSET_PREFIX = 'spread.asset.';

function requestFit() {
  requestAnimationFrame(() => window.dispatchEvent(new Event('spread:fit')));
}

export function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled';
}

/** Every asset referenced by any board (boards share one tray, but be defensive). */
function allAssetMetas(p: Project): AssetMeta[] {
  const m = new Map<string, AssetMeta>();
  for (const b of p.boards) for (const a of Object.values(b.assets)) m.set(a.id, a);
  return [...m.values()];
}

function projectIsEmpty(p: Project) {
  return p.boards.every((b) => !b.nodes.length && !b.assetOrder.length);
}

/** Name used for the project file: the first board's name. */
export function projectName(p: Project = useStore.getState().project) {
  return p.boards[0]?.name || 'Untitled';
}

// ---------- serialise ----------

export async function serializeProject(): Promise<Uint8Array> {
  const { project, comments, changes } = useStore.getState();
  const files: Zippable = {};
  const json: ProjectJson = { app: 'spread', version: 2, project, comments: savableComments(project, comments), changes };
  files['project.json'] = [strToU8(JSON.stringify(json)), { level: 6 }];
  const brand = brandById(project.brandId);
  if (brand) {
    const { dir: _dir, ...copy } = brand;
    files['brand.json'] = [strToU8(JSON.stringify(copy)), { level: 6 }];
  }
  for (const meta of allAssetMetas(project)) {
    const rec = getAsset(meta.id);
    if (!rec) continue;
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    files[`assets/${meta.id}.${extFor(meta)}`] = [bytes, { level: meta.kind === 'font' ? 6 : 0 }];
  }
  return zipSync(files);
}

async function registerMeta(meta: AssetMeta, blob: Blob) {
  if (meta.kind === 'font') await registerFont(blob, meta.name, meta.id, meta.family);
  else await registerImage(blob, meta.name, meta.id);
}

/** Returns whether it opened. Tabs share one asset registry, so the desktop app keeps what's loaded. */
export async function loadProjectBytes(data: Uint8Array, path: string | null): Promise<boolean> {
  const { toast } = useStore.getState();
  let entries: Record<string, Uint8Array>;
  let project: Project;
  let comments: CanvasComment[];
  let changes: ChangeEntry[];
  try {
    entries = unzipSync(data);
    const raw = entries['project.json'];
    if (!raw) throw new Error('missing project.json');
    const json: ProjectJson = JSON.parse(strFromU8(raw));
    if (json.app !== 'spread' || !(json.project || json.doc)) throw new Error('not a Spread project');
    project = migrateProject(json.project ?? json.doc);
    comments = readComments(json.comments, project);
    changes = readChanges(json.changes);
  } catch (e) {
    toast(`Couldn't open project: ${(e as Error).message}`, 'error');
    return false;
  }
  const byId = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(entries)) {
    const m = name.match(/^assets\/([^.]+)\./);
    if (m) byId.set(m[1], bytes);
  }
  if (!isElectron) clearAssets();
  const missing: string[] = [];
  for (const meta of allAssetMetas(project)) {
    const bytes = byId.get(meta.id);
    if (!bytes) {
      missing.push(meta.name);
      continue;
    }
    try {
      await registerMeta(meta, new Blob([bytes as BlobPart], { type: meta.mime }));
    } catch {
      missing.push(meta.name);
    }
  }
  useStore.getState().replaceProject(project, path, comments, changes);
  requestFit();
  if (project.brandId && entries['brand.json'] && !brandById(project.brandId)) {
    try {
      const brand: Brand = JSON.parse(strFromU8(entries['brand.json']));
      const files = new Set(brand.fonts.flatMap((f) => f.files ?? []));
      const fonts = allAssetMetas(project)
        .filter((m) => m.kind === 'font' && files.has(m.name) && byId.has(m.id))
        .map((m) => ({ file: m.name, data: byId.get(m.id)! }));
      await installBrandFromProject(brand, fonts);
    } catch (e) {
      console.warn('Could not install the project brand', e);
    }
  }
  if (missing.length) toast(`${missing.length} asset(s) couldn't be loaded: ${missing.slice(0, 3).join(', ')}`, 'error');
  return true;
}

// ---------- save / open / new ----------

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = useStore.getState();
  try {
    const bytes = await serializeProject();
    let path: string | null;
    if (isElectron && s.filePath && !saveAs) {
      await writeToPath(s.filePath, bytes);
      path = s.filePath;
    } else {
      path = await saveBytes({ suggestedName: `${safeFileName(projectName(s.project))}.spread`, data: bytes, mime: 'application/zip', ext: 'spread' });
      if (!path) return false;
    }
    useStore.setState({ filePath: isElectron ? path : null, dirty: false });
    s.toast('Saved', 'success');
    return true;
  } catch (e) {
    s.toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

function confirmDiscard() {
  const s = useStore.getState();
  return !s.dirty || projectIsEmpty(s.project) || window.confirm('Discard unsaved changes to the current project?');
}

export async function openProject() {
  if (!isElectron && !confirmDiscard()) return;
  try {
    const f = await openProjectFile();
    if (f?.path && isElectron) await openInTab(f.path);
    else if (f) await loadProjectBytes(f.data, f.path);
  } catch (e) {
    useStore.getState().toast(`Couldn't open: ${(e as Error).message}`, 'error');
  }
}

export async function newProject() {
  if (isElectron) return void (await newProjectOfKind('carousel'));
  if (!confirmDiscard()) return;
  clearAssets();
  useStore.getState().replaceProject(makeProject());
  await clearAutosave();
  requestFit();
}

// ---------- autosave ----------

const persisted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

let saving: Promise<boolean> | null = null;
const backedUp = new Set<string>();

async function writeProject(): Promise<boolean> {
  const { project, comments, filePath } = useStore.getState();
  if (!filePath) return false;
  try {
    const bytes = await serializeProject();
    // A safety copy from before this session's first change, since saving is automatic.
    if (!backedUp.has(filePath)) {
      backedUp.add(filePath);
      await native?.projectBackup(filePath).catch(() => {});
    }
    await writeToPath(filePath, bytes);
    const now = useStore.getState();
    if (now.filePath === filePath && now.project === project && now.comments === comments) useStore.setState({ dirty: false });
    return true;
  } catch (e) {
    useStore.getState().toast(`Couldn't save: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Writes the open project to its file now, waiting for any save already running. */
export async function flushSave(): Promise<boolean> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (saving) await saving;
  if (!useStore.getState().dirty || !useStore.getState().filePath) return true;
  saving = writeProject().finally(() => (saving = null));
  return saving;
}

async function persistNow() {
  const { project, comments, changes, filePath, dirty } = useStore.getState();
  try {
    await set(DOC_KEY, { project, comments, changes, filePath, dirty });
    const metas = allAssetMetas(project);
    const live = new Set(metas.map((m) => m.id));
    for (const meta of metas) {
      if (persisted.has(meta.id)) continue;
      const rec = getAsset(meta.id);
      if (!rec) continue;
      await set(ASSET_PREFIX + meta.id, { meta, blob: rec.blob });
      persisted.add(meta.id);
    }
    for (const id of [...persisted]) {
      if (!live.has(id)) {
        await del(ASSET_PREFIX + id);
        persisted.delete(id);
      }
    }
  } catch (e) {
    console.warn('Autosave failed', e);
  }
}

export function startAutosave() {
  if (started) return;
  started = true;
  useStore.subscribe((s, prev) => {
    if (s.dirty !== prev.dirty) setDirtyFlag(s.dirty);
    if (isElectron) {
      if (!s.filePath || s.filePath !== prev.filePath) return;
      if (s.dirty && (s.project !== prev.project || s.comments !== prev.comments)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flushSave().then((ok) => ok && noteSaved()), 2000);
      }
      return;
    }
    if (s.project !== prev.project || s.comments !== prev.comments || s.filePath !== prev.filePath || s.dirty !== prev.dirty) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persistNow, 1500);
    }
  });
  setDirtyFlag(useStore.getState().dirty);
  native?.onOpenPath((p) => void openInTab(p));
  native?.onFlushClose(() => void flushSave().then((ok) => native!.flushed(ok)));
}

export async function restoreAutosave(): Promise<boolean> {
  try {
    const all = (await keys()).map(String);
    for (const k of all) if (k.startsWith(ASSET_PREFIX)) persisted.add(k.slice(ASSET_PREFIX.length));
    const saved = (await get(DOC_KEY)) as { project?: Project; doc?: Doc; comments?: CanvasComment[]; changes?: ChangeEntry[]; filePath: string | null; dirty?: boolean } | undefined;
    if (!saved || !(saved.project || saved.doc)) return false;
    const project = migrateProject(saved.project ?? saved.doc);
    if (projectIsEmpty(project)) return false;
    clearAssets();
    for (const meta of allAssetMetas(project)) {
      const rec = (await get(ASSET_PREFIX + meta.id)) as { meta: AssetMeta; blob: Blob } | undefined;
      if (!rec) continue;
      try {
        await registerMeta(meta, rec.blob);
      } catch (e) {
        console.warn('Could not restore asset', meta.name, e);
      }
    }
    useStore.getState().replaceProject(project, saved.filePath ?? null, readComments(saved.comments, project), readChanges(saved.changes));
    useStore.setState({ dirty: saved.dirty ?? saved.filePath == null });
    requestFit();
    return true;
  } catch (e) {
    console.warn('Restore failed', e);
    return false;
  }
}

export async function clearAutosave() {
  try {
    const all = (await keys()).map(String);
    await Promise.all(all.filter((k) => k === DOC_KEY || k.startsWith(ASSET_PREFIX)).map((k) => del(k)));
    persisted.clear();
  } catch {
    // IndexedDB unavailable
  }
}
