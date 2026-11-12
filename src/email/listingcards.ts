import { useStore, currentLayout } from '../store';
import { fetchImage, fetchPage } from '../platform';
import { getAsset, registerImage } from '../assets';
import { cloneWithNewIds, deepClone, findNode, locate, makeFrame, pathTo, walk } from '../tree';
import { setNodeLink } from '../links';
import { cardNodeId, fieldNamed, photoFields } from '../repeat';
import { measureText } from '../layout';
import { normaliseSpans, remapSpans } from '../richtext';
import { emailRootOf } from './boards';
import {
  bathsLabel,
  bedsLabel,
  cardAddressLine,
  cardDetailsLine,
  croppedPhotoUrl,
  listingGone,
  LISTING_FIELD_LABEL,
  parseListingLinks,
  parseListingPage,
  photoAlt,
  shortStreet,
  sortListings,
  type ListingFacts,
  type ListingSort,
} from './listings';
import type { AssetMeta, Doc, FrameNode, ImageNode, SceneNode, TextNode } from '../types';

// "Fill cards from listing links": reads each listing page, sorts the listings, and fills the
// listing cards already on an email board, in order. Each card gets its price, "Address Unit N",
// "Neighborhood | N BD | N BA", a link to the listing, and its first photo cropped by the photo
// host to the frame's exact size at 2x. That cropped URL is saved as the picture's own web address
// (email.imageUrls), so nothing is uploaded, and the same picture is brought into the photo tray so
// the canvas shows what the inbox will. One undo step for the whole fill.
//
// Cards are found two ways:
// - a repeat (repeat.ts) whose fields are named like price, address, details/meta, photo, link;
// - layers keyed <prefix>-<n>-<role>, like the user's saved template: unit-1-photo, unit-1-price,
//   unit-1-address, unit-1-meta. The card is the frame holding one number's layers.
// Too few cards: more are added (a repeat gets rows; keyed cards are copied, two to a row like the
// ones above). Too many: the extra cards are left as they were and reported.
// A fact the page doesn't have becomes a {{TOKEN}} (or an empty photo), so the export checks catch it.

// ---------- reading pages ----------

export interface ListingRead {
  url: string;
  facts: ListingFacts | null;
  error: string | null;
}

export async function readListing(url: string): Promise<ListingRead> {
  try {
    const page = await fetchPage(url);
    const gone = listingGone(url, page.url);
    if (gone) return { url, facts: null, error: gone };
    const facts = parseListingPage(page.html, url);
    if (!facts.address && !facts.price && !facts.photos.length) return { url, facts: null, error: 'That page doesn’t look like a listing (no address, price or photos found).' };
    return { url, facts, error: null };
  } catch (e) {
    return { url, facts: null, error: (e as Error).message || String(e) };
  }
}

/** Runs fn over items, `limit` at a time, keeping the order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Reads every link, four at a time. */
export async function readListings(urls: string[], onProgress?: (done: number, total: number) => void): Promise<ListingRead[]> {
  let done = 0;
  return pool(urls, 4, async (u) => {
    const r = await readListing(u);
    onProgress?.(++done, urls.length);
    return r;
  });
}

// ---------- finding the cards ----------

export type CardRole = 'photo' | 'price' | 'address' | 'details' | 'hood' | 'beds' | 'baths' | 'unit' | 'link';

