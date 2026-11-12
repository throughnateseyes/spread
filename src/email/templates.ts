import type { FrameNode, ImageNode, SceneNode, ShapeNode, TextNode } from '../types';
import { makeFrame, makeImage, makeShape, makeText } from '../tree';

// The built-in email templates, built from Spread nodes so they stay editable on the canvas and
// compile with html.ts. The house style they share:
// - 600px column on an off-white ground that runs edge to edge (body = sections).
// - Georgia for display, Arial for everything else (both exist in Spread and in every inbox).
// - Spacing only from 8 / 12 / 20 / 32 / 48; 32px side padding; 48px between major blocks.
// - Square corners, no shadows, no gradients, left-aligned except masthead and footer.
// - CTAs are underlined accent-colour text links, one per email. (EMAIL_SECTIONS also has a
//   filled button, which no template uses.)
// - Facts are {{TOKENS}}; html.ts lists any left unfilled at export.
// - Links live in layer names: "See the listing [link:https://…]".

export const EMAIL_WIDTH = 600;

export const EMAIL_STYLE = {
  ground: '#FAFAF7',
  text: '#222222',
  muted: '#6A6A6A',
  hairline: '#E2E1DC',
  accent: '#2C4A6E',
  display: '#2C4A6E',
  onAccent: '#FFFFFF',
  onAccentFine: '#E4E9F0',
  serif: 'Georgia',
  sans: 'Arial',
  side: 32,
} as const;

type Role = 'masthead' | 'h2' | 'h3' | 'h4' | 'body' | 'meta' | 'eyebrow' | 'link' | 'fine' | 'detailLabel' | 'detailValue';

/** px size / px line height, the template type scale. */
const ROLES: Record<Role, Partial<TextNode> & { fontSize: number; lh: number }> = {
  masthead: { fontFamily: EMAIL_STYLE.serif, fontSize: 44, lh: 50, fontWeight: 700, fill: EMAIL_STYLE.display, align: 'center' },
  h2: { fontFamily: EMAIL_STYLE.serif, fontSize: 27, lh: 32, fontWeight: 700, fill: EMAIL_STYLE.text },
  h3: { fontFamily: EMAIL_STYLE.serif, fontSize: 23, lh: 29, fontWeight: 700, fill: EMAIL_STYLE.text },
  h4: { fontFamily: EMAIL_STYLE.serif, fontSize: 19, lh: 25, fontWeight: 700, fill: EMAIL_STYLE.text },
  body: { fontFamily: EMAIL_STYLE.sans, fontSize: 16, lh: 25, fontWeight: 400, fill: EMAIL_STYLE.text },
  meta: { fontFamily: EMAIL_STYLE.sans, fontSize: 13, lh: 20, fontWeight: 400, fill: EMAIL_STYLE.muted },
  eyebrow: { fontFamily: EMAIL_STYLE.sans, fontSize: 11, lh: 16, fontWeight: 700, fill: EMAIL_STYLE.muted, uppercase: true, letterSpacing: (4 / 11) * 100, align: 'center' },
  link: { fontFamily: EMAIL_STYLE.sans, fontSize: 16, lh: 25, fontWeight: 700, fill: EMAIL_STYLE.accent, decoration: 'underline' },
  fine: { fontFamily: EMAIL_STYLE.sans, fontSize: 11, lh: 17, fontWeight: 400, fill: EMAIL_STYLE.onAccentFine, align: 'center' },
  detailLabel: { fontFamily: EMAIL_STYLE.sans, fontSize: 15, lh: 21, fontWeight: 400, fill: EMAIL_STYLE.muted },
  detailValue: { fontFamily: EMAIL_STYLE.sans, fontSize: 15, lh: 21, fontWeight: 700, fill: EMAIL_STYLE.text },
};

const pad = (t: number, r = t, b = t, l = r) => ({ t, r, b, l });

/**
 * What new text on an email board starts as: body copy in Arial, which every inbox has, so the
 * canvas wraps lines the way the sent email will.
 */
export function emailTextDefaults(): Partial<TextNode> {
  const { lh, ...body } = ROLES.body;
  return { ...body, lineHeight: lh / body.fontSize, letterSpacing: 0 };
}

