// Reading a listing page into the facts a listing card shows. Pure: no DOM, no store, so it runs
// in the renderer, in automation and in a plain node test (scripts/test-listings.ts).
//
// What rentbt.com listing pages carry (checked November 2026, fixtures in ./fixtures):
// - JSON-LD { "@type": "Apartment" } with address.streetAddress, numberOfRooms (= bedrooms),
//   floorSize, offers.price (only while it's on the market) and image (the first photo).
// - <meta name="description">: "3 bed, 2 bath, 1,101 sq ft apartment at 2238 Hyde Street in
//   Russian Hill, San Francisco. $11,200/mo." (the price only while it's on the market).
// - The details card: <h3>Russian Hill</h3> <h1>2238 Hyde Street</h1> <div>Unit 8</div>, then
//   "3 Bed", "2 Bath", "1,101 SQFT" and "$11,200 / MONTH".
// - Gallery <img src="https://dam.getresi.co/<id>/conversions/<name>-full.jpg"> in page order.
// - A second, site-wide set of og: tags further down ("News and Articles", a generic photo):
//   only the first of each tag is the listing's, and on rentbt only DAM photos count.
// Other sites get what the generic tags give: JSON-LD, og:title, og:image, the description.

export interface ListingFacts {
  url: string;
  /** Street address, "2238 Hyde Street". */
  address: string | null;
  /** "8", "00A". */
  unit: string | null;
  /** Monthly rent in dollars. */
  price: number | null;
  /** "$11,200". */
  priceText: string | null;
  /** 0 for a studio. */
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  neighborhood: string | null;
  city: string | null;
  /** Photo URLs, best first (floor plans last). */
  photos: string[];
  /** false when the page says it's off the market (no price is shown then). */
  available: boolean | null;
  /** The page title, for pages that aren't listings. */
  title: string | null;
  /** Facts a card needs that the page didn't have. */
  missing: ListingField[];
}

export type ListingField = 'address' | 'unit' | 'price' | 'beds' | 'baths' | 'neighborhood' | 'photo';

export const LISTING_FIELD_LABEL: Record<ListingField, string> = {
  address: 'address',
  unit: 'unit',
  price: 'price',
  beds: 'beds',
  baths: 'baths',
  neighborhood: 'neighborhood',
  photo: 'photo',
};

// ---------- small HTML helpers (regex, so this stays DOM-free) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

const clean = (s: string | null | undefined) => {
  const t = decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || null;
};

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}

/** <meta property|name=key content> values, first one first. */
function metaTags(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') ?? attr(m[0], 'name'))?.toLowerCase();
    const content = attr(m[0], 'content');
    if (!key || content === null) continue;
    out.set(key, [...(out.get(key) ?? []), content.trim()]);
  }
  return out;
}

function jsonLd(html: string): any[] {
  const out: any[] = [];
  const add = (v: any) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') {
      out.push(v);
      if (v['@graph']) add(v['@graph']);
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      add(JSON.parse(m[1].trim()));
    } catch {
      // a broken block is skipped; the others still count
    }
  }
  return out;
}

const PLACE_TYPES = /apartment|residence|house|accommodation|place|product|realestatelisting|offer|room|suite/i;
const typeOf = (o: any) => [o?.['@type']].flat().join(' ');

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(v);
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

const firstString = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (v && typeof v === 'object') return firstString((v as any).url ?? (v as any).contentUrl);
  return null;
};

