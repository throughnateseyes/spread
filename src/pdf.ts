import { useStore } from './store';
import { getAsset, loadFull, allAssets } from './assets';
import { getLayout, letterSpacingPx, textLines, type LayoutMap } from './layout';
import { baseStyle, hasSpans, richLines, runCss } from './richtext';
import { absoluteBoxes, cropGeometry, filterString } from './render';
import { hasEffects, needsLossless, paintEffects } from './effects';
import { paintCanvas } from './gradients';
import { backdropPicture } from './email/images';
import { native } from './platform';
import { walk } from './tree';
import type { Box, Doc, FrameNode, ImageNode, Paint, SceneNode, Shadow, ShapeNode, TextNode } from './types';

// PDF export: the board is rebuilt as self-contained HTML (one absolutely positioned element per
// layer, fonts and images inlined) and printed by Electron's Chromium, so text stays real,
// selectable text. One board unit = 1pt on print documents, 1 CSS px otherwise. Every text line is placed exactly where the canvas draws
// it (same wrap, same baseline), so the PDF matches the canvas instead of re-flowing.

const DPI = 300;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v: number) => +v.toFixed(3);
/** Board units → CSS: points for print documents, px for everything else. */
let unit: 'pt' | 'px' = 'pt';
const pt = (v: number) => `${n2(v)}${unit}`;

function paintCss(p: Paint | null, b: Box): string {
  if (!p) return '';
  if (p.kind === 'solid') return `background:${p.color};`;
  // Angles are CSS-style already (0 = to top, 90 = to right).
  if (p.kind === 'linear' && !p.grain) return `background:linear-gradient(${p.angle}deg, ${p.from}, ${p.to});`;
  return `background:url(${paintCanvas(p, b.w, b.h).toDataURL('image/png')}) 0 0/100% 100% no-repeat;`;
}

function strokeCss(stroke: string | null, width: number): string {
  // Konva strokes are centred on the edge.
  return stroke && width > 0 ? `outline:${pt(width)} solid ${stroke};outline-offset:${pt(-width / 2)};` : '';
}

function boxShadowCss(s?: Shadow) {
  return s?.enabled ? `box-shadow:${pt(s.x)} ${pt(s.y)} ${pt(s.blur)} ${s.color};` : '';
}

