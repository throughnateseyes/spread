import { nanoid } from 'nanoid';
import type Konva from 'konva';
import type { BlurEffect, DitherEffect, FrameNode, GrainEffect, ImageNode, PhotoEffect, ShapeNode } from './types';
import { cropGeometry, filterString, roundRectPath } from './render';

// Photo effects, drawn fresh from the original photo so they can always be changed or removed.
// Each effect takes the picture so far and returns a new one, in stack order. Sizes are measured in
// layer px, not screen px or photo px, so a look holds at any zoom and in every export.
//
// To add an effect: one entry in EFFECTS (its defaults, step and settings) and its library looks in
// EFFECT_LIBRARY. The panel, previews and exports all read from those two lists.

type Source = CanvasImageSource & { width: number; height: number };

const activeStack = (effects: PhotoEffect[] | undefined) => (effects ?? []).filter((e) => e.enabled);

export const hasEffects = (n: ImageNode) => activeStack(n.effects).length > 0;
/** JPEG smears a dither's hard cells, so dithered photos have to stay PNG. */
export const needsLossless = (n: ImageNode) => activeStack(n.effects).some((e) => e.type === 'dither');

// ---------- cache ----------

/** Results stay while they fit this many pixels (about 200 MB), oldest out first. */
const CACHE_PX = 48e6;
const cache = new Map<string, HTMLCanvasElement>();
let cachedPx = 0;

export function memo(key: string, make: () => HTMLCanvasElement) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const c = make();
  cache.set(key, c);
  cachedPx += c.width * c.height;
  for (const [k, old] of cache) {
    if (cachedPx <= CACHE_PX || old === c) break;
    cache.delete(k);
    cachedPx -= old.width * old.height;
  }
  return c;
}

const sourceIds = new WeakMap<object, number>();
let nextSource = 1;
function sourceId(src: Source) {
  let id = sourceIds.get(src);
  if (!id) sourceIds.set(src, (id = nextSource++));
  return id;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// ---------- pixels ----------

/** Threshold map for ordered dithering. */
const BAYER = (() => {
  let m = [[0]];
  while (m.length < 8) {
    const n = m.length;
    const next = Array.from({ length: n * 2 }, () => new Array<number>(n * 2).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
  }
  return m.map((row) => row.map((v) => (v + 0.5) / 64));
})();

/** Repeatable noise in 0..1 for a cell, so a layer's texture doesn't change between redraws. */
function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function seedOf(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h;
}

/** Reduces one channel (values 0..1) to `levels` steps in place. */
function ditherPlane(p: Float32Array, cols: number, rows: number, levels: number, pattern: DitherEffect['pattern'], seed: number) {
  const top = levels - 1;
  if (pattern === 'diffusion') {
    // Floyd-Steinberg, alternating direction each row so the error doesn't streak one way.
    for (let y = 0; y < rows; y++) {
      const dir = y & 1 ? -1 : 1;
      for (let i = 0; i < cols; i++) {
        const x = dir > 0 ? i : cols - 1 - i;
        const at = y * cols + x;
        const v = Math.min(1, Math.max(0, p[at]));
        const q = Math.round(v * top) / top;
        const err = v - q;
        p[at] = q;
        const ahead = x + dir;
        const behind = x - dir;
        if (ahead >= 0 && ahead < cols) p[at + dir] += (err * 7) / 16;
        if (y + 1 < rows) {
          if (behind >= 0 && behind < cols) p[at + cols - dir] += (err * 3) / 16;
          p[at + cols] += (err * 5) / 16;
          if (ahead >= 0 && ahead < cols) p[at + cols + dir] += err / 16;
        }
      }
    }
    return;
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const at = y * cols + x;
      const t = pattern === 'ordered' ? BAYER[y & 7][x & 7] : hash(x, y, seed);
      const s = Math.min(1, Math.max(0, p[at])) * top;
      const low = Math.floor(s);
      p[at] = Math.min(top, low + (s - low > t ? 1 : 0)) / top;
    }
  }
}

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

const colors = new Map<string, [number, number, number, number]>();
/** Any CSS colour as [r, g, b, a] bytes. */
export function colorBytes(color: string) {
  let out = colors.get(color);
  if (!out) {
    const ctx = canvas(1, 1).getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    colors.set(color, (out = [r, g, b, a]));
  }
  return out;
}

/** The photo with its crop, flip and adjustments, drawn into a w×h box in the context's current units. */
function drawPhoto(ctx: CanvasRenderingContext2D, n: ImageNode, w: number, h: number, src: Source) {
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  const f = filterString(n);
  if (f !== 'none') ctx.filter = f;
  if (n.flipX || n.flipY) {
    ctx.translate(n.flipX ? w : 0, n.flipY ? h : 0);
    ctx.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1);
  }
  const g = cropGeometry(n, w, h, src.width, src.height);
  ctx.drawImage(src, g.sx, g.sy, g.sw, g.sh, g.dx, g.dy, g.dw, g.dh);
  ctx.restore();
}

