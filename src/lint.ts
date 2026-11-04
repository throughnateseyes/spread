import { measureText, textLines, type LayoutMap } from './layout';
import { absoluteBoxes } from './render';
import { walk } from './tree';
import type { Box, Brand, Doc, Paint, SceneNode, TextNode } from './types';

// Layout lint: the mechanical checks ("the Floor") the app can compute exactly, so Claude spends
// its attention on taste instead of eyeballing margins. Pure function of the board + its layout,
// plus the project's brand when it has one (off-palette colors, off-brand fonts, sizes off the scale).

export interface LintIssue {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
  /** 0-based page/slide index, when the issue is on one. */
  page: number | null;
  ids: string[];
  keys: (string | null)[];
}

const DEFAULT_MARGIN = 60;

function hexRgb(c: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}

function luminance([r, g, b]: [number, number, number, number]) {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(a: string, b: string): number | null {
  const x = hexRgb(a);
  const y = hexRgb(b);
  if (!x || !y) return null;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (outer: Box, p: { x: number; y: number }) => p.x >= outer.x && p.x <= outer.x + outer.w && p.y >= outer.y && p.y <= outer.y + outer.h;

export function lintBoard(doc: Doc, layout: LayoutMap, brand: Brand | null = null): { issues: LintIssue[]; summary: string } {
  const issues: LintIssue[] = [];
  if (doc.kind === 'email') {
    if (brand) lintBrand(doc, brand, 'px', issues);
    return summarize(issues, 'Email layout is checked by spread_email_html.');
  }
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const N = doc.slides.length;
  const isDoc = doc.kind === 'document';
  // Print documents are in points; screen documents and carousels in px.
  const print = isDoc && doc.page?.units !== 'px';
  const u = print ? 'pt' : 'px';
  const m = doc.page?.margins ?? { t: DEFAULT_MARGIN, r: DEFAULT_MARGIN, b: DEFAULT_MARGIN, l: DEFAULT_MARGIN };
  const baseline = doc.page?.baseline ?? 0;
  const abs = absoluteBoxes(doc.nodes, layout);
  const add = (severity: LintIssue['severity'], rule: string, message: string, nodes: SceneNode[], page: number | null) =>
    issues.push({ severity, rule, message, page, ids: nodes.map((n) => n.id), keys: nodes.map((n) => n.key ?? null) });
  const label = (n: SceneNode) => (n.key ? `"${n.key}"` : n.type === 'text' ? `"${n.text.slice(0, 32).replace(/\n/g, ' ')}${n.text.length > 32 ? '…' : ''}"` : n.name);
  const pageOf = (b: Box) => Math.min(N - 1, Math.max(0, Math.floor((b.x + b.w / 2) / W)));

  // Visible nodes in paint order, with absolute boxes.
  const all: { n: SceneNode; b: Box; z: number }[] = [];
  walk(doc.nodes, (n) => {
    if (!n.visible) return false;
    const b = abs.get(n.id);
    if (b) all.push({ n, b, z: all.length });
  });
  const texts = all.filter((e): e is { n: TextNode; b: Box; z: number } => e.n.type === 'text' && e.n.text.trim().length > 0);

  // Empty pages.
  for (let i = 0; i < N; i++) {
    const region = { x: i * W, y: 0, w: W, h: H };
    if (!all.some((e) => overlaps(e.b, region))) add('warn', 'empty-page', `${isDoc ? 'Page' : 'Slide'} ${i + 1} is empty.`, [], i);
  }

  const lefts: { x: number; e: (typeof texts)[number] }[] = [];
  for (const e of texts) {
    const { n, b } = e;
    const p = pageOf(b);
    const px = b.x - p * W;

    // Off the page / across a page edge.
    if (b.y < 0 || b.y + b.h > H || b.x < 0 || b.x + b.w > N * W) add('error', 'off-page', `${label(n)} runs off the ${isDoc ? 'page' : 'slide'}.`, [n], p);
    const crossK = Math.floor(b.x / W) !== Math.floor((b.x + b.w - 0.01) / W);
    if (crossK) {
      if (isDoc) add('error', 'crosses-page', `${label(n)} crosses from page ${Math.floor(b.x / W) + 1} to the next. Pages don't continue into each other.`, [n], p);
      else add('warn', 'crosses-seam', `${label(n)} crosses a seam. Fine for a deliberate bridge, if the break falls between words.`, [n], p);
    }

    // Margins.
    if (!crossK) {
      const gaps = { left: px, right: W - (px + b.w), top: b.y, bottom: H - (b.y + b.h) };
      const want = { left: m.l, right: m.r, top: m.t, bottom: m.b };
      const short = (Object.keys(gaps) as (keyof typeof gaps)[]).filter((k) => gaps[k] < want[k] - 0.5 && gaps[k] >= 0);
      if (short.length) add('warn', 'margin', `${label(n)} is inside the ${short.map((k) => `${k} margin (${r1(gaps[k])} < ${want[k]})`).join(', ')}.`, [n], p);
    }

    // Cut-off text in a fixed-height box.
    if (n.sizingV === 'fixed' && measureText(n, b.w).h > b.h + 1) add('error', 'overflow', `${label(n)} doesn't fit its box: the last lines are cut off.`, [n], p);

    // Tiny text.
    const min = print ? 7 : isDoc ? 16 : 20;
    if (n.fontSize < min) add('warn', 'tiny-text', `${label(n)} is ${n.fontSize}${u}; below ${min} is hard to read${print ? ' in print' : ' on a screen'}.`, [n], p);

    // Line length and single-word last lines (body text only).
    const lines = textLines(n, b.w);
    const body = print ? n.fontSize <= 14 : n.fontSize <= 40;
    if (body && lines.length >= 2) {
      const full = lines.filter((l) => !l.last);
      const avg = full.length ? full.reduce((s, l) => s + l.text.length, 0) / full.length : 0;
      if (avg > 95) add('warn', 'line-length', `${label(n)} has lines of ~${Math.round(avg)} characters; 45–90 reads best.`, [n], p);
      else if (avg && avg < 25 && lines.length >= 3) add('warn', 'line-length', `${label(n)} has very short lines (~${Math.round(avg)} characters); widen the box or shorten the copy.`, [n], p);
      lines.forEach((l, i) => {
        if (l.last && i > 0 && !lines[i - 1].last && !/\s/.test(l.text.trim()) && l.text.trim().length > 0)
          add('warn', 'widow', `${label(n)} ends a paragraph with one word on its own line ("${l.text.trim()}").`, [n], p);
      });
    }

    // Baseline grid.
    if (baseline > 0) {
      const off = (b.y - m.t) % baseline;
      const d = Math.min(Math.abs(off), Math.abs(baseline - Math.abs(off)));
      if (d > 0.5) add('warn', 'baseline', `${label(n)} starts ${r1(d)}${u} off the ${baseline}${u} baseline grid (y=${r1(b.y)}).`, [n], p);
    }

    // Contrast against what's directly behind the text.
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const under = all.filter((u) => u.z < e.z && u.n.type !== 'text' && contains(u.b, c)).pop();
    if (!(under && under.n.type === 'image')) {
      let bg = doc.slides[p]?.background ?? doc.background;
      if (under && (under.n.type === 'rect' || under.n.type === 'ellipse' || under.n.type === 'frame')) {
        const f = under.n.fill;
        if (f && f.kind === 'solid' && (hexRgb(f.color)?.[3] ?? 1) > 0.9) bg = f.color;
        else bg = '';
      }
      const ratio = bg ? contrastRatio(n.fill, bg) : null;
      const large = print ? n.fontSize >= 18 || (n.fontSize >= 14 && n.fontWeight >= 700) : n.fontSize >= 48;
      if (ratio !== null && ratio < (large ? 3 : 4.5)) add('warn', 'contrast', `${label(n)} has ${r1(ratio)}:1 contrast with its background; aim for ${large ? 3 : 4.5}:1.`, [n], p);
    }

    lefts.push({ x: r1(b.x), e });
  }

  // Overlapping text blocks.
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      const ox = Math.min(a.b.x + a.b.w, b.b.x + b.b.w) - Math.max(a.b.x, b.b.x);
      const oy = Math.min(a.b.y + a.b.h, b.b.y + b.b.h) - Math.max(a.b.y, b.b.y);
      if (ox > 1 && oy > 1) add('warn', 'overlap', `${label(a.n)} and ${label(b.n)} overlap.`, [a.n, b.n], pageOf(a.b));
    }

  // Near-miss alignment: left edges 0.5–3 units apart on the same page.
  const byPage = new Map<number, typeof lefts>();
  for (const l of lefts) {
    const p = pageOf(l.e.b);
    byPage.set(p, [...(byPage.get(p) ?? []), l]);
  }
  for (const [p, all] of byPage) {
    // A right-aligned block (dates flush right) lines up on its right edge; its left edge is free.
    const rightOf = (e: (typeof lefts)[number]['e']) => r1(e.b.x + e.b.w);
    const list = all.filter((l) => all.some((o) => o !== l && o.x === l.x) || !all.some((o) => o !== l && Math.abs(rightOf(o.e) - rightOf(l.e)) < 0.5));
    const xs = [...new Set(list.map((l) => l.x))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d >= 0.5 && d <= 3) {
        const a = list.filter((l) => l.x === xs[i - 1]).map((l) => l.e.n);
        const b = list.filter((l) => l.x === xs[i]).map((l) => l.e.n);
        add('warn', 'alignment', `Left edges almost line up: ${a.map(label).join(', ')} at x=${xs[i - 1]} vs ${b.map(label).join(', ')} at x=${xs[i]}.`, [...a, ...b], p);
      }
    }
  }

  // Inconsistent vertical rhythm: stacked text blocks whose gaps differ by a hair.
  for (const [p, list] of byPage) {
    const col = list.map((l) => l.e).sort((a, b) => a.b.y - b.b.y);
    const gaps: { g: number; a: TextNode; b: TextNode }[] = [];
    for (let i = 0; i < col.length; i++) {
      const a = col[i];
      // Measure from the lowest block on a line (a date beside a taller role isn't a gap).
      if (col.some((c) => c !== a && c.b.y < a.b.y + a.b.h && c.b.y + c.b.h > a.b.y && c.b.y + c.b.h > a.b.y + a.b.h + 0.5)) continue;
      const next = col.slice(i + 1).find((c) => c.b.y >= a.b.y + a.b.h - 0.5 && Math.min(a.b.x + a.b.w, c.b.x + c.b.w) - Math.max(a.b.x, c.b.x) > 0.5 * Math.min(a.b.w, c.b.w));
      // Rhythm is about the small gaps inside and between groups; a big jump is structure (a hanging date to the next one).
      if (next && next.b.y - (a.b.y + a.b.h) <= Math.max(36, 3 * a.n.fontSize * a.n.lineHeight)) gaps.push({ g: r1(next.b.y - (a.b.y + a.b.h)), a: a.n, b: next.n });
    }
    // With a baseline grid, the grid is the spacing scale: flag gaps that fall off it.
    if (baseline > 0) {
      for (const g of gaps) {
        const off = g.g % baseline;
        if (Math.min(off, baseline - off) > 0.25) add('warn', 'spacing', `Gap of ${g.g}${u} between ${label(g.a)} and ${label(g.b)} is off the ${baseline}${u} spacing grid.`, [g.a, g.b], p);
      }
      continue;
    }
    const values = [...new Set(gaps.map((g) => g.g))].sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      if (d > 0 && d <= 2) {
        const odd = gaps.filter((g) => g.g === values[i]).length <= gaps.filter((g) => g.g === values[i - 1]).length ? values[i] : values[i - 1];
        const g = gaps.find((x) => x.g === odd)!;
        add('warn', 'spacing', `Gap of ${odd} between ${label(g.a)} and ${label(g.b)} is a hair off the ${odd === values[i] ? values[i - 1] : values[i]} used elsewhere.`, [g.a, g.b], p);
      }
    }
  }

  // Type system.
  const families = new Set(texts.map((t) => t.n.fontFamily));
  if (families.size > 2) add('warn', 'type-system', `${families.size} font families (${[...families].join(', ')}); two is usually the limit.`, [], null);
  const sizes = [...new Set(texts.map((t) => t.n.fontSize))].sort((a, b) => a - b);
  if (sizes.length > 6) add('warn', 'type-system', `${sizes.length} different font sizes (${sizes.join(', ')}); pick a scale of 4–6.`, [], null);

  if (brand) lintBrand(doc, brand, u, issues);
  return summarize(issues);
}