function absolute(src: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(src.trim()), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** "$11,200". Whole dollars, no locale surprises. */
export function formatPrice(n: number): string {
  const whole = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}`;
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

// ---------- DAM photos ----------

const DAM_HOST = 'dam.getresi.co';
const isDam = (url: string) => {
  try {
    return new URL(url).hostname === DAM_HOST;
  } catch {
    return false;
  }
};

/**
 * A photo cropped to exactly widthPx × heightPx on the server. Resi's DAM (dam.getresi.co) runs
 * Cloudflare's resizer, so `/cdn-cgi/image/width=…,height=…,fit=cover/<path>` returns that size,
 * cropped from the centre. Other hosts come back unchanged.
 */
export function croppedPhotoUrl(url: string, widthPx: number, heightPx: number): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.hostname !== DAM_HOST) return url;
  const w = Math.max(1, Math.round(widthPx));
  const h = Math.max(1, Math.round(heightPx));
  // Already resized: swap the options, keep the photo.
  const path = u.pathname.replace(/^\/cdn-cgi\/image\/[^/]*\//, '/').replace(/^\/+/, '');
  return `https://${DAM_HOST}/cdn-cgi/image/width=${w},height=${h},fit=cover/${path}${u.search}`;
}

const FLOOR_PLAN = /floor[\s_-]?plan|site[\s_-]?plan/i;

// ---------- the parser ----------

