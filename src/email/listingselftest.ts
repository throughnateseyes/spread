import { useStore, currentLayout } from '../store';
import { findNode, makeEmailBoard, makeFrame, makeImage, walk } from '../tree';
import { startRepeat } from '../repeat';
import { nodeLink } from '../links';
import type { Doc, FrameNode, SceneNode, TextNode } from '../types';
import { buildEmailHtml } from './html';
import { pictureSources, pictureSrc } from './hosting';
import { emailText, footerSection, makeEmailRoot } from './templates';
import { parseListingPage } from './listings';
import { fillCardsFromListings, findCardSet, type ListingRead } from './listingcards';

// Dev self-test for "Fill cards from listing links". Runs in the web build (npm run web) from devtools:
//   await (await import('/src/email/listingselftest.ts')).listingCardsSelfTest()
// Adds two email boards, one with keyed cards built like the user's saved "SF monthly" template
// (unit-1-photo, unit-1-price + "/mo", unit-1-address, unit-1-meta, two cards to a [stack] row) and
// one with a repeat, then fills both from the saved rentbt.com pages in ./fixtures. Pages are
// read from the fixtures, not the web; the browser can't download the photos (no CORS on the photo
// host), so the canvas photo is expected to be reported as a problem here and works in the app.

const FIXTURES: [file: string, url: string][] = [
  ['rentbt-2238-hyde-unit-8.html', 'https://rentbt.com/listing/2238-hyde-street-unit-8/'],
  ['rentbt-1690-broadway-unit-205.html', 'https://rentbt.com/listing/1690-broadway-street-unit-205/'],
  ['rentbt-1401-jones-unit-00a.html', 'https://rentbt.com/listing/1401-jones-street-unit-00a/'],
  ['rentbt-434-leavenworth-unit-111.html', 'https://rentbt.com/listing/434-leavenworth-street-unit-111/'],
  ['rentbt-1771-highland-unit-105.html', 'https://rentbt.com/listing/1771-highland-place-unit-105/'],
];

async function fixtureReads(): Promise<ListingRead[]> {
  const reads = await Promise.all(
    FIXTURES.map(async ([file, url]) => {
      const html = await (await fetch(new URL(`./fixtures/${file}`, import.meta.url))).text();
      return { url, facts: parseListingPage(html, url), error: null };
    }),
  );
  return [...reads, { url: 'https://rentbt.com/listing/9-gone-street-unit-1/', facts: null, error: 'That unit isn’t on the site any more.' }];
}

const pad0 = { t: 0, r: 0, b: 0, l: 0 };

/** A card like the user's: photo, then a price row ("$3,840" + "/mo"), address, details. */
function unitCard(n: number, price: string, address: string, meta: string): FrameNode {
  const photo = makeImage(0, 0, 260, 168, null, `Unit ${n} photo [alt:Old photo ${n}]`);
  photo.sizingH = 'fill';
  photo.sizingV = 'fixed';
  photo.key = `unit-${n}-photo`;
  const priceText = emailText(price, 'h4', { hug: false, sizingH: 'fixed', w: 74, fontSize: 20, key: `unit-${n}-price` });
  const mo = emailText('/mo', 'meta', { hug: true });
  const priceRow = makeFrame(0, 0, 100, 30, { name: `Unit ${n} price [nostack]`, fill: null, clip: false, layout: 'row', gap: 5, padding: pad0, sizingH: 'hug', sizingV: 'hug', alignItems: 'end', children: [priceText, mo] });
  const addr = emailText(address, 'detailValue', { hug: true, key: `unit-${n}-address` });
  const details = emailText(meta, 'detailLabel', { hug: true, key: `unit-${n}-meta` });
  const text = makeFrame(0, 0, 260, 80, { name: `Unit ${n} text`, fill: null, clip: false, layout: 'column', gap: 2, padding: pad0, sizingH: 'fill', sizingV: 'hug', children: [priceRow, addr, details] });
  return makeFrame(0, 0, 260, 260, { name: `Unit ${n}`, fill: null, clip: false, layout: 'column', gap: 8, padding: pad0, sizingH: 'fill', sizingV: 'hug', children: [photo, text] });
}

const cardRow = (k: number, cards: SceneNode[]) => makeFrame(0, 0, 536, 260, { name: `Units row ${k} [stack]`, fill: null, clip: false, layout: 'row', gap: 16, padding: pad0, sizingH: 'fill', sizingV: 'hug', alignItems: 'start', children: cards });

