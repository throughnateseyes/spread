import type { MeshPoint, Paint } from './types';
import { colorBytes, grainOver, memo } from './effects';
import { linearPoints } from './render';

// Gradients Konva can't draw itself: radial, mesh, and anything with grain. They're rendered to a
// canvas once and used as the layer's fill, so every shape, frame and export can take them.
// Colours are mixed in OKLab, which keeps the middle of a blend bright instead of muddy.

type CustomPaint = Exclude<Paint, { kind: 'solid' }>;

/** True when Konva or CSS can't draw the paint itself. */
export const isCustomPaint = (p: Paint) => p.kind === 'mesh' || p.kind === 'radial' || (p.kind === 'linear' && !!p.grain);

type Lab = [number, number, number, number];

function toLab(color: string): Lab {
  const [r8, g8, b8, a8] = colorBytes(color);
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, a8 / 255];
}

function fromLab([L, A, B, alpha]: Lab): [number, number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  return [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), Math.round(alpha * 255)];
}

/** Fills a canvas gradient with extra stops, so the browser's plain RGB blend follows OKLab. */
function addStops(g: CanvasGradient, from: string, to: string) {
  const a = toLab(from);
  const b = toLab(to);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const [r, gr, bl, al] = fromLab(a.map((v, k) => v + (b[k] - v) * t) as Lab);
    g.addColorStop(t, `rgba(${r},${gr},${bl},${al / 255})`);
  }
}

function drawMesh(ctx: CanvasRenderingContext2D, p: Extract<Paint, { kind: 'mesh' }>, W: number, H: number) {
  // Colour changes slowly across a mesh, so a small grid scaled up smoothly is all it takes.
  const k = 160 / Math.max(W, H);
  const gw = Math.max(2, Math.round(W * k));
  const gh = Math.max(2, Math.round(H * k));
  const grid = document.createElement('canvas');
  grid.width = gw;
  grid.height = gh;
  const g = grid.getContext('2d')!;
  const img = g.createImageData(gw, gh);
  const labs = p.points.map((pt) => toLab(pt.color));
  // Each point's pull falls off with distance; a low power lets colours spread further.
  const power = 2.2 - 1.6 * Math.min(1, Math.max(0, p.softness));
  const aspect = W / H;
  for (let y = 0, i = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++, i += 4) {
      const u = x / (gw - 1);
      const v = y / (gh - 1);
      const mix: Lab = [0, 0, 0, 0];
      let total = 0;
      let chroma = 0;
      for (let n = 0; n < labs.length; n++) {
        const dx = (u - p.points[n].x) * aspect;
        const dy = v - p.points[n].y;
        const w = 1 / ((dx * dx + dy * dy) ** power + 1e-5);
        total += w;
        chroma += Math.hypot(labs[n][1], labs[n][2]) * w;
        for (let c = 0; c < 4; c++) mix[c] += labs[n][c] * w;
      }
      const lab = mix.map((c) => c / total) as Lab;
      // Opposite colours average out to grey. Keeping their strength turns that into a clean hue shift.
      const lift = Math.min(3, chroma / total / Math.max(1e-4, Math.hypot(lab[1], lab[2])));
      lab[1] *= lift;
      lab[2] *= lift;
      const [r, gr, b, a] = fromLab(lab);
      img.data[i] = r;
      img.data[i + 1] = gr;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(grid, 0, 0, W, H);
}

/** The paint over a w×h box. Rendered at 2x when that stays small, so grain holds up in exports. */
export function paintCanvas(p: CustomPaint, w: number, h: number) {
  const s = w * h <= 2e6 ? 2 : 1;
  const W = Math.max(1, Math.ceil(w * s));
  const H = Math.max(1, Math.ceil(h * s));
  return memo(`paint|${W}x${H}|${JSON.stringify(p)}`, () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    if (p.kind === 'mesh') drawMesh(ctx, p, W, H);
    else {
      let g: CanvasGradient;
      if (p.kind === 'radial') {
        g = ctx.createRadialGradient(p.cx * W, p.cy * H, 0, p.cx * W, p.cy * H, Math.max(1, p.radius * Math.max(W, H)));
      } else {
        const { start, end } = linearPoints(p.angle, W, H);
        g = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      }
      addStops(g, p.from, p.to);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (p.grain) grainOver(c, w, h, s, p.grain, 2, 7);
    return c;
  });
}

// ---------- presets ----------

const LAYOUTS: [number, number][][] = [
  [[0.12, 0.15], [0.88, 0.1], [0.2, 0.88], [0.85, 0.8]],
  [[0.5, 0.05], [0.05, 0.55], [0.95, 0.5], [0.5, 0.95]],
  [[0.2, 0.3], [0.75, 0.2], [0.35, 0.8], [0.95, 0.9]],
];

const mesh = (colors: string[], layout: number, softness = 0.55, grain = 0.25): Paint => ({
  kind: 'mesh',
  points: colors.map((color, i) => ({ x: LAYOUTS[layout][i][0], y: LAYOUTS[layout][i][1], color })),
  softness,
  grain,
});

export const GRADIENT_PRESETS: { name: string; paint: Paint }[] = [
  { name: 'Dusk', paint: mesh(['#2B1B5A', '#E8577E', '#F9A65A', '#1C2C6B'], 0) },
  { name: 'Citrus', paint: mesh(['#FFE45C', '#FF8A3D', '#FFD1A1', '#F2456B'], 1) },
  { name: 'Tide', paint: mesh(['#0D3B66', '#1FA6A0', '#BCEBD8', '#124E89'], 2) },
  { name: 'Ember', paint: mesh(['#160A0A', '#B3261E', '#FF7A2F', '#3A0F16'], 2, 0.4, 0.4) },
  { name: 'Orchid', paint: mesh(['#F6C9E8', '#9A5CF0', '#FFE3D3', '#5B3FD6'], 0) },
  { name: 'Moss', paint: mesh(['#1F3A2E', '#7E9F5B', '#E3DFB8', '#31593F'], 1) },
  { name: 'Peach', paint: mesh(['#FFE9DC', '#FFB199', '#FFD9A8', '#F58A8A'], 0, 0.7, 0.15) },
  { name: 'Ink', paint: mesh(['#0A0A0F', '#2A2A38', '#6D6D80', '#111118'], 2, 0.5, 0.45) },
];

/** New positions, and the same colours (or `palette`) dealt out again. */
export function shuffleMesh(p: Extract<Paint, { kind: 'mesh' }>, palette: string[]): Paint {
  const colors = palette.length >= 3 ? palette : p.points.map((pt) => pt.color);
  const deck = [...colors].sort(() => Math.random() - 0.5);
  const cols = Math.ceil(Math.sqrt(p.points.length));
  const points: MeshPoint[] = p.points.map((_, i) => ({
    // One point per area of the box, so they never bunch up into a single blob.
    x: ((i % cols) + 0.15 + Math.random() * 0.7) / cols,
    y: (Math.floor(i / cols) + 0.15 + Math.random() * 0.7) / Math.ceil(p.points.length / cols),
    color: deck[i % deck.length],
  }));
  return { ...p, points };
}

/** Fills in what a hand-written paint left out. */
export function normalizePaint(p: Paint): Paint {
  if (p.kind === 'mesh') return Object.assign({ softness: 0.55, grain: 0 }, p, { points: p.points.map((pt) => Object.assign({ x: 0.5, y: 0.5 }, pt)) });
  if (p.kind === 'radial') return Object.assign({ cx: 0.5, cy: 0.5, radius: 0.75 }, p);
  return p;
}