function summarize(issues: LintIssue[], clean = 'Clean: no layout issues found.') {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errors;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const found = [errors && count(errors, 'error'), warns && count(warns, 'warning')].filter(Boolean).join(', ');
  return { issues, summary: issues.length ? `${found}.` : clean };
}

const fontKey = (f: string) =>
  f
    .toLowerCase()
    .replace(/\s+variable$/, '')
    .trim();

/**
 * Brand checks: every font is a brand font, every color is in the palette (scrims of pure black or
 * white and fully transparent stops are fine), and every size is on the brand's type scale.
 * One issue per off-brand value, listing every layer that uses it.
 */
function lintBrand(doc: Doc, brand: Brand, u: 'pt' | 'px', issues: LintIssue[]) {
  const byValue = (rule: string, entries: [string, SceneNode][], message: (v: string) => string) => {
    const groups = new Map<string, SceneNode[]>();
    for (const [v, n] of entries) groups.set(v, [...(groups.get(v) ?? []), n]);
    for (const [v, nodes] of groups) {
      const uniq = [...new Map(nodes.map((n) => [n.id, n])).values()];
      issues.push({ severity: 'warn', rule, message: message(v) + (uniq.length ? ` (${uniq.length} layer${uniq.length > 1 ? 's' : ''})` : ''), page: null, ids: uniq.map((n) => n.id), keys: uniq.map((n) => n.key ?? null) });
    }
  };
  const texts: TextNode[] = [];
  const nodes: SceneNode[] = [];
  walk(doc.nodes, (n) => {
    if (!n.visible) return false;
    nodes.push(n);
    if (n.type === 'text' && n.text.trim()) texts.push(n);
  });

  const fams = brand.fonts.map((f) => fontKey(f.family));
  if (fams.length) {
    const names = brand.fonts.map((f) => f.family).join(' or ');
    byValue('brand-font', texts.filter((t) => !fams.includes(fontKey(t.fontFamily))).map((t) => [t.fontFamily, t]), (f) => `"${f}" isn't a ${brand.name} font; use ${names}.`);
  }

  const palette = brand.colors.map((c) => ({ c, rgb: hexRgb(c.hex)! })).filter((p) => p.rgb);
  if (palette.length) {
    const near = (rgb: number[]) => palette.find((p) => Math.max(Math.abs(p.rgb[0] - rgb[0]), Math.abs(p.rgb[1] - rgb[1]), Math.abs(p.rgb[2] - rgb[2])) <= 4);
    const ok = (hex: string) => {
      const rgb = hexRgb(hex);
      if (!rgb) return true;
      if (rgb[3] === 0) return true;
      const neutral = (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) || (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255);
      if (neutral && rgb[3] < 1) return true;
      return !!near(rgb);
    };
    const closest = (hex: string) => {
      const rgb = hexRgb(hex)!;
      const d = (p: (typeof palette)[number]) => (p.rgb[0] - rgb[0]) ** 2 + (p.rgb[1] - rgb[1]) ** 2 + (p.rgb[2] - rgb[2]) ** 2;
      const best = [...palette].sort((a, b) => d(a) - d(b))[0];
      return `${best.c.name} ${best.c.hex}`;
    };
    const used: [string, SceneNode][] = [];
    const paint = (p: Paint | null | undefined, n: SceneNode) => {
      if (!p) return;
      if (p.kind === 'solid') used.push([p.color, n]);
      else if (p.kind === 'mesh') used.push(...p.points.map((pt): [string, SceneNode] => [pt.color, n]));
      else used.push([p.from, n], [p.to, n]);
    };
    for (const n of nodes) {
      if (n.type === 'text') used.push([n.fill, n]);
      if (n.type === 'rect' || n.type === 'ellipse' || n.type === 'frame') paint(n.fill as Paint | null, n);
      if ('stroke' in n && n.stroke && (n.strokeWidth ?? 0) > 0) used.push([n.stroke, n]);
    }
    const bg = [doc.background, ...doc.slides.map((s) => s.background).filter((b): b is string => !!b)];
    const offBg = [...new Set(bg.filter((c) => !ok(c)).map((c) => c.slice(0, 7).toUpperCase()))];
    for (const c of offBg) issues.push({ severity: 'warn', rule: 'brand-color', message: `Background ${c} isn't in the ${brand.name} palette (closest: ${closest(c)}).`, page: null, ids: [], keys: [] });
    byValue('brand-color', used.filter(([c]) => !ok(c)).map(([c, n]) => [c.slice(0, 7).toUpperCase(), n]), (c) => `${c} isn't in the ${brand.name} palette (closest: ${closest(c)}).`);
  }

  const scale = brand.typeScale?.[u];
  if (scale?.length) {
    byValue('brand-scale', texts.filter((t) => !scale.some((s) => Math.abs(s - t.fontSize) < 0.26)).map((t) => [String(t.fontSize), t]), (v) => `${v}${u} isn't on the ${brand.name} type scale (${scale.join(' / ')}).`);
  }
}