/** Text in a role. Wraps to its container (fill width) unless `hug` is set. */
export function emailText(text: string, role: Role, patch: Partial<TextNode> & { hug?: boolean } = {}): TextNode {
  const { lh, ...spec } = ROLES[role];
  const { hug, ...rest } = patch;
  const fontSize = rest.fontSize ?? spec.fontSize;
  return makeText(0, 0, text, {
    name: text.length > 40 ? text.slice(0, 40).trim() + '…' : text,
    letterSpacing: 0,
    ...spec,
    lineHeight: lh / spec.fontSize,
    sizingH: hug ? 'hug' : 'fill',
    sizingV: 'hug',
    w: 536,
    ...rest,
    fontSize,
  });
}

function column(name: string, children: SceneNode[], patch: Partial<FrameNode> = {}): FrameNode {
  return makeFrame(0, 0, EMAIL_WIDTH, 100, {
    name,
    layout: 'column',
    sizingH: 'fill',
    sizingV: 'hug',
    fill: null,
    clip: false,
    gap: 0,
    padding: pad(0),
    children,
    ...patch,
  });
}

function row(name: string, children: SceneNode[], patch: Partial<FrameNode> = {}): FrameNode {
  return column(name, children, { layout: 'row', ...patch });
}

function rule(): ShapeNode {
  const r = makeShape('rect', 0, 0, 536, 1);
  r.name = 'Rule';
  r.fill = { kind: 'solid', color: EMAIL_STYLE.hairline };
  r.sizingH = 'fill';
  return r;
}

function photo(assetId: string | null, name: string, w: number, h: number): ImageNode {
  const im = makeImage(0, 0, w, h, assetId, name);
  im.sizingH = 'fill';
  im.sizingV = 'fixed';
  return im;
}

/** Hands out photo asset ids in order; null (an empty placeholder) once they run out. */
export type PhotoPicker = () => string | null;
export function photoPicker(ids: (string | null)[] = []): PhotoPicker {
  let i = 0;
  return () => (i < ids.length ? ids[i++] : null);
}

const linkName = (label: string, href: string) => `${label} [link:${href}]`;

// ---------- sections ----------

export function mastheadSection(title: string, dateline: string): FrameNode {
  return column(
    'Section / Masthead',
    [
      emailText('{{BRAND_NAME}}', 'eyebrow'),
      emailText(title, 'masthead'),
      emailText(dateline, 'eyebrow', { letterSpacing: (3 / 11) * 100 }),
    ],
    { padding: pad(32, 32, 20, 32), gap: 8, alignItems: 'center' },
  );
}

export function heroSection(take: PhotoPicker, alt = '{{HERO_ALT}}'): FrameNode {
  return column('Section / Hero', [photo(take(), `Hero photo [alt:${alt}]`, EMAIL_WIDTH, 400)]);
}

/** Lead paragraph with the accent left rule. */
export function introSection(text: string): FrameNode {
  const bar = makeShape('rect', 0, 0, 4, 50);
  bar.name = 'Left rule';
  bar.fill = { kind: 'solid', color: EMAIL_STYLE.accent };
  bar.sizingV = 'fill';
  return row('Section / Intro', [bar, emailText(text, 'body')], { padding: pad(32, 32, 0, 32), gap: 16, alignItems: 'start' });
}

/** "2 bed ✦ 1 bath ✦ Mission" with accent separators. */
export function metaLine(items: string[]): FrameNode {
  const kids: SceneNode[] = [];
  items.forEach((it, i) => {
    if (i) kids.push(emailText('✦', 'meta', { hug: true, fill: EMAIL_STYLE.accent, name: 'Separator' }));
    kids.push(emailText(it, 'meta', { hug: true }));
  });
  return row('Meta', kids, { sizingH: 'hug', gap: 6, alignItems: 'center' });
}

export function headingBlock(title: string, meta: string[] | null, size: 'h2' | 'h3' | 'h4' = 'h2'): FrameNode {
  const kids: SceneNode[] = [emailText(title, size)];
  if (meta?.length) kids.push(metaLine(meta));
  return column('Heading', kids, { gap: 8 });
}