const ROLE_NAMES: [CardRole, RegExp][] = [
  ['photo', /photo|image|img|pic/i],
  ['price', /price|rent/i],
  ['details', /meta|details?|info|facts|specs/i],
  ['hood', /hood|neighbou?rhood|area/i],
  ['beds', /^beds?$|bedrooms?|^bd$/i],
  ['baths', /^baths?$|bathrooms?|^ba$/i],
  ['unit', /^unit$|^unit[\s_-]?(no|number|#)$/i],
  ['address', /address|addr|street|title|^name$/i],
  ['link', /link|url|href|cta/i],
];

export function roleOf(name: string): CardRole | null {
  return ROLE_NAMES.find(([, re]) => re.test(name.trim()))?.[0] ?? null;
}

const TEXT_ROLES: CardRole[] = ['price', 'address', 'details', 'hood', 'beds', 'baths', 'unit'];

export interface KeyedCard {
  n: number;
  /** The frame holding the card. */
  container: string;
  layers: Partial<Record<CardRole, string>>;
}

export type CardSet =
  | { kind: 'keyed'; prefix: string; cards: KeyedCard[] }
  | { kind: 'repeat'; frameId: string; cardId: string; fields: Partial<Record<CardRole, string>>; photoId: string | null; rows: number };

/** unit-1-photo → { prefix: 'unit', n: 1, role: 'photo' }. */
const KEY = /^(.*?)[-_]?(\d+)[-_]([a-z][\w-]*)$/i;

function keyedSets(root: FrameNode, nodes: SceneNode[]): { prefix: string; cards: KeyedCard[]; score: number }[] {
  const groups = new Map<string, Map<number, KeyedCard>>();
  walk([root], (n) => {
    if (n.type === 'frame' && n.repeat) return false;
    const m = n.key ? KEY.exec(n.key) : null;
    if (!m) return;
    const role = roleOf(m[3]);
    if (!role || (role === 'photo' && n.type !== 'image') || (TEXT_ROLES.includes(role) && n.type !== 'text')) return;
    const prefix = m[1].toLowerCase();
    const num = Number(m[2]);
    const g = groups.get(prefix) ?? new Map<number, KeyedCard>();
    groups.set(prefix, g);
    const card = g.get(num) ?? { n: num, container: '', layers: {} };
    g.set(num, card);
    card.layers[role] ??= n.id;
  });
  const out: { prefix: string; cards: KeyedCard[]; score: number }[] = [];
  for (const [prefix, g] of groups) {
    const cards = [...g.values()].sort((a, b) => a.n - b.n);
    for (const c of cards) {
      const ids = Object.values(c.layers) as string[];
      const paths = ids.map((id) => pathTo(nodes, id));
      // The lowest frame that holds every keyed layer of this card; one layer alone: its parent.
      let common = paths[0].slice(0, -1);
      for (const p of paths.slice(1)) {
        let i = 0;
        while (i < common.length && common[i] === p[i]) i++;
        common = common.slice(0, i);
      }
      c.container = common[common.length - 1] ?? '';
    }
    const usable = cards.filter((c) => c.container && (c.layers.price || c.layers.address || c.layers.details));
    if (!usable.length) continue;
    const score = usable.reduce((s, c) => s + Object.keys(c.layers).length, 0) + (usable.some((c) => c.layers.price) ? 100 : 0);
    out.push({ prefix, cards: usable, score });
  }
  return out;
}

const firstCard = (f: FrameNode): SceneNode | undefined => {
  const line = f.children[0];
  return line?.type === 'frame' ? line.children[0] : undefined;
};

function repeatSets(root: FrameNode) {
  const out: { set: Extract<CardSet, { kind: 'repeat' }>; score: number }[] = [];
  walk([root], (n) => {
    if (!(n.type === 'frame' && n.repeat)) return;
    const card = firstCard(n);
    if (!card) return false;
    const photos = photoFields(n);
    const fields: Partial<Record<CardRole, string>> = {};
    for (const f of n.repeat.fields) {
      const role = photos.includes(f) ? 'photo' : roleOf(f);
      if (role && !fields[role]) fields[role] = f;
    }
    let photoId: string | null = null;
    if (fields.photo) walk([card], (x) => void (x.bind?.image === fields.photo && (photoId ??= x.id)));
    if (fields.price || fields.address || fields.details) {
      const score = Object.keys(fields).length + (fields.price ? 100 : 0) + 0.5;
      out.push({ set: { kind: 'repeat', frameId: n.id, cardId: card.id, fields, photoId, rows: n.repeat.rows.length }, score });
    }
    return false;
  });
  return out;
}

/** The listing cards on an email board, or null. A repeat wins a tie with keyed cards. */
export function findCardSet(doc: Doc): CardSet | null {
  const root = emailRootOf(doc);
  if (!root) return null;
  const options: { set: CardSet; score: number }[] = [
    ...repeatSets(root),
    ...keyedSets(root, doc.nodes).map((k) => ({ set: { kind: 'keyed' as const, prefix: k.prefix, cards: k.cards }, score: k.score })),
  ];
  options.sort((a, b) => b.score - a.score);
  return options[0]?.set ?? null;
}

export const NO_CARDS =
  'No listing cards found on this board. Spread fills either a repeat whose fields are named like price, address, details and photo, or cards whose layers are keyed unit-1-price, unit-1-address, unit-1-meta, unit-1-photo (unit-2-…, and so on).';

/** How many cards the board has now, for the dialog. */
export function cardCount(set: CardSet | null): number {
  return !set ? 0 : set.kind === 'keyed' ? set.cards.length : set.rows;
}

// ---------- what goes on a card ----------

const TOKEN = { price: '{{PRICE}}', address: '{{ADDRESS}}', details: '{{DETAILS}}', hood: '{{NEIGHBORHOOD}}', beds: '{{BEDS}}', baths: '{{BATHS}}', unit: '{{UNIT}}' };

/** "/mo" and the like after the number, kept from what the card said before. */
const priceSuffix = (old: string) => /\s*\/\s*(mo|month)\.?\s*$/i.exec(old)?.[0] ?? '';

/** The separator the card's details line already uses ("  |  "), or " | ". */
function separatorOf(old: string): string {
  const m = /\s*[|•·✦]\s*/.exec(old);
  return m ? m[0] : ' | ';
}

/** The value for one text role, given what the layer said before. */
function textFor(role: CardRole, f: ListingFacts, old: string, sole = true): string {
  switch (role) {
    case 'price':
      return f.priceText ? f.priceText + priceSuffix(old) : TOKEN.price;
    case 'address':
      return cardAddressLine(f) ?? TOKEN.address;
    case 'details':
      return cardDetailsLine(f, separatorOf(old)) ?? TOKEN.details;
    case 'hood':
      return f.neighborhood ?? TOKEN.hood;
    case 'beds':
      return (sole ? bedsLabel(f.beds) : f.beds === 0 ? 'Studio' : f.beds?.toString()) ?? TOKEN.beds;
    case 'baths':
      return (sole ? bathsLabel(f.baths) : f.baths?.toString()) ?? TOKEN.baths;
    case 'unit':
      return f.unit ?? TOKEN.unit;
    default:
      return old;
  }
}

function setText(n: TextNode, text: string) {
  const before = n.text;
  if (before === text) return;
  n.text = text;
  n.spans = remapSpans(before, text, n.spans);
  n.spans = n.spans ? normaliseSpans(n) : undefined;
  if (!n.spans) delete n.spans;
}

/** A fixed-width text box too narrow for its new words hugs them instead (a $11,200 in a box made for $3,840). */
function fitWidth(n: TextNode): boolean {
  if (n.sizingH !== 'fixed' || /\n/.test(n.text)) return false;
  if (measureText({ ...n, sizingH: 'hug' } as TextNode).w <= n.w + 0.5) return false;
  n.sizingH = 'hug';
  return true;
}

function setAlt(n: SceneNode, alt: string) {
  const clean = alt.replace(/[[\]]/g, '');
  n.name = /\[alt:[^\]]*\]/i.test(n.name) ? n.name.replace(/\[alt:[^\]]*\]/i, `[alt:${clean}]`) : `${n.name} [alt:${clean}]`;
}

