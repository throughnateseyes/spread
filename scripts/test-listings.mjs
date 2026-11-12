// Offline checks for the listing page parser (src/email/listings.ts) against saved rentbt.com pages.
//   node scripts/test-listings.mjs
// Needs Node 23.6+ (runs the .ts file directly). The fixtures are trimmed real pages, so a change
// to rentbt.com's markup shows up here first: fetch a fresh page and compare.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardAddressLine,
  cardDetailsLine,
  croppedPhotoUrl,
  listingGone,
  parseListingLinks,
  parseListingPage,
  photoAlt,
  sortListings,
} from '../src/email/listings.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'email', 'fixtures');
const page = (name) => readFileSync(join(FIX, name), 'utf8');
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`ok  ${name}`);
};

check('on the market: 2238 Hyde Street unit 8', () => {
  const f = parseListingPage(page('rentbt-2238-hyde-unit-8.html'), 'https://rentbt.com/listing/2238-hyde-street-unit-8/');
  assert.equal(f.address, '2238 Hyde Street');
  assert.equal(f.unit, '8');
  assert.equal(f.price, 11200);
  assert.equal(f.priceText, '$11,200');
  assert.equal(f.beds, 3);
  assert.equal(f.baths, 2);
  assert.equal(f.sqft, 1101);
  assert.equal(f.neighborhood, 'Russian Hill');
  assert.equal(f.city, 'San Francisco');
  assert.equal(f.available, true);
  assert.equal(f.photos[0], 'https://dam.getresi.co/54802/conversions/2238-Hyde-Unit-8-Living-Room-full.jpg');
  assert.ok(f.photos.length >= 15, `photos: ${f.photos.length}`);
  assert.ok(f.photos.every((p) => p.startsWith('https://dam.getresi.co/')), 'only DAM photos');
  assert.ok(!f.photos.some((p) => /wp-content|700-Church/.test(p)), 'not the site-wide og:image');
  assert.match(f.photos.at(-1), /Floorplan/, 'floor plan last');
  assert.deepEqual(f.missing, []);
  assert.equal(cardAddressLine(f), '2238 Hyde Unit 8');
  assert.equal(cardAddressLine(f, { short: false }), '2238 Hyde Street Unit 8');
  assert.equal(cardDetailsLine(f), 'Russian Hill | 3 BD | 2 BA');
  assert.equal(cardDetailsLine(f, '  |  '), 'Russian Hill  |  3 BD  |  2 BA');
  assert.equal(photoAlt(f, f.photos[0]), 'Living room at 2238 Hyde Street unit 8');
});

check('on the market: 1690 Broadway unit 205', () => {
  const f = parseListingPage(page('rentbt-1690-broadway-unit-205.html'), 'https://rentbt.com/listing/1690-broadway-street-unit-205/');
  assert.equal(f.price, 4600);
  assert.equal(cardAddressLine(f), '1690 Broadway Unit 205');
  assert.equal(cardDetailsLine(f), 'Pacific Heights | 1 BD | 1 BA');
  assert.ok(f.photos.length >= 5);
  assert.deepEqual(f.missing, []);
});

check('a studio: 434 Leavenworth Street unit 111', () => {
  const f = parseListingPage(page('rentbt-434-leavenworth-unit-111.html'), 'https://rentbt.com/listing/434-leavenworth-street-unit-111/');
  assert.equal(f.beds, 0);
  assert.equal(cardDetailsLine(f), 'Tenderloin | Studio | 1 BA');
});

check('off the market, with photos: 1401 Jones Street unit 00A', () => {
  const f = parseListingPage(page('rentbt-1401-jones-unit-00a.html'), 'https://rentbt.com/listing/1401-jones-street-unit-00a/');
  assert.equal(f.address, '1401 Jones Street');
  assert.equal(f.unit, '00A');
  assert.equal(f.price, null);
  assert.equal(f.priceText, null);
  assert.equal(f.beds, 3);
  assert.equal(f.baths, 2.5);
  assert.equal(f.neighborhood, 'Nob Hill');
  assert.equal(f.photos[0], 'https://dam.getresi.co/21891/conversions/1401-Jones-Unit-A-Kitchen-1-full.jpg');
  assert.deepEqual(f.missing, ['price']);
  assert.equal(cardDetailsLine(f), 'Nob Hill | 3 BD | 2.5 BA');
});