export function bodySection(text: string, top = 20): FrameNode {
  return column('Section / Body', [emailText(text, 'body')], { padding: pad(top, 32, 0, 32) });
}

/** The call to action: an underlined accent text link. */
export function ctaLink(label: string, href: string): TextNode {
  return emailText(label, 'link', { hug: true, name: linkName('CTA', href) });
}

export function ctaSection(label: string, href: string, top = 20): FrameNode {
  return column('Section / CTA', [ctaLink(label, href)], { padding: pad(top, 32, 0, 32) });
}

/** Filled bulletproof button, for when a text link won't do. */
export function buttonSection(label: string, href: string, color: string = EMAIL_STYLE.accent): FrameNode {
  const btn = row(linkName('Button', href), [emailText(label, 'body', { hug: true, fill: EMAIL_STYLE.onAccent, fontWeight: 700, fontSize: 15 })], {
    sizingH: 'hug',
    fill: { kind: 'solid', color },
    padding: pad(14, 28),
    alignItems: 'center',
    justify: 'center',
  });
  return column('Section / Button', [btn], { padding: pad(20, 32, 0, 32) });
}

/** Featured listing: photo, address, meta, copy, link. */
export function listingSection(take: PhotoPicker, o: { address: string; meta: string[]; copy: string; href: string; alt?: string }): FrameNode {
  return column(
    'Section / Listing',
    [photo(take(), `Listing photo [alt:${o.alt ?? '{{UNIT_ALT}}'}]`, 536, 357), headingBlock(o.address, o.meta), emailText(o.copy, 'body'), ctaLink('See the listing >', o.href)],
    { padding: pad(48, 32, 0, 32), gap: 12 },
  );
}

/** Two photos side by side (stacks on phones), with optional captions per photo. */
export function twoUpSection(take: PhotoPicker, captions?: { title: string; meta?: string[]; href?: string }[], top = 20): FrameNode {
  const cell = (i: number) => {
    const c = captions?.[i];
    const kids: SceneNode[] = [photo(take(), `Photo ${i === 0 ? 'left' : 'right'} [alt:{{PHOTO_${i + 1}_ALT}}]`, 252, 189)];
    if (c) {
      kids.push(headingBlock(c.title, c.meta ?? null, 'h4'));
      if (c.href) kids.push(emailText('See the listing >', 'link', { hug: true, fontSize: 15, name: linkName('CTA', c.href) }));
    }
    return column(i === 0 ? 'Left' : 'Right', kids, { gap: 12 });
  };
  return row('Section / Two-up', [cell(0), cell(1)], { padding: pad(top, 32, 0, 32), gap: 16, alignItems: 'start' });
}

/** Event or story block: optional photo, headline, meta line, blurb, details link. */
export function storySection(take: PhotoPicker | null, o: { title: string; meta: string[]; blurb: string; href: string; linkLabel?: string; alt?: string }): FrameNode {
  const kids: SceneNode[] = [];
  if (take) kids.push(photo(take(), `Story photo [alt:${o.alt ?? '{{STORY_ALT}}'}]`, 536, 302));
  kids.push(headingBlock(o.title, o.meta), emailText(o.blurb, 'body'), emailText(o.linkLabel ?? 'Details >', 'link', { hug: true, name: linkName('Details link', o.href) }));
  return column('Section / Story', kids, { padding: pad(48, 32, 0, 32), gap: 12 });
}

/** Hairline above and below, smaller headline, one link. For referrals, portal, specials. */
export function ruledNoteSection(o: { headline: string; body: string; linkLabel: string; href: string }): FrameNode {
  const inner = column('Note', [emailText(o.headline, 'h3'), emailText(o.body, 'body'), emailText(o.linkLabel, 'link', { hug: true, name: linkName('Note link', o.href) })], {
    padding: pad(20, 0, 20, 0),
    gap: 12,
  });
  return column('Section / Ruled note', [rule(), inner, rule()], { padding: pad(48, 32, 0, 32) });
}

