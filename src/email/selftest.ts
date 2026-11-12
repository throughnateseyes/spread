import type { Doc, FrameNode, ImageNode } from '../types';
import { computeLayout } from '../layout';
import { makeEmailBoard, walk } from '../tree';
import { buildEmailHtml, collectEmailImages, GMAIL_CLIP_BYTES, joinUrl } from './html';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES, makeEmailRoot } from './templates';
import { renderEmailImages, withHash } from './images';
import { missingAddressText, pictureSources, pictureSrc, picturesToRender, picturesWithoutAddress, platformWarnings, renderedNames } from './hosting';
import { sendChecks } from './checklist';

// Dev self-test for the email engine. From devtools:
//   (await import('/src/email/selftest.ts')).emailSelfTest()
// or, once anything imports this module, window.__emailSelfTest().
// Builds every template with empty photo placeholders, lays it out, compiles it, and reports
// size and warnings. Pass { html: true } to get the HTML back (e.g. to paste into a preview).

export interface EmailSelfTestResult {
  template: string;
  bytes: number;
  kb: string;
  underGmailLimit: boolean;
  images: number;
  warnings: string[];
  /** Structural problems found by the test itself (empty means pass). */
  failures: string[];
  html?: string;
}

function check(html: string, root: FrameNode): string[] {
  const f: string[] = [];
  if (!html.startsWith('<!DOCTYPE html>')) f.push('missing doctype');
  if (!/<meta name="viewport"/.test(html)) f.push('missing viewport meta');
  if (!/<!--\[if mso\]>/.test(html)) f.push('missing MSO wrapper');
  if (/display:\s*(flex|grid)/i.test(html)) f.push('uses flexbox/grid');
  if (/<script/i.test(html)) f.push('contains a script');
  const opens = (html.match(/<table\b/g) ?? []).length;
  const closes = (html.match(/<\/table>/g) ?? []).length;
  if (opens !== closes) f.push(`unbalanced tables (${opens} open, ${closes} close)`);
  const tdO = (html.match(/<td\b/g) ?? []).length;
  const tdC = (html.match(/<\/td>/g) ?? []).length;
  if (tdO !== tdC) f.push(`unbalanced cells (${tdO} open, ${tdC} close)`);
  if (/<img(?![^>]*\balt=)[^>]*>/i.test(html)) f.push('an <img> has no alt attribute');
  if (!/Unsubscribe/.test(html)) f.push('no unsubscribe text');
  if (root.w !== 600) f.push(`root is ${root.w}px wide`);
  return f;
}

export function emailSelfTest(opts: { html?: boolean } = {}): EmailSelfTestResult[] {
  const cases: { id: string; root: FrameNode }[] = EMAIL_TEMPLATES.map((t) => ({ id: t.id, root: t.build([]) }));
  // Every section in one email, so the button / unit grid / details paths are exercised too.
  cases.push({ id: 'all-sections', root: makeEmailRoot(EMAIL_SECTIONS.map((s) => s.build([])), 'Email / All sections') });
  const results = cases.map(({ id, root }) => {
    const layout = computeLayout([root]);
    const r = buildEmailHtml(root, layout, {
      title: id,
      preheader: 'Self-test preview text',
      imageUrl: (_nodeId, file) => joinUrl('https://cdn.example.com/eblasts/selftest/', file),
    });
    return {
      template: id,
      bytes: r.bytes,
      kb: (r.bytes / 1024).toFixed(1) + ' KB',
      underGmailLimit: r.bytes <= GMAIL_CLIP_BYTES,
      images: r.images.length,
      warnings: r.warnings,
      failures: check(r.html, root),
      ...(opts.html ? { html: r.html } : {}),
    };
  });
  if (typeof console !== 'undefined' && console.table) {
    console.table(results.map(({ template, kb, images, warnings, failures }) => ({ template, kb, images, warnings: warnings.length, failures: failures.join('; ') || 'ok' })));
  }
  return results;
}

// ---------- picture addresses ----------
// From devtools: await (await import('/src/email/selftest.ts')).emailHostingSelfTest()
// Checks the one resolver every export path uses: hosting defaults, the "no web address" block,
// content-hashed file names, pictures' own addresses and the RentCafe platform.

export interface HostingCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export async function emailHostingSelfTest(): Promise<HostingCheck[]> {
  const out: HostingCheck[] = [];
  const expect = (check: string, ok: boolean, detail?: unknown) => out.push({ check, ok, ...(ok ? {} : { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }) });
  const root = makeEmailRoot(EMAIL_SECTIONS.map((sec) => sec.build([])), 'Email / Hosting test');
  const board = (email: Doc['email']): Doc => ({ ...makeEmailBoard('Hosting test'), nodes: [root], email });
  const layout = computeLayout([root]);
  const images = collectEmailImages(root, layout);
  expect('the test email has pictures', images.length >= 2, images.length);
  const [first, second] = images;
  const FOLDER = 'https://cdn.example.com/eblasts/test/';

  expect('withHash puts the hash before the extension', withHash('07-unit-6-photo.jpg', '3f9a1c') === '07-unit-6-photo-3f9a1c.jpg', withHash('07-unit-6-photo.jpg', '3f9a1c'));

