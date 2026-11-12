import { isHeic, isImageFile, toDecodable } from './assets';
import type { ChatThumb } from './platform';

// Pictures pasted or dropped into a message to Claude. Each one is decoded and, when it's big,
// redrawn smaller in the renderer, so what goes to Claude Code is a JPEG, PNG, GIF or WebP whose long
// edge is at most 1568px (what Claude actually looks at) and well under the 5 MB an image may be.
// A small WebP thumbnail rides along for the composer and the transcript; only that is saved.

export interface ChatImage {
  id: string;
  name: string;
  /** What Claude Code is sent: base64 without the data: prefix. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
  width: number;
  height: number;
  /** A small data: URL, for the composer and the transcript. */
  thumb: string;
  /** Where it lives on disk, when it came from the Finder: Claude can open or place it from there. */
  path?: string;
}

const LONG_EDGE = 1568;
const MAX_BYTES = 3.75 * 1024 * 1024;
const THUMB_EDGE = 192;
const SENDABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Files a message can carry as pictures (HEIC too: it's converted first). */
export const isChatImage = (f: File) => isImageFile(f) || isHeic(f);

let n = 0;

function draw(src: CanvasImageSource, w: number, h: number, edge: number) {
  const k = Math.min(1, edge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, quality));

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** True when any pixel is see-through, so the picture stays a PNG instead of turning into a JPEG. */
function hasAlpha(c: HTMLCanvasElement) {
  const probe = draw(c, c.width, c.height, 256);
  const px = probe.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, probe.width, probe.height).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
  return false;
}

/** Decodes a pasted or dropped picture and makes it ready to send. Null if it can't be read. */
export async function prepareChatImage(file: File | Blob, name = (file as File).name || 'Pasted picture', path?: string): Promise<ChatImage | null> {
  try {
    const { blob } = await toDecodable(file, name);
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const { width, height } = bmp;
    const thumb = draw(bmp, width, height, THUMB_EDGE).toDataURL('image/webp', 0.75);
    const id = `img${Date.now().toString(36)}${n++}`;
    // Already small enough and in a format Claude reads: send the original bytes.
    if (SENDABLE.has(blob.type) && Math.max(width, height) <= LONG_EDGE && blob.size <= MAX_BYTES) {
      bmp.close();
      return { id, name, mediaType: blob.type as ChatImage['mediaType'], data: await base64Of(blob), width, height, thumb, path };
    }
    let edge = LONG_EDGE;
    let canvas = draw(bmp, width, height, edge);
    bmp.close();
    const png = hasAlpha(canvas);
    for (let attempt = 0; attempt < 6; attempt++) {
      const out = await toBlob(canvas, png ? 'image/png' : 'image/jpeg', png ? undefined : attempt < 2 ? 0.86 - attempt * 0.12 : 0.72);
      if (out && out.size <= MAX_BYTES) return { id, name, mediaType: png ? 'image/png' : 'image/jpeg', data: await base64Of(out), width: canvas.width, height: canvas.height, thumb, path };
      // Still too heavy: shrink and try again.
      edge = Math.round(edge * 0.8);
      canvas = draw(canvas, canvas.width, canvas.height, edge);
    }
    return null;
  } catch {
    return null;
  }
}

/** What the transcript keeps of a picture: its thumbnail and name, never the full image. */
export const thumbOf = (im: ChatImage): ChatThumb => ({ thumb: im.thumb, name: im.name, width: im.width, height: im.height });