/** Label / value rows separated by hairlines (dates, times, places, rules). */
export function detailsSection(title: string | null, rows: [string, string][], intro?: string): FrameNode {
  const list = column(
    'Details',
    rows.flatMap(([label, value], i) => {
      const line = row(
        `Row / ${label}`,
        [emailText(label, 'detailLabel', { sizingH: 'fixed', w: 110 }), emailText(value, 'detailValue')],
        { padding: pad(10, 0), gap: 12, alignItems: 'start', phoneStack: 'side-by-side' },
      );
      return i === 0 ? [rule(), line, rule()] : [line, rule()];
    }),
  );
  const kids: SceneNode[] = [];
  if (title) kids.push(emailText(title, 'h2'));
  if (intro) kids.push(emailText(intro, 'body'));
  kids.push(list);
  return column('Section / Details', kids, { padding: pad(title ? 48 : 20, 32, 0, 32), gap: 12 });
}

export function spacerSection(height = 48): FrameNode {
  return column('Spacer', [], { sizingV: 'fixed', h: height });
}

/** Accent band with site, socials, phone, mailing address and unsubscribe (required). */
export function footerSection(): FrameNode {
  const white = (text: string, href: string, patch: Partial<TextNode> = {}) =>
    emailText(text, 'meta', { hug: true, fill: EMAIL_STYLE.onAccent, decoration: 'underline', name: linkName(text, href), ...patch });
  const dot = () => emailText('·', 'meta', { hug: true, fill: EMAIL_STYLE.onAccent, name: 'Dot' });
  const socials = row(
    'Socials',
    [
      white('Instagram', '{{INSTAGRAM_URL}}'),
      dot(),
      white('Facebook', '{{FACEBOOK_URL}}'),
      dot(),
      white('TikTok', '{{TIKTOK_URL}}'),
      dot(),
      white('YouTube', '{{YOUTUBE_URL}}'),
    ],
    { sizingH: 'hug', gap: 8, alignItems: 'center', phoneStack: 'side-by-side' },
  );
  const fine = column(
    'Fine print',
    [
      emailText('{{BRAND_NAME}} · {{MAILING_ADDRESS}}', 'fine'),
      emailText('Unsubscribe', 'fine', { hug: true, decoration: 'underline', name: linkName('Unsubscribe', '{{UNSUBSCRIBE_URL}}') }),
    ],
    { padding: pad(8, 0, 0, 0), alignItems: 'center' },
  );
  return column(
    'Section / Footer',
    [
      white('{{WEBSITE}}', '{{WEBSITE_URL}}', { decoration: 'none', fontWeight: 700, uppercase: true, letterSpacing: (4 / 13) * 100 }),
      socials,
      white('Phone: {{PHONE}}', 'tel:{{PHONE}}', { decoration: 'none', fontSize: 12, uppercase: true, letterSpacing: (1 / 12) * 100 }),
      fine,
    ],
    { fill: { kind: 'solid', color: EMAIL_STYLE.accent }, padding: pad(32), gap: 12, alignItems: 'center' },
  );
}

/** The email root: a fixed 600px auto-layout column whose height follows its sections. */
export function makeEmailRoot(sections: SceneNode[], name = 'Email', background: string = EMAIL_STYLE.ground): FrameNode {
  return makeFrame(0, 0, EMAIL_WIDTH, 1200, {
    name,
    layout: 'column',
    sizingH: 'fixed',
    sizingV: 'hug',
    padding: pad(0),
    gap: 0,
    fill: { kind: 'solid', color: background },
    clip: true,
    alignItems: 'start',
    justify: 'start',
    children: sections,
  });
}

// ---------- section catalogue (for an "Insert section" menu) ----------

export interface EmailSectionDef {
  id: string;
  name: string;
  description: string;
  build: (photoAssetIds?: string[]) => FrameNode;
}

