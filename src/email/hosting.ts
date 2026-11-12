import { create } from 'zustand';
import { isElectron, native, type HostingStatus } from '../platform';
import { useStore } from '../store';
import type { Doc, EmailMeta, EmailPlatform, PictureHosting } from '../types';
import { joinUrl, type EmailImage } from './html';
import type { RenderedEmailImage } from './images';

// Where an email's pictures live once exported, and uploading them to the connected WordPress
// media library (electron/hosting.cjs). Exported file names carry a hash of the rendered picture
// (see renderEmailImages), so a changed picture gets a new name and URL (emails already sent keep
// the old one) and an unchanged one keeps its name and is never uploaded twice.
//
// Every place that writes a picture's src goes through pictureSources + pictureSrc: the Export
// window, Copy HTML, Copy for RentCafe and Claude's email_html / export_email. Order of precedence:
// the picture's own web address (EmailMeta.imageUrls), then the board's hosting choice.

export type WordPress = HostingStatus['wordpress'];

// ---------- the WordPress connection, shared by the panel and the export dialog ----------

interface WpState {
  /** undefined while checking, null when not connected. */
  wp: WordPress | undefined;
  set: (wp: WordPress) => void;
}

export const useWordPress = create<WpState>((set) => ({ wp: native ? undefined : null, set: (wp) => set({ wp }) }));

let checked = false;
/** Asks the desktop app once per session; components read useWordPress afterwards. */
export function checkWordPress() {
  if (checked || !native) return;
  checked = true;
  void native.hostingStatus().then((r) => useWordPress.getState().set(r.ok ? r.wordpress : null));
}

/** Asks the desktop app now and remembers the answer (for automation, which can't wait on a component). */
export async function refreshWordPress(): Promise<WordPress> {
  if (!native) return null;
  const r = await native.hostingStatus();
  const wp = r.ok ? r.wordpress : null;
  checked = true;
  useWordPress.getState().set(wp);
  return wp;
}

export async function hostingStatus() {
  if (!native) return null;
  const r = await native.hostingStatus();
  return r.ok ? r.wordpress : null;
}

// ---------- the board's hosting choice ----------

/**
 * Before hosting was saved on the board it lived in this browser's storage, shared by every email.
 * WordPress is only the default when a site is actually connected; otherwise it's one folder
 * address, empty until the user adds it.
 */
function legacyHosting(wp: WordPress | undefined): PictureHosting {
  const get = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const mode = get('spread.email.hosting');
  let urls: Record<string, string> = {};
  try {
    urls = JSON.parse(get('spread.email.imageUrls') ?? '{}') ?? {};
  } catch {
    // ignore a corrupt value
  }
  const connected = isElectron && !!wp;
  return {
    mode: mode === 'base' || mode === 'each' ? mode : connected && (mode === 'wordpress' || !mode) ? 'wordpress' : 'base',
    baseUrl: get('spread.email.baseUrl') ?? '',
    urls,
  };
}

/** The board's hosting choice, falling back to what older versions remembered. */
export function boardHosting(doc: Doc, wp: WordPress | undefined = useWordPress.getState().wp): PictureHosting {
  const h = doc.email?.hosting ?? legacyHosting(wp);
  // WordPress uploads need the desktop app.
  return h.mode === 'wordpress' && !isElectron ? { ...h, mode: 'base' } : h;
}

function boardById(boardId: string) {
  return useStore.getState().project.boards.find((b) => b.id === boardId);
}

function setEmail(boardId: string, patch: (email: EmailMeta) => EmailMeta) {
  const doc = boardById(boardId);
  if (!doc) return;
  useStore.getState().updateBoard(boardId, { email: patch({ ...doc.email }) });
}

/** Saves a change to a board's hosting choice (undoable, like any board setting). */
export function setBoardHosting(boardId: string, patch: Partial<PictureHosting>) {
  const doc = boardById(boardId);
  if (!doc) return;
  setEmail(boardId, (e) => ({ ...e, hosting: { ...boardHosting(doc), ...patch } }));
}

/** Saves which tool sends the email (null: not said, same as 'other'). */
export function setEmailPlatform(boardId: string, platform: EmailPlatform | null) {
  setEmail(boardId, (e) => ({ ...e, platform: platform ?? undefined }));
}

/** Sets (or with '' / null clears) pictures' own web addresses, by layer id. */
export function setImageUrls(boardId: string, urls: Record<string, string | null>) {
  const doc = boardById(boardId);
  if (!doc) return;
  const next = { ...doc.email?.imageUrls };
  for (const [id, url] of Object.entries(urls)) {
    const u = url?.trim() ?? '';
    if (u) next[id] = u;
    else delete next[id];
  }
  const email = { ...doc.email, imageUrls: Object.keys(next).length ? next : undefined };
  useStore.getState().updateBoard(boardId, { email });
}