function boxCss(n: SceneNode, b: Box) {
  let css = `left:${pt(b.x)};top:${pt(b.y)};width:${pt(b.w)};height:${pt(b.h)};`;
  if (n.rotation) css += `transform:rotate(${n.rotation}deg);`;
  if (n.opacity < 1) css += `opacity:${n.opacity};`;
  return css;
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/** The node's visible crop at 300 dpi, with flips and adjustments baked in. */
async function imageDataUrl(n: ImageNode, w: number, h: number): Promise<string | null> {
  if (!n.assetId) return null;
  const p = loadFull(n.assetId);
  if (!p) return null;
  const bmp = await p;
  try {
    const k = Math.min(DPI / 72, 8000 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(k, k);
    if (hasEffects(n)) {
      paintEffects(ctx, n, w, h, bmp, k, true);
    } else {
      if (n.flipX || n.flipY) {
        ctx.translate(n.flipX ? w : 0, n.flipY ? h : 0);
        ctx.scale(n.flipX ? -1 : 1, n.flipY ? -1 : 1);
      }
      const f = filterString(n);
      if (f !== 'none') ctx.filter = f;
      const g = cropGeometry(n, w, h, bmp.width, bmp.height);
      ctx.drawImage(bmp, g.sx, g.sy, g.sw, g.sh, g.dx, g.dy, g.dw, g.dh);
    }
    const mime = getAsset(n.assetId)?.meta.mime ?? '';
    return /png|webp|gif/.test(mime) || n.fit === 'fit' || needsLossless(n) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
  } finally {
    bmp.close();
  }
}

function textHtml(n: TextNode, b: Box): string {
  const lh = n.lineHeight * n.fontSize;
  const ls = letterSpacingPx(n);
  const font =
    // Single quotes: this CSS lives inside a double-quoted style attribute.
    `font-family:'${n.fontFamily.replace(/['"\\]/g, '')}';font-size:${pt(n.fontSize)};font-weight:${n.fontWeight};` +
    `font-style:${n.italic ? 'italic' : 'normal'};color:${n.fill};letter-spacing:${pt(ls)};` +
    `line-height:${pt(lh)};height:${pt(lh)};` +
    (n.decoration !== 'none' ? `text-decoration:${n.decoration};` : '') +
    (n.shadow?.enabled ? `text-shadow:${pt(n.shadow.x)} ${pt(n.shadow.y)} ${pt(n.shadow.blur)} ${n.shadow.color};` : '');
  // Line breaks are already fixed, so no-break characters can go back to their plain forms: many fonts
  // lack a glyph for U+2011, and a fallback font there splits "Gen‑Z" into separate runs in the PDF text.
  const plain = (s: string) => s.replace(/\u2011/g, '-').replace(/\u00a0/g, ' ');
  if (hasSpans(n)) {
    // Styled ranges: each line is its runs, every run its own span with what differs from the layer.
    const base = baseStyle(n);
    const inner = richLines(n, b.w)
      .map((l, i) => {
        const top = `top:${pt(i * lh)};`;
        const runs = l.segs.map((sg) => {
          const css = runCss(sg.style, base);
          return css ? `<span style="${css}">${esc(plain(sg.text))}</span>` : esc(plain(sg.text));
        });
        if (n.align === 'justify' && !l.last) {
          return `<div class="ln" style="${top}left:0;width:${pt(b.w)};text-align:justify;text-align-last:justify;${font}">${runs.join('')}</div>`;
        }
        const x = n.align === 'right' ? b.w - l.width : n.align === 'center' ? (b.w - l.width) / 2 : 0;
        return `<div class="ln" style="${top}left:${pt(x)};${font}">${runs.join('')}</div>`;
      })
      .join('');
    return `<div class="n" style="${boxCss(n, b)}">${inner}</div>`;
  }
  const lines = textLines(n, b.w).map((l) => ({ ...l, text: plain(l.text) }));
  const inner = lines
    .map((l, i) => {
      const top = `top:${pt(i * lh)};`;
      if (n.align === 'justify' && !l.last) {
        return `<div class="ln" style="${top}left:0;width:${pt(b.w)};text-align:justify;text-align-last:justify;${font}">${esc(l.text)}</div>`;
      }
      const x = n.align === 'right' ? b.w - l.width : n.align === 'center' ? (b.w - l.width) / 2 : 0;
      return `<div class="ln" style="${top}left:${pt(x)};${font}">${esc(l.text)}</div>`;
    })
    .join('');
  return `<div class="n" style="${boxCss(n, b)}">${inner}</div>`;
}

type Backdrop = (n: ShapeNode | FrameNode) => Promise<string>;

/** Printing ignores CSS background blur, so it goes in as a picture just under the layer. */
async function backdropHtml(n: ShapeNode | FrameNode, b: Box, images: Map<string, string | null>, backdrop: Backdrop) {
  if (!n.backdropBlur) return '';
  const key = `blur:${n.id}`;
  if (!images.has(key)) images.set(key, await backdrop(n));
  return `<img class="n" src="${images.get(key)}" alt="" style="${boxCss(n, b)}">`;
}

async function nodeHtml(n: SceneNode, b: Box, layout: LayoutMap, images: Map<string, string | null>, backdrop: Backdrop): Promise<string> {
  if (!n.visible) return '';
  switch (n.type) {
    case 'text':
      return textHtml(n, b);
    case 'rect':
    case 'ellipse': {
      const radius = n.type === 'ellipse' ? 'border-radius:50%;' : n.radius ? `border-radius:${pt(n.radius)};` : '';
      return `${await backdropHtml(n, b, images, backdrop)}<div class="n" style="${boxCss(n, b)}${paintCss(n.fill, b)}${radius}${strokeCss(n.stroke, n.strokeWidth)}${boxShadowCss(n.shadow)}"></div>`;
    }
    case 'image': {
      if (!images.has(n.id)) images.set(n.id, await imageDataUrl(n, b.w, b.h));
      const src = images.get(n.id);
      const radius = n.radius ? `border-radius:${pt(n.radius)};` : '';
      const img = src ? `<img src="${src}" alt="${esc(n.name)}" style="width:100%;height:100%;display:block">` : '';
      return `<div class="n" style="${boxCss(n, b)}overflow:hidden;${radius}${strokeCss(n.stroke, n.strokeWidth)}${boxShadowCss(n.shadow)}">${img}</div>`;
    }
    case 'frame': {
      const kids: string[] = [];
      for (const c of n.children) {
        const cb = layout.get(c.id);
        if (cb) kids.push(await nodeHtml(c, cb, layout, images, backdrop));
      }
      const radius = n.radius ? `border-radius:${pt(n.radius)};` : '';
      return `${await backdropHtml(n, b, images, backdrop)}<div class="n" style="${boxCss(n, b)}${paintCss(n.fill, b)}${radius}${n.clip ? 'overflow:hidden;' : ''}${strokeCss(n.stroke, n.strokeWidth)}${boxShadowCss(n.shadow)}">${kids.join('')}</div>`;
    }
  }
}

// ---------- fonts ----------

const fontData = new Map<string, Promise<string>>();
function fetchDataUrl(url: string) {
  let p = fontData.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.blob())
      .then(blobToDataUrl);
    fontData.set(url, p);
  }
  return p;
}

