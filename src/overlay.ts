import { create } from 'zustand';
import { getAsset, registerImage } from './assets';
import { parseNameTags } from './email/html';
import { renderBoardCanvas } from './exporter';
import { getLayout } from './layout';
import { useLibrary } from './library';
import { native, readFile } from './platform';
import { absoluteBoxes } from './render';
import { useStore } from './store';
import { walk } from './tree';
import type { BoardOverlay, Doc } from './types';

// The reference overlay: a past design laid over a board so the two can be compared. The picture
// is drawn in HTML above the canvas, so it can never reach an export, and it's saved with the
// board like a photo. Comparing renders the board and measures it against the picture: how many
// pixels differ, where, and which parts sit higher or lower than they did.

/** Past emails render wider than the compiler's 600px breakpoint, so they get their desktop layout. */
const HTML_WIDTH = 640;
/** Colour difference (0-255) that counts as changed. Below this is JPEG noise and antialiasing. */
const THRESHOLD = 24;
const CELL = 8;
const MAX_REGIONS = 12;

const CHANGED = 1;
const UNCOVERED = 2;

export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of this area's pixels that differ. */
  percent: number;
  /** The layers under it, biggest overlap first. */
  layers: { id: string; name: string }[];
}

export interface DriftBand {
  fromY: number;
  toY: number;
  /** Pixels lower than the reference (negative: higher). */
  shift: number;
}

export interface OverlayReport {
  boardId: string;
  /** What was compared. A different key means the report is out of date. */
  key: string;
  width: number;
  height: number;
  referenceHeight: number;
  changedPercent: number;
  /** Share of the board the reference doesn't reach. */
  uncoveredPercent: number;
  regionCount: number;
  regions: DiffRegion[];
  drift: DriftBand[];
  /** Changed pixels as a picture, for the Changes view. */
  url: string;
  /** Pixels of that picture per board pixel. */
  ratio: number;
}

/** The last comparison per board. Working state, so it isn't saved or undone. */
export const useOverlayReports = create<Record<string, OverlayReport>>(() => ({}));

export const overlayKey = (b: Doc) => JSON.stringify([b.overlay?.assetId, b.overlay?.x, b.overlay?.y, b.overlay?.scale, b.slideHeight, b.slideWidth * b.slides.length, b.nodes.length, nodesVersion(b)]);

const versions = new WeakMap<object, number>();
let nextVersion = 1;
/** Layers are replaced on every edit, so identity tells whether they've changed. */
function nodesVersion(b: Doc) {
  let v = versions.get(b.nodes);
  if (!v) versions.set(b.nodes, (v = nextVersion++));
  return v;
}

const urls = new Map<string, string>();
/** A full-size URL for a reference picture, or null if its file is gone. */
export function overlayUrl(assetId: string): string | null {
  const known = urls.get(assetId);
  if (known) return known;
  const rec = getAsset(assetId);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(assetId, url);
  return url;
}

// ---------- setting a reference ----------

function boardById(id: string) {
  const b = useStore.getState().project.boards.find((x) => x.id === id);
  if (!b) throw new Error(`No board ${id}.`);
  return b;
}

async function place(boardId: string, blob: Blob, name: string, fit?: Partial<BoardOverlay>) {
  const meta = await registerImage(blob, name);
  const b = boardById(boardId);
  const width = b.slideWidth * b.slides.length;
  const overlay: BoardOverlay = { assetId: meta.id, name, x: 0, y: 0, scale: width / meta.width, opacity: 0.5, mode: 'fade', visible: true, ...fit };
  // Kept off the Photos tray: it's a comparison, not something to place.
  useStore.getState().changeProject((p) => {
    const t = p.boards.find((x) => x.id === boardId);
    if (!t) return;
    dropAsset(t);
    t.assets[meta.id] = meta;
    t.overlay = overlay;
  });
  return overlay;
}

function dropAsset(b: Doc) {
  if (b.overlay && !b.assetOrder.includes(b.overlay.assetId)) delete b.assets[b.overlay.assetId];
}

const isHtml = (name: string) => /\.html?$/i.test(name);

/** Pictures come in as they are. HTML is photographed at desktop width, with its pictures found beside the file. */
async function fromBytes(boardId: string, data: Blob, name: string, path?: string) {
  if (!isHtml(name)) return place(boardId, data, name);
  if (!native) throw new Error('Past emails as HTML need the desktop app. Use a picture of the email here.');
  const dir = path?.replace(/[\\/][^\\/]*$/, '');
  const shot = await native.renderHtml({ html: await data.text(), width: HTML_WIDTH, height: 0, dir, format: 'png' });
  const width = boardById(boardId).slideWidth;
  return place(boardId, new Blob([shot as BlobPart], { type: 'image/png' }), name.replace(/\.html?$/i, '.png'), { scale: 1, x: (width - HTML_WIDTH) / 2 });
}

