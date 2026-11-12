import { hasSpans, richHtml } from '../richtext';
import type { Box, FrameNode, ImageNode, Paint, SceneNode, ShapeNode, TextNode } from '../types';
import type { LayoutMap } from '../layout';
import { getAsset } from '../assets';
import { needsLossless } from '../effects';
import { isCustomPaint } from '../gradients';
import { nodeLink, withTracking } from '../links';

// Email compiler: turns an auto-layout node tree into inbox-safe HTML.
//
// Every frame becomes a presentation table. Column frames stack one <tr> per child, with the
// gap and padding carried as td padding (taken from the computed layout boxes, so justify and
// fixed heights come out right). Row frames become one <tr> with a td per child and spacer tds
// for gaps; rows that hold photos or cards stack on phones via a media query (a row's
// `phoneStack` overrides that). Text is a styled td, photos are <img> tags pointing at hosted
// copies (rendered by images.ts), and anything free-positioned (layout 'none') is flattened into
// one picture.
//
// Text that hugs its words never gets a fixed px column: inboxes swap in wider fonts, and a
// column cut to the canvas width breaks "1050 Post St" in two. In a column it fills the cell; in
// a row it can't wrap on desktop. `phoneFullWidth` on a picture (or frame) takes it edge to edge
// on phones by dropping the side padding around it there and giving that padding back to
// everything beside it.
//
// A layer's `link` property links it and everything inside it (see links.ts).
// Naming conventions read from layer names (tags are stripped from alt text):
//   [link:https://…]  the older form of `link`, still read
//   [alt:…]           alt text for a photo (otherwise the layer name is used)
//   [button]          force a frame to compile as a bulletproof button
//   [stack] / [nostack]  the older form of `phoneStack`, still read (the property wins)
//   [raster]          flatten a frame into one picture even if it uses auto layout

export const GMAIL_CLIP_BYTES = 102_000;

export type EmailImageFormat = 'jpeg' | 'png';

export interface EmailImage {
  nodeId: string;
  fileName: string;
  /** Alt text written into the HTML. */
  alt: string;
  /** Size in CSS px (1x). Files are rendered at a multiple of this. */
  width: number;
  height: number;
  format: EmailImageFormat;
  /** Colour baked into rounded corners / letterboxing (JPEG has no alpha). */
  matte: string;
  /** A frame or shape flattened into one picture (not a photo layer). */
  rasterize?: boolean;
  /** Where the picture links, if anywhere. */
  href?: string;
}

export interface EmailHtmlOptions {
  /** <title>; most clients show the subject line instead, but some use this. */
  title: string;
  /** Hidden inbox preview text. Should not repeat the subject line. */
  preheader?: string;
  /** Public URL for an exported picture. */
  imageUrl: (nodeId: string, suggestedFileName: string) => string;
  /** Gutter colour outside the 600px column. Defaults to the root frame's fill. */
  bodyBackground?: string;
  /** CSS font-family value (with fallbacks) for a Spread font family. */
  fontStack?: (family: string) => string;
  /** Extra links by node id (wins over the layers' own links). */
  links?: Record<string, string>;
  /** Tags added to every web link ("utm_source=x&utm_campaign=y"). */
  tracking?: string;
  /** 'light' (default) asks clients not to recolour; 'light dark' lets them. */
  colorScheme?: 'light' | 'light dark';
  lang?: string;
  /** Mobile breakpoint in px (default 600). */
  breakpoint?: number;
  /** Preview only: draws each picture as the empty box a blocked image leaves, with its alt text. */
  imagesOff?: boolean;
  /** Preview only: marks each text cell with data-sid="<layer id>" so the preview can measure it. */
  tagText?: boolean;
}

/** A text (or inline row) inside a row that stays side by side on phones. */
export interface TwoAcrossText {
  id: string;
  rowId: string;
}

export interface EmailHtmlResult {
  html: string;
  images: EmailImage[];
  warnings: string[];
  /** Every {{TOKEN}} left in the HTML. The warning only names the first few. */
  placeholders: string[];
  /** UTF-8 size of `html`. */
  bytes: number;
  /** Every font family the email asks for. */
  fonts: string[];
  /** Texts in rows of cards that stay side by side on phones, where they get half a phone's width. */
  twoAcross: TwoAcrossText[];
}

// ---------- small helpers ----------

/** Escapes text for HTML and turns non-ASCII into numeric entities (survives any ESP paste). */
export function escapeHtml(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else if (cp > 126) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}

function escAttr(s: string): string {
  return s.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const r = (n: number) => Math.max(0, Math.round(n));
const pct = (part: number, whole: number) => `${Math.round((part / Math.max(1, whole)) * 10000) / 100}%`;

interface NameTags {
  clean: string;
  link?: string;
  alt?: string;
  flags: Set<string>;
}

/** Parses `[tag]` / `[tag:value]` markers out of a layer name. */
export function parseNameTags(name: string): NameTags {
  const flags = new Set<string>();
  let link: string | undefined;
  let alt: string | undefined;
  const clean = name
    .replace(/\[(\w+)(?::([^\]]*))?\]/g, (_m, key: string, val?: string) => {
      const k = key.toLowerCase();
      if (k === 'link' && val) link = val.trim();
      else if (k === 'alt' && val !== undefined) alt = val.trim();
      else flags.add(k);
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { clean, link, alt, flags };
}

/** A row's phone setting: its `phoneStack`, else an older [stack] / [nostack] name tag, else automatic. */
export function phoneStackSetting(f: FrameNode): 'stack' | 'side-by-side' | undefined {
  if (f.phoneStack === 'stack' || f.phoneStack === 'side-by-side') return f.phoneStack;
  const tags = parseNameTags(f.name).flags;
  if (tags.has('nostack')) return 'side-by-side';
  if (tags.has('stack')) return 'stack';
  return undefined;
}

/** What "automatic" does: rows holding photos or cards (120px or wider) stack on phones. */
export function autoStacks(f: FrameNode, layout: LayoutMap): boolean {
  const kids = f.children.filter((c) => c.visible);
  if (kids.length < 2) return false;
  return kids.some((c) => {
    const b = layout.get(c.id);
    return !!b && b.w >= 120 && (c.type === 'image' || c.type === 'frame' || c.type === 'ellipse');
  });
}

/** Whether a row frame stacks on phones in the compiled email. */
export function rowStacksOnPhones(f: FrameNode, layout: LayoutMap): boolean {
  const set = phoneStackSetting(f);
  return set ? set === 'stack' : autoStacks(f, layout);
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || ''
  );
}

function hex2(c: string): { rgb: [number, number, number]; a: number } {
  let s = (c || '#000000').trim();
  if (!s.startsWith('#')) s = '#' + s;
  if (s.length === 4 || s.length === 5) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('');
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16) || 0;
  return { rgb: [n(1), n(3), n(5)], a: s.length >= 9 ? n(7) / 255 : 1 };
}

