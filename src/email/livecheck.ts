import { create } from 'zustand';
import type { LayoutMap } from '../layout';
import { native, type HostingAnswer, type LiveCheckAnswer } from '../platform';
import { findNode } from '../tree';
import type { Doc, FrameNode } from '../types';
import { buildEmailHtml, collectEmailImages } from './html';
import { pictureSources, pictureSrc, picturesToRender, refreshWordPress, renderedNames } from './hosting';
import { renderEmailImages } from './images';
import { compareCard, emailLinks, layerLabel, pageFacts, ratioName, shapeGap, shapeKept } from './livematch';

// The send checklist's live check, run on demand (a button in the checklist, or spread_send_check
// with live: true), never in the background. It does by machine what used to be done by hand with
// curl before a send:
//   Pictures     every <img> address in the compiled email loads and is a picture
//   Links        every web link opens, and a listing card's link goes to that listing
//   Photo shapes a photo isn't cut down a lot by its frame, and a picture hosted elsewhere has its
//                frame's shape (inboxes show the file as it is, not the canvas crop)
// Addresses are loaded by the desktop app's main process (electron/livecheck.cjs), six at a time.
// Only addresses in the email itself are loaded, and links without their tracking tags, so the
// check doesn't count as a click in the campaign's numbers.

export type LiveGroup = 'pictures' | 'links' | 'shapes';
export type LiveLevel = 'ok' | 'note' | 'fix';

export interface LiveItem {
  group: LiveGroup;
  level: LiveLevel;
  /** The layer it's about (selectable on the canvas). */
  nodeId: string | null;
  name: string;
  title: string;
  url?: string;
}

export interface LiveCounts {
  pictures: { checked: number; loaded: number; broken: number; notOnWeb: number };
  links: { checked: number; open: number; broken: number; blocked: number; cards: number; match: number; mismatch: number; unknown: number };
  shapes: { checked: number; fine: number; cropped: number; wrongShape: number };
}

export interface LiveResult {
  boardId: string;
  at: number;
  items: LiveItem[];
  counts: LiveCounts;
  /** One line per group: "12 pictures load, 1 broken". */
  summary: Record<LiveGroup, string>;
}

const CONCURRENCY = 6;
/** Below this share of the photo showing, the frame's shape is cutting a lot away. */
const KEEP_MIN = 0.75;
/** Shapes this close count as the same (rounding in exported sizes). */
const SAME_SHAPE = 0.025;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * Every picture with the address it gets in the HTML, from the same resolver export uses. A folder
 * address needs the exported (hashed) file names, so those pictures are rendered first, as export does.
 */
async function pictureAddresses(doc: Doc, root: FrameNode, layout: LayoutMap) {
  const sources = pictureSources(doc, {}, await refreshWordPress());
  const base = sources.hosting.mode === 'base' && sources.hosting.baseUrl?.trim();
  const toRender = picturesToRender(sources, collectEmailImages(root, layout));
  if (base && toRender.length) sources.files = renderedNames(await renderEmailImages(root, layout, toRender, 2));
  const src = new Map<string, string>();
  const { images } = buildEmailHtml(root, layout, {
    title: '',
    tracking: doc.email?.tracking,
    imageUrl: (nodeId, fileName) => {
      const url = pictureSrc(sources, nodeId, fileName);
      src.set(nodeId, url);
      return url;
    },
  });
  return { wordpress: sources.hosting.mode === 'wordpress', pictures: images.map((im) => ({ im, src: src.get(im.nodeId) ?? im.fileName })) };
}

type Answer = HostingAnswer<LiveCheckAnswer>;

