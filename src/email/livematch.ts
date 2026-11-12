import { linkIssue, nodeLink } from '../links';
import type { FrameNode, SceneNode } from '../types';
import { parseNameTags } from './html';

// The reading half of the live check (livecheck.ts does the loading): which layers are listing
// cards and what they say, what a listing page says about itself, and whether the two agree.
// No DOM and no store, so it runs anywhere.
//
// It's built to be quiet: a card is only flagged when the page names a different unit or street
// number. A page that doesn't mention one at all is no evidence either way.

// ---------- units and street addresses in text ----------

export interface Mention {
  /** Normalised for comparing: "403", "12B", "450 main". */
  key: string;
  /** As written, for messages: "Unit 403", "#403", "450 Main St". */
  text: string;
}

// "Unit 403", "Apt. 2B", "Apartment #12", "Suite 300", "Townhome 7", "#403".
const UNIT_WORD = /\b(unit|apt|apartment|suite|ste|townhome|residence)\b\.?\s*(?:no\.?\s*|number\s*|#\s*)?([a-z]?\d{1,5}[a-z]?(?:-[a-z0-9]{1,4})?)\b/gi;
// "#" alone reads as a unit only with two or more digits ("#1 in the city" isn't one).
const UNIT_HASH = /(?:^|[^\w&])#\s?([a-z]?\d{2,5}[a-z]?(?:-[a-z0-9]{1,4})?)\b/gi;

const unitKey = (u: string) => u.toUpperCase().replace(/^([A-Z]?)0+(?=\d)/, '$1');

/** Unit numbers in text. Office suites are left out with `noSuites`, for the body of a page. */
export function unitsIn(text: string, noSuites = false): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(UNIT_WORD)) {
    if (noSuites && /^(suite|ste)$/i.test(m[1])) continue;
    out.push({ key: unitKey(m[2]), text: m[0].replace(/\s+/g, ' ').trim() });
  }
  for (const m of text.matchAll(UNIT_HASH)) out.push({ key: unitKey(m[1]), text: `#${m[1]}` });
  return out;
}

const SUFFIX: Record<string, string> = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd', boulevard: 'blvd', blvd: 'blvd',
  drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', way: 'way', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl', parkway: 'pkwy',
  pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', square: 'sq', sq: 'sq', terrace: 'ter', ter: 'ter', circle: 'cir', cir: 'cir',
  trail: 'trl', trl: 'trl', alley: 'aly', plaza: 'plz', row: 'row', loop: 'loop',
};
const SUFFIXES = Object.keys(SUFFIX).join('|');
// A street number (not part of a price like "$2,450"), up to three name words, then a street word.
// Name words start with a letter, or are ordinals ("5th"), so "Unit 403 450 Main St" isn't one address.
const WORD = "(?:\\d{1,3}(?:st|nd|rd|th)|\\p{L}[\\p{L}\\d'’.-]*)";
const STREET = new RegExp(`(?<![\\d$,.#])\\b(\\d{1,6})(?:\\s?-\\s?(\\d{1,6}))?\\s+((?:(?:n|s|e|w|north|south|east|west)\\.?\\s+)?${WORD}(?:\\s+${WORD}){0,2}?)\\s+(${SUFFIXES})\\b\\.?`, 'giu');
const DIRECTION = /^(n|s|e|w|north|south|east|west)\.?\s+/i;
const NOT_NAMES = /^(bed|beds|bedroom|bedrooms|bath|baths|bathroom|bathrooms|br|ba|sq|sqft|ft|car|min|minutes|mins|blocks|miles|units|homes|floor|floors|story|stories)$/i;

export type Street = Mention & { to?: number };

/** Street addresses in text, keyed "450 main". A range ("450-460 Main St") keeps its top in `to`. */
export function streetsIn(text: string): Street[] {
  const out: Street[] = [];
  for (const m of text.matchAll(STREET)) {
    const words = m[3].replace(DIRECTION, '').trim().toLowerCase().split(/\s+/);
    if (!words[0] || words.some((w) => NOT_NAMES.test(w.replace(/[.,]/g, '')))) continue;
    const to = m[2] && +m[2] > +m[1] ? +m[2] : undefined;
    out.push({ key: `${+m[1]} ${words.join(' ').replace(/[.'’]/g, '')}`, text: m[0].replace(/\s+/g, ' ').trim(), to });
  }
  return out;
}

const streetName = (key: string) => key.replace(/^\d+\s+/, '');
const streetNumber = (key: string) => key.split(' ')[0];

// ---------- what a page says about itself ----------

