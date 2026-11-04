import type { Box, Doc, SceneNode } from './types';
import { makeImage, makeText, uid } from './tree';
import { useStore } from './store';

// Auto-arrange a set of photos into seamless carousel layouts across slides.

export type ArrangeMode = 'one-per-slide' | 'panorama' | 'collage' | 'brick';

export interface ArrangeOptions {
  mode: ArrangeMode;
  gap: number;
  margin: number;
  radius: number;
  addText: boolean;
  where: 'replace' | 'append';
  /** Target slide count for panorama, collage and brick (photos stretch or crop to fill). Default: what the photos naturally need. */
  slides?: number;
}

export const ARRANGE_MODES: { id: ArrangeMode; label: string; hint: string }[] = [
  { id: 'one-per-slide', label: 'One per slide', hint: 'Each photo full-bleed on its own slide' },
  { id: 'panorama', label: 'Panorama', hint: 'One continuous row, with seams cutting through photos' },
  { id: 'collage', label: 'Collage', hint: 'Wide + narrow tiles so seams land inside photos' },
  { id: 'brick', label: 'Brick', hint: 'Two offset rows that flow across slides' },
];

const COLLAGE_PATTERN = [1.35, 0.65, 1.0];

/** Turns tile edges (in content space [0, C]) into boxes, insetting interior edges by gap/2. */
function tiles(edges: number[], x0: number, y: number, h: number, gap: number): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i] + (i > 0 ? gap / 2 : 0);
    const b = edges[i + 1] - (i < edges.length - 2 ? gap / 2 : 0);
    out.push({ x: x0 + a, y, w: Math.max(1, b - a), h });
  }
  return out;
}

function edgesFromWidths(widths: number[], total: number) {
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  const edges = [0];
  let acc = 0;
  for (const w of widths) {
    acc += (w / sum) * total;
    edges.push(acc);
  }
  edges[edges.length - 1] = total;
  return edges;
}

/**
 * Computes the boxes for `count` photos with given aspect ratios. Returns boxes + number of slides used.
 * `target` fixes the slide count for panorama, collage and brick; one-per-slide always uses one slide per photo.
 */
export function arrangeBoxes(mode: ArrangeMode, aspects: number[], W: number, H: number, gap: number, margin: number, target?: number): { boxes: Box[]; slides: number } {
  const n = aspects.length;
  if (!n) return { boxes: [], slides: 0 };
  const fixed = target && target >= 1 ? Math.round(target) : 0;
  const m = margin;
  const innerH = Math.max(1, H - 2 * m);

  if (mode === 'one-per-slide') {
    return {
      boxes: aspects.map((_, i) => ({ x: i * W + m, y: m, w: W - 2 * m, h: innerH })),
      slides: n,
    };
  }

  if (mode === 'panorama' || mode === 'collage') {
    const widths = mode === 'panorama' ? aspects.map((a) => innerH * a) : aspects.map((_, i) => COLLAGE_PATTERN[i % COLLAGE_PATTERN.length] * W);
    const natural = widths.reduce((a, b) => a + b, 0) + gap * (n - 1) + 2 * m;
    const slides = fixed || Math.max(1, Math.round(natural / W));
    const C = slides * W - 2 * m;
    return { boxes: tiles(edgesFromWidths(widths, C), m, m, innerH, gap), slides };
  }

  // brick: photos alternate between two rows; row 2 is offset by half a tile.
  const r1 = Math.ceil(n / 2);
  const r2 = n - r1;
  const slides = fixed || Math.max(1, r1);
  const C = slides * W - 2 * m;
  const rowH = r2 ? (innerH - gap) / 2 : innerH;
  const row1 = tiles(edgesFromWidths(Array(r1).fill(1), C), m, m, rowH, gap);
  let row2: Box[] = [];
  if (r2 === 1) row2 = tiles([0, C], m, m + rowH + gap, rowH, gap);
  else if (r2 > 1) {
    const widths = Array.from({ length: r2 }, (_, i) => (i === 0 || i === r2 - 1 ? 0.5 : 1));
    row2 = tiles(edgesFromWidths(widths, C), m, m + rowH + gap, rowH, gap);
  }
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) boxes.push(i % 2 === 0 ? row1[i >> 1] : row2[i >> 1]);
  return { boxes, slides };
}

export function arrange(doc: Doc, assetIds: string[], opts: ArrangeOptions): { nodes: SceneNode[]; slideCount: number; startSlide: number } {
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const metas = assetIds.map((id) => doc.assets[id]).filter((m) => m && m.kind === 'image');
  const startSlide = opts.where === 'replace' || doc.nodes.length === 0 ? 0 : doc.slides.length;
  const aspects = metas.map((m) => m.width / Math.max(1, m.height));
  const { boxes, slides } = arrangeBoxes(opts.mode, aspects, W, H, opts.gap, opts.margin, opts.slides);
  const x0 = startSlide * W;
  const nodes: SceneNode[] = metas.map((m, i) => {
    const b = boxes[i];
    const img = makeImage(Math.round(x0 + b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), m.id, m.name);
    img.radius = opts.radius;
    return img;
  });
  if (opts.addText && nodes.length) {
    const t = makeText(x0 + 80, H - 330, 'Your headline\ngoes here', {
      fill: '#FFFFFF',
      fontSize: 96,
      name: 'Headline',
      shadow: { enabled: true, color: '#00000066', x: 0, y: 4, blur: 24 },
    });
    t.sizingH = 'fixed';
    t.w = W - 160;
    nodes.push(t);
  }
  return { nodes, slideCount: startSlide + Math.max(1, slides), startSlide };
}

/** Applies an arrangement to the current document as one undo step. */
export function applyArrange(assetIds: string[], opts: ArrangeOptions) {
  const s = useStore.getState();
  const { nodes, slideCount, startSlide } = arrange(s.doc, assetIds, opts);
  if (!nodes.length) return;
  s.change((d) => {
    if (startSlide === 0) {
      d.nodes = [];
      d.slides = d.slides.slice(0, slideCount);
    }
    while (d.slides.length < slideCount) d.slides.push({ id: uid(), background: null });
    if (startSlide === 0 && d.slides.length > slideCount) d.slides.length = slideCount;
    d.nodes.push(...nodes);
  });
  s.set({ selection: [], modal: null });
  window.dispatchEvent(new Event('spread:fit'));
}