// ---------- adding keyed cards ----------

const EMPTY_CARD = 'Empty card';
const isFiller = (n: SceneNode) => n.type === 'frame' && n.name === EMPTY_CARD && !n.children.length;

function filler(): FrameNode {
  return makeFrame(0, 0, 1, 1, { fill: null, clip: false, layout: 'column', padding: { t: 0, r: 0, b: 0, l: 0 }, sizingH: 'fill', name: EMPTY_CARD });
}

/** Swaps the card number in a name's label ("Unit 4 photo [alt:…]" → "Unit 5 photo [alt:…]"). */
function renumber(name: string, from: number, to: number): string {
  const i = name.indexOf('[');
  const label = i < 0 ? name : name.slice(0, i);
  const swapped = label.replace(new RegExp(`(^|\\D)${from}(?!\\d)`), `$1${to}`);
  return swapped + (i < 0 ? '' : name.slice(i));
}

/**
 * Copies the last card for card number `n`, beside it when its row has room (or a placeholder to
 * take), else in a new row like the one above. Returns the new card's layers. Use inside a producer.
 */
function addKeyedCard(d: Doc, prefix: string, last: KeyedCard, n: number, columns: number): KeyedCard | null {
  const at = locate(d.nodes, last.container);
  if (!at) return null;
  const source = at.list[at.index];
  const copy = cloneWithNewIds(deepClone(source));
  const card: KeyedCard = { n, container: copy.id, layers: {} };
  walk([copy], (x) => {
    x.name = renumber(x.name, last.n, n);
    const m = x.key ? KEY.exec(x.key) : null;
    if (m && m[1].toLowerCase() === prefix && Number(m[2]) === last.n) {
      x.key = x.key!.replace(new RegExp(`^(.*?[-_]?)${last.n}([-_])`), `$1${n}$2`);
      const role = roleOf(m[3]);
      if (role) card.layers[role] ??= x.id;
    } else if (x.key && x !== copy) delete x.key; // keys stay unique on the board
  });
  if (copy.key) {
    const renamed = copy.key.replace(new RegExp(`(^|\\D)${last.n}(?!\\d)`), `$1${n}`);
    if (renamed === copy.key) delete copy.key;
    else copy.key = renamed;
  }

  const row = at.parent;
  if (row && row.layout === 'row') {
    const cardsInRow = row.children.filter((c) => !isFiller(c)).length;
    if (cardsInRow < columns) {
      const gap = row.children.findIndex(isFiller);
      if (gap >= 0) row.children[gap] = copy;
      else row.children.splice(at.index + 1, 0, copy);
      return card;
    }
    // A new row like this one, after it.
    const rowAt = locate(d.nodes, row.id);
    if (!rowAt) return null;
    const fresh = cloneWithNewIds(deepClone(row) as FrameNode);
    const rowNum = /(\d+)(?!.*\d)/.exec(row.name.split('[')[0])?.[1];
    if (rowNum) fresh.name = renumber(row.name, Number(rowNum), Number(rowNum) + 1);
    delete fresh.key;
    fresh.children = [copy, ...Array.from({ length: Math.max(0, columns - 1) }, filler)];
    rowAt.list.splice(rowAt.index + 1, 0, fresh);
    return card;
  }
  at.list.splice(at.index + 1, 0, copy);
  return card;
}