export function overlayFromFile(boardId: string, file: File) {
  const path = native ? native.pathForFile(file) : undefined;
  return fromBytes(boardId, file, file.name, path || undefined);
}

export async function overlayFromPath(boardId: string, path: string) {
  const f = await readFile(path);
  return fromBytes(boardId, new Blob([f.data as BlobPart]), f.name, path);
}

export async function overlayFromBoard(boardId: string, fromBoardId: string) {
  const name = boardById(fromBoardId).name;
  const { canvas, ratio } = await renderBoardCanvas(fromBoardId);
  useStore.getState().setActiveBoard(boardId);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error(`Couldn't render "${name}".`);
  return place(boardId, blob, `${name}.png`, { scale: 1 / ratio });
}

export async function overlayFromLibrary(boardId: string, referenceId: string) {
  const r = useLibrary.getState().references.find((x) => x.id === referenceId);
  if (!r) throw new Error(`No saved reference ${referenceId}.`);
  const f = await readFile(`${r.dir}/${r.images[0]}`);
  return place(boardId, new Blob([f.data as BlobPart], { type: 'image/jpeg' }), `${r.name}.jpg`);
}

export function patchOverlay(boardId: string, patch: Partial<BoardOverlay>, key?: string) {
  useStore.getState().changeProject((p) => {
    const b = p.boards.find((x) => x.id === boardId);
    if (b?.overlay) Object.assign(b.overlay, patch);
  }, key ?? 'overlay-' + boardId);
}

export function removeOverlay(boardId: string) {
  useStore.getState().changeProject((p) => {
    const b = p.boards.find((x) => x.id === boardId);
    if (!b?.overlay) return;
    dropAsset(b);
    delete b.overlay;
  });
  useOverlayReports.setState((s) => {
    const { [boardId]: gone, ...rest } = s;
    if (gone) URL.revokeObjectURL(gone.url);
    return rest;
  }, true);
}

// ---------- measuring (plain arrays, so these run anywhere) ----------

/**
 * Marks each pixel changed or not. Where the reference has no pixels there's nothing to compare.
 * `loose` forgives a match one pixel away: a resized picture can't land on the same pixels, so
 * every edge of type would otherwise count as changed.
 */
export function diffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, loose = false, threshold = THRESHOLD) {
  const mask = new Uint8Array(a.length / 4);
  const far = (i: number, j: number) => Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2])) > threshold;
  const height = mask.length / width;
  let changed = 0;
  let uncovered = 0;
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    if (b[i + 3] < 128) {
      mask[p] = UNCOVERED;
      uncovered++;
      continue;
    }
    if (!far(i, i)) continue;
    let near = false;
    if (loose) {
      const x = p % width;
      const y = (p / width) | 0;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1 && !near; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) near = !far(i, (ny * width + nx) * 4);
        }
      }
    }
    if (!near) {
      mask[p] = CHANGED;
      changed++;
    }
  }
  return { mask, changed, uncovered };
}

/** Groups changed pixels into boxes: nearby cells of change join up, stray specks are dropped. */
export function findRegions(mask: Uint8Array, width: number, height: number, minInCell = 6) {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const counts = new Uint16Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (mask[y * width + x] === CHANGED) counts[((y / CELL) | 0) * cols + ((x / CELL) | 0)]++;
  }
  const hot = (i: number) => counts[i] >= minInCell;
  const seen = new Uint8Array(cols * rows);
  const out: { x: number; y: number; w: number; h: number; percent: number }[] = [];
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || !hot(start)) continue;
    const stack = [start];
    seen[start] = 1;
    let [c0, c1, r0, r1, cells] = [cols, 0, rows, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols;
      const r = (i / cols) | 0;
      cells++;
      [c0, c1, r0, r1] = [Math.min(c0, c), Math.max(c1, c), Math.min(r0, r), Math.max(r1, r)];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const n = nr * cols + nc;
          if (!seen[n] && hot(n)) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (cells < 2) continue;
    const x = c0 * CELL;
    const y = r0 * CELL;
    const w = Math.min(width, (c1 + 1) * CELL) - x;
    const h = Math.min(height, (r1 + 1) * CELL) - y;
    let changed = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (mask[yy * width + xx] === CHANGED) changed++;
    out.push({ x, y, w, h, percent: Math.round((changed / (w * h)) * 1000) / 10 });
  }
  return out.sort((p, q) => q.w * q.h - p.w * p.h);
}