export const EMAIL_SECTIONS: EmailSectionDef[] = [
  { id: 'masthead', name: 'Masthead', description: 'Brand line, big title, dateline. Centred.', build: () => mastheadSection('{{TITLE}}', '{{MONTH}} {{YEAR}}') },
  { id: 'hero', name: 'Hero photo', description: 'Full-bleed 600px photo.', build: (ids) => heroSection(photoPicker(ids)) },
  { id: 'intro', name: 'Intro', description: 'Lead paragraph with the accent left rule.', build: () => introSection('One or two lines that say what this email is for.') },
  {
    id: 'listing',
    name: 'Featured listing',
    description: 'Photo, address, beds and baths, copy, link.',
    build: (ids) =>
      listingSection(photoPicker(ids), {
        address: '{{ADDRESS}}, Unit {{UNIT}}',
        meta: ['{{BEDS}} bed', '{{BATHS}} bath', '{{NEIGHBORHOOD}}'],
        copy: 'Two or three plain sentences about the unit. Facts only.',
        href: '{{LISTING_URL}}',
      }),
  },
  {
    id: 'two-up',
    name: 'Two-up photos',
    description: 'Two photos side by side. Stacks on phones.',
    build: (ids) => twoUpSection(photoPicker(ids)),
  },
  {
    id: 'unit-grid',
    name: 'Two-up units',
    description: 'Two units side by side with address and link. Stacks on phones.',
    build: (ids) =>
      twoUpSection(
        photoPicker(ids),
        [
          { title: '{{ADDRESS_A}}', meta: ['{{META_A}}'], href: '{{URL_A}}' },
          { title: '{{ADDRESS_B}}', meta: ['{{META_B}}'], href: '{{URL_B}}' },
        ],
        48,
      ),
  },
  {
    id: 'story',
    name: 'Story',
    description: 'Photo, headline, date and place, blurb, details link.',
    build: (ids) =>
      storySection(photoPicker(ids), { title: '{{EVENT_NAME}}', meta: ['{{DATES}}', '{{PLACE}}', '{{COST}}'], blurb: 'Lead with the most interesting fact, then the useful details.', href: '{{EVENT_URL}}' }),
  },
  {
    id: 'item',
    name: 'Text item',
    description: 'Headline, meta line, blurb and link, no photo.',
    build: () => storySection(null, { title: '{{ITEM_TITLE}}', meta: ['{{DATE}}', '{{PLACE}}'], blurb: '{{BODY}}', href: '{{ITEM_URL}}' }),
  },
  { id: 'body', name: 'Body text', description: 'A paragraph.', build: () => bodySection('A paragraph of body copy.') },
  { id: 'cta', name: 'Call to action', description: 'Underlined accent text link.', build: () => ctaSection('See the listing >', '{{CTA_URL}}') },
  { id: 'button', name: 'Button', description: 'Filled bulletproof button.', build: () => buttonSection('See the listing', '{{CTA_URL}}') },
  {
    id: 'ruled-note',
    name: 'Ruled note',
    description: 'Hairlines above and below, smaller headline, one link.',
    build: () => ruledNoteSection({ headline: '{{NOTE_HEADLINE}}', body: '{{NOTE_BODY}}', linkLabel: '{{NOTE_CTA}} >', href: '{{NOTE_URL}}' }),
  },
  {
    id: 'details',
    name: 'Details table',
    description: 'Label and value rows: dates, times, places.',
    build: () => detailsSection('{{TABLE_TITLE}}', [['Date', '{{DATE}}'], ['Time', '{{TIME}}'], ['Where', '{{PLACE}}']]),
  },
  { id: 'spacer', name: 'Spacer', description: '48px of space.', build: () => spacerSection(48) },
  { id: 'footer', name: 'Footer', description: 'Site, socials, phone, address and unsubscribe.', build: () => footerSection() },
];