// ---------- filling ----------

export interface CardReport {
  card: number;
  url: string;
  price: string | null;
  address: string | null;
  details: string | null;
  /** The picture's web address (cropped to the frame at 2x). */
  photo: string | null;
  /** Problems on this card, in plain words. */
  problems: string[];
  /** What Spread adjusted to make it fit (not a problem). */
  notes: string[];
}

export interface FillReport {
  boardId: string;
  sort: ListingSort;
  cards: CardReport[];
  /** Cards added because there were more links than cards. */
  added: number;
  /** Cards left as they were because there were fewer links (card numbers, from 1). */
  extras: number[];
  /** Links that couldn't be read. */
  failed: { url: string; error: string }[];
  summary: string;
}

export interface FillOptions {
  sort?: ListingSort;
  boardId?: string;
  onProgress?: (text: string) => void;
}

/** Reads the links, then fills the cards. */
export async function fillListingCards(urls: string[], opts: FillOptions = {}): Promise<FillReport> {
  if (!urls.length) throw new Error('Paste at least one listing link.');
  opts.onProgress?.(`Reading ${urls.length} listing ${urls.length === 1 ? 'page' : 'pages'}…`);
  const reads = await readListings(urls, (done, total) => opts.onProgress?.(`Read ${done} of ${total}…`));
  return fillCardsFromListings(reads, opts);
}

interface Planned {
  facts: ListingFacts;
  /** Photo frame size on the canvas, px. */
  box: { w: number; h: number } | null;
  photoUrl: string | null;
  asset: AssetMeta | null;
  problems: string[];
}

const photoName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'Listing photo');