function keyedBoard(): Doc {
  const units = makeFrame(0, 0, 600, 600, {
    name: 'Section / Units',
    key: 'units',
    fill: null,
    clip: false,
    layout: 'column',
    gap: 20,
    padding: { t: 32, r: 32, b: 32, l: 32 },
    sizingH: 'fill',
    sizingV: 'hug',
    children: [
      emailText('A few units open right now', 'h3'),
      cardRow(1, [unitCard(1, '$3,840', '1735 Van Ness Unit 205', 'Pac Heights  |  Studio  |  1 BA'), unitCard(2, '$4,700', '355 Fulton Unit 308', 'Hayes Valley  |  1 BD  |  1 BA')]),
      cardRow(2, [unitCard(3, '$6,445', '1301 Leavenworth Unit 14', 'Nob Hill  |  2 BD  |  1 BA'), unitCard(4, '$7,740', '1660 Bay Unit 305', 'Marina  |  2 BD  |  2 BA')]),
    ],
  });
  return { ...makeEmailBoard('Listing cards test (keyed)'), nodes: [makeEmailRoot([units, footerSection()], 'Email / Listing cards test')] };
}

function repeatBoard(): Doc {
  const card = unitCard(1, '{{price}}', '{{address}}', '{{details}}');
  walk([card], (n) => void delete n.key);
  const section = makeFrame(0, 0, 600, 400, { name: 'Section / Units', fill: null, clip: false, layout: 'column', gap: 20, padding: { t: 32, r: 32, b: 32, l: 32 }, sizingH: 'fill', sizingV: 'hug', children: [card] });
  const board: Doc = { ...makeEmailBoard('Listing cards test (repeat)'), nodes: [makeEmailRoot([section, footerSection()], 'Email / Listing repeat test')] };
  const photo = card.children[0];
  startRepeat(board, card.id, { columns: 2, fields: { Photo: photo } });
  return board;
}

export interface ListingCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

const texts = (d: Doc, key: string) => {
  let out: string | null = null;
  walk(d.nodes, (n) => void (n.key === key && n.type === 'text' && (out = (n as TextNode).text)));
  return out;
};