check('off the market, no photos: 1771 Highland Place unit 105', () => {
  const f = parseListingPage(page('rentbt-1771-highland-unit-105.html'), 'https://rentbt.com/listing/1771-highland-place-unit-105/');
  assert.equal(f.address, '1771 Highland Place');
  assert.equal(f.unit, '105');
  assert.equal(f.available, false);
  assert.equal(f.neighborhood, 'Berkeley');
  assert.deepEqual(f.photos, [], 'the generic site photo is not the unit');
  assert.deepEqual(f.missing, ['price', 'photo']);
  assert.equal(cardAddressLine(f), '1771 Highland Place Unit 105', 'Place is kept');
});

check('the link alone, when the page says nothing', () => {
  const f = parseListingPage('<html><head><title>Not found</title></head><body></body></html>', 'https://rentbt.com/listing/355-fulton-street-unit-308/');
  assert.equal(f.address, '355 Fulton Street');
  assert.equal(f.unit, '308');
  assert.deepEqual(f.missing, ['price', 'beds', 'baths', 'neighborhood', 'photo']);
});

check('another site: og: tags and JSON-LD', () => {
  const html = `<html><head><title>Sunny 1BR | Example Rentals</title>
    <meta property="og:title" content="Sunny 1BR at 12 Oak St">
    <meta property="og:image" content="/img/oak-12-living.jpg">
    <meta name="description" content="Studio, 1 bath at 12 Oak St in Hayes Valley, San Francisco. $3,100/mo">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Residence","address":{"streetAddress":"12 Oak St","addressLocality":"San Francisco"},"offers":{"@type":"Offer","price":"3100"}}]}</script>
    </head><body><img src="/img/logo.svg"></body></html>`;
  const f = parseListingPage(html, 'https://example.com/units/12-oak');
  assert.equal(f.address, '12 Oak St');
  assert.equal(f.price, 3100);
  assert.equal(f.beds, 0);
  assert.equal(f.baths, 1);
  assert.equal(f.neighborhood, 'Hayes Valley');
  assert.deepEqual(f.photos, ['https://example.com/img/oak-12-living.jpg']);
  assert.equal(cardDetailsLine(f), 'Hayes Valley | Studio | 1 BA');
  assert.equal(cardAddressLine(f), '12 Oak');
});

check('listingGone', () => {
  assert.match(listingGone('https://rentbt.com/listing/x-unit-1/', 'https://rentbt.com/browse-apartments/?resi_unit_notice=unit_not_found'), /isn’t on the site/);
  assert.match(listingGone('https://rentbt.com/listing/x-unit-1/', 'https://rentbt.com/'), /different page/);
  assert.equal(listingGone('https://rentbt.com/listing/x-unit-1/', 'https://rentbt.com/listing/x-unit-1/'), null);
});

check('croppedPhotoUrl', () => {
  const src = 'https://dam.getresi.co/54802/conversions/2238-Hyde-Unit-8-Living-Room-full.jpg';
  assert.equal(croppedPhotoUrl(src, 520, 336), 'https://dam.getresi.co/cdn-cgi/image/width=520,height=336,fit=cover/54802/conversions/2238-Hyde-Unit-8-Living-Room-full.jpg');
  assert.equal(croppedPhotoUrl(croppedPhotoUrl(src, 520, 336), 1072, 714.4), 'https://dam.getresi.co/cdn-cgi/image/width=1072,height=714,fit=cover/54802/conversions/2238-Hyde-Unit-8-Living-Room-full.jpg', 'resizing again swaps the size');
  assert.equal(croppedPhotoUrl('https://example.com/a.jpg', 520, 336), 'https://example.com/a.jpg');
  assert.equal(croppedPhotoUrl('not a url', 1, 1), 'not a url');
});

check('parseListingLinks', () => {
  const text = `https://rentbt.com/listing/2238-hyde-street-unit-8/
    rentbt.com/listing/1401-jones-street-unit-00a/, https://rentbt.com/listing/2238-hyde-street-unit-8/
    <https://rentbt.com/listing/355-fulton-street-unit-308/> and some words`;
  assert.deepEqual(parseListingLinks(text), [
    'https://rentbt.com/listing/2238-hyde-street-unit-8/',
    'https://rentbt.com/listing/1401-jones-street-unit-00a/',
    'https://rentbt.com/listing/355-fulton-street-unit-308/',
  ]);
});

check('sortListings', () => {
  const list = [{ price: 4700 }, { price: null }, { price: 3840 }, { price: 4700, b: 1 }];
  assert.deepEqual(sortListings(list, 'price'), [{ price: 3840 }, { price: 4700 }, { price: 4700, b: 1 }, { price: null }]);
  assert.deepEqual(sortListings(list, 'as-given'), list);
});

console.log(`\n${passed} checks passed`);