function copyOf(input: HTMLCanvasElement) {
  const c = canvas(input.width, input.height);
  c.getContext('2d')!.drawImage(input, 0, 0);
  return c;
}

function ditherStep(input: HTMLCanvasElement, d: DitherEffect, s: number, w: number, h: number, seed: number) {
  const size = Math.max(1, d.size);
  // One pixel per cell.
  const grid = canvas(w / size, h / size);
  const cols = grid.width;
  const rows = grid.height;
  const ctx = grid.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  // True to scale, so the picture never stretches to fit the grid. Only a part cell at the right or
  // bottom edge is left half empty, and the stretched copy underneath fills just those.
  ctx.drawImage(input, 0, 0, input.width, input.height, 0, 0, input.width / (size * s), input.height / (size * s));
  ctx.globalCompositeOperation = 'destination-over';
  ctx.drawImage(input, 0, 0, cols, rows);
  const img = ctx.getImageData(0, 0, cols, rows);
  const px = img.data;
  const count = cols * rows;
  const levels = Math.max(2, Math.round(d.levels));

  if (d.mode === 'duotone') {
    // Two pure colours mix optically, so their tone has to be worked out in linear light.
    const tone = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      tone[i] = levels === 2 ? 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b] : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    ditherPlane(tone, cols, rows, levels, d.pattern, seed);
    const ink = colorBytes(d.ink);
    const paper = colorBytes(d.paper);
    for (let i = 0; i < count; i++) {
      const t = tone[i];
      for (let ch = 0; ch < 3; ch++) px[i * 4 + ch] = ink[ch] + (paper[ch] - ink[ch]) * t;
    }
  } else {
    const plane = new Float32Array(count);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < count; i++) plane[i] = px[i * 4 + ch] / 255;
      ditherPlane(plane, cols, rows, levels, d.pattern, seed + ch);
      for (let i = 0; i < count; i++) px[i * 4 + ch] = plane[i] * 255;
    }
  }
  // Cells are either there or not, so a cut-out photo keeps a crisp dithered edge.
  for (let i = 0; i < count; i++) px[i * 4 + 3] = px[i * 4 + 3] < 128 ? 0 : 255;
  ctx.putImageData(img, 0, 0);

  const out = canvas(input.width, input.height);
  const o = out.getContext('2d')!;
  o.imageSmoothingEnabled = false;
  o.drawImage(grid, 0, 0, cols * size * s, rows * size * s);
  return out;
}