const familyOf = (raw: string) => raw.replace(/["']/g, '').trim();

/** @font-face rules for every family the board uses: bundled faces from the app's stylesheets, uploaded fonts from the asset registry. */
export async function fontFaceCss(families: Set<string>): Promise<string> {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      if (!families.has(familyOf(rule.style.getPropertyValue('font-family')))) continue;
      const base = sheet.href ?? location.href;
      let css = rule.cssText;
      const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'));
      for (const u of new Set(urls)) {
        const data = await fetchDataUrl(new URL(u, base).href).catch(() => null);
        if (data) css = css.split(u).join(data);
      }
      out.push(css);
    }
  }
  for (const r of allAssets()) {
    if (r.meta.kind === 'font' && r.meta.family && families.has(r.meta.family)) {
      out.push(`@font-face{font-family:"${r.meta.family}";src:url(${await blobToDataUrl(r.blob)});}`);
    }
  }
  return out.join('\n');
}

// ---------- document ----------

/** Self-contained HTML for a board's pages (one board unit = 1pt). */
export async function buildPrintHtml(board: Doc, layout: LayoutMap): Promise<string> {
  const W = board.slideWidth;
  const H = board.slideHeight;
  unit = board.page?.units === 'px' || board.kind !== 'document' ? 'px' : 'pt';
  const abs = absoluteBoxes(board.nodes, layout);
  const families = new Set<string>();
  walk(board.nodes, (n) => {
    if (n.type === 'text') families.add(n.fontFamily);
  });
  const images = new Map<string, string | null>();
  const backdrop: Backdrop = (n) => backdropPicture(board, n, abs.get(n.id)!, layout);
  const pages: string[] = [];
  for (let i = 0; i < board.slides.length; i++) {
    const x0 = i * W;
    const parts: string[] = [];
    for (const n of board.nodes) {
      const b = abs.get(n.id);
      if (!b || b.x >= x0 + W || b.x + b.w <= x0) continue;
      parts.push(await nodeHtml(n, { ...b, x: b.x - x0 }, layout, images, backdrop));
    }
    const bg = board.slides[i].background ?? board.background;
    pages.push(`<section class="page" style="background:${bg}">${parts.join('')}</section>`);
  }
  const css =
    `@page{size:${pt(W)} ${pt(H)};margin:0}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `.page{position:relative;width:${pt(W)};height:${pt(H)};overflow:hidden;break-after:page}` +
    `.page:last-child{break-after:auto}` +
    `.n{position:absolute;box-sizing:border-box;transform-origin:0 0}` +
    `.ln{position:absolute;white-space:pre;font-kerning:normal;text-rendering:geometricPrecision}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(board.name)}</title><style>${await fontFaceCss(families)}\n${css}</style></head><body>${pages.join('')}</body></html>`;
}

/** Exports a board as a PDF with real text. Desktop app only. */
export async function exportPdf(boardId?: string): Promise<{ bytes: Uint8Array; pages: number; name: string }> {
  if (!native?.printPdf) throw new Error('PDF export needs the Spread desktop app.');
  const s = useStore.getState();
  const board = boardId ? s.project.boards.find((b) => b.id === boardId) : s.doc;
  if (!board) throw new Error(`Unknown board "${boardId}"`);
  await document.fonts.ready;
  const html = await buildPrintHtml(board, getLayout(board.nodes, s.fontsVersion));
  const perInch = board.kind === 'document' && board.page?.units !== 'px' ? 72 : 96;
  const bytes = await native.printPdf({ html, widthIn: board.slideWidth / perInch, heightIn: board.slideHeight / perInch });
  return { bytes, pages: board.slides.length, name: board.name };
}
