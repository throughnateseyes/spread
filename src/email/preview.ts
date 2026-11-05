import type { FrameNode, SceneNode } from '../types';
import type { LayoutMap } from '../layout';
import { findNode, walk } from '../tree';
import { buildEmailHtml, defaultFontStack, fallbackStack, isWebSafe, parseNameTags, type EmailImage } from './html';

// The inbox preview: compiles an email the way one inbox setup would show it, measures the
// result in a real browser layout, and turns that into a short list of things to check.
// It uses the same compiler as export, so what it shows is the HTML that ships. It is one
// browser engine, not Outlook or Gmail themselves.

/** Wider than the compiler's 600px breakpoint, so desktop really gets the desktop layout. */
export const DESKTOP_W = 640;
export const PHONE_W = 375;
/** About what a phone's inbox list shows of a subject before it cuts off. */
export const PHONE_SUBJECT_CHARS = 38;

export type InboxDevice = 'desktop' | 'mobile';
export type InboxFonts = 'fallback' | 'design';

export interface InboxView {
  device: InboxDevice;
  fonts: InboxFonts;
  images: boolean;
}

export interface InboxSource {
  root: FrameNode;
  layout: LayoutMap;
  title: string;
  preheader: string;
  tracking?: string;
  /** Rendered pictures by node id. Anything missing falls back to `imageUrl`, then its file name. */
  pictures: Record<string, string>;
  imageUrl?: (nodeId: string, fileName: string) => string;
}

export const viewWidth = (device: InboxDevice) => (device === 'desktop' ? DESKTOP_W : PHONE_W);

const designStack = (family: string) => `'${family.replace(/'/g, '')}', ${defaultFontStack(family)}`;

export function inboxHtml(src: InboxSource, view: InboxView, fontCss = ''): string {
  const { html } = buildEmailHtml(src.root, src.layout, {
    title: src.title,
    preheader: src.preheader,
    tracking: src.tracking,
    imageUrl: (id, file) => src.pictures[id] ?? src.imageUrl?.(id, file) ?? file,
    imagesOff: !view.images,
    fontStack: view.fonts === 'design' ? designStack : fallbackStack,
  });
  return view.fonts === 'design' && fontCss ? html.replace('<style>', () => `<style>${fontCss}\n`) : html;
}

/** Families the email uses that most inboxes won't have, with what shows instead. */
export function fontSwaps(fonts: string[]): { family: string; label: string; shows: string }[] {
  return fonts
    .filter((f) => !isWebSafe(f))
    .map((family) => ({
      family,
      label: family.replace(/\s+Variable$/i, ''),
      shows: fallbackStack(family).split(', ')[0].replace(/'/g, ''),
    }));
}

export interface Measure {
  height: number;
  /** How wide the content really is. Past the viewport means sideways scrolling. */
  width: number;
  /** A few words from what runs off the edge, when something does ('' when no text is to blame). */
  overflow: string | null;
}

export function measureDoc(doc: Document): Omit<Measure, 'overflow'> {
  return { height: Math.ceil(doc.body.getBoundingClientRect().height), width: doc.documentElement.scrollWidth };
}

/** The text holding the page open: hiding it brings the width in the most. Everything past the edge stretches with it, so position alone can't tell. */
function widestText(doc: Document, viewport: number): string {
  const page = doc.documentElement;
  const start = page.scrollWidth;
  let best = '';
  let most = 0;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('td,a,span'))) {
    const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent?.trim());
    if (!own || el.getBoundingClientRect().right <= viewport + 1) continue;
    const was = el.style.display;
    el.style.display = 'none';
    const saved = start - page.scrollWidth;
    el.style.display = was;
    if (saved > most) {
      most = saved;
      best = el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40) ?? '';
    }
  }
  return best;
}