/** Facts from a listing page. Anything the page doesn't say is null (and named in `missing`). */
export function parseListingPage(html: string, url: string): ListingFacts {
  const page = String(html ?? '');
  const metas = metaTags(page);
  const meta = (k: string) => metas.get(k)?.[0] ?? null;
  const ld = jsonLd(page);
  const place = ld.find((o) => PLACE_TYPES.test(typeOf(o)) && (o.address || o.offers || o.numberOfRooms || o.floorSize)) ?? null;
  const offer = [place?.offers].flat().find((o) => o && typeof o === 'object') ?? (ld.find((o) => /offer/i.test(typeOf(o))) || null);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep '' for a malformed url
  }
  const rentbt = host === 'rentbt.com' || /dam\.getresi\.co/.test(page);

  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1]) ?? meta('og:title');
  const description = clean(place?.description) ?? meta('description') ?? meta('og:description') ?? '';

  // The details card: neighborhood, street, unit.
  const card = /<h3[^>]*>([^<]{1,60})<\/h3>\s*<h1[^>]*>([^<]{1,120})<\/h1>\s*<div[^>]*>\s*Unit\s+([^<]{1,20}?)\s*<\/div>/i.exec(page);
  // "2238 Hyde Street – Unit 8 | Brick + Timber"
  const titled = /^(.+?)\s+[–—-]\s+Unit\s+([^\s|]+)/i.exec(title ?? '');
  // ".../listing/2238-hyde-street-unit-8/"
  const slug = /\/listing\/(\d+[a-z]?)-([a-z0-9-]+?)-unit-([a-z0-9]+)(?:-\d+)?\/?$/i.exec(url.split(/[?#]/)[0]);
  // "… apartment at 2238 Hyde Street in Russian Hill, San Francisco."
  const at = /\bat\s+(.+?)\s+in\s+([^,.]+?)(?:,\s*([^.]+?))?\.(?:\s|$)/i.exec(description);

  const address = clean(card?.[2]) ?? clean(place?.address?.streetAddress) ?? clean(titled?.[1]) ?? clean(at?.[1]) ?? (slug ? `${slug[1]} ${titleCase(slug[2].replace(/-/g, ' '))}` : null);
  const unit = clean(card?.[3]) ?? clean(titled?.[2]) ?? (slug ? slug[3].toUpperCase() : null);

  // Beds and baths: the card's "3 Bed" / "Studio", then the description, then schema.org.
  const bedsText = />\s*(\d+(?:\.\d+)?)\s*(?:Beds?|BD|Bedrooms?)\s*</i.exec(page) ?? />\s*(Studio)\s*</i.exec(page);
  const descBeds = /(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:bed|bd|br)\b/i.exec(description) ?? (/\bstudio\b/i.test(description) ? ['', '0'] : null);
  const beds = bedsText ? (/studio/i.test(bedsText[1]) ? 0 : num(bedsText[1])) : descBeds ? num(descBeds[1]) : (num(place?.numberOfBedrooms) ?? num(place?.numberOfRooms));
  const bathsText = />\s*(\d+(?:\.\d+)?)\s*(?:Baths?|BA|Bathrooms?)\s*</i.exec(page);
  const descBaths = /(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:bath|ba)\b/i.exec(description);
  const baths = bathsText ? num(bathsText[1]) : descBaths ? num(descBaths[1]) : num(place?.numberOfBathroomsTotal ?? place?.numberOfFullBathrooms);
  const sqftText = />\s*([\d,]+)\s*(?:SQFT|sq\.?\s*ft)\s*</i.exec(page) ?? /([\d,]+)\s*sq\.?\s*ft/i.exec(description);
  const sqft = sqftText ? num(sqftText[1]) : num(place?.floorSize?.value ?? place?.floorSize);

  // Price: schema.org, the card's "$11,200 / MONTH", then "$11,200/mo" anywhere in the description.
  const cardPrice = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:<[^>]*>\s*)*\/\s*(?:MONTH|mo)\b/i.exec(page);
  const descPrice = /\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*(?:mo|month)\b/i.exec(description);
  const price = num(offer?.price) ?? num(offer?.lowPrice) ?? (cardPrice ? num(cardPrice[1]) : null) ?? (descPrice ? num(descPrice[1]) : null);

  const neighborhood = clean(card?.[1]) ?? clean(at?.[2]) ?? clean(place?.address?.addressNeighborhood) ?? null;
  const city = clean(place?.address?.addressLocality) ?? clean(at?.[3]) ?? null;

  const availability = String(offer?.availability ?? '');
  const available = /InStock|InStoreOnly|LimitedAvailability|PreOrder/i.test(availability) ? true : /OutOfStock|SoldOut|Discontinued/i.test(availability) ? false : price !== null ? true : null;

  // Photos: schema.org image, the gallery, then og:/twitter: image. On rentbt only DAM photos count:
  // its second, site-wide og:image is a stock photo, not the unit.
  const seen = new Set<string>();
  const photos: string[] = [];
  const addPhoto = (src: string | null | undefined) => {
    if (!src) return;
    const abs = absolute(src, url);
    if (!abs || seen.has(abs)) return;
    if (rentbt && !isDam(abs)) return;
    if (/\.(svg|gif)(\?|$)/i.test(abs) || /logo|icon|sprite|avatar|placeholder/i.test(abs)) return;
    seen.add(abs);
    photos.push(abs);
  };
  for (const im of [place?.image].flat()) addPhoto(firstString(im));
  for (const m of page.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(m[0], 'src') ?? attr(m[0], 'data-src');
    if (src && (!rentbt || isDam(absolute(src, url) ?? ''))) addPhoto(src);
  }
  addPhoto(meta('og:image') ?? meta('og:image:secure_url'));
  addPhoto(meta('twitter:image'));
  // A floor plan is a poor card photo: keep it, last.
  photos.sort((a, b) => Number(FLOOR_PLAN.test(a)) - Number(FLOOR_PLAN.test(b)));

  const facts: ListingFacts = {
    url,
    address,
    unit,
    price,
    priceText: price !== null ? formatPrice(price) : null,
    beds,
    baths,
    sqft,
    neighborhood,
    city,
    photos,
    available,
    title: title ? title.replace(/\s*\|\s*[^|]+$/, '').trim() || title : null,
    missing: [],
  };
  facts.missing = missingFields(facts);
  return facts;
}

export function missingFields(f: ListingFacts): ListingField[] {
  const out: ListingField[] = [];
  if (!f.address) out.push('address');
  if (!f.unit) out.push('unit');
  if (f.price === null) out.push('price');
  if (f.beds === null) out.push('beds');
  if (f.baths === null) out.push('baths');
  if (!f.neighborhood) out.push('neighborhood');
  if (!f.photos.length) out.push('photo');
  return out;
}

// ---------- what a card shows ----------

/** Street types the house style drops on cards ("2238 Hyde Street" → "2238 Hyde"). Places, ways and terraces stay. */
const DROPPED_STREET_TYPE = /\s+(Street|St\.?|Avenue|Ave\.?)$/i;

export function shortStreet(address: string): string {
  const short = address.replace(DROPPED_STREET_TYPE, '').trim();
  return /\s/.test(short) ? short : address; // never leave just the number
}

/** "2238 Hyde Unit 8". */
export function cardAddressLine(f: Pick<ListingFacts, 'address' | 'unit'>, opts: { short?: boolean } = {}): string | null {
  if (!f.address) return null;
  const street = opts.short === false ? f.address : shortStreet(f.address);
  return f.unit ? `${street} Unit ${f.unit}` : street;
}

export const bedsLabel = (beds: number | null) => (beds === null ? null : beds === 0 ? 'Studio' : `${beds} BD`);
export const bathsLabel = (baths: number | null) => (baths === null ? null : `${baths} BA`);

/** "Russian Hill | 3 BD | 2 BA". `sep` is the separator the card already uses. */
export function cardDetailsLine(f: Pick<ListingFacts, 'neighborhood' | 'beds' | 'baths'>, sep = ' | '): string | null {
  const parts = [f.neighborhood, bedsLabel(f.beds), bathsLabel(f.baths)].filter((p): p is string => !!p);
  return parts.length ? parts.join(sep) : null;
}

const ROOMS: [RegExp, string][] = [
  [/living[\s_-]?room|living\b/i, 'Living room'],
  [/kitchen/i, 'Kitchen'],
  [/bed[\s_-]?room/i, 'Bedroom'],
  [/bath[\s_-]?room/i, 'Bathroom'],
  [/dining/i, 'Dining room'],
  [/exterior|facade|building/i, 'Building'],
  [/patio|deck|balcony|terrace|garden|yard/i, 'Outdoor space'],
  [/view/i, 'View'],
  [/lobby/i, 'Lobby'],
];

/** Alt text for a listing photo: "Living room at 2238 Hyde Street unit 8". */
export function photoAlt(f: Pick<ListingFacts, 'address' | 'unit'>, photoUrl?: string): string {
  const where = [f.address, f.unit ? `unit ${f.unit}` : null].filter(Boolean).join(' ') || 'the apartment';
  const file = (photoUrl ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
  const room = ROOMS.find(([re]) => re.test(file))?.[1];
  return room ? `${room} at ${where}` : `Photo of ${where}`;
}

/**
 * Why a fetched page isn't the listing that was asked for, or null. rentbt.com sends a unit that's
 * gone to its search page (/browse-apartments/?resi_unit_notice=unit_not_found) with a 200.
 */
export function listingGone(requested: string, landed: string): string | null {
  if (/[?&]resi_unit_notice=unit_not_found\b/.test(landed)) return 'That unit isn’t on the site any more (it sent the link to the search page).';
  try {
    const a = new URL(requested);
    const b = new URL(landed);
    if (/\/listing\//.test(a.pathname) && !/\/listing\//.test(b.pathname)) return 'That link now opens a different page, so the listing is probably gone.';
  } catch {
    // compare nothing for malformed urls
  }
  return null;
}

// ---------- links and order ----------

/** Links pasted one per line, or separated by spaces or commas. Dupes dropped, order kept. */
export function parseListingLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    let t = raw.trim().replace(/^[<(["']+|[>)\]"'.]+$/g, '');
    if (!t) continue;
    if (!/^https?:\/\//i.test(t)) {
      if (!/^[\w-]+(\.[\w-]+)+\//.test(t)) continue;
      t = `https://${t}`;
    }
    try {
      const u = new URL(t);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (!out.includes(u.href)) out.push(u.href);
    } catch {
      // not a link
    }
  }
  return out;
}

export type ListingSort = 'price' | 'as-given';

/** Cheapest first (stable; listings without a price go last), or as given. */
export function sortListings<T extends { price: number | null }>(list: T[], sort: ListingSort = 'price'): T[] {
  if (sort === 'as-given') return [...list];
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.price ?? Infinity) - (b.x.price ?? Infinity) || a.i - b.i)
    .map((e) => e.x);
}