  // Defaults: never WordPress without a connected site.
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem('spread.email.hosting');
  } catch {
    // no storage
  }
  if (!legacy) expect('no saved hosting and no WordPress: one folder address', pictureSources(board(undefined), {}, null).hosting.mode === 'base', pictureSources(board(undefined), {}, null).hosting);

  // No folder yet: every picture is blocked, and the message says what to do.
  const noFolder = pictureSources(board({ hosting: { mode: 'base', baseUrl: '' } }), {}, null);
  const lacking = picturesWithoutAddress(noFolder, images);
  expect('no folder: every picture lacks a web address', lacking.length === images.length, lacking.length);
  expect('no folder: the message asks for the folder address', /folder/i.test(missingAddressText(noFolder, lacking, 'app', null)), missingAddressText(noFolder, lacking, 'app', null));
  expect('no folder: src is the bare file name (draft only)', pictureSrc(noFolder, first.nodeId, first.fileName) === first.fileName, pictureSrc(noFolder, first.nodeId, first.fileName));

  // A folder, but not rendered yet: still blocked (the exported name needs the hash).
  const folder = board({ hosting: { mode: 'base', baseUrl: FOLDER } });
  expect('folder, not rendered: still blocked', picturesWithoutAddress(pictureSources(folder, {}, null), images).length === images.length);

  // Rendered: hashed names, full addresses, nothing blocked.
  const files = await renderEmailImages(root, layout, images, 1);
  const named = pictureSources(folder, { files: renderedNames(files) }, null);
  expect('every picture rendered', files.length === images.length, `${files.length} of ${images.length}`);
  expect('exported names carry a 12-character hash', files.every((f) => /-[0-9a-f]{12}\.(jpg|png)$/.test(f.fileName) && f.fileName === withHash(f.baseName, f.hash)), files.map((f) => f.fileName));
  expect('folder + rendered: nothing blocked', picturesWithoutAddress(named, images).length === 0, picturesWithoutAddress(named, images));
  expect('folder + rendered: src is folder + hashed name', pictureSrc(named, first.nodeId, first.fileName) === joinUrl(FOLDER, files[0].fileName), pictureSrc(named, first.nodeId, first.fileName));
  const html = buildEmailHtml(root, layout, { title: 't', imageUrl: (id, f) => pictureSrc(named, id, f) }).html;
  const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  expect('every <img> in the HTML has a full address', srcs.length === images.length && srcs.every((u) => u.startsWith(FOLDER)), srcs);

  // Same picture, same name; changed picture, new name.
  const again = await renderEmailImages(root, layout, images, 1);
  expect('unchanged pictures keep their names', again.every((f, i) => f.fileName === files[i].fileName), again.map((f) => f.fileName));
  const changed = structuredClone(root);
  let photo: ImageNode | null = null;
  walk([changed], (n) => {
    if (!photo && n.type === 'image' && n.id === first.nodeId) photo = n;
  });
  if (photo) (photo as ImageNode).opacity = 0.5;
  const changedLayout = computeLayout([changed]);
  const [redone] = await renderEmailImages(changed, changedLayout, collectEmailImages(changed, changedLayout).slice(0, 1), 1);
  expect('a changed picture gets a new name', !!redone && redone.baseName === files[0].baseName && redone.fileName !== files[0].fileName, [redone?.fileName, files[0].fileName]);

  // A picture's own web address wins over every mode and isn't rendered.
  const OWN = 'https://photos.example.com/duboce-unit-6.jpg';
  for (const mode of ['wordpress', 'base', 'each'] as const) {
    const s = pictureSources(board({ hosting: { mode, baseUrl: FOLDER }, imageUrls: { [first.nodeId]: OWN } }), {}, null);
    expect(`own address wins in ${mode}`, pictureSrc(s, first.nodeId, first.fileName) === OWN, pictureSrc(s, first.nodeId, first.fileName));
    expect(`own address isn't rendered in ${mode}`, !picturesToRender(s, images).some((im) => im.nodeId === first.nodeId) && picturesToRender(s, images).some((im) => im.nodeId === second.nodeId));
  }
  const wpOnly = pictureSources(board({ hosting: { mode: 'wordpress' }, imageUrls: { [first.nodeId]: OWN } }), {}, null);
  expect('WordPress, not uploaded: only pictures without their own address are blocked', picturesWithoutAddress(wpOnly, images).length === images.length - 1);
  const share = pictureSources(board({ hosting: { mode: 'base', baseUrl: FOLDER }, imageUrls: { [first.nodeId]: 'https://www.dropbox.com/s/abc/photo.jpg' } }), { files: renderedNames(files) }, null);
  expect('a share link is not a web address', picturesWithoutAddress(share, images).some((m) => m.nodeId === first.nodeId));

  // RentCafe adds the unsubscribe link and the mailing address.
  const rc = sendChecks(board({ platform: 'rentcafe' }), root, layout);
  expect('RentCafe: unsubscribe and address pass', rc.filter((c) => c.id === 'unsubscribe' || c.id === 'address').every((c) => c.level === 'ok'), rc);
  const bare = makeEmailRoot([EMAIL_SECTIONS[0].build([])]);
  const plain = buildEmailHtml(bare, computeLayout([bare]), { title: 't', imageUrl: (_id, f) => f });
  const warned = plain.warnings.some((w) => /^No unsubscribe link found/.test(w));
  expect('RentCafe: no missing-unsubscribe warning', !warned || platformWarnings(board({ platform: 'rentcafe' }), plain.warnings).length === plain.warnings.length - 1);

  if (typeof console !== 'undefined' && console.table) console.table(out.map(({ check, ok, detail }) => ({ check, ok: ok ? 'ok' : 'FAIL', detail: detail ?? '' })));
  return out;
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { __emailSelfTest?: typeof emailSelfTest; __emailHostingSelfTest?: typeof emailHostingSelfTest };
  w.__emailSelfTest = emailSelfTest;
  w.__emailHostingSelfTest = emailHostingSelfTest;
}
