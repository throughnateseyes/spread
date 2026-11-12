import { create } from 'zustand';
import { isElectron, native, type HostingStatus } from '../platform';
import { useStore } from '../store';
import type { Doc, PictureHosting } from '../types';
import { joinUrl } from './html';
import type { RenderedEmailImage } from './images';

// Where an email's pictures live once exported, and uploading them to the connected WordPress
// media library (electron/hosting.cjs). File names carry a hash of the picture, so a changed picture
// gets a new URL (emails already sent keep the old one) and an unchanged one is never uploaded twice.

export type WordPress = HostingStatus['wordpress'];

// ---------- the board's hosting choice ----------

/** Before hosting was saved on the board it lived in this browser's storage, shared by every email. */
function legacyHosting(): PictureHosting {
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
  return {
    mode: mode === 'base' || mode === 'each' || (mode === 'wordpress' && isElectron) ? mode : isElectron ? 'wordpress' : 'base',
    baseUrl: get('spread.email.baseUrl') ?? '',
    urls,
  };
}

/** The board's hosting choice, falling back to what older versions remembered. */
export function boardHosting(doc: Doc): PictureHosting {
  const h = doc.email?.hosting ?? legacyHosting();
  // WordPress uploads need the desktop app.
  return h.mode === 'wordpress' && !isElectron ? { ...h, mode: 'base' } : h;
}

/** Saves a change to a board's hosting choice (undoable, like any board setting). */
export function setBoardHosting(boardId: string, patch: Partial<PictureHosting>) {
  const s = useStore.getState();
  const doc = s.project.boards.find((b) => b.id === boardId);
  if (!doc) return;
  s.updateBoard(boardId, { email: { ...doc.email, hosting: { ...boardHosting(doc), ...patch } } });
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

/** The src a picture gets in the HTML. `uploaded` holds WordPress URLs from this session's upload. */
export function pictureSrc(h: PictureHosting, nodeId: string, fileName: string, uploaded: Record<string, string> = {}) {
  if (h.mode === 'wordpress') return uploaded[nodeId] ?? fileName;
  if (h.mode === 'base') return h.baseUrl?.trim() ? joinUrl(h.baseUrl, fileName) : fileName;
  return h.urls?.[nodeId]?.trim() || fileName;
}

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

// ---------- uploading ----------

async function hashOf(data: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const withHash = (fileName: string, hash: string) => fileName.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${hash}${ext}`);

/** Uploads the pictures; returns { nodeId: url } and how many went up vs. were already there. */
export async function hostEmailImages(files: RenderedEmailImage[], onProgress?: (text: string) => void) {
  if (!native) throw new Error('Uploading needs the Spread desktop app');
  const items = await Promise.all(
    files.map(async (f) => {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const hash = await hashOf(data);
      return { nodeId: f.nodeId, name: withHash(f.fileName, hash), type: f.blob.type || (/\.png$/i.test(f.fileName) ? 'image/png' : 'image/jpeg'), hash, data };
    }),
  );
  onProgress?.(`Uploading ${items.length} picture${items.length === 1 ? '' : 's'}…`);
  const r = await native.hostingUpload({ files: items.map(({ nodeId: _n, ...x }) => x) });
  if (!r.ok) throw new Error(r.error);
  const urls: Record<string, string> = {};
  for (const it of items) urls[it.nodeId] = r.urls[it.hash];
  return { urls, uploaded: r.uploaded, reused: r.reused };
}

export async function hostingStatus() {
  if (!native) return null;
  const r = await native.hostingStatus();
  return r.ok ? r.wordpress : null;
}