const toHex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Flattens a (possibly translucent) colour over a solid background: email has no alpha. */
export function flatten(color: string, over: string, extraAlpha = 1): string {
  const fg = hex2(color);
  const bg = hex2(over);
  const a = fg.a * extraAlpha;
  if (a >= 0.999) return toHex(fg.rgb);
  return toHex(fg.rgb.map((v, i) => v * a + bg.rgb[i] * (1 - a)));
}

const SERIF = /(serif|georgia|times|playfair|fraunces|garamond|baskerville|caslon|didot|bodoni|merriweather|lora)/i;
const MONO = /(mono|courier|consolas)/i;
const CONDENSED = /(bebas|impact|oswald|condensed|narrow)/i;
const WEB_SAFE = /^(arial|helvetica|georgia|times new roman|times|verdana|tahoma|trebuchet ms|courier new|impact)$/i;

/** Default font stack: the family (minus Fontsource's " Variable") plus web-safe fallbacks. */
export function defaultFontStack(family: string): string {
  const name = family.replace(/\s+Variable$/i, '').trim();
  const q = (f: string) => (/[^a-z0-9-]/i.test(f) ? `'${f.replace(/'/g, '')}'` : f);
  const isSans = /sans/i.test(name);
  let tail: string[];
  if (MONO.test(name)) tail = ["'Courier New'", 'Courier', 'monospace'];
  else if (CONDENSED.test(name)) tail = ['Impact', "'Arial Narrow'", 'Arial', 'sans-serif'];
  else if (!isSans && SERIF.test(name)) tail = ['Georgia', "'Times New Roman'", 'Times', 'serif'];
  else tail = ['Arial', 'Helvetica', 'sans-serif'];
  const first = q(name);
  return [first, ...tail.filter((t) => t.replace(/'/g, '').toLowerCase() !== name.toLowerCase())].join(', ');
}

export const isWebSafe = (family: string) => WEB_SAFE.test(family);

/** What inboxes really fall back to: the stack without a family they won't have. */
export function fallbackStack(family: string): string {
  const stack = defaultFontStack(family);
  return isWebSafe(family) ? stack : stack.split(', ').slice(1).join(', ');
}

/** Alt text colour that reads on `bg`, since a blocked picture leaves its background showing. */
function altInk(bg: string): string {
  const [r8, g8, b8] = hex2(bg).rgb;
  return 0.299 * r8 + 0.587 * g8 + 0.114 * b8 > 140 ? '#333333' : '#FFFFFF';
}

// ---------- compiler ----------

interface Env {
  /** Solid colour visible behind this node (for flattening alpha and matting photos). */
  bg: string;
  /** Inherited link. */
  href: string | null;
  /** Inside a row that stacks on phones. */
  stacked: boolean;
  /**
   * Side padding (left, right) dropped on phones somewhere above, to let a full-width picture
   * reach the edges. Cells here that aren't on the way to that picture add it back.
   */
  restore?: [number, number];
  /** Inside a row of cards that stays side by side on phones (its id). */
  twoAcross?: string;
}

interface Place {
  /** td padding t r b l */
  pad: [number, number, number, number];
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** td width attr (px) and style width. */
  widthAttr?: number;
  widthStyle?: string;
  heightAttr?: number;
  classes: string[];
  /** The td's content box is exactly the child's width (row cells), or wider (column cells). */
  full: boolean;
  /** Content width available inside the td. */
  avail: number;
  nowrap?: boolean;
  /** Row cell whose child fills the row's height: let it stretch instead of fixing a height. */
  stretch?: boolean;
  bgcolor?: string;
  /** Phones: drop this cell's side padding ('edge'), or add `restore` to it. */
  phone?: 'edge' | [number, number];
}

class Compiler {
  images: EmailImage[] = [];
  warnings: string[] = [];
  private warned = new Set<string>();
  gapClasses = new Set<number>();
  fonts = new Set<string>();
  hrefs: string[] = [];
  hasUnsubscribe = false;
  emptyPhotos: string[] = [];
  /** Full-width-on-phones layers and every frame that holds one. */
  bleed = new Set<string>();
  /** The full-width-on-phones layers themselves. */
  edgeNodes = new Set<string>();
  padClasses = { l: new Set<number>(), r: new Set<number>() };
  usesEdge = false;
  twoAcross: TwoAcrossText[] = [];

  constructor(
    readonly layout: LayoutMap,
    readonly opts: EmailHtmlOptions,
  ) {}

  /** Marks layers set to full width on phones, and the frames on the way down to them. */
  markBleed(nodes: SceneNode[]): boolean {
    let any = false;
    for (const n of nodes) {
      if (!n.visible) continue;
      const own = (n.type === 'image' || n.type === 'frame') && !!n.phoneFullWidth;
      const inside = n.type === 'frame' && n.layout !== 'none' ? this.markBleed(n.children) : false;
      if (own) this.edgeNodes.add(n.id);
      if (own || inside) {
        this.bleed.add(n.id);
        any = true;
      }
    }
    return any;
  }

  /**
   * Phone padding for a child cell. On the way to a full-width picture the cell drops its side
   * padding (and the child remembers how much went); a cell beside it gets back what was dropped above.
   */
  phonePlace(c: SceneNode, pad: [number, number], env: Env, canBleed = true): { phone?: Place['phone']; restore?: [number, number] } {
    const owed = env.restore ?? [0, 0];
    if (canBleed && this.bleed.has(c.id)) return { phone: 'edge', restore: [owed[0] + pad[0], owed[1] + pad[1]] };
    if (owed[0] || owed[1]) return { phone: owed };
    return {};
  }

  /** data-sid for preview measuring, and the two-across list. */
  textAttrs(id: string, env: Env): string[] {
    if (env.twoAcross) this.twoAcross.push({ id, rowId: env.twoAcross });
    return this.opts.tagText ? [`data-sid="${escAttr(id)}"`] : [];
  }

  warn(msg: string, key = msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(msg);
  }

  box(n: SceneNode): Box | null {
    const b = this.layout.get(n.id);
    if (!b) this.warn(`“${parseNameTags(n.name).clean || n.type}” has no layout box and was skipped (recompute layout before exporting).`);
    return b ?? null;
  }

  fontStack(family: string) {
    this.fonts.add(family);
    return (this.opts.fontStack ?? defaultFontStack)(family);
  }

  /** The layer's own link as it will ship, tracking tags included. */
  ownHref(n: SceneNode): string | undefined {
    const url = this.opts.links?.[n.id] ?? nodeLink(n);
    return url ? withTracking(url, this.opts.tracking) : undefined;
  }

  hrefFor(n: SceneNode, env: Env): string | null {
    return this.ownHref(n) ?? env.href;
  }

  noteHref(href: string, label: string) {
    this.hrefs.push(href);
    if (/unsub/i.test(href) || /unsubscribe/i.test(label)) this.hasUnsubscribe = true;
  }

  paintColor(p: Paint | null, bg: string, opacity: number, what: string): { color: string | null; gradient?: string } {
    if (!p) return { color: null };
    if (p.kind === 'solid') {
      if (hex2(p.color).a * opacity <= 0.001) return { color: null };
      return { color: flatten(p.color, bg, opacity) };
    }
    if (p.kind !== 'linear' || p.grain) {
      // Shapes become pictures (see cell()); only a frame's background can reach here.
      const first = p.kind === 'mesh' ? p.points[0].color : p.from;
      this.warn(`Mesh, radial and grainy gradients can't be a frame's background in email, so “${what}” uses a solid colour. Put the gradient on a shape inside it, or tag the frame [raster] to send it as a picture.`, 'custom-paint');
      return { color: flatten(first, bg, opacity) };
    }
    this.warn(`Gradient fills show in Apple Mail and iOS only; other clients get the solid start colour (${what}).`, 'gradient');
    const from = flatten(p.from, bg, opacity);
    const to = flatten(p.to, bg, opacity);
    return { color: from, gradient: `linear-gradient(${p.angle}deg,${from},${to})` };
  }

  generic(n: SceneNode, env: Env) {
    if (n.rotation) this.warn(`Rotation isn't supported in email and was ignored (“${parseNameTags(n.name).clean}”). Put it inside a free-positioned frame to flatten it into a picture.`, 'rot:' + n.id);
    if (n.shadow?.enabled) this.warn('Drop shadows are dropped in email.', 'shadow');
    if ((n.type === 'rect' || n.type === 'ellipse' || n.type === 'frame') && n.backdropBlur) this.warn(`Background blur doesn't work in email, so “${parseNameTags(n.name).clean}” won't have it. Tag its frame [raster] to send it as a picture.`, 'backdrop');
  }

  // ----- frames -----

  /** `width` 'auto' shrinks the table to its content, like a hugging frame of text. */
  frameTable(f: FrameNode, box: Box, env: Env, width: 'full' | 'auto' | number, align?: 'left' | 'center' | 'right'): string {
    this.generic(f, env);
    const name = parseNameTags(f.name);
    const href = this.hrefFor(f, env);
    if (f.opacity < 1) this.warn(`Layer opacity isn't supported on frames in email; “${name.clean}” is drawn fully opaque (its fill colour is blended).`, 'op:' + f.id);
    const { color: fill, gradient } = this.paintColor(f.fill, env.bg, f.opacity, name.clean);
    const inner: Env = { ...env, bg: fill ?? env.bg, href };

    const attrs = [`role="presentation"`, `cellpadding="0"`, `cellspacing="0"`, `border="0"`];
    const style: string[] = [];
    const cls: string[] = [];
    if (width === 'full') attrs.push(`width="100%"`);
    else if (width !== 'auto') {
      attrs.push(`width="${r(width)}"`);
      style.push(`width:${r(width)}px`, 'max-width:100%');
      if (width >= 160) cls.push('es-full');
    }
    if (f.phoneFullWidth) {
      cls.push('es-bleed');
      this.usesEdge = true;
    }
    if (align && align !== 'left') attrs.push(`align="${align}"`);
    if (fill) {
      attrs.push(`bgcolor="${fill}"`);
      style.push(`background-color:${fill}`);
    }
    if (gradient) style.push(`background-image:${gradient}`);
    if (f.radius > 0) style.push(`border-radius:${r(f.radius)}px`, 'border-collapse:separate', 'overflow:hidden');
    if (f.stroke && f.strokeWidth > 0) style.push(`border:${r(f.strokeWidth)}px solid ${flatten(f.stroke, inner.bg)}`);
    if (cls.length) attrs.push(`class="${cls.join(' ')}"`);
    if (style.length) attrs.push(`style="${style.join(';')}"`);
    const open = `<table ${attrs.join(' ')}>`;

    const body = f.layout === 'row' ? this.rowBody(f, box, inner) : this.columnBody(f, box, inner);
    return `${open}\n${body}\n</table>`;
  }

  columnBody(f: FrameNode, box: Box, env: Env): string {
    const kids = f.children.filter((c) => c.visible);
    const pad = f.padding;
    const innerW = Math.max(1, box.w - pad.l - pad.r);
    if (!kids.length) return `<tr><td height="${r(box.h)}" style="height:${r(box.h)}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    const rows: string[] = [];
    let prevBottom = 0;
    kids.forEach((c, i) => {
      const b = this.box(c);
      if (!b) return;
      const top = b.y - prevBottom;
      prevBottom = b.y + b.h;
      const bottom = i === kids.length - 1 ? box.h - (b.y + b.h) : 0;
      const full = b.w >= innerW - 1;
      const align = full ? 'left' : f.alignItems === 'center' ? 'center' : f.alignItems === 'end' ? 'right' : 'left';
      const { phone, restore } = this.phonePlace(c, [r(pad.l), r(pad.r)], env);
      const place: Place = { pad: [r(top), r(pad.r), r(bottom), r(pad.l)], align, valign: 'top', classes: [], full, avail: innerW, phone };
      rows.push(`<tr>${this.cell(c, b, { ...env, restore }, place)}</tr>`);
    });
    return rows.join('\n');
  }

  shouldStack(f: FrameNode): boolean {
    return rowStacksOnPhones(f, this.layout);
  }

  /**
   * A frame that only hugs text (a column of hugging lines, like an address block). It compiles
   * as a table that shrinks to its words instead of one cut to the canvas width, which a wider
   * inbox font would overflow. Photos and rules are left out: they size against their cell.
   */
  hugsText(n: SceneNode): boolean {
    if (n.type === 'text') return n.sizingH === 'hug' && !n.rotation;
    if (n.type !== 'frame' || n.sizingH !== 'hug' || n.rotation || n.phoneFullWidth) return false;
    if (n.layout === 'row') return this.isInlineRow(n);
    const kids = n.children.filter((c) => c.visible);
    return n.layout === 'column' && kids.length > 0 && !this.buttonParts(n) && !parseNameTags(n.name).flags.has('raster') && kids.every((c) => this.hugsText(c));
  }

  rowBody(f: FrameNode, box: Box, env: Env): string {
    const kids = f.children.filter((c) => c.visible);
    const pad = f.padding;
    const innerW = Math.max(1, box.w - pad.l - pad.r);
    const innerH = Math.max(0, box.h - pad.t - pad.b);
    if (!kids.length) return `<tr><td height="${r(box.h)}" style="height:${r(box.h)}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    const stack = this.shouldStack(f);
    // A full-width picture can only reach the edges through a row that stacks; side by side, it
    // fills its own cell. The row's padding sits on one td around every cell.
    const rowPad: [number, number] = [r(pad.l), r(pad.r)];
    const { phone: rowPhone, restore: rowRestore } = this.phonePlace(f, rowPad, env, stack);
    const owed = rowPhone === 'edge' ? rowRestore! : ([0, 0] as [number, number]);
    const cards = kids.filter((c) => c.type === 'frame' || c.type === 'image').length;
    const childEnv: Env = { ...env, stacked: env.stacked || stack, restore: undefined, twoAcross: !stack && cards >= 2 ? f.id : env.twoAcross };
    const valign = f.alignItems === 'center' ? 'middle' : f.alignItems === 'end' ? 'bottom' : 'top';
    // The frame's own gap is a fixed px spacer; slack from justify (between / centre / end) is
    // flexible, so it can shrink on phones instead of pushing the row wider than the screen.
    const spacer = (w: number, flexible: boolean) => {
      const ww = r(w);
      if (ww <= 0) return '';
      const width = flexible ? pct(w, innerW) : `${ww}px`;
      return `<td width="${ww}"${stack ? ' class="es-spc"' : ''} style="width:${width};font-size:0;line-height:0">&nbsp;</td>`;
    };
    const tds: string[] = [];
    let cursor = pad.l;
    let pendingGap = 0;
    kids.forEach((c, i) => {
      const b = this.box(c);
      if (!b) return;
      const gap = b.x - cursor;
      cursor = b.x + b.w;
      tds.push(spacer(gap, i === 0 || f.justify === 'between' || Math.abs(gap - f.gap) > 1));
      if (i > 0) pendingGap = r(gap);
      const classes: string[] = [];
      // An empty cell only holds a row's shape, like the end of a half-full grid. Phones skip it.
      if (stack && c.type === 'frame' && !c.children.length && !c.fill) classes.push('es-spc');
      else if (stack) {
        classes.push('es-col');
        if (i > 0 && pendingGap > 0) {
          classes.push(`es-gt${pendingGap}`);
          this.gapClasses.add(pendingGap);
        }
      }
      const fixedH = f.sizingV === 'fixed' && innerH > b.h + 1 ? innerH : undefined;
      // Cross-axis fill frames: paint the td too, so the colour stretches with the row.
      let bgcolor: string | undefined;
      if (c.type === 'frame' && b.h >= innerH - 1) bgcolor = this.paintColor(c.fill, env.bg, c.opacity, c.name).color ?? undefined;
      // Text that hugs its words never wraps on desktop, even when the inbox font runs wider than
      // the canvas font. Stacked on phones, it gets the whole width and may wrap there.
      const hugText = c.type === 'text' && c.sizingH === 'hug';
      // Stacked cells on the way to a full-width picture pass the row's dropped padding down;
      // the cells beside them take it back.
      const cellPhone = rowPhone === 'edge' ? this.phonePlace(c, [0, 0], { ...env, restore: owed }) : {};
      const place: Place = {
        pad: [0, 0, 0, 0],
        align: 'left',
        valign,
        widthAttr: r(b.w),
        // Fixed-size cells keep their px width; flexible ones share the row by percentage.
        widthStyle: c.sizingH === 'fixed' && !stack ? `${r(b.w)}px` : pct(b.w, innerW),
        heightAttr: fixedH ? r(fixedH) : undefined,
        classes,
        full: true,
        avail: b.w,
        nowrap: hugText,
        stretch: c.sizingV === 'fill',
        bgcolor,
        phone: cellPhone.phone === 'edge' ? undefined : cellPhone.phone,
      };
      tds.push(this.cell(c, b, { ...childEnv, restore: cellPhone.restore }, place));
    });
    tds.push(spacer(box.w - pad.r - cursor, true));
    const row = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>\n${tds.filter(Boolean).join('\n')}\n</tr></table>`;
    const padStyle = [pad.t, pad.r, pad.b, pad.l].some((v) => v > 0) ? ` style="padding:${r(pad.t)}px ${r(pad.r)}px ${r(pad.b)}px ${r(pad.l)}px"` : '';
    const padCls = this.phoneClasses(rowPhone, [r(pad.t), r(pad.r), r(pad.b), r(pad.l)]);
    return `<tr><td${padCls.length ? ` class="${padCls.join(' ')}"` : ''}${padStyle}>\n${row}\n</td></tr>`;
  }

  /** Classes that change a cell's side padding on phones (see mobileCss). */
  phoneClasses(phone: Place['phone'], pad: [number, number, number, number]): string[] {
    if (!phone) return [];
    if (phone === 'edge') {
      if (!pad[1] && !pad[3]) return [];
      this.usesEdge = true;
      return ['es-edge'];
    }
    const out: string[] = [];
    if (phone[0] || phone[1]) this.usesEdge = true;
    if (phone[0]) {
      const l = pad[3] + phone[0];
      this.padClasses.l.add(l);
      out.push(`es-pl${l}`);
    }
    if (phone[1]) {
      const rr = pad[1] + phone[1];
      this.padClasses.r.add(rr);
      out.push(`es-pr${rr}`);
    }
    return out;
  }

  // ----- cells -----

  tdOpen(place: Place, extraStyle: string[] = [], extraAttrs: string[] = []): string {
    const a: string[] = [];
    if (place.widthAttr !== undefined) a.push(`width="${place.widthAttr}"`);
    if (place.heightAttr !== undefined) a.push(`height="${place.heightAttr}"`);
    if (place.align !== 'left') a.push(`align="${place.align}"`);
    a.push(`valign="${place.valign}"`);
    if (place.bgcolor) a.push(`bgcolor="${place.bgcolor}"`);
    const classes = [...place.classes, ...this.phoneClasses(place.phone, place.pad)];
    if (classes.length) a.push(`class="${classes.join(' ')}"`);
    a.push(...extraAttrs);
    const s: string[] = [];
    if (place.widthStyle) s.push(`width:${place.widthStyle}`);
    const [t, rr, b, l] = place.pad;
    if (t || rr || b || l) s.push(`padding:${t}px ${rr}px ${b}px ${l}px`);
    if (place.bgcolor) s.push(`background-color:${place.bgcolor}`);
    if (place.nowrap) s.push('white-space:nowrap');
    s.push(...extraStyle);
    if (s.length) a.push(`style="${s.join(';')}"`);
    return `<td ${a.join(' ')}>`;
  }

  cell(n: SceneNode, b: Box, env: Env, place: Place): string {
    if (n.type === 'text') return this.textCell(n, b, env, place);
    if (n.type === 'image') return this.tdOpen(place) + this.img(this.addImage(n, b, env, false), b, env, place, this.hrefFor(n, env)) + '</td>';
    if (n.type === 'ellipse') return this.tdOpen(place) + this.img(this.addImage(n, b, env, true), b, env, place, this.hrefFor(n, env)) + '</td>';
    if (n.type !== 'frame') {
      if (n.fill && isCustomPaint(n.fill)) return this.tdOpen(place) + this.img(this.addImage(n, b, env, true), b, env, place, this.hrefFor(n, env)) + '</td>';
      return this.rectCell(n, b, env, place);
    }
    // frame
    const tags = parseNameTags(n.name);
    const btn = this.buttonParts(n);
    if (btn) return this.tdOpen(place) + this.button(n, b, env, place, btn) + '</td>';
    if (n.layout === 'none' || tags.flags.has('raster')) {
      if (n.layout === 'none')
        this.warn(
          `“${tags.clean || 'Frame'}” uses free positioning, so it was exported as one picture. Text inside it won't be live (or readable with images off). Turn on auto layout to keep it as real text.`,
          'raster:' + n.id,
        );
      return this.tdOpen(place) + this.img(this.addImage(n, b, env, true), b, env, place, this.hrefFor(n, env)) + '</td>';
    }
    if (this.isInlineRow(n)) return this.inlineRowCell(n, b, env, place);
    const width = place.full ? 'full' : this.hugsText(n) ? 'auto' : b.w;
    return this.tdOpen(place) + this.frameTable(n, b, env, width, place.align) + '</td>';
  }

  /** A row of one-line hugging texts on no background ("2 bed ✦ 1 bath", social links), or one such text. */
  isInlineRow(f: FrameNode): boolean {
    if (f.layout !== 'row' || f.justify === 'between' || f.fill || (f.stroke && f.strokeWidth > 0) || f.rotation || f.phoneFullWidth) return false;
    const kids = f.children.filter((c) => c.visible);
    return kids.length > 0 && kids.every((c) => c.type === 'text' && c.sizingH === 'hug' && !c.text.includes('\n') && !c.rotation);
  }

  /**
   * Compiles an inline row as one td of styled spans. It wraps naturally on phones, where a
   * table of fixed cells would overflow. Gaps become non-breaking spaces (padding on inline
   * elements is ignored by Outlook) with a normal space last so lines can still break.
   */
  inlineRowCell(f: FrameNode, b: Box, env: Env, place: Place): string {
    const kids = f.children.filter((c): c is TextNode => c.visible && c.type === 'text');
    const rowHref = this.hrefFor(f, env);
    const first = kids[0];
    const lineH = Math.max(...kids.map((t) => Math.round(t.fontSize * t.lineHeight)));
    const base = [`font-family:${this.fontStack(first.fontFamily)}`, `font-size:${Math.round(first.fontSize * 100) / 100}px`, `line-height:${lineH}px`, 'mso-line-height-rule:exactly'];
    const pieces = kids.map((t) => {
      this.generic(t, env);
      // Spans inherit family/size from the td; only write what differs.
      const s = this.textStyle(t, env).filter(
        (x) => !x.startsWith('line-height') && !x.startsWith('mso-line') && !x.startsWith('text-align') && !base.includes(x),
      );
      const href = this.ownHref(t) ?? rowHref;
      if (href) {
        this.noteHref(href, t.text);
        if (t.decoration === 'none') s.push('text-decoration:none');
        return `<a href="${escAttr(href)}" target="_blank" style="${s.join(';')}">${this.textHtml(t)}</a>`;
      }
      return `<span style="${s.join(';')}">${this.textHtml(t)}</span>`;
    });
    const space = Math.max(1, Math.round(f.gap / (first.fontSize * 0.28)));
    const sep = '&nbsp;'.repeat(space - 1) + ' ';
    const p = f.padding;
    const pad: [number, number, number, number] = [place.pad[0] + r(p.t), place.pad[1] + r(p.r), place.pad[2] + r(p.b), place.pad[3] + r(p.l)];
    const align = place.full ? (f.justify === 'center' ? 'center' : f.justify === 'end' ? 'right' : 'left') : place.align;
    if (align !== 'left') base.push(`text-align:${align}`);
    return this.tdOpen({ ...place, pad, align, nowrap: false }, base, this.textAttrs(f.id, env)) + pieces.join(sep) + '</td>';
  }

  textStyle(t: TextNode, env: Env): string[] {
    const fs = t.fontSize;
    const s = [
      `font-family:${this.fontStack(t.fontFamily)}`,
      `font-size:${Math.round(fs * 100) / 100}px`,
      `line-height:${Math.round(fs * t.lineHeight)}px`,
      `font-weight:${t.fontWeight >= 600 ? 'bold' : t.fontWeight <= 400 ? 'normal' : t.fontWeight}`,
      `color:${flatten(t.fill, env.bg, t.opacity)}`,
      'mso-line-height-rule:exactly',
    ];
    if (t.align !== 'left') s.push(`text-align:${t.align}`);
    const ls = Math.round((t.letterSpacing / 100) * fs * 10) / 10;
    if (ls) s.push(`letter-spacing:${ls}px`);
    if (t.uppercase) s.push('text-transform:uppercase');
    if (t.italic) s.push('font-style:italic');
    if (t.decoration !== 'none') s.push(`text-decoration:${t.decoration}`);
    return s;
  }

  textHtml(t: TextNode): string {
    if (!t.text.trim()) return '&nbsp;';
    const piece = (s: string) =>
      s
        .split('\n')
        .map((line) => escapeHtml(line).replace(/ {2}/g, ' &nbsp;'))
        .join('<br>');
    // Styled ranges (a bold word) become inline spans; inbox clients all honour these.
    return hasSpans(t) ? richHtml(t, piece) : piece(t.text);
  }

  textCell(t: TextNode, b: Box, env: Env, place: Place): string {
    this.generic(t, env);
    const style = this.textStyle(t, env);
    let content = this.textHtml(t);
    const href = this.hrefFor(t, env);
    if (href) {
      this.noteHref(href, t.text);
      const color = flatten(t.fill, env.bg, t.opacity);
      const deco = t.decoration === 'none' ? 'none' : t.decoration;
      content = `<a href="${escAttr(href)}" target="_blank" style="color:${color};text-decoration:${deco}">${content}</a>`;
    } else if (/unsubscribe/i.test(t.text) && /\{\{|%%|\*\|/.test(t.text)) {
      this.hasUnsubscribe = true;
    }
    const lineH = t.fontSize * t.lineHeight;
    const multiLine = b.h > lineH * 1.5;
    const attrs = this.textAttrs(t.id, env);
    if (!place.full && t.sizingH === 'hug') {
      // Hugging its words: its lines are its own, so it gets the whole cell instead of a column cut
      // to the canvas width (a wider inbox font would break "1050 Post St" in two there).
      const textAlign = t.align === 'left' || t.align === 'justify' ? place.align : t.align;
      if (multiLine && textAlign !== place.align) {
        // Lines centred on each other inside a block that sits left (or right): a table that
        // shrinks to the words keeps both.
        const tbl = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${place.align !== 'left' ? ` align="${place.align}"` : ''}><tr><td ${attrs.length ? attrs.join(' ') + ' ' : ''}style="${style.join(';')}">${content}</td></tr></table>`;
        return this.tdOpen(place) + tbl + '</td>';
      }
      const s = style.filter((x) => !x.startsWith('text-align'));
      if (textAlign !== 'left') s.push(`text-align:${textAlign}`);
      return this.tdOpen(place, s, attrs) + content + '</td>';
    }
    if (!place.full && multiLine) {
      // Narrower than its column and wrapping: pin its width so it wraps like the canvas.
      const w = r(b.w);
      const tbl = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${w}"${place.align !== 'left' ? ` align="${place.align}"` : ''} style="width:${w}px;max-width:100%"><tr><td ${attrs.length ? attrs.join(' ') + ' ' : ''}style="${style.join(';')}">${content}</td></tr></table>`;
      return this.tdOpen(place) + tbl + '</td>';
    }
    return this.tdOpen(place, style, attrs) + content + '</td>';
  }

  rectCell(n: ShapeNode, b: Box, env: Env, place: Place): string {
    this.generic(n, env);
    const { color, gradient } = this.paintColor(n.fill, env.bg, n.opacity, parseNameTags(n.name).clean);
    const c = color ?? env.bg;
    const h = r(b.h);
    const w = r(b.w);
    const fx: string[] = [`background-color:${c}`];
    if (gradient) fx.push(`background-image:${gradient}`);
    if (n.radius > 0) fx.push(`border-radius:${r(n.radius)}px`);
    if (n.stroke && n.strokeWidth > 0) fx.push(`border:${r(n.strokeWidth)}px solid ${flatten(n.stroke, c)}`);
    const solid = `font-size:0;line-height:0;mso-line-height-rule:exactly${place.stretch ? '' : `;height:${h}px`}`;
    if (place.full && place.pad.every((p) => p === 0) && !n.radius && !(n.stroke && n.strokeWidth > 0)) {
      // The td itself is the rectangle (e.g. a rule or a column of colour in a row).
      return this.tdOpen({ ...place, bgcolor: c, heightAttr: place.heightAttr ?? (place.stretch ? undefined : h) }, [solid, ...(gradient ? [`background-image:${gradient}`] : [])]) + '&nbsp;</td>';
    }
    const width = place.full ? '100%' : String(w);
    const tbl = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${width}"${place.align !== 'left' ? ` align="${place.align}"` : ''}${place.full ? '' : ` style="width:${w}px;max-width:100%"`}><tr><td height="${h}" bgcolor="${c}" style="${[solid, ...fx].join(';')}">&nbsp;</td></tr></table>`;
    return this.tdOpen(place) + tbl + '</td>';
  }

  // ----- images -----

  addImage(n: SceneNode, b: Box, env: Env, rasterize: boolean): EmailImage {
    const tags = parseNameTags(n.name);
    const idx = this.images.length + 1;
    let format: EmailImageFormat = 'jpeg';
    if (n.type === 'image') {
      const mime = n.assetId ? getAsset(n.assetId)?.meta.mime ?? '' : '';
      if (/png|gif/i.test(mime) || needsLossless(n)) format = 'png';
      if (!n.assetId) this.emptyPhotos.push(tags.clean || 'Photo');
    } else if (n.type === 'frame') {
      let hasPhoto = false;
      let lossless = false;
      const scan = (x: SceneNode) => {
        if (x.type === 'image') {
          hasPhoto = true;
          lossless ||= needsLossless(x);
        }
        if (x.type === 'frame') x.children.forEach(scan);
      };
      scan(n);
      format = hasPhoto && !lossless ? 'jpeg' : 'png';
    } else format = 'png';
    let alt = tags.alt ?? tags.clean.replace(/^section\s*\/\s*/i, '');
    const generic = /^(photo|image|picture|frame|ellipse|rectangle|group)( ?\d+)?$/i.test(alt) || !alt;
    if (generic && n.type === 'image') {
      this.warn(`A photo has no alt text (layer “${tags.clean || 'Photo'}”). Rename the layer to describe what's in it, e.g. “Sunny living room with bay windows”.`, 'alt:' + n.id);
    }
    if (generic) alt = '';
    const ext = format === 'png' ? 'png' : 'jpg';
    const base = slug(tags.clean) || (n.type === 'image' ? 'photo' : n.type);
    const fileName = `${String(idx).padStart(2, '0')}-${base}.${ext}`;
    const href = this.hrefFor(n, env) ?? undefined;
    const img: EmailImage = { nodeId: n.id, fileName, alt, width: r(b.w), height: r(b.h), format, matte: env.bg, rasterize: rasterize || undefined, href };
    this.images.push(img);
    return img;
  }

  img(im: EmailImage, b: Box, env: Env, place: Place, href: string | null): string {
    const url = this.opts.imageUrl(im.nodeId, im.fileName);
    const margin = place.align === 'center' ? ';margin:0 auto' : place.align === 'right' ? ';margin:0 0 0 auto' : '';
    const edge = this.edgeNodes.has(im.nodeId);
    if (edge) this.usesEdge = true;
    const cls = edge ? ' class="es-img es-bleed"' : im.width >= 160 ? ' class="es-img"' : '';
    // With images off the alt text takes this type, so it stays readable on dark sections.
    const ink = altInk(env.bg);
    const altType = `font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:${ink}`;
    let tag = this.opts.imagesOff
      ? `<div${edge ? ' class="es-bleed"' : ''} style="box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;max-width:${im.width}px;aspect-ratio:${im.width}/${Math.max(1, im.height)};overflow:hidden;padding:4px;text-align:center;border:1px dashed ${flatten(ink + '66', env.bg)};${altType}${margin}">${escapeHtml(im.alt)}</div>`
      : `<img src="${escAttr(url)}" width="${im.width}" height="${im.height}" alt="${escapeHtml(im.alt)}"${cls} style="display:block;width:100%;max-width:${im.width}px;height:auto;border:0;outline:none;text-decoration:none;${altType}${margin}">`;
    if (href) {
      this.noteHref(href, im.alt);
      tag = `<a href="${escAttr(href)}" target="_blank" style="text-decoration:none">${tag}</a>`;
    }
    return tag;
  }

  // ----- buttons -----

  buttonParts(f: FrameNode): { text: TextNode; bg: Paint | null; radius: number; stroke: string | null; strokeWidth: number } | null {
    const tags = parseNameTags(f.name);
    const kids = f.children.filter((c) => c.visible);
    const texts = kids.filter((c): c is TextNode => c.type === 'text');
    const rects = kids.filter((c): c is ShapeNode => c.type === 'rect');
    const named = tags.flags.has('button') || /^(button|cta button|btn)\b/i.test(tags.clean);
    // Free-positioned "rect + label" is the classic hand-made button.
    if (f.layout === 'none' && texts.length === 1 && rects.length === 1 && kids.length === 2) {
      const rb = this.layout.get(rects[0].id);
      if (rb && rb.w >= f.w * 0.9 - 1 && rb.h >= f.h * 0.9 - 1) {
        return { text: texts[0], bg: rects[0].fill, radius: rects[0].radius, stroke: rects[0].stroke, strokeWidth: rects[0].strokeWidth };
      }
    }
    if (f.layout !== 'none' && texts.length === 1 && kids.length === 1) {
      const linked = !!this.ownHref(f);
      if (named || (linked && f.fill)) return { text: texts[0], bg: f.fill, radius: f.radius, stroke: f.stroke, strokeWidth: f.strokeWidth };
    }
    if (named) {
      // Named a button but built differently (icon + label?): use its first text.
      const first = (function find(list: SceneNode[]): TextNode | null {
        for (const c of list) {
          if (!c.visible) continue;
          if (c.type === 'text') return c;
          if (c.type === 'frame') {
            const t = find(c.children);
            if (t) return t;
          }
        }
        return null;
      })(kids);
      if (first && f.layout !== 'none' && kids.length === 1) return { text: first, bg: f.fill, radius: f.radius, stroke: f.stroke, strokeWidth: f.strokeWidth };
    }
    return null;
  }

  button(f: FrameNode, b: Box, env: Env, place: Place, parts: NonNullable<ReturnType<Compiler['buttonParts']>>): string {
    const tags = parseNameTags(f.name);
    let href = this.ownHref(f) ?? this.ownHref(parts.text) ?? env.href;
    if (!href) {
      this.warn(`Button “${parts.text.text.trim() || tags.clean}” has no link. Select it and add one in the Link section.`, 'btnhref:' + f.id);
      href = '#';
    }
    this.noteHref(href, parts.text.text);
    const { color: bg } = this.paintColor(parts.bg, env.bg, f.opacity, tags.clean);
    const fill = bg ?? env.bg;
    const tb = this.layout.get(parts.text.id);
    let pad: [number, number, number, number];
    if (f.layout === 'none' && tb) pad = [r(tb.y), r(b.w - tb.x - tb.w), r(b.h - tb.y - tb.h), r(tb.x)];
    else pad = [r(f.padding.t), r(f.padding.r), r(f.padding.b), r(f.padding.l)];
    const padCss = `${pad[0]}px ${pad[1]}px ${pad[2]}px ${pad[3]}px`;
    const full = place.full && b.w >= place.avail - 1 && place.avail > 0 && f.sizingH !== 'hug';
    const radius = parts.radius > 0 ? r(parts.radius) : 0;
    const textStyle = this.textStyle(parts.text, { ...env, bg: fill }).filter((s) => !s.startsWith('text-decoration'));
    const axis = f.layout === 'row' ? f.justify : f.alignItems;
    const textAlign = f.layout === 'none' ? 'center' : axis === 'start' ? 'left' : axis === 'end' ? 'right' : 'center';
    const border = parts.stroke && parts.strokeWidth > 0 ? `;border:${r(parts.strokeWidth)}px solid ${flatten(parts.stroke, fill)}` : '';
    const radiusCss = radius ? `;border-radius:${radius}px` : '';
    const aStyle = [
      `display:${full ? 'block' : 'inline-block'}`,
      `padding:${padCss}`,
      'mso-padding-alt:0',
      ...textStyle,
      `text-align:${textAlign}`,
      'text-decoration:' + (parts.text.decoration === 'none' ? 'none' : parts.text.decoration),
    ].join(';');
    const tableAttrs = `role="presentation" cellpadding="0" cellspacing="0" border="0"${full ? ' width="100%"' : ''}${place.align !== 'left' ? ` align="${place.align}"` : ''}`;
    const tdAttrs = `align="${textAlign}" bgcolor="${fill}" style="background-color:${fill}${radiusCss}${border};mso-padding-alt:${padCss}"`;
    return `<table ${tableAttrs} style="border-collapse:separate${full ? ';width:100%' : ''}"><tr><td ${tdAttrs}><a href="${escAttr(href)}" target="_blank" style="${aStyle}${radiusCss}">${this.textHtml(parts.text)}</a></td></tr></table>`;
  }
}

// ---------- document ----------

function mobileCss(c: Compiler, bp: number): string {
  const gaps = [...c.gapClasses]
    .sort((a, b) => a - b)
    .map((g) => `.es-gt${g}{padding-top:${g}px!important}`)
    .join('');
  const sides = (side: 'l' | 'r') =>
    [...c.padClasses[side]]
      .sort((a, b) => a - b)
      .map((v) => `.es-p${side}${v}{padding-${side === 'l' ? 'left' : 'right'}:${v}px!important}`)
      .join('');
  // Full width on phones: the cells on the way drop their side padding (es-edge), the cells
  // beside them take it back (es-pl / es-pr), and the picture fills what's left (es-bleed).
  const edge = c.usesEdge
    ? `.es-edge{padding-left:0!important;padding-right:0!important}` + sides('l') + sides('r') + `.es-bleed{width:100%!important;max-width:100%!important;height:auto!important}`
    : '';
  return (
    `@media only screen and (max-width:${bp}px){` +
    `.es-wrap{width:100%!important;max-width:100%!important}` +
    `.es-col{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;white-space:normal!important}` +
    `.es-spc{display:none!important;width:0!important;max-width:0!important;overflow:hidden!important}` +
    gaps +
    `.es-col .es-full{width:100%!important}` +
    `.es-img{width:100%!important;height:auto!important}` +
    edge +
    `}`
  );
}

function preheaderHtml(text: string, bg: string): string {
  if (!text.trim()) return '';
  // Pad with invisible joiners so clients don't pull body copy into the preview.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${bg}">${escapeHtml(text)}${filler}</div>\n`;
}

/**
 * Compiles an email root (normally one auto-layout column frame, 600 wide) to HTML.
 * `layout` must cover every node in `root` (computeLayout([root]) is enough).
 */
export function buildEmailHtml(root: FrameNode | SceneNode[], layout: LayoutMap, opts: EmailHtmlOptions): EmailHtmlResult {
  const c = new Compiler(layout, opts);
  const tops = (Array.isArray(root) ? root : [root]).filter((n) => n.visible);
  const single = tops.length === 1 ? tops[0] : null;
  const rootFrame = single && single.type === 'frame' ? single : null;
  const rootBox = single ? layout.get(single.id) : null;
  const width = r(Math.max(0, ...tops.map((n) => layout.get(n.id)?.w ?? 0)) || 600);
  const rootFill = rootFrame?.fill?.kind === 'solid' ? flatten(rootFrame.fill.color, '#FFFFFF') : rootFrame?.fill?.kind === 'linear' || rootFrame?.fill?.kind === 'radial' ? flatten(rootFrame.fill.from, '#FFFFFF') : rootFrame?.fill?.kind === 'mesh' ? flatten(rootFrame.fill.points[0].color, '#FFFFFF') : null;
  const bodyBg = flatten(opts.bodyBackground ?? rootFill ?? '#FFFFFF', '#FFFFFF');
  const env: Env = { bg: bodyBg, href: null, stacked: false };
  c.markBleed(tops);

  if (width > 640) c.warn(`The email is ${width}px wide. Keep it at 600px; wider emails get scaled down or scroll sideways in many clients.`);
  if (!tops.length) c.warn('Nothing to export: the email is empty.');

  let content: string;
  if (rootFrame && rootBox && rootFrame.layout !== 'none' && !parseNameTags(rootFrame.name).flags.has('raster')) {
    content = c.frameTable(rootFrame, rootBox, env, 'full');
  } else {
    // Several top-level layers (or a free-positioned root): stack them by position.
    const sorted = [...tops].sort((a, b) => (layout.get(a.id)?.y ?? 0) - (layout.get(b.id)?.y ?? 0));
    const rows = sorted
      .map((n) => {
        const b = c.box(n);
        if (!b) return '';
        const full = b.w >= width - 1;
        return `<tr>${c.cell(n, b, env, { pad: [0, 0, 0, 0], align: 'left', valign: 'top', classes: [], full, avail: width })}</tr>`;
      })
      .join('\n');
    content = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">\n${rows}\n</table>`;
    if (tops.length > 1) c.warn('The email has several top-level layers. Put everything inside one auto-layout column frame so sections stack predictably.');
  }

  // ----- checks -----
  if (c.emptyPhotos.length) {
    const counts = new Map<string, number>();
    for (const n of c.emptyPhotos) counts.set(n, (counts.get(n) ?? 0) + 1);
    const list = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
    c.warn(`${c.emptyPhotos.length} empty photo placeholder${c.emptyPhotos.length === 1 ? '' : 's'} (${list}). Drop photos in before exporting; they'll export as grey blocks.`);
  }
  const nonSafe = [...c.fonts].filter((f) => !WEB_SAFE.test(f));
  if (nonSafe.length)
    c.warn(
      `${nonSafe.map((f) => f.replace(/\s+Variable$/i, '')).join(', ')} ${nonSafe.length === 1 ? "isn't" : "aren't"} installed on most phones and laptops, so inboxes will show the fallback (Arial or Georgia). Line breaks may shift. Use Arial or Georgia for an exact match.`,
    );
  const badHref = c.hrefs.filter((h) => h === '#' || !h.trim());
  if (badHref.length) c.warn(`${badHref.length} link${badHref.length === 1 ? ' goes' : 's go'} nowhere (“#”). Every link needs a real URL.`);
  const driveLinks = c.hrefs.filter((h) => /drive\.google\.com|docs\.google\.com|\bbox\.com|dropbox\.com/i.test(h));
  if (driveLinks.length) c.warn('Some links point at Drive/Box/Dropbox share pages. Check they open without a sign-in.');
  if (!c.hasUnsubscribe) c.warn('No unsubscribe link found. Bulk senders require an unsubscribe link and the mailing address in the footer.');

  const bp = opts.breakpoint ?? 600;
  const lang = opts.lang ?? 'en';
  const scheme = opts.colorScheme ?? 'light';
  const head = [
    '<!DOCTYPE html>',
    `<html lang="${escAttr(lang)}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">',
    `<meta name="color-scheme" content="${scheme}">`,
    `<meta name="supported-color-schemes" content="${scheme}">`,
    `<title>${escapeHtml(opts.title || 'Email')}</title>`,
    '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->',
    '<style>',
    `:root{color-scheme:${scheme};supported-color-schemes:${scheme}}` +
      'html,body{margin:0!important;padding:0!important;width:100%!important}' +
      'body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}' +
      'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}' +
      'table{border-collapse:collapse}' +
      'img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}' +
      'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}' +
      'u+#body a{color:inherit;text-decoration:none;font-size:inherit;font-family:inherit;font-weight:inherit;line-height:inherit}',
    mobileCss(c, bp),
    '</style>',
    '</head>',
  ].join('\n');

  const body = [
    `<body id="body" style="margin:0;padding:0;width:100%;background-color:${bodyBg}" bgcolor="${bodyBg}">`,
    preheaderHtml(opts.preheader ?? '', bodyBg) +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${bodyBg}" style="background-color:${bodyBg}"><tr><td align="center" valign="top">`,
    `<!--[if mso]><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="${width}"><tr><td><![endif]-->`,
    `<div class="es-wrap" style="max-width:${width}px;margin:0 auto">`,
    content,
    '</div>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');

  const html = head + '\n' + body + '\n';
  const tokens = [...new Set(html.match(/\{\{\s*[\w.-]+\s*\}\}/g) ?? [])];
  if (tokens.length) {
    const more = tokens.length - 3;
    c.warn(`${tokens.length} placeholder${tokens.length === 1 ? '' : 's'} still to fill: ${tokens.slice(0, 3).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`);
  }
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > GMAIL_CLIP_BYTES) c.warn(`The HTML is ${(bytes / 1024).toFixed(1)} KB. Gmail clips emails over about 102 KB, hiding the footer and unsubscribe link. Cut a section or simplify.`);
  return { html, images: c.images, warnings: c.warnings, placeholders: tokens, bytes, fonts: [...c.fonts], twoAcross: c.twoAcross };
}

/** The pictures an email will reference (same names buildEmailHtml would give them). */
export function collectEmailImages(root: FrameNode | SceneNode[], layout: LayoutMap): EmailImage[] {
  return buildEmailHtml(root, layout, { title: '', imageUrl: (_id, f) => f }).images;
}

/** Joins a base folder URL and a file name ("https://x/y" + "a.jpg" → "https://x/y/a.jpg"). */
export function joinUrl(base: string, fileName: string): string {
  const b = base.trim();
  if (!b) return fileName;
  return (b.endsWith('/') ? b : b + '/') + encodeURIComponent(fileName).replace(/%2F/g, '/');
}