/**
 * Finds what moved up or down. Each strip of the board looks for itself in the reference within
 * `reach` rows. Strips of plain colour match anywhere, so they take on their neighbours' answer,
 * and strips that match nothing are new content, not movement.
 */
export function findDrift(a: Uint8Array, b: Uint8Array, width: number, heightA: number, heightB: number, minShift = 1, strip = 32, reach = 240): DriftBand[] {
  const errorAt = (y0: number, y1: number, dy: number) => {
    let sum = 0;
    let rows = 0;
    for (let y = y0; y < y1; y += 2) {
      const yb = y + dy;
      if (yb < 0 || yb >= heightB) continue;
      rows++;
      const pa = y * width;
      const pb = yb * width;
      for (let x = 0; x < width; x++) sum += Math.abs(a[pa + x] - b[pb + x]);
    }
    return rows * 2 >= (y1 - y0) * 0.6 ? sum / (rows * width) : Infinity;
  };
  const plain = (y0: number, y1: number) => {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = 0; x < width; x++) {
        const v = a[y * width + x];
        sum += v;
        sq += v * v;
        n++;
      }
    }
    return sq / n - (sum / n) ** 2 < 16;
  };
  const strips: { y0: number; y1: number; dy: number | null | 'plain' }[] = [];
  let prev = 0;
  for (let y0 = 0; y0 < heightA; y0 += strip) {
    const y1 = Math.min(heightA, y0 + strip);
    if (plain(y0, y1)) {
      strips.push({ y0, y1, dy: 'plain' });
      continue;
    }
    let best = errorAt(y0, y1, prev);
    let dy = prev;
    // Nearest offsets first, so a repeating pattern can't pull the answer far away.
    for (let step = 0; step <= reach; step++) {
      for (const d of step ? [step, -step] : [0]) {
        const e = errorAt(y0, y1, d);
        if (e < best - 0.5) {
          best = e;
          dy = d;
        }
      }
    }
    if (best > 10) strips.push({ y0, y1, dy: null });
    else {
      strips.push({ y0, y1, dy });
      prev = dy;
    }
  }
  const bands: DriftBand[] = [];
  let open: { fromY: number; toY: number; dy: number } | null = null;
  const close = () => {
    if (open && Math.abs(open.dy) >= minShift) bands.push({ fromY: open.fromY, toY: open.toY, shift: -open.dy });
    open = null;
  };
  for (const s of strips) {
    if (s.dy === 'plain') {
      if (open) open.toY = s.y1;
    } else if (s.dy === null) {
      close();
    } else if (open && open.dy === s.dy) {
      open.toY = s.y1;
    } else {
      close();
      open = { fromY: s.y0, toY: s.y1, dy: s.dy };
    }
  }
  close();
  // A strip across the edge of a move matches somewhere in between, so it joins the band beside it.
  // Any other lone strip is a chance match: one strip of type looks like many others.
  return bands.filter((d, i) => {
    if (d.toY - d.fromY > strip) return true;
    const next = bands[i + 1];
    if (next && next.fromY === d.toY && Math.abs(next.shift - d.shift) < strip) next.fromY = d.fromY;
    return false;
  });
}

// ---------- comparing ----------

function grayOf(source: CanvasImageSource, srcW: number, height: number, width: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, srcW, height, 0, 0, width, height);
  const d = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return out;
}

function layersIn(b: Doc, fontsVersion: number, r: { x: number; y: number; w: number; h: number }) {
  const boxes = absoluteBoxes(b.nodes, getLayout(b.nodes, fontsVersion));
  const hits: { id: string; name: string; area: number }[] = [];
  const frames: { id: string; name: string; size: number }[] = [];
  walk(b.nodes, (n) => {
    const box = boxes.get(n.id);
    if (!n.visible || !box) return;
    const w = Math.min(r.x + r.w, box.x + box.w) - Math.max(r.x, box.x);
    const h = Math.min(r.y + r.h, box.y + box.h) - Math.max(r.y, box.y);
    if (w <= 0 || h <= 0) return;
    const name = parseNameTags(n.name).clean || n.type;
    if (n.type === 'frame' && n.children.length) frames.push({ id: n.id, name, size: box.w * box.h });
    else hits.push({ id: n.id, name, area: w * h });
  });
  // Nothing drawn here but a frame's own fill: name the tightest frame.
  if (!hits.length) return frames.sort((p, q) => p.size - q.size).slice(0, 1).map(({ id, name }) => ({ id, name }));
  return hits
    .sort((p, q) => q.area - p.area)
    .slice(0, 3)
    .map(({ id, name }) => ({ id, name }));
}

