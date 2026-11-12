import type { AssetMeta } from './types';
import { uid } from './tree';

// Asset registry: the binary side of the document. Doc only stores AssetMeta; blobs,
// decoded previews and thumbnails live here, keyed by asset id.
//
// Memory strategy: originals stay as compressed Blobs. On-canvas rendering uses a downscaled
// preview (≤ PREVIEW_MAX px). Full resolution is decoded only during export (loadFull).

export const PREVIEW_MAX = 1800;
const THUMB_MAX = 320;

export interface AssetRecord {
  meta: AssetMeta;
  blob: Blob;
  preview?: HTMLCanvasElement;
  thumbUrl?: string;
}

const registry = new Map<string, AssetRecord>();

export function getAsset(id: string): AssetRecord | undefined {
  return registry.get(id);
}

export function allAssets(): AssetRecord[] {
  return [...registry.values()];
}

export function clearAssets() {
  for (const r of registry.values()) if (r.thumbUrl) URL.revokeObjectURL(r.thumbUrl);
  registry.clear();
}

export function removeAsset(id: string) {
  const r = registry.get(id);
  if (r?.thumbUrl) URL.revokeObjectURL(r.thumbUrl);
  registry.delete(id);
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export function isImageFile(f: { name: string; type?: string }) {
  return (f.type && f.type.startsWith('image/') && !/heic|heif/i.test(f.type)) || IMAGE_EXT.test(f.name);
}
export function isFontFile(f: { name: string }) {
  return FONT_EXT.test(f.name);
}
export function isHeic(f: { name: string; type?: string }) {
  return /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type ?? '');
}

function scaledCanvas(src: CanvasImageSource, sw: number, sh: number, max: number) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * HEIC/HEIF (iPhone) photos can't be decoded by Chromium, so convert them to high-quality JPEG.
 * The decoder (libheif, ~3 MB) is only loaded the first time a HEIC shows up.
 */
export async function toDecodable(blob: Blob, name: string): Promise<{ blob: Blob; name: string }> {
  if (!isHeic({ name, type: blob.type })) return { blob, name };
  const { heicTo } = await import('heic-to');
  const jpeg = await heicTo({ blob, type: 'image/jpeg', quality: 0.95 });
  return { blob: jpeg, name: name.replace(/\.(heic|heif)$/i, '') + '.jpg' };
}

/** Decodes an image blob and registers it. Returns its meta (caller adds it to the doc). */
export async function registerImage(input: Blob, rawName: string, id = uid()): Promise<AssetMeta> {
  const { blob, name } = await toDecodable(input, rawName);
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const meta: AssetMeta = { id, name, kind: 'image', mime: blob.type || guessMime(name), width: bmp.width, height: bmp.height };
  const preview = scaledCanvas(bmp, bmp.width, bmp.height, PREVIEW_MAX);
  bmp.close();
  const thumbCanvas = scaledCanvas(preview, preview.width, preview.height, THUMB_MAX);
  const thumbBlob = await new Promise<Blob | null>((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.8));
  registry.set(id, { meta, blob, preview, thumbUrl: thumbBlob ? URL.createObjectURL(thumbBlob) : undefined });
  return meta;
}

const fontRanges = new Map<string, [number, number]>();

/** The weights an uploaded variable font can draw, or undefined for a single-weight font. */
export const fontWeightRange = (family: string) => fontRanges.get(family);

/**
 * Finds a variable font's weight range by drawing it: a variable font lays down more ink as the
 * weight rises and stops changing past the ends of its axis. Works for every format, WOFF2 included.
 */
