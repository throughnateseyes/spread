import type { BoardKind, Brand, CommentStatus } from './types';

// File IO that works in both Electron (via window.spreadNative) and a plain browser
// (File System Access API when available, otherwise downloads / <input type=file>).

export interface NativeFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface AutomationRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  /** The project the calling Claude belongs to (URI-encoded path), when it runs in Spread's panel. */
  project?: string | null;
}

export type AutomationResponse = { id: string; result: unknown } | { id: string; error: string };

export interface ClaudeStatus {
  /** app: the Claude desktop app is on this computer; installed: the Spread extension is in it. */
  desktop: { app: boolean; installed: boolean };
  /** cli: Claude Code was found; installed: Spread is registered for all folders. */
  code: { cli: boolean; installed: boolean };
  /** The MCP client that last drove Spread this session ('claude-code', 'claude-ai', …). */
  lastClient: { name: string; at: number } | null;
}

/** One row of the Claude panel's transcript (built by electron/chat.cjs). */
export type ChatItem =
  | { id: string; at: number; kind: 'user'; text: string; label: string | null }
  | { id: string; at: number; kind: 'text'; text: string }
  | { id: string; at: number; kind: 'tool'; toolId: string; name: string; label: string; detail?: string; status: 'running' | 'done' | 'error' | 'stopped'; error?: string }
  | { id: string; at: number; kind: 'approval'; requestId: string; name: string; label: string; detail?: string; preview: string; reason: string | null; status: 'pending' | 'allowed' | 'denied' | 'expired' }
  | { id: string; at: number; kind: 'notice'; tone: 'error' | 'info'; text: string; action?: 'login' | 'install' }
  | { id: string; at: number; kind: 'question'; requestId: string; questions: ChatQuestion[]; answers: Record<string, string> | null; status: 'pending' | 'answered' | 'skipped' | 'expired' };

/** One of Claude's brief questions (AskUserQuestion), shown as a card with options. */
export interface ChatQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface ChatState {
  key: string;
  items: ChatItem[];
  /** Sent while Claude was working, and not read yet. */
  queued: { id: string; text: string; noteId?: string }[];
  status: 'idle' | 'working';
  hasSession: boolean;
  /** Where each canvas comment sent in this chat has got to, by comment id. */
  notes?: Record<string, CommentStatus>;
}

export type LibraryKind = 'templates' | 'references';
export interface LibraryMeta {
  id: string;
  name: string;
  createdAt: number;
}

export interface HostingStatus {
  wordpress: { site: string; user: string; name: string } | null;
}
export type HostingAnswer<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface ProjectRecord {
  path: string;
  folderId: string | null;
  /** When it was last opened here; 0 for files found in the default folder. */
  openedAt: number;
  /** The board types inside, most used first. */
  kinds?: BoardKind[];
  boards?: number;
  /** Bumped when the thumbnail changes. */
  thumbV?: number;
  updatedAt?: number;
  missing?: boolean;
  thumbPath?: string;
}

export interface ProjectIndex {
  version: 1;
  folders: { id: string; name: string }[];
  projects: ProjectRecord[];
  /** Files taken off Home, so the default-folder scan doesn't bring them back. */
  hidden: string[];
  tabs: string[];
  activeTab: string | null;
  home: boolean;
}