const BAD_HOST = /drive\.google\.com|docs\.google\.com|\bbox\.com|dropbox\.com|onedrive\.live\.com|1drv\.ms/i;

/** What's wrong with a picture (or folder) URL, or null when it will work in an inbox. */
export function pictureUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (BAD_HOST.test(u)) return 'Drive, Box, Dropbox and OneDrive share links don’t work as email pictures. Use WordPress or your sending tool’s hosting.';
  if (/^http:\/\//i.test(u)) return 'Use https://. Many inboxes block plain http pictures.';
  if (!/^https:\/\/\S+$/i.test(u)) return 'Needs a full public address starting with https://';
  return null;
}

/** A full web address an inbox can load: absolute http(s). */
export const isWebAddress = (url: string | null | undefined) => !!url && /^https?:\/\/[^\s/]+\S*$/i.test(url.trim());

/** Why a typed web address can't be saved for a picture (stricter than isWebAddress: no share links). */
export function imageUrlProblem(url: string): string | null {
  const u = url.trim();
  if (BAD_HOST.test(u)) return pictureUrlProblem(u);
  if (!isWebAddress(u)) return 'Needs a full public address starting with https://';
  return null;
}

// ---------- one resolver for every picture src ----------

export interface PictureSources {
  hosting: PictureHosting;
  /** Pictures' own web addresses (EmailMeta.imageUrls). */
  imageUrls: Record<string, string>;
  /** WordPress URLs from an upload, by layer id. */
  uploaded?: Record<string, string>;
  /** Exported file names from a render, by layer id: `base` is the compiler's name, `name` has the hash. */
  files?: Record<string, { base: string; name: string }>;
}

/** Everything that decides a board's picture addresses. */
export function pictureSources(doc: Doc, extra: Omit<Partial<PictureSources>, 'hosting' | 'imageUrls'> = {}, wp?: WordPress): PictureSources {
  return { hosting: boardHosting(doc, wp), imageUrls: doc.email?.imageUrls ?? {}, ...extra };
}

/** File names from a render, for PictureSources.files. */
export function renderedNames(files: RenderedEmailImage[]): Record<string, { base: string; name: string }> {
  return Object.fromEntries(files.map((f) => [f.nodeId, { base: f.baseName, name: f.fileName }]));
}

/** A picture's own address: set on the picture, or (older boards in "URL per picture") in the hosting. */
export function ownAddress(s: PictureSources, nodeId: string): string | null {
  return s.imageUrls[nodeId]?.trim() || (s.hosting.mode === 'each' ? s.hosting.urls?.[nodeId]?.trim() : '') || null;
}

/** The pictures Spread has to render (and upload or write out): the ones without their own address. */
export function picturesToRender<T extends { nodeId: string }>(s: PictureSources, images: T[]): T[] {
  return images.filter((im) => !ownAddress(s, im.nodeId));
}

/** The exported file name: with its hash once rendered, else the compiler's name. */
export function pictureFileName(s: PictureSources, nodeId: string, fileName: string) {
  const f = s.files?.[nodeId];
  return f && f.base === fileName ? f.name : fileName;
}

/** The web address a picture gets, or null while it has none (no folder, not uploaded, not rendered yet). */
export function pictureAddress(s: PictureSources, nodeId: string, fileName: string): string | null {
  const own = ownAddress(s, nodeId);
  if (own) return own;
  if (s.hosting.mode === 'wordpress') return s.uploaded?.[nodeId] ?? null;
  if (s.hosting.mode === 'each') return null;
  const base = s.hosting.baseUrl?.trim() ?? '';
  if (!base || pictureUrlProblem(base)) return null;
  // The folder address only works with the exported (hashed) name, which needs a render.
  const f = s.files?.[nodeId];
  return f && f.base === fileName ? joinUrl(base, f.name) : null;
}

/** The src written into the HTML: the web address, or the file name for a draft. */
export function pictureSrc(s: PictureSources, nodeId: string, fileName: string): string {
  // Never a folder address with an unrendered name: that looks right and loads nothing.
  return pictureAddress(s, nodeId, fileName) ?? pictureFileName(s, nodeId, fileName);
}

export interface MissingPicture {
  nodeId: string;
  fileName: string;
  /** The picture's layer name, when known. */
  name?: string;
}