/** "No answer after 8 seconds." → "no answer after 8 seconds", to follow a colon. */
const reason = (e: string) => e.replace(/\.$/, '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

function pictureProblem(a: Answer): string | null {
  if (!a.ok) return `Didn’t load: ${reason(a.error)}.`;
  if (a.status === 401 || a.status === 403) return `Didn’t load (${a.status}): the address isn’t public, so inboxes can’t show it.`;
  if (a.status === 404 || a.status === 410) return `Didn’t load (${a.status}): nothing is at that address.`;
  if (a.status < 200 || a.status > 299) return `Didn’t load: the server answered ${a.status}.`;
  if (/html/.test(a.type)) return `It’s a web page, not a picture${a.title ? ` (“${a.title.slice(0, 60)}”)` : ''}. Often a login or share page.`;
  if (!a.type.startsWith('image/')) return `It isn’t a picture (the server says ${a.type || 'nothing'}).`;
  if (a.bytes === 0) return 'The picture is empty.';
  return null;
}

function linkProblem(a: Answer): { level: LiveLevel; title: string } | null {
  if (!a.ok) return { level: 'fix', title: `Doesn’t open: ${reason(a.error)}.` };
  if (a.status === 404 || a.status === 410) return { level: 'fix', title: `Page not found (${a.status}).` };
  // Many sites turn away anything that isn't a person in a browser; that says nothing about readers.
  if (a.status === 401 || a.status === 403 || a.status === 429) return { level: 'note', title: `The site wouldn’t let Spread look (${a.status}). Open it yourself to be sure.` };
  if (a.status >= 500) return { level: 'fix', title: `The site answered with an error (${a.status}).` };
  if (a.status < 200 || a.status > 299) return { level: 'note', title: `The site answered ${a.status}.` };
  return null;
}

function summarise(c: LiveCounts): Record<LiveGroup, string> {
  const p = c.pictures;
  const pictures = !p.checked
    ? 'No pictures'
    : [plural(p.loaded, 'picture loads', 'pictures load'), p.broken && `${p.broken} broken`, p.notOnWeb && `${p.notOnWeb} not on the web yet`].filter(Boolean).join(', ');
  const l = c.links;
  const linkPart = !l.checked
    ? 'No web links'
    : [plural(l.open, 'link opens', 'links open'), l.broken && `${l.broken} ${l.broken === 1 ? 'doesn’t' : 'don’t'}`, l.blocked && `${l.blocked} couldn’t be checked`].filter(Boolean).join(', ');
  const told = l.match + l.mismatch;
  const cardPart = told ? `${plural(l.match, 'card matches its page', 'cards match their pages')}${l.mismatch ? `, ${l.mismatch} ${l.mismatch === 1 ? 'doesn’t' : 'don’t'}` : ''}` : '';
  const s = c.shapes;
  const shapes = !s.checked
    ? 'No photos'
    : [plural(s.fine, 'photo fits its frame', 'photos fit their frames'), s.wrongShape && `${s.wrongShape} won’t keep ${s.wrongShape === 1 ? 'its' : 'their'} shape in inboxes`, s.cropped && `${s.cropped} cut down a lot`].filter(Boolean).join(', ');
  return { pictures, links: cardPart ? `${linkPart} · ${cardPart}` : linkPart, shapes };
}

async function load(url: string, kind: 'image' | 'page'): Promise<Answer> {
  try {
    return await native!.liveCheckUrl({ url, kind });
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? String(e) };
  }
}

