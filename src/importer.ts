import { getAsset, isFontFile, isHeic, isImageFile, registerFont, registerImage, sortFiles } from './assets';
import { fetchImage, readFile } from './platform';
import { useStore } from './store';
import { findNode, makeImage } from './tree';
import type { AssetMeta, ImageNode } from './types';

// Bringing photos and fonts into the document: file pickers, drops, tray → canvas placement.

/** Creates image nodes for the given assets around a strip-space point and selects them. */
export function placeAssets(assetIds: string[], at: { x: number; y: number }) {
  const s = useStore.getState();
  const W = s.doc.slideWidth;
  const nodes: ImageNode[] = [];
  assetIds.forEach((id, i) => {
    const meta = s.doc.assets[id] ?? getAsset(id)?.meta;
    if (!meta || meta.kind !== 'image') return;
    const w = Math.round(W * 0.6);
    const h = Math.round((w * meta.height) / Math.max(1, meta.width));
    nodes.push(makeImage(Math.round(at.x - w / 2 + i * 40), Math.round(at.y - h / 2 + i * 40), w, h, id, meta.name));
  });
  if (nodes.length) s.addNodes(nodes, null, true);
}

export async function importFiles(files: File[], opts: { dropAt?: { x: number; y: number }; targetImageId?: string } = {}) {
  const st = useStore.getState();
  const sorted = sortFiles(files);
  const images = sorted.filter((f) => isImageFile(f) || isHeic(f));
  const fonts = sorted.filter((f) => isFontFile(f));
  const heic = sorted.filter((f) => isHeic(f));
  const skipped = sorted.filter((f) => !isImageFile(f) && !isFontFile(f) && !isHeic(f) && !f.name.startsWith('.'));

  if (heic.length) st.toast(`Converting ${heic.length} HEIC photo${heic.length > 1 ? 's' : ''} to JPG…`);
  if (skipped.length) st.toast(`Skipped ${skipped.length} unsupported file${skipped.length > 1 ? 's' : ''}`, 'error');
  if (!images.length && !fonts.length) return;

  const metas: AssetMeta[] = [];
  const imageMetas: AssetMeta[] = [];
  const big = images.length > 6;
  for (let i = 0; i < images.length; i++) {
    if (big && i % 5 === 0) st.toast(`Importing ${i + 1}/${images.length}…`);
    try {
      const m = await registerImage(images[i], images[i].name);
      metas.push(m);
      imageMetas.push(m);
    } catch {
      st.toast(`Couldn't read ${images[i].name}`, 'error');
    }
  }
  for (const f of fonts) {
    try {
      const m = await registerFont(f, f.name);
      metas.push(m);
      st.toast(`Font added: ${m.family}`, 'success');
    } catch {
      st.toast(`Couldn't load font ${f.name}`, 'error');
    }
  }
  if (!metas.length) return;
  st.addAssets(metas);
  if (fonts.length) st.bumpFonts();
  if (!imageMetas.length) return;

  const ids = imageMetas.map((m) => m.id);
  const s = useStore.getState();
  if (opts.targetImageId && ids.length === 1) {
    const target = findNode(s.doc.nodes, opts.targetImageId);
    if (target && target.type === 'image') {
      s.updateNode(target.id, (n) => {
        const img = n as ImageNode;
        img.assetId = ids[0];
        img.crop = { zoom: 1, cx: 0.5, cy: 0.5 };
        img.name = imageMetas[0].name;
      });
      s.select([target.id]);
      return;
    }
  }
  if (opts.dropAt && ids.length <= 3) {
    placeAssets(ids, opts.dropAt);
    return;
  }
  if (ids.length >= 2) {
    s.set({ traySelection: ids, leftTab: 'photos', modal: 'arrange' });
    if (big) s.toast(`Imported ${ids.length} photos`, 'success');
    return;
  }
  s.set({ traySelection: ids, leftTab: 'photos' });
  s.toast('Added to Photos. Drag one onto a slide.');
}

/**
 * What a table's photo cell can hold: a photo already in the project (id or name), a web link or a
 * file path. Returns the photo's id, bringing it in first if it's new.
 */
export async function photoCell(value: string): Promise<string> {
  const v = value.trim();
  if (!v) return '';
  const known = useStore.getState().doc.assets;
  if (known[v]) return v;
  const named = Object.values(known).find((a) => a.name === v || a.name.replace(/\.[^.]+$/, '') === v);
  if (named) return named.id;
  let blob: Blob;
  if (/^https?:\/\//i.test(v)) {
    const r = await fetchImage(v);
    blob = new Blob([r.data as BlobPart], { type: r.type });
  } else if (/^(\/|[a-z]:\\)/i.test(v)) {
    blob = new Blob([(await readFile(v)).data as BlobPart]);
  } else throw new Error(`No photo called "${v}"`);
  const name = decodeURIComponent(v.split(/[?#]/)[0].split(/[\\/]/).pop() || 'Photo');
  const meta = await registerImage(blob, name);
  useStore.getState().addAssets([meta]);
  return meta.id;
}

function pick(configure: (input: HTMLInputElement) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.style.display = 'none';
  configure(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) void importFiles(files);
  });
  document.body.appendChild(input);
  input.click();
}

export function pickImages() {
  pick((i) => {
    i.multiple = true;
    i.accept = 'image/*,.heic,.heif,.ttf,.otf,.woff,.woff2';
  });
}

export function pickFolder() {
  pick((i) => {
    i.multiple = true;
    (i as any).webkitdirectory = true;
    i.setAttribute('webkitdirectory', '');
  });
}

/** Picks one image and puts it into an existing image node. */
export function pickReplacement(targetImageId: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.heic,.heif';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) void importFiles(files.slice(0, 1), { targetImageId });
  });
  document.body.appendChild(input);
  input.click();
}

/** Picks font files and registers them. */
export function pickFonts() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.ttf,.otf,.woff,.woff2';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) void importFiles(files);
  });
  document.body.appendChild(input);
  input.click();
}