/** Pictures whose src would be a bare file name or anything but a full web address. */
export function picturesWithoutAddress(s: PictureSources, images: Pick<EmailImage, 'nodeId' | 'fileName'>[]): MissingPicture[] {
  const lacks = (im: Pick<EmailImage, 'nodeId' | 'fileName'>) => {
    const a = pictureAddress(s, im.nodeId, im.fileName);
    return !a || !!imageUrlProblem(a);
  };
  return images.filter(lacks).map((im) => ({ nodeId: im.nodeId, fileName: pictureFileName(s, im.nodeId, im.fileName) }));
}

/**
 * Why the HTML can't be copied yet, in plain words, with how to fix it. `where` is 'app' for the
 * Export window and 'claude' for automation (which names its parameters instead of buttons).
 */
export function missingAddressText(s: PictureSources, missing: MissingPicture[], where: 'app' | 'claude', wp?: WordPress): string {
  const n = missing.length;
  const names = missing.slice(0, 4).map((m) => m.name ?? m.fileName).join(', ') + (n > 4 ? ` and ${n - 4} more` : '');
  const head = `${n} picture${n === 1 ? ' has' : 's have'} no web address yet (${names}), so ${n === 1 ? 'it would show' : 'they would show'} as broken images.`;
  const own = where === 'app' ? 'or paste each picture’s own web address under Each picture' : "or set each picture's own address (urls, or spread_update_board imageUrls)";
  const base = s.hosting.baseUrl?.trim() ?? '';
  let fix: string;
  if (s.hosting.mode === 'wordpress') {
    fix =
      wp === null
        ? where === 'app'
          ? 'Connect WordPress, or switch to One folder URL.'
          : 'WordPress isn’t connected: ask the user to connect it (Export → Upload to WordPress), or pass baseUrl after they upload the pictures.'
        : where === 'app'
          ? 'Use Upload & copy HTML so Spread uploads them first.'
          : 'Export with host: "wordpress" so Spread uploads them first.';
  } else if (s.hosting.mode === 'each') {
    fix = where === 'app' ? 'Paste a web address for each one.' : "Pass urls { nodeId: 'https://…' } for each one.";
  } else if (!base) {
    fix = where === 'app' ? `Upload the pictures, then add the folder’s web address under Pictures, ${own}.` : `Export once, have the user upload the picture files, then pass baseUrl (the folder’s https address; it’s saved on the board), ${own}.`;
  } else if (pictureUrlProblem(base)) {
    fix = `The folder address doesn’t work: ${pictureUrlProblem(base)}`;
  } else {
    fix = where === 'app' ? 'Render the pictures first (Preview & export).' : 'Run spread_export_email so the pictures are rendered and named.';
  }
  return `${head} ${fix}`;
}

// ---------- uploading ----------

/** Uploads the pictures; returns { nodeId: url } and how many went up vs. were already there. */
export async function hostEmailImages(files: RenderedEmailImage[], onProgress?: (text: string) => void) {
  if (!native) throw new Error('Uploading needs the Spread desktop app');
  const items = await Promise.all(
    files.map(async (f) => ({
      nodeId: f.nodeId,
      name: f.fileName,
      type: f.blob.type || (/\.png$/i.test(f.fileName) ? 'image/png' : 'image/jpeg'),
      hash: f.hash,
      data: new Uint8Array(await f.blob.arrayBuffer()),
    })),
  );
  onProgress?.(`Uploading ${items.length} picture${items.length === 1 ? '' : 's'}…`);
  const r = await native.hostingUpload({ files: items.map(({ nodeId: _n, ...x }) => x) });
  if (!r.ok) throw new Error(r.error);
  const urls: Record<string, string> = {};
  for (const it of items) urls[it.nodeId] = r.urls[it.hash];
  return { urls, uploaded: r.uploaded, reused: r.reused };
}

// ---------- the sending tool ----------

/** Paste steps for RentCafe's email editor. */
export const RENTCAFE_STEPS = [
  'In RentCafe, open the email in the editor and switch to Source view.',
  'Select everything in the source and paste.',
  'Switch back to the normal view and check the pictures show.',
  'Send a test to your phone before sending.',
];

export const RENTCAFE_NOTE = 'RentCafe adds the unsubscribe link and your mailing address when it sends, so they don’t need to be in the design.';

/** The compile warnings that still apply for the board's sending tool. */
export function platformWarnings(doc: Doc, warnings: string[]): string[] {
  return doc.email?.platform === 'rentcafe' ? warnings.filter((w) => !/^No unsubscribe link found/.test(w)) : warnings;
}