/** Runs the whole check on one email board. */
export async function liveCheck(doc: Doc, root: FrameNode, layout: LayoutMap, onProgress?: (done: number, total: number) => void): Promise<LiveResult> {
  if (!native) throw new Error('The live check needs the Spread desktop app');
  const items: LiveItem[] = [];
  const counts: LiveCounts = {
    pictures: { checked: 0, loaded: 0, broken: 0, notOnWeb: 0 },
    links: { checked: 0, open: 0, broken: 0, blocked: 0, cards: 0, match: 0, mismatch: 0, unknown: 0 },
    shapes: { checked: 0, fine: 0, cropped: 0, wrongShape: 0 },
  };
  const nodes = [root];
  const nameOf = (id: string, fallback: string) => {
    const n = findNode(nodes, id);
    return n ? layerLabel(n, fallback) : fallback;
  };

  // What to load: each picture address and each web link, once however often they appear.
  const { pictures, wordpress } = await pictureAddresses(doc, root, layout);
  const { links, cards } = emailLinks(root);
  const imageUrls = [...new Set(pictures.map((p) => p.src).filter((u) => /^https?:\/\//i.test(u)))];
  const pageUrls = [...new Set(links.map((l) => l.url))];
  const total = imageUrls.length + pageUrls.length;
  let done = 0;
  onProgress?.(0, total);
  const tick = <T,>(p: Promise<T>) => p.finally(() => onProgress?.(++done, total));
  const answers = new Map<string, Answer>();
  await pool(
    [
      ...imageUrls.map((u) => () => tick(load(u, 'image')).then((a) => void answers.set(`image ${u}`, a))),
      ...pageUrls.map((u) => () => tick(load(u, 'page')).then((a) => void answers.set(`page ${u}`, a))),
    ],
    CONCURRENCY,
  );

  // ---- pictures, and the shape of each photo ----
  for (const { im, src } of pictures) {
    const n = findNode(nodes, im.nodeId);
    const name = nameOf(im.nodeId, 'Picture');
    counts.pictures.checked++;
    let hostedShape: { width: number; height: number } | null = null;
    if (!/^https?:\/\//i.test(src)) {
      counts.pictures.notOnWeb++;
      items.push(
        wordpress
          ? { group: 'pictures', level: 'note', nodeId: im.nodeId, name, title: 'Not uploaded yet. Spread puts it on WordPress when you export the email; check again after.' }
          : { group: 'pictures', level: 'fix', nodeId: im.nodeId, name, title: `Not on the web yet: the address is only a file name (${src.slice(0, 60)}). Set where the pictures live, then check again.` },
      );
    } else {
      const a = answers.get(`image ${src}`)!;
      const problem = pictureProblem(a);
      if (problem) {
        counts.pictures.broken++;
        items.push({ group: 'pictures', level: 'fix', nodeId: im.nodeId, name, title: problem, url: src });
      } else {
        counts.pictures.loaded++;
        const ok = a as LiveCheckAnswer;
        if (ok.width && ok.height) hostedShape = { width: ok.width, height: ok.height };
        const plain = /^http:\/\//i.test(src);
        items.push({
          group: 'pictures',
          level: plain ? 'note' : 'ok',
          nodeId: im.nodeId,
          name,
          title: plain ? 'Loads, but over http://. Many inboxes block plain http pictures; use https://.' : `Loads${hostedShape ? ` (${hostedShape.width}×${hostedShape.height})` : ''}.`,
          url: src,
        });
      }
    }

    if (n?.type !== 'image' || im.rasterize) continue;
    counts.shapes.checked++;
    // A hosted picture is shown as the file is, so its shape has to be its frame's.
    if (hostedShape && shapeGap(hostedShape.width, hostedShape.height, im.width, im.height) > SAME_SHAPE) {
      counts.shapes.wrongShape++;
      items.push({
        group: 'shapes',
        level: 'fix',
        nodeId: im.nodeId,
        name,
        title: `The picture at its address is ${ratioName(hostedShape.width, hostedShape.height)} but its frame is ${ratioName(im.width, im.height)}. Inboxes show the whole file, not the canvas crop, so the card changes shape (Outlook stretches it). Use Spread’s exported picture, or crop the file to ${ratioName(im.width, im.height)}.`,
        url: src,
      });
      continue;
    }
    const meta = n.assetId ? doc.assets[n.assetId] : undefined;
    if (meta?.width && meta.height && n.fit === 'fill') {
      const kept = shapeKept(meta.width, meta.height, im.width, im.height);
      if (kept < KEEP_MIN) {
        counts.shapes.cropped++;
        items.push({
          group: 'shapes',
          level: 'note',
          nodeId: im.nodeId,
          name,
          title: `Only ${Math.round(kept * 100)}% of the photo shows: it’s ${ratioName(meta.width, meta.height)} and its frame is ${ratioName(im.width, im.height)}. Check nothing important is cut off.`,
        });
        continue;
      }
    }
    counts.shapes.fine++;
    items.push({ group: 'shapes', level: 'ok', nodeId: im.nodeId, name, title: 'Fits its frame.' });
  }

  // ---- links, and whether each listing card's link goes to that listing ----
  const pages = new Map<string, ReturnType<typeof pageFacts> | null>();
  for (const url of pageUrls) {
    const a = answers.get(`page ${url}`)!;
    const first = links.find((l) => l.url === url)!;
    const name = nameOf(first.id, 'Link');
    counts.links.checked++;
    const problem = linkProblem(a);
    if (problem) {
      if (problem.level === 'fix') counts.links.broken++;
      else counts.links.blocked++;
      items.push({ group: 'links', level: problem.level, nodeId: first.id, name, title: problem.title, url });
      pages.set(url, null);
      continue;
    }
    counts.links.open++;
    const ok = a as LiveCheckAnswer;
    pages.set(url, ok.html ? pageFacts(ok.html, ok.finalUrl || url) : null);
    items.push({ group: 'links', level: 'ok', nodeId: first.id, name, title: ok.redirected && ok.finalUrl ? `Opens (goes on to ${shortUrl(ok.finalUrl).slice(0, 60)}).` : 'Opens.', url });
  }
  for (const card of cards) {
    const page = pages.get(card.url);
    if (!page) continue;
    counts.links.cards++;
    const v = compareCard(card.text, page);
    if (v.verdict === 'mismatch') {
      counts.links.mismatch++;
      items.push({ group: 'links', level: 'fix', nodeId: card.cardId, name: card.name, title: v.detail, url: card.url });
    } else if (v.verdict === 'match') {
      counts.links.match++;
      items.push({ group: 'links', level: 'ok', nodeId: card.cardId, name: card.name, title: 'Its link goes to the same listing.', url: card.url });
    } else counts.links.unknown++;
  }

  return { boardId: doc.id, at: Date.now(), items, counts, summary: summarise(counts) };
}

// ---------- remembered results, shared by the checklist and Claude ----------

export interface LiveEntry {
  /** The board as it was checked. Results stand until it changes. */
  doc: Doc;
  result: LiveResult | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

interface LiveState {
  byBoard: Record<string, LiveEntry>;
}

export const useLiveCheck = create<LiveState>(() => ({ byBoard: {} }));

const running = new Map<string, Promise<LiveResult>>();

function put(boardId: string, patch: Partial<LiveEntry> & { doc: Doc }) {
  useLiveCheck.setState((s) => {
    const prev: Omit<LiveEntry, 'doc'> = s.byBoard[boardId] ?? { result: null, progress: null, error: null };
    return { byBoard: { ...s.byBoard, [boardId]: { ...prev, ...patch } } };
  });
}

/** Starts a live check of the board (or joins the one already running) and remembers the result. */
export function startLiveCheck(doc: Doc, root: FrameNode, layout: LayoutMap): Promise<LiveResult> {
  const now = running.get(doc.id);
  if (now) return now;
  put(doc.id, { doc, result: null, error: null, progress: { done: 0, total: 0 } });
  const p = liveCheck(doc, root, layout, (done, total) => put(doc.id, { doc, progress: { done, total } }))
    .then((result) => {
      put(doc.id, { doc, result, progress: null });
      return result;
    })
    .catch((e: Error) => {
      put(doc.id, { doc, progress: null, error: e.message ?? String(e) });
      throw e;
    })
    .finally(() => running.delete(doc.id));
  running.set(doc.id, p);
  return p;
}

/** The check's findings in a compact form for Claude: counts, the one-line summaries, and only what needs a look. */
export function compactLive(r: LiveResult) {
  return {
    ready: !r.items.some((i) => i.level === 'fix'),
    summary: r.summary,
    counts: r.counts,
    problems: r.items.filter((i) => i.level !== 'ok').map(({ group, level, nodeId, name, title, url }) => ({ group, level, nodeId, name, title, ...(url ? { url } : {}) })),
  };
}