async function variableWeightRange(data: ArrayBuffer): Promise<[number, number] | null> {
  const family = `spread-probe-${uid()}`;
  const face = new FontFace(family, data.slice(0), { weight: '1 1000' });
  try {
    await face.load();
    document.fonts.add(face);
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 96;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
    const ink = weights.map((w) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${w} 64px "${family}"`;
      ctx.fillText('Hamburg', 0, 72);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 3; i < px.length; i += 4) sum += px[i];
      return sum;
    });
    const moved = weights.filter((_, i) => i < weights.length - 1 && ink[i] !== ink[i + 1]);
    return moved.length ? [moved[0], moved[moved.length - 1] + 100] : null;
  } catch {
    return null;
  } finally {
    document.fonts.delete(face);
  }
}

const NAMED_WEIGHTS: [RegExp, number][] = [
  [/\b(hairline|thin)\b/i, 100],
  [/\b(extra|ultra)\s*light\b/i, 200],
  [/\b(semi|demi)\s*bold\b/i, 600],
  [/\b(extra|ultra)\s*bold\b/i, 800],
  [/\b(black|heavy)\b/i, 900],
  [/\blight\b/i, 300],
  [/\bmedium\b/i, 500],
  [/\bbold\b/i, 700],
  [/\b(regular|normal|book|roman)\b/i, 400],
];

/** The weight a single-weight font file's family name says it is ("Roboto Bold" → 700), if any. */
export function weightInName(family: string): number | null {
  const name = family.replace(/([a-z])([A-Z])/g, '$1 $2');
  return NAMED_WEIGHTS.find(([re]) => re.test(name))?.[1] ?? null;
}

/**
 * The CSS font-weight descriptors an uploaded font is registered under, one face per entry.
 * A variable font gets its range. A single-weight font gets 400 plus the weight its name gives
 * ("Roboto Bold" → 400 and 700): at 700 the browser draws the real bold instead of thickening it a
 * second time, and designs saved with that font at 400 keep drawing the same file as before.
 */
export function fontFaceWeights(family: string): string[] {
  const range = fontRanges.get(family);
  if (range) return [`${range[0]} ${range[1]}`];
  const named = weightInName(family);
  return named && named !== 400 ? ['400', String(named)] : ['400'];
}

/** Registers a font file under a CSS family name derived from the file name. */
export async function registerFont(blob: Blob, name: string, id = uid(), family?: string): Promise<AssetMeta> {
  const fam = family ?? name.replace(FONT_EXT, '').replace(/[-_]+/g, ' ').trim();
  const data = await blob.arrayBuffer();
  const range = await variableWeightRange(data);
  if (range) fontRanges.set(fam, range);
  // Without a declared range the browser treats a variable font as one weight and never moves its axis.
  for (const weight of fontFaceWeights(fam)) {
    const face = new FontFace(fam, data.slice(0), { weight });
    await face.load();
    document.fonts.add(face);
  }
  const meta: AssetMeta = { id, name, kind: 'font', mime: blob.type || guessMime(name), width: 0, height: 0, family: fam };
  registry.set(id, { meta, blob });
  return meta;
}

/** Full-resolution decode for export. Caller must close() the bitmap. */
export function loadFull(id: string): Promise<ImageBitmap> | null {
  const r = registry.get(id);
  if (!r) return null;
  return createImageBitmap(r.blob, { imageOrientation: 'from-image' });
}

export function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' } as Record<string, string>)[ext] ?? 'application/octet-stream'
  );
}

export function extFor(meta: AssetMeta) {
  const fromName = meta.name.split('.').pop();
  if (fromName && fromName.length <= 5 && fromName !== meta.name) return fromName.toLowerCase();
  return meta.mime.split('/')[1] ?? 'bin';
}

// ---------- gathering files from drops / pickers ----------

/** Flattens a DataTransfer (files and dropped folders, recursively) into File objects. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
    if (e) entries.push(e);
  }
  if (!entries.length) return Array.from(dt.files);
  const out: File[] = [];
  const readEntry = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches; keep reading until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await readEntry(b);
      }
    }
  };
  for (const e of entries) await readEntry(e);
  return out;
}

/** Natural sort so IMG_2.jpg comes before IMG_10.jpg. */
export function sortFiles(files: File[]) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...files].sort((a, b) => coll.compare((a as any).webkitRelativePath || a.name, (b as any).webkitRelativePath || b.name));
}
