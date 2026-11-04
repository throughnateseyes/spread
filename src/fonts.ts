import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter/wght-italic.css';
import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/dm-sans/wght-italic.css';
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource-variable/archivo/wght.css';
import '@fontsource-variable/archivo/wght-italic.css';
import '@fontsource-variable/playfair-display/wght.css';
import '@fontsource-variable/playfair-display/wght-italic.css';
import '@fontsource-variable/fraunces/wght.css';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource/dm-serif-display/400.css';
import '@fontsource/dm-serif-display/400-italic.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/bebas-neue/400.css';
import { fontWeightRange } from './assets';
import { useStore } from './store';
import { findNode, walk } from './tree';
import type { Doc, TextNode } from './types';

export interface FontOption {
  family: string;
  label: string;
  source: 'bundled' | 'system' | 'local' | 'uploaded';
}

/** Fonts that ship inside the app and work offline. */
export const BUNDLED_FONTS: FontOption[] = [
  { family: 'Inter Variable', label: 'Inter', source: 'bundled' },
  { family: 'DM Sans Variable', label: 'DM Sans', source: 'bundled' },
  { family: 'Space Grotesk Variable', label: 'Space Grotesk', source: 'bundled' },
  { family: 'Archivo Variable', label: 'Archivo', source: 'bundled' },
  { family: 'Playfair Display Variable', label: 'Playfair Display', source: 'bundled' },
  { family: 'Fraunces Variable', label: 'Fraunces', source: 'bundled' },
  { family: 'DM Serif Display', label: 'DM Serif Display', source: 'bundled' },
  { family: 'Instrument Serif', label: 'Instrument Serif', source: 'bundled' },
  { family: 'Bebas Neue', label: 'Bebas Neue', source: 'bundled' },
];

export const SYSTEM_FONTS: FontOption[] = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS'].map(
  (f) => ({ family: f, label: f, source: 'system' as const }),
);

let localFonts: FontOption[] | null = null;

/** Installed fonts via the Local Font Access API (Chromium / Electron). */
export async function queryInstalledFonts(): Promise<FontOption[]> {
  if (localFonts) return localFonts;
  const q = (window as any).queryLocalFonts as undefined | (() => Promise<{ family: string }[]>);
  if (!q) return [];
  try {
    const list = await q();
    const fams = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    localFonts = fams.map((f) => ({ family: f, label: f, source: 'local' as const }));
    return localFonts;
  } catch {
    return [];
  }
}

export function uploadedFonts(doc: Doc): FontOption[] {
  return Object.values(doc.assets)
    .filter((a) => a.kind === 'font' && a.family)
    .map((a) => ({ family: a.family!, label: a.family!, source: 'uploaded' as const }));
}

export function fontLabel(family: string) {
  return BUNDLED_FONTS.find((f) => f.family === family)?.label ?? family;
}

const span = (from: number, to: number) => Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);

/** Weights each known family really ships. Anything else would be faked (or ignored) by the browser. */
const FONT_WEIGHTS: Record<string, number[]> = {
  'Inter Variable': span(100, 900),
  'DM Sans Variable': span(100, 900),
  'Space Grotesk Variable': span(300, 700),
  'Archivo Variable': span(100, 900),
  'Playfair Display Variable': span(400, 900),
  'Fraunces Variable': span(100, 900),
  'DM Serif Display': [400],
  'Instrument Serif': [400],
  'Bebas Neue': [400],
  ...Object.fromEntries(SYSTEM_FONTS.map((f) => [f.family, [400, 700]])),
};

/** Weights available for a family, or null when unknown (installed fonts: offer them all). */
export function fontWeights(family: string, doc: Doc): number[] | null {
  if (FONT_WEIGHTS[family]) return FONT_WEIGHTS[family];
  const range = fontWeightRange(family);
  if (range) return span(range[0], range[1]);
  // Any other uploaded font is one file registered as its own family: a single weight.
  if (uploadedFonts(doc).some((f) => f.family === family)) return [400];
  return null;
}

/** The available weight closest to `w` (ties go heavier). */
export function nearestWeight(weights: number[] | null, w: number) {
  if (!weights) return w;
  return weights.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) || (Math.abs(x - w) === Math.abs(best - w) && x > best) ? x : best));
}

/** The weight "B" switches to: 700 when the family has it, else its heaviest weight from 600 up. */
export function boldWeightFor(weights: number[] | null): number | null {
  if (!weights) return 700;
  if (weights.includes(700)) return 700;
  const heavy = weights.filter((w) => w >= 600);
  return heavy.length ? Math.max(...heavy) : null;
}

export const isBold = (w: number) => w >= 600;

/**
 * Toggles bold on the selected text layers (the B button and Ctrl+B). Fonts that only come
 * in one weight say so instead of faking a bold.
 */
export function toggleBoldSelection() {
  const s = useStore.getState();
  const ids = s.editingTextId && !s.selection.includes(s.editingTextId) ? [...s.selection, s.editingTextId] : s.selection;
  const texts = ids.map((id) => findNode(s.doc.nodes, id)).filter((n): n is TextNode => n?.type === 'text');
  if (!texts.length) return false;
  const turnOn = !texts.every((n) => isBold(n.fontWeight));
  const single = texts.filter((n) => turnOn && boldWeightFor(fontWeights(n.fontFamily, s.doc)) === null);
  s.updateNodes(
    texts.map((n) => n.id),
    (n) => {
      if (n.type !== 'text') return;
      const weights = fontWeights(n.fontFamily, s.doc);
      if (turnOn) n.fontWeight = boldWeightFor(weights) ?? n.fontWeight;
      else n.fontWeight = nearestWeight(weights, 400);
    },
  );
  if (single.length) {
    const fam = fontLabel(single[0].fontFamily);
    s.toast(`${fam} only comes in one weight. For a bold serif, try Playfair Display or Fraunces.`);
  }
  return true;
}

const loaded = new Set<string>();

/**
 * Makes sure every font the doc uses is loaded, then bumps fontsVersion so text is
 * re-measured and redrawn. Called whenever the doc changes (cheap when nothing is new).
 */
export async function ensureDocFonts(doc: Doc) {
  const specs = new Set<string>();
  walk(doc.nodes, (n) => {
    if (n.type === 'text') specs.add(`${n.italic ? 'italic ' : ''}${n.fontWeight} 32px "${n.fontFamily}"`);
  });
  const fresh = [...specs].filter((s) => !loaded.has(s));
  if (!fresh.length) return;
  fresh.forEach((s) => loaded.add(s));
  await Promise.all(fresh.map((s) => document.fonts.load(s).catch(() => [])));
  useStore.getState().bumpFonts();
}

// Any late font load (e.g. a variable font file finishing) should trigger a re-measure.
if (typeof document !== 'undefined') {
  document.fonts.addEventListener?.('loadingdone', () => useStore.getState().bumpFonts());
}