export async function listingCardsSelfTest(): Promise<ListingCheck[]> {
  const out: ListingCheck[] = [];
  const expect = (check: string, ok: boolean, detail?: unknown) => out.push({ check, ok, ...(ok ? {} : { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }) });
  const reads = await fixtureReads();
  const s = () => useStore.getState();

  // ---- keyed cards, sorted by price, 5 listings into 4 cards ----
  const keyedId = s().addBoard(keyedBoard());
  const set = findCardSet(s().doc);
  expect('finds the keyed cards', set?.kind === 'keyed' && set.cards.length === 4, set);
  const pastBefore = s().past.length;
  const report = await fillCardsFromListings(reads, { sort: 'price' });
  const d = s().project.boards.find((b) => b.id === keyedId)!;
  expect('one undo step for the whole fill', s().past.length === pastBefore + 1, s().past.length - pastBefore);
  expect('five cards filled, one added', report.cards.length === 5 && report.added === 1, report);
  expect('the failed link is reported', report.failed.length === 1 && /isn’t on the site/.test(report.failed[0].error), report.failed);
  expect('card 1 is the cheapest (1690 Broadway, $4,600)', texts(d, 'unit-1-price') === '$4,600' && texts(d, 'unit-1-address') === '1690 Broadway Unit 205', [texts(d, 'unit-1-price'), texts(d, 'unit-1-address')]);
  expect('card 2 is 2238 Hyde at $11,200', texts(d, 'unit-2-price') === '$11,200' && texts(d, 'unit-2-address') === '2238 Hyde Unit 8', [texts(d, 'unit-2-price'), texts(d, 'unit-2-address')]);
  expect('details keep the card’s separator', texts(d, 'unit-2-meta') === 'Russian Hill  |  3 BD  |  2 BA', texts(d, 'unit-2-meta'));
  expect('no price becomes a {{PRICE}} token', texts(d, 'unit-3-price') === '{{PRICE}}', texts(d, 'unit-3-price'));
  expect('a studio says Studio', [3, 4, 5].some((n) => /Tenderloin {2}\| {2}Studio {2}\| {2}1 BA/.test(texts(d, `unit-${n}-meta`) ?? '')), [3, 4, 5].map((n) => texts(d, `unit-${n}-meta`)));
  expect('the added card is unit-5', texts(d, 'unit-5-address') === '1771 Highland Place Unit 105', texts(d, 'unit-5-address'));
  let rows = 0;
  walk(d.nodes, (n) => void (n.type === 'frame' && /^Units row \d/.test(n.name) && rows++));
  expect('three card rows now', rows === 3, rows);
  const fixed = (() => {
    let n: TextNode | null = null;
    walk(d.nodes, (x) => void (x.key === 'unit-2-price' && (n = x as TextNode)));
    return n as TextNode | null;
  })();
  expect('a price too wide for its box hugs it', fixed?.sizingH === 'hug', fixed?.sizingH);
  const photoIds: string[] = [];
  walk(d.nodes, (n) => void (n.key && /^unit-\d-photo$/.test(n.key) && photoIds.push(n.id)));
  const urls = d.email?.imageUrls ?? {};
  const layout = currentLayout();
  const box = layout.get(photoIds[0]);
  expect('photo frame laid out', !!box && box.w > 200, box);
  const crop = box ? `https://dam.getresi.co/cdn-cgi/image/width=${Math.round(box.w * 2)},height=${Math.round(box.h * 2)},fit=cover/` : '?';
  expect('photos use the DAM crop at 2x the frame', (urls[photoIds[0]] ?? '').startsWith(crop), [urls[photoIds[0]], crop]);
  expect('listings without photos get no picture address', photoIds.length === 5 && Object.keys(urls).length === 3, urls);
  const cardFrames: SceneNode[] = [];
  walk(d.nodes, (n) => void (n.type === 'frame' && /^Unit \d$/.test(n.name) && cardFrames.push(n)));
  expect('each card links to its listing', cardFrames.length === 5 && cardFrames.every((c) => /^https:\/\/rentbt\.com\/listing\//.test(nodeLink(c) ?? '')), cardFrames.map((c) => nodeLink(c)));
  const photo2 = findNode(d.nodes, photoIds[1]);
  expect('alt text names the room and the unit', /\[alt:Living room at 2238 Hyde Street unit 8\]/.test(photo2?.name ?? ''), photo2?.name);
  const root = d.nodes[0] as FrameNode;
  const html = buildEmailHtml(root, layout, { title: 't', imageUrl: (id, f) => pictureSrc(pictureSources(d, {}, null), id, f) }).html;
  expect('the HTML loads the cropped DAM photos', (html.match(/src="https:\/\/dam\.getresi\.co\/cdn-cgi\/image\//g) ?? []).length === 3, (html.match(/<img[^>]+>/g) ?? []).slice(0, 3));
  expect('the HTML links the cards', html.includes('href="https://rentbt.com/listing/2238-hyde-street-unit-8/"'));
  s().undo();
  expect('undo puts the cards back', texts(s().project.boards.find((b) => b.id === keyedId)!, 'unit-1-price') === '$3,840');

  // ---- fewer listings than cards, as pasted ----
  const two = await fillCardsFromListings(reads.slice(0, 2), { sort: 'as-given' });
  expect('two links, four cards: cards 3 and 4 left alone', two.extras.join(',') === '3,4' && texts(s().doc, 'unit-3-price') === '$6,445', two);
  expect('as pasted: Hyde first', texts(s().doc, 'unit-1-address') === '2238 Hyde Unit 8', texts(s().doc, 'unit-1-address'));
  const trayBefore = Object.keys(s().doc.assets).length;
  await fillCardsFromListings(reads.slice(0, 2), { sort: 'as-given' });
  expect('filling again reuses the photos already in the tray', Object.keys(s().doc.assets).length === trayBefore, [trayBefore, Object.keys(s().doc.assets).length]);
  expect('a widened price box is a note, not a problem', !two.cards.some((c) => c.problems.some((p) => /Widened/.test(p))));

  // ---- a repeat ----
  const repeatId = s().addBoard(repeatBoard());
  const rset = findCardSet(s().doc);
  expect('finds the repeat and its fields', rset?.kind === 'repeat' && !!rset.fields.price && !!rset.fields.address && !!rset.fields.details && !!rset.fields.photo, rset);
  const r = await fillCardsFromListings(reads, { sort: 'price' });
  const rd = s().project.boards.find((b) => b.id === repeatId)!;
  const frame = (() => {
    let f: FrameNode | null = null;
    walk(rd.nodes, (n) => void (n.type === 'frame' && n.repeat && (f = n)));
    return f as FrameNode | null;
  })();
  expect('the repeat has five rows', frame?.repeat?.rows.length === 5 && r.added === 4, frame?.repeat?.rows.length);
  expect('repeat row 1 is the cheapest', frame?.repeat?.rows[0].price === '$4,600' && frame?.repeat?.rows[0].address === '1690 Broadway Unit 205', frame?.repeat?.rows[0]);
  expect('a link column was added', !!frame?.repeat?.fields.includes('Listing link') && frame!.repeat!.rows[1]['Listing link'] === 'https://rentbt.com/listing/2238-hyde-street-unit-8/', frame?.repeat?.fields);
  let repeatPrice: TextNode | null = null;
  walk(rd.nodes, (n) => void (n.type === 'text' && n.bind?.text === '{{price}}' && (repeatPrice ??= n)));
  expect('the repeat’s price box hugs $11,200', (repeatPrice as TextNode | null)?.sizingH === 'hug', (repeatPrice as TextNode | null)?.sizingH);
  const rurls = rd.email?.imageUrls ?? {};
  expect('repeat photos have their own addresses', Object.keys(rurls).length === 3 && Object.values(rurls).every((u) => u.includes('/cdn-cgi/image/')), rurls);
  const rhtml = buildEmailHtml(rd.nodes[0] as FrameNode, currentLayout(), { title: 't', imageUrl: (id, f) => pictureSrc(pictureSources(rd, {}, null), id, f) }).html;
  expect('repeat cards link in the HTML', rhtml.includes('href="https://rentbt.com/listing/1690-broadway-street-unit-205/"'));

  if (typeof console !== 'undefined' && console.table) console.table(out.map(({ check, ok, detail }) => ({ check, ok: ok ? 'ok' : 'FAIL', detail: detail ?? '' })));
  return out;
}
