import { native } from '../platform';
import type { RenderedEmailImage } from './images';

// Uploading an email's rendered pictures to the connected WordPress media library
// (electron/hosting.cjs). File names carry a hash of the picture, so a changed picture gets a new
// URL (emails already sent keep the old one) and an unchanged one is never uploaded twice.

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