/** Lays HTML out at a real viewport width in a hidden frame and reads the result. */
export function measureHtml(html: string, viewport: number): Promise<Measure> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const done = (fn: () => void) => {
      window.clearTimeout(timer);
      frame.remove();
      fn();
    };
    const timer = window.setTimeout(() => done(() => reject(new Error('The preview took too long to lay out.'))), 15000);
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${viewport}px;height:800px;border:0;opacity:0;pointer-events:none`;
    frame.onload = async () => {
      const doc = frame.contentDocument;
      if (!doc) return done(() => reject(new Error('The preview frame is not readable.')));
      void doc.body.offsetHeight; // layout starts the font loads that fonts.ready waits for
      await doc.fonts.ready;
      const m = measureDoc(doc);
      const overflow = m.width > viewport + 1 ? widestText(doc, viewport) : null;
      done(() => resolve({ ...m, overflow }));
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

export interface InboxMetrics {
  desktop: { fallback: Measure; design: Measure | null };
  mobile: { fallback: Measure; design: Measure | null };
}

/** Measures with picture boxes in place of pictures: same layout, none of the image weight. */
export async function inboxMetrics(src: InboxSource, fontCss: string, swapsFonts: boolean): Promise<InboxMetrics> {
  const at = (device: InboxDevice, fonts: InboxFonts) => measureHtml(inboxHtml(src, { device, fonts, images: false }, fontCss), viewWidth(device));
  return {
    desktop: { fallback: await at('desktop', 'fallback'), design: swapsFonts ? await at('desktop', 'design') : null },
    mobile: { fallback: await at('mobile', 'fallback'), design: swapsFonts ? await at('mobile', 'design') : null },
  };
}

/** The opening words, which is what an inbox shows when there's no preview text. */
export function firstWords(root: SceneNode, max = 90): string {
  const parts: string[] = [];
  walk([root], (n) => {
    if (n.type === 'text' && n.visible && n.text.trim()) parts.push(n.text.replace(/\s+/g, ' ').trim());
  });
  return parts.join(' ').slice(0, max);
}

export type CheckLevel = 'ok' | 'note' | 'fix';

export interface InboxCheck {
  id: 'phone' | 'fonts' | 'images' | 'row';
  level: CheckLevel;
  title: string;
  detail: string;
  /** The view that shows this. */
  view: Partial<InboxView>;
  /** Layers it's about, when that's known. */
  ids?: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function textIn(n: SceneNode): string {
  const out: string[] = [];
  walk([n], (x) => {
    if (x.type === 'text' && x.visible && x.text.trim()) out.push(x.text.trim());
  });
  return out.join(' ').replace(/\s+/g, ' ');
}

export function imagesCheck(root: FrameNode, images: EmailImage[]): InboxCheck {
  const view = { images: false };
  if (!images.length) return { id: 'images', level: 'ok', title: 'No pictures', detail: 'This email reads the same with images off.', view };
  // Pictures whose words vanish with the picture, unless the layer says them in its alt text.
  const flattened = images
    .filter((im) => im.rasterize)
    .map((im) => {
      const n = findNode([root], im.nodeId);
      return n && !parseNameTags(n.name).alt ? { id: im.nodeId, name: parseNameTags(n.name).clean || 'A frame', words: textIn(n) } : null;
    })
    .filter((x): x is { id: string; name: string; words: string } => !!x?.words);
  const blank = images.filter((im) => (!im.alt || /\{\{/.test(im.alt)) && (!im.rasterize || im.href));
  const deadLinks = blank.filter((im) => im.href).length;
  const lines: string[] = [];
  if (flattened.length) lines.push(`${flattened[0].name}${flattened.length > 1 ? ` and ${flattened.length - 1} more` : ''} ${flattened.length > 1 ? 'are pictures' : 'is a picture'}, so “${flattened[0].words.slice(0, 40)}” disappears. Add [alt:…] to the layer name or turn on auto layout.`);
  if (deadLinks) lines.push(`${plural(deadLinks, 'linked picture')} ${deadLinks === 1 ? 'has' : 'have'} no alt text, so there's nothing to click.`);
  if (blank.length > deadLinks) lines.push(`${plural(blank.length - deadLinks, 'picture')} ${blank.length - deadLinks === 1 ? 'has' : 'have'} no alt text. Rename the layer to describe it.`);
  if (!lines.length) return { id: 'images', level: 'ok', title: 'Reads with images off', detail: `${plural(images.length, 'picture')}, all covered by alt text or live text.`, view };
  const ids = [...new Set([...flattened.map((f) => f.id), ...blank.map((im) => im.nodeId)])];
  return { id: 'images', level: flattened.length || deadLinks ? 'fix' : 'note', title: 'Images off loses something', detail: lines.join(' '), view, ids };
}