/** Measures a board against its reference. `picture` also returns the board with changes marked, as a JPEG. */
export async function compareOverlay(boardId: string, opts: { picture?: boolean } = {}): Promise<OverlayReport & { base64?: string }> {
  const start = boardById(boardId);
  const o = start.overlay;
  if (!o) throw new Error(`Board "${start.name}" has no reference to compare.`);
  const rec = getAsset(o.assetId);
  if (!rec) throw new Error(`The reference file "${o.name}" is missing. Add it again.`);
  const { canvas, ratio } = await renderBoardCanvas(boardId);
  const b = boardById(boardId);
  const W = canvas.width;
  const H = canvas.height;
  const bmp = await createImageBitmap(rec.blob);
  const refW = bmp.width * o.scale * ratio;
  const refH = bmp.height * o.scale * ratio;
  const refBottom = Math.round(o.y * ratio + refH);

  // The reference as it lands on the board, run on past the bottom so moved content can be found.
  const ref = document.createElement('canvas');
  ref.width = W;
  ref.height = Math.max(H, refBottom);
  const rctx = ref.getContext('2d', { willReadFrequently: true })!;
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(bmp, o.x * ratio, o.y * ratio, refW, refH);
  bmp.close();

  const a = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const r = rctx.getImageData(0, 0, W, H).data;
  const resized = Math.abs(o.scale * ratio - 1) > 0.001;
  const { mask, changed, uncovered } = diffPixels(a, r, W, resized);
  // Resizing leaves specks along type. Real changes fill a cell.
  const regions = findRegions(mask, W, H, resized ? 20 : 6);

  const gw = Math.min(160, W);
  const drift = findDrift(grayOf(canvas, W, H, gw), grayOf(ref, W, ref.height, gw), gw, H, ref.height, resized ? 2 : 1);

  const marks = document.createElement('canvas');
  marks.width = W;
  marks.height = H;
  const mctx = marks.getContext('2d')!;
  const img = mctx.createImageData(W, H);
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== CHANGED) continue;
    const i = p * 4;
    img.data[i] = 255;
    img.data[i + 1] = 0;
    img.data[i + 2] = 200;
    img.data[i + 3] = 190;
  }
  mctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => marks.toBlob(res, 'image/png'));
  if (!blob) throw new Error("Couldn't draw the changes.");

  const px = (v: number) => Math.round(v / ratio);
  const fv = useStore.getState().fontsVersion;
  const compared = W * H - uncovered;
  const report: OverlayReport = {
    boardId,
    key: overlayKey(b),
    width: px(W),
    height: px(H),
    referenceHeight: px(refBottom),
    changedPercent: compared ? Math.round((changed / compared) * 1000) / 10 : 0,
    uncoveredPercent: Math.round((uncovered / (W * H)) * 1000) / 10,
    regionCount: regions.length,
    regions: regions.slice(0, MAX_REGIONS).map((g) => {
      const box = { x: px(g.x), y: px(g.y), w: px(g.w), h: px(g.h) };
      return { ...box, percent: g.percent, layers: layersIn(b, fv, box) };
    }),
    drift: drift.map((d) => ({ fromY: px(d.fromY), toY: px(d.toY), shift: px(d.shift) })),
    url: URL.createObjectURL(blob),
    ratio,
  };
  const old = useOverlayReports.getState()[boardId];
  if (old) URL.revokeObjectURL(old.url);
  useOverlayReports.setState({ [boardId]: report });
  if (!opts.picture) return report;
  const shot = document.createElement('canvas');
  const fit = Math.min(1, 1600 / Math.max(W, H));
  shot.width = Math.round(W * fit);
  shot.height = Math.round(H * fit);
  const sctx = shot.getContext('2d')!;
  sctx.drawImage(canvas, 0, 0, shot.width, shot.height);
  sctx.drawImage(marks, 0, 0, shot.width, shot.height);
  return { ...report, base64: shot.toDataURL('image/jpeg', 0.85).split(',')[1] };
}

/** One line per thing worth saying, biggest first. */
export function overlaySummary(r: OverlayReport): string[] {
  const lines = [`${r.changedPercent}% of pixels differ, in ${r.regionCount} ${r.regionCount === 1 ? 'area' : 'areas'}.`];
  const delta = r.height - r.referenceHeight;
  if (Math.abs(delta) > 1) lines.push(`The board is ${Math.abs(delta)}px ${delta > 0 ? 'taller' : 'shorter'} than the reference.`);
  for (const d of r.drift) lines.push(`${d.fromY}–${d.toY} sits ${Math.abs(d.shift)}px ${d.shift > 0 ? 'lower' : 'higher'} than the reference.`);
  return lines;
}
