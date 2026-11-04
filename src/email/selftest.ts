import type { FrameNode } from '../types';
import { computeLayout } from '../layout';
import { buildEmailHtml, GMAIL_CLIP_BYTES, joinUrl } from './html';
import { EMAIL_SECTIONS, EMAIL_TEMPLATES, makeEmailRoot } from './templates';

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

if (typeof window !== 'undefined') (window as unknown as { __emailSelfTest?: typeof emailSelfTest }).__emailSelfTest = emailSelfTest;