export interface PageFacts {
  title: string;
  /** Title, og:title, headings and the address in its structured data: what the page is. */
  identity: string;
  /** The words of its web address ("unit 403"), used only when the page itself doesn't say. */
  path: string;
  /** Everything else a reader sees. */
  body: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', middot: '·', bull: '•', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', num: '#' };

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag: string, name: string) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/** Reads a listing page's HTML for what it is (title, headings, address) and what it says. */
export function pageFacts(html: string, url = ''): PageFacts {
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const metas: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') || attr(m[0], 'name')).toLowerCase();
    if (key === 'og:title' || key === 'twitter:title') metas.push(attr(m[0], 'content'));
  }
  const heads = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => clean(m[1]));
  // Pages that draw themselves with scripts still tend to carry their address as structured data.
  const addresses = [...html.matchAll(/"streetAddress"\s*:\s*"([^"]{1,120})"/g)].map((m) => decodeEntities(m[1]));
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/[-_/+]+/g, ' ').replace(/\.\w+$/, '');
  } catch {
    // not a URL
  }
  const body = clean(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|p|div|li|h\d|tr|td|section|article)\b/gi, ' | <$1'),
  );
  return { title, identity: [title, ...metas, ...heads, ...addresses].filter(Boolean).join(' | '), path, body };
}

// ---------- does the card agree with its page? ----------

export interface CardVerdict {
  verdict: 'match' | 'mismatch' | 'unknown';
  /** "Card says Unit 403, the link's page says Unit 203." */
  detail: string;
}

/** One of each, as first written (a title's "Unit 203" over a web address's "unit 203"). */
function uniq<T extends Mention>(ms: T[]): T[] {
  const seen = new Set<string>();
  return ms.filter((m) => !seen.has(m.key) && !!seen.add(m.key));
}
/** What the page says, or failing that, what its address says. */
const orElse = <T,>(found: T[], next: () => T[]) => (found.length ? found : next());
const list = (ms: Mention[]) => uniq(ms).slice(0, 2).map((m) => m.text).join(' and ');

/**
 * Compares a card's text with its page. Units first (the 403-versus-203 slip), then street numbers.
 * Only a conflict counts: the page naming a different unit or address. A page that doesn't say is "unknown".
 */
export function compareCard(cardText: string, page: PageFacts): CardVerdict {
  const cardUnits = uniq(unitsIn(cardText));
  const cardStreets = uniq(streetsIn(cardText));
  if (!cardUnits.length && !cardStreets.length) return { verdict: 'unknown', detail: 'The card has no unit or street number to compare.' };
  let matched = false;

  if (cardUnits.length) {
    const want = new Set(cardUnits.map((u) => u.key));
    const named = uniq(orElse(unitsIn(page.identity), () => unitsIn(page.path)));
    // The body also lists other units ("Similar homes") and the office suite, so it only counts when
    // it names exactly one unit.
    const said = uniq(unitsIn(page.body, true));
    if (named.length) {
      if (named.some((u) => want.has(u.key))) matched = true;
      else return { verdict: 'mismatch', detail: `Card says ${list(cardUnits)}, the link’s page says ${list(named)}.` };
    } else if (said.some((u) => want.has(u.key))) {
      matched = true;
    } else if (said.length === 1) {
      return { verdict: 'mismatch', detail: `Card says ${list(cardUnits)}, the link’s page only mentions ${said[0].text}.` };
    }
  }

  if (cardStreets.length) {
    const named = uniq(orElse(streetsIn(page.identity), () => streetsIn(page.path)));
    const said = uniq(streetsIn(page.body));
    // A range on the page ("450-460 Main St") takes in every number on it.
    const same = (c: Street, p: Street) =>
      c.key === p.key || (p.to !== undefined && streetName(c.key) === streetName(p.key) && +streetNumber(c.key) >= +streetNumber(p.key) && +streetNumber(c.key) <= p.to);
    const has = (ps: Street[]) => ps.some((p) => cardStreets.some((c) => same(c, p)));
    if (has(named) || has(said)) matched = true;
    else {
      // The same street with another number is a slip; a single different address in the heading is
      // another listing. Anything less certain stays quiet.
      const sameStreet = named.find((p) => cardStreets.some((c) => streetName(c.key) === streetName(p.key)));
      if (sameStreet) return { verdict: 'mismatch', detail: `Card says ${list(cardStreets)}, the link’s page says ${sameStreet.text}.` };
      if (named.length === 1) return { verdict: 'mismatch', detail: `Card says ${list(cardStreets)}, the link’s page says ${named[0].text}.` };
    }
  }
  return matched ? { verdict: 'match', detail: 'The page names the same listing.' } : { verdict: 'unknown', detail: 'The page doesn’t say which unit or address it is.' };
}