export interface SpreadNative {
  platform: string;
  homeDir: string;
  picturesDir: string;
  saveFile(opts: { defaultPath?: string; filters?: { name: string; extensions: string[] }[]; data: Uint8Array }): Promise<string | null>;
  writeFile(opts: { path: string; data: Uint8Array }): Promise<string>;
  openFile(opts: { filters?: { name: string; extensions: string[] }[] }): Promise<NativeFile | null>;
  readFile(path: string): Promise<NativeFile>;
  fetchImage(url: string): Promise<{ data: Uint8Array; type: string }>;
  pickDirectory(opts: { defaultPath?: string }): Promise<string | null>;
  /** One folder's subfolders, plus shortcuts (Desktop, Downloads…), for Spread's own folder browser. */
  listDir(dir?: string | null): Promise<{ dir: string; parent: string | null; entries: { name: string; path: string }[]; places: { label: string; path: string }[]; error: string | null }>;
  makeDir(opts: { dir: string; name: string }): Promise<string>;
  writeFiles(opts: { dir: string; files: { name: string; data: Uint8Array }[] }): Promise<string>;
  writeFiles(dir: string, files: { name: string; data: Uint8Array }[]): Promise<string>;
  listFiles(paths: string[], exts?: string[]): Promise<string[]>;
  reveal(path: string): Promise<void>;
  /** Prints self-contained HTML to a PDF (page size in inches). */
  printPdf(opts: { html: string; widthIn: number; heightIn: number }): Promise<Uint8Array>;
  /** Photographs self-contained HTML in a hidden window, as a JPEG. */
  renderHtml(opts: { html: string; width: number; height: number; maxHeight?: number }): Promise<Uint8Array>;
  setDirty(v: boolean): Promise<void>;
  /** The window is closing with unsaved work: save, then call flushed. */
  onFlushClose(cb: () => void): () => void;
  flushed(ok: boolean): void;
  /** The Home screen's index (electron/projects.cjs). */
  projectsRead(): Promise<ProjectIndex & { dir: string }>;
  projectsWrite(index: ProjectIndex): Promise<void>;
  projectFreePath(opts: { dir?: string; name: string }): Promise<string>;
  projectRename(opts: { from: string; name: string }): Promise<string>;
  projectDuplicate(path: string): Promise<string>;
  projectTrash(path: string): Promise<void>;
  projectThumb(opts: { path: string; data: Uint8Array }): Promise<void>;
  projectBackup(path: string): Promise<void>;
  /** The brand library (~/.spread/brands). Listed brands carry `dir`, their folder on disk. */
  brandsList(): Promise<(Brand & { dir: string })[]>;
  brandSave(opts: { brand: Brand; fontFiles?: { path: string; family: string }[] }): Promise<Brand & { dir: string }>;
  brandWriteFont(opts: { id: string; file: string; data: Uint8Array }): Promise<void>;
  brandDelete(id: string): Promise<void>;
  /** The design library (~/.spread/templates, ~/.spread/references). Listed items carry `dir`. */
  libraryList<T extends LibraryMeta>(kind: LibraryKind): Promise<(T & { dir: string })[]>;
  librarySave<T extends LibraryMeta>(opts: { kind: LibraryKind; meta: T; files: { name: string; data: Uint8Array }[] }): Promise<T & { dir: string }>;
  libraryDelete(opts: { kind: LibraryKind; id: string }): Promise<void>;
  /** WordPress picture hosting for email exports (electron/hosting.cjs). */
  hostingStatus(): Promise<HostingAnswer<HostingStatus>>;
  hostingConnect(opts: { site: string; user: string; password: string }): Promise<HostingAnswer<HostingStatus>>;
  hostingDisconnect(): Promise<HostingAnswer<HostingStatus>>;
  hostingUpload(opts: { files: { name: string; type: string; hash: string; data: Uint8Array }[] }): Promise<HostingAnswer<{ urls: Record<string, string>; uploaded: number; reused: number }>>;
  claudeStatus(): Promise<ClaudeStatus>;
  /** Desktop opens the .mcpb for Claude Desktop to install; code registers the server with Claude Code for every folder. */
  claudeConnect(target: 'desktop' | 'code'): Promise<{ ok: boolean; error?: string }>;
  claudeDisconnectCode(): Promise<{ ok: boolean; error?: string }>;
  chatOpen(key: string): Promise<ChatState>;
  /** text is what the transcript shows; content is what Claude gets (with the <spread-context> block). */
  /** noteId: the message is a canvas comment, and its pin follows it through the chat. */
  chatSend(opts: { key: string; cwd?: string; text: string; content: string; label?: string; noteId?: string }): Promise<void>;
  chatRetry(key: string): Promise<void>;
  chatStop(key: string): Promise<void>;
  chatReset(key: string): Promise<void>;
  chatRename(opts: { from: string; to: string }): Promise<void>;
  chatApprove(opts: { key: string; requestId: string; decision: 'allow' | 'always' | 'deny' }): Promise<void>;
  /** answers: question text → chosen label(s), comma-separated; null skips the questions. */
  chatAnswer(opts: { key: string; requestId: string; answers: Record<string, string> | null }): Promise<void>;
  chatLogin(): Promise<{ ok: boolean; error?: string }>;
  chatDesignDocs(dir: string): Promise<string[]>;
  onChatUpdate(cb: (u: ChatState) => void): () => void;
  pathForFile(file: File): string;
  onOpenPath(cb: (path: string) => void): () => void;
  onAutomationRequest(cb: (req: AutomationRequest) => void): () => void;
  respondAutomation(resp: AutomationResponse): void;
}

export const native: SpreadNative | null = (window as any).spreadNative ?? null;
export const isElectron = !!native;
export const picturesDir: string | null = native?.picturesDir ?? null;
export const homeDir: string | null = native?.homeDir ?? null;

function requireNative(what: string): SpreadNative {
  if (!native) throw new Error(`${what} needs the Spread desktop app`);
  return native;
}

/** Recursively expands files/folders into absolute file paths (natural sort). Electron only. */
export function listFiles(paths: string[], exts?: string[]): Promise<string[]> {
  return requireNative('Listing files').listFiles(paths, exts);
}