function phoneCheck(m: Measure): InboxCheck {
  const view: Partial<InboxView> = { device: 'mobile' };
  if (m.overflow === null) return { id: 'phone', level: 'ok', title: 'Fits a phone', detail: `No sideways scrolling at ${PHONE_W}px.`, view };
  const what = m.overflow ? `“${m.overflow}” pushes` : 'Something pushes';
  return { id: 'phone', level: 'fix', title: 'Scrolls sideways on a phone', detail: `${what} it to ${m.width}px on a ${PHONE_W}px screen.`, view };
}

function fontsCheck(fonts: string[], metrics: InboxMetrics): InboxCheck {
  const view: Partial<InboxView> = { fonts: 'fallback' };
  const swaps = fontSwaps(fonts);
  if (!swaps.length) return { id: 'fonts', level: 'ok', title: 'Same fonts everywhere', detail: 'These fonts are on nearly every device.', view };
  const names = swaps.map((s) => `${s.label} shows as ${s.shows}`).join(', ');
  const delta = (d: { fallback: Measure; design: Measure | null }) => (d.design ? d.fallback.height - d.design.height : 0);
  const say = (n: number, where: string) => (n ? `${Math.abs(n)}px ${n > 0 ? 'taller' : 'shorter'} on ${where}` : '');
  const shift = [say(delta(metrics.desktop), 'desktop'), say(delta(metrics.mobile), 'phones')].filter(Boolean).join(', ');
  return {
    id: 'fonts',
    level: 'note',
    title: 'Most inboxes swap the font',
    detail: `${names}. ${shift ? `The email ends up ${shift}.` : 'The height stays the same.'}`,
    view,
  };
}

export function rowCheck(root: FrameNode, subject: string, preheader: string): InboxCheck {
  const view: Partial<InboxView> = {};
  const s = subject.trim();
  if (!s) return { id: 'row', level: 'fix', title: 'No subject', detail: 'Add one in the Inbox section.', view };
  if (/\{\{/.test(`${s} ${preheader}`)) return { id: 'row', level: 'fix', title: 'Inbox line has a placeholder', detail: 'Fill in the {{TOKEN}} in the subject or preview text.', view };
  if (!preheader.trim()) {
    const words = firstWords(root, 50);
    return { id: 'row', level: 'note', title: 'No preview text', detail: words ? `Inboxes will show the opening words instead: “${words}”.` : 'Inboxes will fill the line with whatever comes first.', view };
  }
  if (s.length > PHONE_SUBJECT_CHARS) return { id: 'row', level: 'note', title: 'Subject cuts off on phones', detail: `Phones show about ${PHONE_SUBJECT_CHARS} characters: “${s.slice(0, PHONE_SUBJECT_CHARS).trim()}…”`, view };
  return { id: 'row', level: 'ok', title: 'Inbox line looks right', detail: 'Subject and preview text both fit.', view };
}

export function inboxChecks(src: InboxSource, subject: string, images: EmailImage[], fonts: string[], metrics: InboxMetrics): InboxCheck[] {
  return [rowCheck(src.root, subject, src.preheader), phoneCheck(metrics.mobile.fallback), fontsCheck(fonts, metrics), imagesCheck(src.root, images)];
}