// ---------- which layers are listing cards ----------

/** Links the live check leaves alone: not a web page, or a page that isn't the reader's to check. */
export function skipLink(url: string): boolean {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u) || linkIssue(u)) return true;
  return /unsub|opt-?out|email-?preferences|manage-?preferences|\{\{|%%|\*\|/i.test(u);
}

const GENERIC = /^(frame|group|card|row|column|stack|auto layout|container|rectangle|image|photo|picture|section)\b/i;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function texts(n: SceneNode, out: string[] = []): string[] {
  if (!n.visible) return out;
  if (n.type === 'text') {
    const t = oneLine(n.text);
    if (t) out.push(t);
  } else if (n.type === 'frame') for (const c of n.children) texts(c, out);
  return out;
}

/** A name for a layer in a list: its own name unless that's generic, else its first words. */
export function layerLabel(n: SceneNode, fallback = 'Layer'): string {
  if (n.type === 'text') return oneLine(n.text).slice(0, 48) || fallback;
  const name = parseNameTags(n.name).clean.replace(/\s*\[[^\]]*\]/g, '').trim();
  if (name && !GENERIC.test(name)) return name;
  return texts(n)[0]?.slice(0, 48) || name || fallback;
}

function webLinks(n: SceneNode, out = new Set<string>()): Set<string> {
  if (!n.visible) return out;
  const own = nodeLink(n);
  if (own !== undefined && !skipLink(own)) out.add(own.trim());
  if (n.type === 'frame') for (const c of n.children) webLinks(c, out);
  return out;
}

export interface CardLink {
  url: string;
  /** The layer that carries the link. */
  linkId: string;
  /** The smallest frame around it that says which listing it is (or the linked layer itself). */
  cardId: string;
  name: string;
  /** All the card's text, one line. */
  text: string;
}

/** Every web link on the email, and for those inside a listing card, the card and its text. */
export function emailLinks(root: FrameNode): { links: { url: string; id: string; name: string }[]; cards: CardLink[] } {
  const links: { url: string; id: string; name: string }[] = [];
  const cards: CardLink[] = [];
  const seen = new Set<string>();
  const says = (t: string[]) => t.some((s) => unitsIn(s).length || streetsIn(s).length);

  const visit = (n: SceneNode, path: FrameNode[]) => {
    if (!n.visible) return;
    const own = nodeLink(n);
    if (own !== undefined && !skipLink(own)) {
      const url = own.trim();
      links.push({ url, id: n.id, name: layerLabel(n, 'Link') });
      // Climb from the linked layer until the text says which listing it is, but never as far as a
      // frame that also holds another listing's link.
      const chain: SceneNode[] = [n, ...path.slice().reverse()];
      for (const c of chain) {
        if ([...webLinks(c)].some((u) => u !== url)) break;
        const t = texts(c);
        if (says(t)) {
          const key = `${c.id} ${url}`;
          if (!seen.has(key)) {
            seen.add(key);
            cards.push({ url, linkId: n.id, cardId: c.id, name: layerLabel(c, 'Card'), text: t.join(' · ') });
          }
          break;
        }
      }
    }
    if (n.type === 'frame') for (const c of n.children) visit(c, [...path, n]);
  };
  // The root holds every section, so it's never a card.
  for (const s of root.children) visit(s, []);
  return { links, cards };
}

// ---------- photo shapes ----------

const RATIOS: [number, number][] = [[1, 1], [4, 5], [5, 4], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [2, 1], [1, 2], [5, 7], [7, 5], [21, 9]];

/** "3:2", "16:9", or "1.42:1" when it's nothing common. */
export function ratioName(w: number, h: number): string {
  const a = w / h;
  const near = RATIOS.find(([x, y]) => Math.abs(a / (x / y) - 1) < 0.03);
  return near ? `${near[0]}:${near[1]}` : a >= 1 ? `${a.toFixed(2)}:1` : `1:${(1 / a).toFixed(2)}`;
}

/** Share of a photo a frame shows when it fills the frame at its natural size (no zoom). */
export function shapeKept(srcW: number, srcH: number, frameW: number, frameH: number): number {
  const a = srcW / srcH;
  const b = frameW / frameH;
  return Math.min(a / b, b / a);
}

/** How far apart two shapes are, as a fraction (0.02 = 2%). */
export function shapeGap(w1: number, h1: number, w2: number, h2: number): number {
  return Math.abs((w1 / h1) / (w2 / h2) - 1);
}