/** Reads a file from disk. Electron only. */
/** Downloads a photo. In the browser this only works for sites that allow it (CORS). */
export async function fetchImage(url: string): Promise<{ data: Uint8Array; type: string }> {
  if (native) return native.fetchImage(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return { data: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
}

export function readFile(path: string): Promise<NativeFile> {
  return requireNative('Reading files').readFile(path);
}

/** Writes files into a directory (created if missing). Electron only. Returns the directory. */
export async function writeFiles(dir: string, files: { name: string; data: Uint8Array | Blob }[]): Promise<string> {
  const n = requireNative('Writing files');
  const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBytes(f.data) })));
  return n.writeFiles({ dir, files: payload });
}

/** Subscribes to automation requests from the local bridge. No-op (returns noop) in the browser. */
export function onAutomationRequest(cb: (req: AutomationRequest) => void): () => void {
  return native ? native.onAutomationRequest(cb) : () => {};
}

export function respondAutomation(resp: AutomationResponse) {
  native?.respondAutomation(resp);
}

const LAST_EXPORT_DIR = 'spread.lastExportDir';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage unavailable; ignore
  }
}

async function toBytes(data: Uint8Array | Blob): Promise<Uint8Array> {
  return data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
}

function toBlob(data: Uint8Array | Blob, mime: string): Blob {
  return data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
}

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError';
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save one file with a save dialog. Returns the path (Electron) or file name (browser), null if cancelled. */
export async function saveBytes(opts: { suggestedName: string; data: Uint8Array | Blob; mime: string; ext: string }): Promise<string | null> {
  const { suggestedName, data, mime, ext } = opts;
  if (native) {
    return native.saveFile({
      defaultPath: suggestedName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      data: await toBytes(data),
    });
  }
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }] });
      const w = await handle.createWritable();
      await w.write(toBlob(data, mime));
      await w.close();
      return handle.name as string;
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  download(toBlob(data, mime), suggestedName);
  return suggestedName;
}

/** Overwrite a file at a known path (Electron only). */
export async function writeToPath(path: string, data: Uint8Array | Blob) {
  if (!native) throw new Error('Writing to a path needs the desktop app');
  await native.writeFile({ path, data: await toBytes(data) });
}

/** Pick a .spread project file. */
export async function openProjectFile(): Promise<{ name: string; path: string | null; data: Uint8Array } | null> {
  if (native) {
    const r = await native.openFile({ filters: [{ name: 'Spread project', extensions: ['spread'] }] });
    return r ? { name: r.name, path: r.path, data: r.data } : null;
  }
  const picker = (window as any).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker({ types: [{ description: 'Spread project', accept: { 'application/zip': ['.spread'] } }] });
      const f: File = await handle.getFile();
      return { name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.spread';
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Write several files into a folder the user picks. Returns the folder (path or name), null if cancelled. */
/**
 * Where exports go in the desktop app: the folder the user last chose, else Pictures/Spread/<project>.
 * Exports write straight there (no dialog on the way); "Change…" picks another.
 */
export function exportFolderFor(projectName: string): string | null {
  if (!native) return null;
  const chosen = lsGet(LAST_EXPORT_DIR);
  if (chosen) return chosen;
  const safe = projectName.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'Export';
  return `${native.picturesDir || native.homeDir}/Spread/${safe}`;
}

/** The folder browser's host (FolderPicker) registers itself here. */
let folderPrompt: ((start: string | null) => Promise<string | null>) | null = null;
export function setFolderPrompt(fn: typeof folderPrompt) {
  folderPrompt = fn;
}

/** Asks for a new export folder (in Spread's own browser) and remembers it. Null if cancelled. */
export async function chooseExportFolder(current: string | null): Promise<string | null> {
  if (!native) return null;
  const dir = folderPrompt ? await folderPrompt(current) : await native.pickDirectory({ defaultPath: current ?? undefined });
  if (dir) lsSet(LAST_EXPORT_DIR, dir);
  return dir;
}

/** Writes files into a folder: `opts.folder` directly (desktop app), else asks for one. */
export async function saveFilesToFolder(files: { name: string; blob: Blob }[], opts: { remember?: boolean; folder?: string | null } = {}): Promise<{ folder: string } | null> {
  const remember = opts.remember ?? true;
  if (native) {
    const dir = opts.folder ?? (await native.pickDirectory({ defaultPath: lsGet(LAST_EXPORT_DIR) ?? undefined }));
    if (!dir) return null;
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })));
    await native.writeFiles({ dir, files: payload });
    if (remember && !opts.folder) lsSet(LAST_EXPORT_DIR, dir);
    return { folder: dir };
  }
  const picker = (window as any).showDirectoryPicker;
  if (picker) {
    try {
      const dir = await picker({ mode: 'readwrite', id: 'spread-export' });
      for (const f of files) {
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
      }
      return { folder: dir.name as string };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  for (const f of files) {
    download(f.blob, f.name);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { folder: 'Downloads' };
}

export function revealInFolder(path: string) {
  if (native) void native.reveal(path);
}

export function setDirtyFlag(v: boolean) {
  if (native) void native.setDirty(v);
}