// ---------- templates ----------

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  build: (photoAssetIds: string[]) => FrameNode;
}

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'listing-spotlight',
    name: 'Listing spotlight',
    description: 'One unit: hero photo, address and beds/baths, two more photos, copy, one link.',
    build: (ids) => {
      const take = photoPicker(ids);
      return makeEmailRoot(
        [
          mastheadSection('Now leasing', '{{NEIGHBORHOOD}}'),
          heroSection(take, '{{HERO_ALT}}'),
          column('Section / Headline', [headingBlock('{{ADDRESS}}, Unit {{UNIT}}', ['{{BEDS}} bed', '{{BATHS}} bath', '{{CROSS_STREETS}}'])], { padding: pad(32, 32, 0, 32) }),
          twoUpSection(take),
          bodySection(
            'Two or three plain sentences about the unit: the light, how the rooms connect, what is a short walk away. Facts only, from the listing page, and say where any walk time is measured from.',
          ),
          ctaSection('See the listing >', '{{LISTING_URL}}'),
          spacerSection(48),
          footerSection(),
        ],
        'Email / Listing spotlight',
      );
    },
  },
  {
    id: 'newsletter',
    name: 'Newsletter',
    description: 'Masthead, hero, intro, three stories with photos, a ruled note, footer.',
    build: (ids) => {
      const take = photoPicker(ids);
      const story = (n: number) =>
        storySection(take, {
          title: `{{STORY_${n}_TITLE}}`,
          meta: [`{{STORY_${n}_DATES}}`, `{{STORY_${n}_PLACE}}`, `{{STORY_${n}_COST}}`],
          blurb: 'Open with the most interesting true thing about it, then when to go and how to get there. Three or four sentences.',
          href: `{{STORY_${n}_URL}}`,
          alt: `{{STORY_${n}_ALT}}`,
        });
      return makeEmailRoot(
        [
          mastheadSection('{{TITLE}}', '{{MONTH}} {{YEAR}}'),
          heroSection(take),
          introSection('A line or two on the month. Lead with what most people will want to know.'),
          story(1),
          story(2),
          story(3),
          ruledNoteSection({
            headline: '{{NOTE_HEADLINE}}',
            body: '{{NOTE_BODY}}',
            linkLabel: '{{NOTE_CTA}} >',
            href: '{{NOTE_URL}}',
          }),
          spacerSection(48),
          footerSection(),
        ],
        'Email / Newsletter',
      );
    },
  },
  {
    id: 'resident-notice',
    name: 'Resident notice',
    description: 'Text-forward notice: what is happening, when, what to do, who to contact.',
    build: () =>
      makeEmailRoot(
        [
          mastheadSection('{{PROPERTY_NAME}}', '{{DATE}}'),
          column('Section / Lead', [emailText('{{WHAT_IS_HAPPENING}} on {{DAY}}, {{DATE}}', 'h2')], { padding: pad(32, 32, 0, 32) }),
          bodySection('One sentence on what residents will notice, and one on why it is happening.', 12),
          detailsSection(null, [
            ['When', '{{DAY}}, {{DATE}}'],
            ['Time', '{{START_TIME}} to {{END_TIME}}'],
            ['Where', '{{AFFECTED_AREA}}'],
            ['What to do', '{{RESIDENT_ACTION}}'],
          ]),
          bodySection('Questions? Reply to this email or call the leasing office at {{OFFICE_PHONE}}.'),
          ctaSection('Contact the leasing office >', 'mailto:{{OFFICE_EMAIL}}'),
          spacerSection(48),
          footerSection(),
        ],
        'Email / Resident notice',
      ),
  },
  {
    id: 'event',
    name: 'Event',
    description: 'Hero, event name, date/time/place table, short copy, RSVP link.',
    build: (ids) => {
      const take = photoPicker(ids);
      return makeEmailRoot(
        [
          mastheadSection("You're invited", '{{PROPERTY_NAME}}'),
          heroSection(take, '{{EVENT_PHOTO_ALT}}'),
          column('Section / Headline', [emailText('{{EVENT_NAME}}', 'h2')], { padding: pad(32, 32, 0, 32) }),
          bodySection('One or two sentences on what happens and why it is worth the walk downstairs.', 12),
          detailsSection(null, [
            ['Date', '{{DAY_OF_WEEK}}, {{DATE}}'],
            ['Time', '{{START_TIME}} to {{END_TIME}}'],
            ['Where', '{{EVENT_LOCATION}}'],
            ['Food', '{{REFRESHMENTS}}'],
          ]),
          ctaSection('RSVP >', '{{RSVP_URL}}', 20),
          spacerSection(48),
          footerSection(),
        ],
        'Email / Event',
      );
    },
  },
];