/** One pixel per grain, mid grey on average, so an overlay leaves the overall tone alone. */
function grainGrid(w: number, h: number, size: number, seed: number) {
  const c = canvas(w / size, h / size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const px = img.data;
  for (let y = 0, i = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++, i += 4) {
      // Two samples added together bunch around the middle, which reads as film rather than static.
      const v = (hash(x, y, seed) + hash(x, y, seed + 1)) * 127.5;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Lays grain over a canvas in place. Goes through a mask so it can't land on transparent areas. */
export function grainOver(c: HTMLCanvasElement, w: number, h: number, s: number, amount: number, size: number, seed: number) {
  const cell = Math.max(1, size);
  const grid = memo(`grain|${seed}|${Math.ceil(w)}x${Math.ceil(h)}|${cell}`, () => grainGrid(w, h, cell, seed));
  const mask = canvas(c.width, c.height);
  const m = mask.getContext('2d')!;
  m.imageSmoothingQuality = 'high';
  m.drawImage(grid, 0, 0, grid.width * cell * s, grid.height * cell * s);
  m.globalCompositeOperation = 'destination-in';
  m.drawImage(c, 0, 0);
  const ctx = c.getContext('2d')!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = Math.min(1, amount);
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

function grainStep(input: HTMLCanvasElement, g: GrainEffect, s: number, w: number, h: number, seed: number) {
  const c = copyOf(input);
  grainOver(c, w, h, s, g.amount, g.size, seed);
  return c;
}

/** `input` softened by `r` canvas px. The edges are extended first, or the picture would fade out around them. */
function blurred(input: HTMLCanvasElement, r: number) {
  const { width: W, height: H } = input;
  const pad = Math.ceil(r * 2);
  const wide = canvas(W + pad * 2, H + pad * 2);
  const x = wide.getContext('2d')!;
  x.drawImage(input, pad, pad);
  x.drawImage(input, 0, 0, 1, H, 0, pad, pad, H);
  x.drawImage(input, W - 1, 0, 1, H, pad + W, pad, pad, H);
  x.drawImage(wide, 0, pad, wide.width, 1, 0, 0, wide.width, pad);
  x.drawImage(wide, 0, pad + H - 1, wide.width, 1, 0, pad + H, wide.width, pad);
  const out = canvas(W, H);
  const o = out.getContext('2d')!;
  o.filter = `blur(${r}px)`;
  o.drawImage(wide, -pad, -pad);
  return out;
}

/** Steps between sharp and fully blurred. Each one fades into the next, so no band shows. */
const BLUR_LEVELS = 6;

function blurStep(input: HTMLCanvasElement, b: BlurEffect, s: number) {
  const r = b.amount * s;
  if (r <= 0) return copyOf(input);
  if (b.mode === 'even') return blurred(input, r);
  const out = copyOf(input);
  const ctx = out.getContext('2d')!;
  const start = Math.min(0.95, Math.max(0, b.start));
  const flip = b.direction === 'top' || b.direction === 'left';
  const along = b.direction === 'left' || b.direction === 'right' ? out.width : out.height;
  const at = (t: number) => (flip ? 1 - t : t) * along;
  for (let k = 1; k <= BLUR_LEVELS; k++) {
    // Radius grows with the square of the step, which looks even: small changes show most near sharp.
    const level = blurred(input, r * (k / BLUR_LEVELS) ** 2);
    const from = at(start + ((1 - start) * (k - 1)) / BLUR_LEVELS);
    const to = at(start + ((1 - start) * k) / BLUR_LEVELS);
    const l = level.getContext('2d')!;
    const ramp = b.direction === 'left' || b.direction === 'right' ? l.createLinearGradient(from, 0, to, 0) : l.createLinearGradient(0, from, 0, to);
    ramp.addColorStop(0, 'rgba(0,0,0,0)');
    ramp.addColorStop(1, '#000');
    l.globalCompositeOperation = 'destination-in';
    l.fillStyle = ramp;
    l.fillRect(0, 0, level.width, level.height);
    ctx.drawImage(level, 0, 0);
  }
  return out;
}

/** Blurs what's already drawn on `c` under a w×h box at its origin, inside `path`. */
function paintBackdrop(c: CanvasRenderingContext2D, w: number, h: number, amount: number, path: () => void) {
  const m = c.getTransform();
  const r = amount * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  if (r < 0.25) return;
  const xs = [m.e, m.a * w + m.e, m.c * h + m.e, m.a * w + m.c * h + m.e];
  const ys = [m.f, m.b * w + m.f, m.d * h + m.f, m.b * w + m.d * h + m.f];
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - r * 3));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - r * 3));
  const x1 = Math.min(c.canvas.width, Math.ceil(Math.max(...xs) + r * 3));
  const y1 = Math.min(c.canvas.height, Math.ceil(Math.max(...ys) + r * 3));
  if (x1 <= x0 || y1 <= y0) return;
  const region = canvas(x1 - x0, y1 - y0);
  region.getContext('2d')!.drawImage(c.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  const soft = blurred(region, r);
  // Past the slide's edge there's nothing to blur, which would leave the sharp picture showing
  // through. Layering the result on itself makes it solid again without changing its colours.
  const sc = soft.getContext('2d')!;
  for (let i = 0; i < 3; i++) sc.drawImage(soft, 0, 0);
  c.save();
  path();
  c.clip();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(soft, x0, y0);
  c.restore();
}

/** Draws a shape or frame's background blur. Runs just before its fill, when the layer canvas holds everything behind it. */
export const backdropScene = (n: ShapeNode | FrameNode, w: number, h: number) => (k: Konva.Context) => {
  const c = (k as any)._context as CanvasRenderingContext2D;
  paintBackdrop(c, w, h, n.backdropBlur ?? 0, () => {
    if (n.type !== 'ellipse') return roundRectPath(c, 0, 0, w, h, n.radius);
    c.beginPath();
    c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  });
};

// ---------- registry ----------

export type Setting = { /** Only shown when this says so. */ when?: (e: any) => boolean } & (
  | { kind: 'choice'; key: string; label: string; options: { value: string; label: string; hint: string }[] }
  | { kind: 'slider'; key: string; label: string; hint: string; min: number; max: number; percent?: boolean; /** Compared in the hover preview. */ demo: [number, number]; demoLabels: [string, string] }
  | { kind: 'colors'; label: string; keys: [string, string]; names: [string, string]; hint: string }
);

interface EffectDef {
  label: string;
  defaults: Record<string, unknown>;
  settings: Setting[];
  summary: (e: any) => string;
  step: (input: HTMLCanvasElement, e: any, s: number, w: number, h: number, seed: number) => HTMLCanvasElement;
  /** Effect sizes are set for full layers; a thumbnail needs them scaled to its own size. */
  demo: (e: any) => any;
}

const PATTERN_NAMES: Record<DitherEffect['pattern'], string> = { ordered: 'Ordered', diffusion: 'Diffuse', noise: 'Noise' };

export const EFFECTS: Record<PhotoEffect['type'], EffectDef> = {
  dither: {
    label: 'Dither',
    defaults: { pattern: 'ordered', size: 4, mode: 'duotone', ink: '#141414', paper: '#F2EFE8', levels: 2 },
    summary: (e: DitherEffect) => `${PATTERN_NAMES[e.pattern]}, size ${e.size}`,
    step: ditherStep,
    demo: (e: DitherEffect) => ({ ...e, size: Math.max(2, Math.min(9, Math.round(e.size * 0.6))) }),
    settings: [
      {
        kind: 'choice',
        key: 'pattern',
        label: 'Pattern',
        options: [
          { value: 'ordered', label: 'Ordered', hint: 'Dots on a regular grid. Graphic and crisp.' },
          { value: 'diffusion', label: 'Diffuse', hint: 'Dots scatter to follow the photo. Keeps the most detail.' },
          { value: 'noise', label: 'Noise', hint: 'Random speckle. Rough and gritty.' },
        ],
      },
      { kind: 'slider', key: 'size', label: 'Size', hint: 'How big each dot is.', min: 1, max: 24, demo: [2, 8], demoLabels: ['Small', 'Large'] },
      { kind: 'slider', key: 'levels', label: 'Tones', hint: 'Shades between dark and light. 2 keeps it to pure dots.', min: 2, max: 8, demo: [2, 6], demoLabels: ['2 tones', '6 tones'] },
      {
        kind: 'choice',
        key: 'mode',
        label: 'Color',
        options: [
          { value: 'duotone', label: 'Two colors', hint: 'Redraws the photo in the two colors you pick.' },
          { value: 'photo', label: 'Photo colors', hint: "Keeps the photo's own colors." },
        ],
      },
      { kind: 'colors', label: 'Colors', keys: ['ink', 'paper'], names: ['Ink', 'Paper'], hint: 'Ink draws the shadows, paper the highlights.', when: (e: DitherEffect) => e.mode === 'duotone' },
    ],
  },
  grain: {
    label: 'Grain',
    defaults: { amount: 0.35, size: 2 },
    summary: (e: GrainEffect) => `${Math.round(e.amount * 100)}%, size ${e.size}`,
    step: grainStep,
    demo: (e: GrainEffect) => ({ ...e, size: Math.max(1, Math.round(e.size * 0.75)) }),
    settings: [
      { kind: 'slider', key: 'amount', label: 'Amount', hint: 'How strong the grain is.', min: 0, max: 1, percent: true, demo: [0.15, 0.9], demoLabels: ['Subtle', 'Strong'] },
      { kind: 'slider', key: 'size', label: 'Size', hint: 'How coarse each speck is.', min: 1, max: 8, demo: [1, 4], demoLabels: ['Fine', 'Coarse'] },
    ],
  },
  blur: {
    label: 'Blur',
    defaults: { mode: 'even', amount: 24, direction: 'bottom', start: 0.4 },
    summary: (e: BlurEffect) => `${e.mode === 'even' ? 'Even' : 'Progressive'}, ${e.amount}`,
    step: (input, e, s) => blurStep(input, e, s),
    demo: (e: BlurEffect) => ({ ...e, amount: e.amount * 0.2 }),
    settings: [
      {
        kind: 'choice',
        key: 'mode',
        label: 'Type',
        options: [
          { value: 'even', label: 'Even', hint: 'Softens the whole photo the same amount.' },
          { value: 'progressive', label: 'Progressive', hint: 'Goes from sharp to soft across the photo.' },
        ],
      },
      { kind: 'slider', key: 'amount', label: 'Amount', hint: 'How soft the blur gets.', min: 1, max: 120, demo: [12, 80], demoLabels: ['Light', 'Heavy'] },
      {
        kind: 'choice',
        key: 'direction',
        label: 'Direction',
        when: (e: BlurEffect) => e.mode === 'progressive',
        options: [
          { value: 'top', label: 'Top', hint: 'Blur builds towards the top edge.' },
          { value: 'bottom', label: 'Bottom', hint: 'Blur builds towards the bottom edge.' },
          { value: 'left', label: 'Left', hint: 'Blur builds towards the left edge.' },
          { value: 'right', label: 'Right', hint: 'Blur builds towards the right edge.' },
        ],
      },
      { kind: 'slider', key: 'start', label: 'Start', hint: 'How much of the photo stays sharp before the blur begins.', min: 0, max: 0.9, percent: true, when: (e: BlurEffect) => e.mode === 'progressive', demo: [0.1, 0.7], demoLabels: ['Early', 'Late'] },
    ],
  },
};

export interface LibraryLook {
  id: string;
  group: string;
  name: string;
  blurb: string;
  effect: Partial<PhotoEffect> & { type: PhotoEffect['type'] };
}

export const EFFECT_LIBRARY: LibraryLook[] = [
  { id: 'bitmap', group: 'Dither', name: 'Bitmap', blurb: 'Crisp dots on a grid, like an early computer screen.', effect: { type: 'dither', pattern: 'ordered', size: 4 } },
  { id: 'newsprint', group: 'Dither', name: 'Newsprint', blurb: 'Soft scattered dots, like a photo in a newspaper.', effect: { type: 'dither', pattern: 'diffusion', size: 3, ink: '#1A1A1A', paper: '#EFEAE0' } },
  { id: 'riso', group: 'Dither', name: 'Riso', blurb: 'Two inks on one sheet, like a risograph print.', effect: { type: 'dither', pattern: 'diffusion', size: 4, ink: '#2B3FA0', paper: '#FFB199' } },
  { id: 'stipple', group: 'Dither', name: 'Stipple', blurb: 'Random speckle, like shading with a pen.', effect: { type: 'dither', pattern: 'noise', size: 3 } },
  { id: 'pixel', group: 'Dither', name: 'Pixel', blurb: "Chunky pixels that keep the photo's colors.", effect: { type: 'dither', pattern: 'ordered', size: 10, mode: 'photo', levels: 3 } },
  { id: 'fine-grain', group: 'Texture', name: 'Fine grain', blurb: 'A light film texture.', effect: { type: 'grain', amount: 0.25, size: 1 } },
  { id: 'film-grain', group: 'Texture', name: 'Film grain', blurb: 'Visible grain, like fast film.', effect: { type: 'grain', amount: 0.5, size: 2 } },
  { id: 'rough-grain', group: 'Texture', name: 'Rough grain', blurb: 'Coarse and gritty.', effect: { type: 'grain', amount: 0.85, size: 4 } },
  { id: 'soft-focus', group: 'Blur', name: 'Soft focus', blurb: 'A gentle softness over the whole photo.', effect: { type: 'blur', mode: 'even', amount: 16 } },
  { id: 'heavy-blur', group: 'Blur', name: 'Heavy blur', blurb: 'Melts the photo into shapes of color.', effect: { type: 'blur', mode: 'even', amount: 48 } },
  { id: 'fade-to-blur', group: 'Blur', name: 'Fade to blur', blurb: 'Sharp at the top, soft at the bottom. Good behind text.', effect: { type: 'blur', mode: 'progressive', direction: 'bottom', start: 0.45, amount: 60 } },
];

/** A complete effect from a partial one (a library look, or what Claude sent). */
export function makeEffect(e: Partial<PhotoEffect> & { type: PhotoEffect['type'] }): PhotoEffect {
  return { ...EFFECTS[e.type].defaults, id: nanoid(8), enabled: true, ...e } as PhotoEffect;
}

// ---------- compositing ----------

/** The photo at `s` pixels per layer px, with `effects` applied. Each step is kept, so changing a late effect doesn't redo the early ones. */
export function renderStack(n: ImageNode, w: number, h: number, src: Source, s: number, effects: PhotoEffect[]) {
  let key = `stack|${sourceId(src)}|${n.id}|${Math.ceil(w)}x${Math.ceil(h)}|${s}|${JSON.stringify([n.fit, n.crop, n.flipX, n.flipY, n.adjust])}`;
  let out = memo(key, () => {
    const c = canvas(w * s, h * s);
    const ctx = c.getContext('2d')!;
    ctx.scale(s, s);
    drawPhoto(ctx, n, w, h, src);
    return c;
  });
  const seed = seedOf(n.id);
  for (const e of activeStack(effects)) {
    const { id: _id, name: _name, ...look } = e;
    key += `|${JSON.stringify(look)}`;
    const input = out;
    out = memo(key, () => EFFECTS[e.type].step(input, e, s, w, h, seed));
  }
  return out;
}

/** The largest pixels-per-layer-px within `area` and the canvas side limit. */
function fitScale(w: number, h: number, s: number, area: number) {
  const k = Math.min(1, Math.sqrt(area / Math.max(1, w * h * s * s)), 16000 / Math.max(1, w * s, h * s));
  return s * k;
}

/**
 * Draws the photo with its effects into a w×h box at the context's origin. `px` is device pixels per
 * layer px. On screen that's rounded up to a power of two (never below 1, so zooming out costs nothing
 * and a dither can't change with zoom); `exact` keeps the true value for exports.
 */
export function paintEffects(c: CanvasRenderingContext2D, n: ImageNode, w: number, h: number, src: Source, px: number, exact: boolean) {
  let s = Math.max(1, exact ? fitScale(w, h, px, 100e6) : 2 ** Math.ceil(Math.log2(Math.max(px, 1))));
  if (!exact) while (s > 1 && w * h * s * s > 8e6) s /= 2;
  const out = renderStack(n, w, h, src, s, n.effects ?? []);
  const before = c.imageSmoothingEnabled;
  // Zoomed in past what was rendered: keep dither cells square instead of blurring them.
  c.imageSmoothingEnabled = !(needsLossless(n) && px > s);
  c.imageSmoothingQuality = 'high';
  c.drawImage(out, 0, 0, w * s, h * s, 0, 0, w, h);
  c.imageSmoothingEnabled = before;
}
