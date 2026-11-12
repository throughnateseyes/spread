import type { FrameNode, ImageNode } from '../types';
import { computeLayout } from '../layout';
import { makeFrame } from '../tree';
import { buildEmailHtml, GMAIL_CLIP_BYTES, joinUrl, type TwoAcrossText } from './html';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES, emailText, footerSection, makeEmailRoot, photoPicker, twoUpSection } from './templates';

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

/**
 * Phone layout and hugging text: a two-across card grid whose cards hold a two-line address that
 * hugs its words, a hugging address block, a hugging line beside a box, a full-width photo, and
 * rows set by property and by the older name tags.
 */
function phoneLayoutCase(): { root: FrameNode; failures: (html: string, twoAcross: TwoAcrossText[]) => string[] } {
  const grid = twoUpSection(photoPicker([]), [
    { title: 'A', meta: ['1 bed'] },
    { title: 'B', meta: ['2 bed'] },
  ]);
  const cards = grid.children as FrameNode[];
  for (const card of cards) {
    card.children.splice(1, 0, emailText('1050 Post St\nSan Francisco', 'h4', { hug: true, name: 'Address' }));
    const block = makeFrame(0, 0, 100, 40, { name: 'Address block', layout: 'column', sizingH: 'hug', sizingV: 'hug', fill: null, gap: 4, padding: { t: 0, r: 0, b: 0, l: 0 } });
    block.children = [emailText('1050 Post St', 'body', { hug: true }), emailText('Unit 4', 'meta', { hug: true })];
    card.children.push(block);
  }
  (cards[0].children[0] as ImageNode).phoneFullWidth = true;
  const box = makeFrame(0, 0, 200, 40, { name: 'Box', layout: 'column', sizingH: 'fixed', fill: { kind: 'solid', color: '#EEEEEE' } });
  const line = makeFrame(0, 0, 536, 40, { name: 'Pin row', layout: 'row', sizingH: 'fill', sizingV: 'hug', fill: null, gap: 12, padding: { t: 20, r: 32, b: 0, l: 32 } });
  line.children = [emailText('1050 Post St', 'body', { hug: true, name: 'Pin address' }), box];
  // Same grid kept side by side: by property (which beats a [stack] tag), and by the older tag.
  const sideProp = twoUpSection(photoPicker([]), [{ title: 'C' }, { title: 'D' }]);
  sideProp.name = 'Section / Side by prop [stack]';
  sideProp.phoneStack = 'side-by-side';
  const sideTag = twoUpSection(photoPicker([]), [{ title: 'E' }, { title: 'F' }]);
  sideTag.name = 'Section / Side by tag [nostack]';
  const root = makeEmailRoot([grid, line, sideProp, sideTag, footerSection()], 'Email / Phone layout');
  const failures = (html: string, twoAcross: TwoAcrossText[]) => {
    const f: string[] = [];
    if (/width="\d+"[^>]*>\s*<tr><td[^>]*>1050 Post St<br>/.test(html)) f.push('two-line hugging address is pinned to a px column');
    if (!/<table role="presentation" cellpadding="0" cellspacing="0" border="0">\s*<tr><td[^>]*>1050 Post St<\/td>/.test(html)) f.push('hugging address block is not a shrink-to-fit table');
    if (!/class="es-col"[^>]*white-space:nowrap[^>]*>1050 Post St</.test(html)) f.push('hugging text in a stacking row can wrap on desktop');
    if (!/class="es-img es-bleed"/.test(html)) f.push('full-width photo has no es-bleed class');
    if (!/\.es-edge\{padding-left:0!important;padding-right:0!important\}/.test(html)) f.push('no es-edge rule in the mobile CSS');
    if (!/class="[^"]*es-pl32 es-pr32/.test(html)) f.push('cells beside the full-width photo do not get their padding back');
    const rows = new Set(twoAcross.map((t) => t.rowId));
    if (!rows.has(sideProp.id)) f.push('phoneStack side-by-side (over a [stack] tag) did not keep the row across');
    if (!rows.has(sideTag.id)) f.push('[nostack] tag no longer keeps the row across');
    if (rows.has(grid.id)) f.push('automatic card grid did not stack');
    return f;
  };
  return { root, failures };
}

export function emailSelfTest(opts: { html?: boolean } = {}): EmailSelfTestResult[] {
  const cases: { id: string; root: FrameNode; extra?: (html: string, twoAcross: TwoAcrossText[]) => string[] }[] = EMAIL_TEMPLATES.map((t) => ({ id: t.id, root: t.build([]) }));
  // Every section in one email, so the button / unit grid / details paths are exercised too.
  cases.push({ id: 'all-sections', root: makeEmailRoot(EMAIL_SECTIONS.map((s) => s.build([])), 'Email / All sections') });
  const phone = phoneLayoutCase();
  cases.push({ id: 'phone-layout', root: phone.root, extra: phone.failures });
  const results = cases.map(({ id, root, extra }) => {
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
      failures: [...check(r.html, root), ...(extra?.(r.html, r.twoAcross) ?? [])],
      ...(opts.html ? { html: r.html } : {}),
    };
  });
  if (typeof console !== 'undefined' && console.table) {
    console.table(results.map(({ template, kb, images, warnings, failures }) => ({ template, kb, images, warnings: warnings.length, failures: failures.join('; ') || 'ok' })));
  }
  return results;
}

if (typeof window !== 'undefined') (window as unknown as { __emailSelfTest?: typeof emailSelfTest }).__emailSelfTest = emailSelfTest;