/** Fills the cards from listings already read (the dialog reads first to show what it found). */
export async function fillCardsFromListings(reads: ListingRead[], opts: FillOptions = {}): Promise<FillReport> {
  const sort = opts.sort ?? 'price';
  const failed = reads.filter((r) => !r.facts).map((r) => ({ url: r.url, error: r.error ?? 'Couldn’t read it.' }));
  const listings = sortListings(
    reads.filter((r) => r.facts).map((r) => r.facts!),
    sort,
  );
  if (!listings.length) throw new Error(`None of the links could be read. ${failed.map((f) => `${f.url}: ${f.error}`).join(' ')}`);

  const st = useStore.getState();
  if (opts.boardId && opts.boardId !== st.project.activeBoardId) st.setActiveBoard(opts.boardId);
  const doc = useStore.getState().doc;
  if (opts.boardId && doc.id !== opts.boardId) throw new Error(`No board with id "${opts.boardId}".`);
  if (doc.kind !== 'email') throw new Error(`"${doc.name}" isn't an email board.`);
  const set = findCardSet(doc);
  if (!set) throw new Error(NO_CARDS);
  const layout = currentLayout();
  const boxOf = (id: string | null | undefined) => {
    const b = id ? layout.get(id) : undefined;
    return b ? { w: b.w, h: b.h } : null;
  };

  // Photo frame sizes: each card's own, new cards the same as the last one.
  const planned: Planned[] = listings.map((facts, i) => {
    let box: { w: number; h: number } | null;
    if (set.kind === 'keyed') box = boxOf(set.cards[Math.min(i, set.cards.length - 1)].layers.photo);
    else box = boxOf(set.photoId);
    const src = facts.photos[0] ?? null;
    const photoUrl = src && box ? croppedPhotoUrl(src, box.w * 2, box.h * 2) : src;
    const problems: string[] = [];
    if (facts.available === false) problems.push('The page says it’s off the market.');
    const missing = facts.missing.filter((m) => m !== 'unit' || !!facts.address);
    if (missing.length) problems.push(`Not on the page: ${missing.map((m) => LISTING_FIELD_LABEL[m]).join(', ')}.`);
    return { facts, box, photoUrl, asset: null, problems };
  });

  // The pictures, for the canvas: the same cropped file the inbox will load.
  const hasPhotoSlot = set.kind === 'keyed' ? set.cards.some((c) => c.layers.photo) : !!set.photoId;
  if (hasPhotoSlot) {
    let done = 0;
    const withPhoto = planned.filter((p) => p.photoUrl);
    opts.onProgress?.(`Getting ${withPhoto.length} ${withPhoto.length === 1 ? 'photo' : 'photos'}…`);
    await pool(withPhoto, 4, async (p) => {
      // The same photo at the same size is already in the tray (filled before): use it again.
      const name = photoName(p.facts.photos[0]);
      const w = p.box ? Math.round(p.box.w * 2) : 0;
      const h = p.box ? Math.round(p.box.h * 2) : 0;
      const known = Object.values(doc.assets).find((a) => a.kind === 'image' && a.name === name && a.width === w && a.height === h && !!getAsset(a.id));
      if (known) {
        p.asset = known;
        opts.onProgress?.(`Got ${++done} of ${withPhoto.length} photos…`);
        return;
      }
      try {
        const r = await fetchImage(p.photoUrl!);
        p.asset = await registerImage(new Blob([r.data as BlobPart], { type: r.type }), name);
      } catch (e) {
        p.problems.push(`Couldn’t show the photo on the canvas (${(e as Error).message}). The email still uses its web address.`);
      }
      opts.onProgress?.(`Got ${++done} of ${withPhoto.length} photos…`);
    });
  }

  const reports: CardReport[] = planned.map((p, i) => ({
    card: i + 1,
    url: p.facts.url,
    price: null,
    address: null,
    details: null,
    photo: null,
    problems: p.problems,
    notes: [],
  }));
  const extras: number[] = [];
  let added = 0;
  const assets = planned.map((p) => p.asset).filter((a): a is AssetMeta => !!a);
  const boardId = doc.id;

  useStore.getState().changeProject((proj) => {
    // The photo tray is shared by every board.
    for (const b of proj.boards) {
      for (const m of assets) {
        b.assets[m.id] = m;
        if (!b.assetOrder.includes(m.id)) b.assetOrder.push(m.id);
      }
    }
    const d = proj.boards.find((b) => b.id === boardId)!;
    const urls: Record<string, string> = { ...d.email?.imageUrls };
    const setUrl = (id: string, url: string | null) => {
      if (url) urls[id] = url;
      else delete urls[id];
    };

    if (set.kind === 'keyed') {
      const cards = [...set.cards];
      const columns = (() => {
        const first = locate(d.nodes, cards[0].container);
        return first?.parent?.layout === 'row' ? Math.max(1, first.parent.children.filter((c) => !isFiller(c)).length) : 1;
      })();
      while (cards.length < planned.length) {
        const card = addKeyedCard(d, set.prefix, cards[cards.length - 1], cards[cards.length - 1].n + 1, columns);
        if (!card) break;
        cards.push(card);
        added++;
      }
      for (let i = planned.length; i < cards.length; i++) extras.push(i + 1);
      planned.forEach((p, i) => {
        const card = cards[i];
        const rep = reports[i];
        if (!card) {
          rep.problems.push('No card for this one: the cards couldn’t be copied.');
          return;
        }
        const f = p.facts;
        for (const role of TEXT_ROLES) {
          const id = card.layers[role];
          const n = id ? findNode(d.nodes, id) : null;
          if (!n || n.type !== 'text') continue;
          setText(n, textFor(role, f, n.text));
          if (role === 'price' && fitWidth(n)) rep.notes.push('Widened the price box so the price fits on one line.');
          if (role === 'price') rep.price = n.text;
          if (role === 'address') rep.address = n.text;
          if (role === 'details') rep.details = n.text;
        }
        const container = findNode(d.nodes, card.container);
        if (container) setNodeLink(container, f.url);
        const linkLayer = card.layers.link ? findNode(d.nodes, card.layers.link) : null;
        if (linkLayer) setNodeLink(linkLayer, f.url);
        const photo = card.layers.photo ? findNode(d.nodes, card.layers.photo) : null;
        if (photo?.type === 'image') {
          const img = photo as ImageNode;
          setNodeLink(img, f.url);
          img.assetId = p.asset?.id ?? null;
          img.crop = { zoom: 1, cx: 0.5, cy: 0.5 };
          setAlt(img, photoAlt(f, f.photos[0]));
          setUrl(img.id, p.photoUrl);
          rep.photo = p.photoUrl;
        }
      });
    } else {
      const frame = findNode(d.nodes, set.frameId);
      if (!frame || frame.type !== 'frame' || !frame.repeat) return;
      const spec = frame.repeat;
      const source = firstCard(frame);
      const fields = { ...set.fields };
      const freeField = (name: string) => {
        let out = name;
        for (let k = 2; fieldNamed(spec, out); k++) out = `${name} ${k}`;
        spec.fields.push(out);
        for (const row of spec.rows) row[out] ??= '';
        return out;
      };
      // Every card links to its own listing: a link column bound to the whole card.
      if (!fields.link && source) {
        fields.link = freeField('Listing link');
        source.bind = { ...source.bind, link: `{{${fields.link}}}` };
      }
      // And its photo gets its own alt text.
      const photoNode = set.photoId && source ? findNode([source], set.photoId) : null;
      let altField: string | null = null;
      if (photoNode && !photoNode.bind?.name) {
        altField = freeField('Photo alt');
        photoNode.bind = { ...photoNode.bind, name: `${photoNode.name.replace(/\s*\[alt:[^\]]*\]/i, '')} [alt:{{${altField}}}]` };
      }
      // A field that's the whole of a layer gets the labelled value ("3 BD"); inside a line, the bare one.
      const sole = (field: string) => {
        let found = true;
        if (source)
          walk([source], (x) => {
            const t = x.bind?.text;
            if (t && new RegExp(`\\{\\{\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'i').test(t)) found = /^\s*\{\{[^{}]+\}\}\s*$/.test(t);
          });
        return found;
      };
      const unitField = !!fields.unit;
      for (let i = planned.length; i < spec.rows.length; i++) extras.push(i + 1);
      planned.forEach((p, i) => {
        const f = p.facts;
        const rep = reports[i];
        if (i >= spec.rows.length) {
          spec.rows.push({ ...spec.rows[spec.rows.length - 1] });
          added++;
        }
        const row = spec.rows[i];
        for (const role of TEXT_ROLES) {
          const field = fields[role];
          if (!field) continue;
          let value = textFor(role, f, row[field] ?? '', sole(field));
          if (role === 'address' && unitField) value = f.address ? shortStreet(f.address) : TOKEN.address;
          row[field] = value;
          if (role === 'price') rep.price = value;
          if (role === 'address') rep.address = unitField && f.unit ? `${value} Unit ${f.unit}` : value;
          if (role === 'details') rep.details = value;
        }
        if (fields.link) row[fields.link] = f.url;
        if (altField) row[altField] = photoAlt(f, f.photos[0]);
        if (fields.photo) {
          row[fields.photo] = p.asset?.id ?? '';
          row[`${fields.photo}#crop`] = '1,0.5,0.5';
        }
        if (set.photoId) {
          setUrl(cardNodeId(set.photoId, i), p.photoUrl);
          rep.photo = p.photoUrl;
        }
      });
      // A price layer too narrow for the longest price hugs it instead (every card shares the box).
      const priceField = fields.price;
      if (priceField && source)
        walk([source], (x) => {
          if (x.type !== 'text' || !x.bind?.text || !new RegExp(`^\\s*\\{\\{\\s*${priceField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}\\s*$`, 'i').test(x.bind.text)) return;
          const t = x as TextNode;
          if (spec.rows.some((row) => fitWidth({ ...t, text: row[priceField] ?? '' } as TextNode))) {
            t.sizingH = 'hug';
            reports[0]?.notes.push('Widened the price box so every price fits on one line.');
          }
        });
    }
    d.email = { ...d.email, imageUrls: Object.keys(urls).length ? urls : undefined };
  });

  const filled = reports.length;
  const parts = [`Filled ${filled} ${filled === 1 ? 'card' : 'cards'}${sort === 'price' ? ', cheapest first' : ', in the order pasted'}.`];
  if (added) parts.push(`Added ${added} ${added === 1 ? 'card' : 'cards'}.`);
  if (extras.length) parts.push(`${extras.length === 1 ? `Card ${extras[0]} was` : `Cards ${extras.join(', ')} were`} left as ${extras.length === 1 ? 'it was' : 'they were'}: delete ${extras.length === 1 ? 'it' : 'them'} if you don’t need ${extras.length === 1 ? 'it' : 'them'}.`);
  if (failed.length) parts.push(`${failed.length} ${failed.length === 1 ? 'link' : 'links'} couldn’t be read.`);
  const flagged = reports.filter((r) => r.problems.length).length;
  if (flagged) parts.push(`${flagged} ${flagged === 1 ? 'card needs' : 'cards need'} a look.`);
  return { boardId, sort, cards: reports, added, extras, failed, summary: parts.join(' ') };
}

/** A plain description of the cards a fill will use, for the dialog. */
export function describeCardSet(set: CardSet | null): string {
  if (!set) return 'No listing cards on this board yet.';
  const n = cardCount(set);
  return set.kind === 'repeat' ? `${n} ${n === 1 ? 'card' : 'cards'} in a repeat` : `${n} ${n === 1 ? 'card' : 'cards'} (${set.prefix}-1 to ${set.prefix}-${set.cards[set.cards.length - 1].n})`;
}

// ---------- automation (spread_fill_listing_cards) ----------

/** One read listing as Claude sees it. */
function brief(r: ListingRead) {
  if (!r.facts) return { url: r.url, error: r.error };
  const f = r.facts;
  return {
    url: r.url,
    price: f.priceText,
    address: cardAddressLine(f),
    details: cardDetailsLine(f),
    sqft: f.sqft,
    available: f.available,
    photos: f.photos.length,
    firstPhoto: f.photos[0] ?? null,
    missing: f.missing,
  };
}

/** Registered by src/automation.ts. boardId is handled there (it makes that board active). */
export const listingHandlers: Record<string, (p: Record<string, any>) => Promise<unknown>> = {
  async fill_listing_cards(p) {
    const urls = parseListingLinks(Array.isArray(p.urls) ? p.urls.map(String).join('\n') : String(p.urls ?? ''));
    if (!urls.length) throw new Error('Pass urls: the listing links, e.g. ["https://rentbt.com/listing/2238-hyde-street-unit-8/"].');
    const sort: ListingSort = p.sort === 'as-given' ? 'as-given' : 'price';
    const reads = await readListings(urls);
    if (p.preview) {
      const set = findCardSet(useStore.getState().doc);
      const ok = sortListings(
        reads.filter((r) => r.facts).map((r) => ({ ...r, price: r.facts!.price })),
        sort,
      );
      return { cardsOnBoard: describeCardSet(set), listings: ok.map(brief), failed: reads.filter((r) => !r.facts).map(brief) };
    }
    return fillCardsFromListings(reads, { sort });
  },
};
