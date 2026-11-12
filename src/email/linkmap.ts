import type { LayoutMap } from '../layout';
import { LINK_ISSUE_TEXT, linkIssue, nodeLink, type LinkIssue } from '../links';
import type { Doc, FrameNode, PictureHosting, SceneNode, TextNode } from '../types';
import { collectEmailImages, parseNameTags, type EmailImage } from './html';
import { imageUrlProblem, pictureUrlProblem, type WordPress } from './hosting';

// Everything on an email that has to point somewhere: click links on layers, and the pictures
// whose files have to live on a public URL. One list feeds the Links panel, the pills on the
// canvas and the export dialog, so all three agree on what's left to do.
//
// A picture inside a linked card joins that card's entry, so a listing card reads as one row:
// its photo (hosted?) and where it goes (linked?).

/** wait: fine once the board's hosting is set (one fix for every picture, so not counted per picture). */
export type PictureStatus = 'ok' | 'fix' | 'wait';

export interface PictureEntry {
  nodeId: string;
  fileName: string;
  /** The photo on the layer, for thumbnails. Null for a flattened frame. */
  assetId: string | null;
  status: PictureStatus;
  text: string;
  /** The picture's own web address, when it has one (or, in "URL per picture", the one typed so far). */
  url?: string;
}

export interface LinkItem {
  /** The layer the entry is about (the one that carries the link, or the picture). */
  id: string;
  section: string;
  name: string;
  pictures: PictureEntry[];
  /** null: the layer has no link (a picture that goes nowhere, or a suggestion). */
  link: { url: string; issue: LinkIssue | null } | null;
  /** Looks like a button or a "Read more" but has no link. A hint, not a problem. */
  suggested: boolean;
  /** A broken link or a picture without a home. */
  fix: boolean;
  /** One line on how it stands, for rows and tooltips. */
  status: string;
}

// Short text that reads as an action. Long text is copy, even when it starts with "See".
const CTA_WORDS = /^(view|see|learn|read|explore|discover|browse|find|get|book|schedule|tour|apply|contact|send|email|call|text|sign up|join|rsvp|shop|start|request|check|reserve|visit|watch|download|register|claim|more|unsubscribe|manage)\b/i;
const ARROW = /(→|›|»|>)\s*$/;

function isCtaText(t: TextNode) {
  const text = t.text.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 40 || /\{\{/.test(text)) return false;
  return t.decoration === 'underline' || CTA_WORDS.test(text) || ARROW.test(text);
}

function isButtonFrame(f: FrameNode) {
  const tags = parseNameTags(f.name);
  if (tags.flags.has('button') || /^(button|cta|btn)\b/i.test(tags.clean)) return true;
  const kids = f.children.filter((c) => c.visible);
  return kids.length === 1 && kids[0].type === 'text' && !!f.fill && isCtaText(kids[0]);
}

const GENERIC = /^(frame|group|card|row|column|stack|auto layout|container|rectangle|image|photo)\b/i;

function firstText(n: SceneNode): string {
  if (n.type === 'text') return n.text.replace(/\s+/g, ' ').trim();
  if (n.type === 'frame') for (const c of n.children) if (c.visible) {
    const t = firstText(c);
    if (t) return t;
  }
  return '';
}

function labelOf(n: SceneNode) {
  if (n.type === 'text') return n.text.replace(/\s+/g, ' ').trim().slice(0, 48);
  const clean = parseNameTags(n.name).clean.replace(/\s*\[[^\]]*\]/g, '').trim();
  if (clean && !GENERIC.test(clean)) return clean;
  return firstText(n).slice(0, 48) || clean || 'Layer';
}

const sectionName = (n: SceneNode) => parseNameTags(n.name).clean.replace(/^section\s*\/\s*/i, '').trim() || 'Section';
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '');

function pictureState(im: EmailImage, assetId: string | null, h: PictureHosting, wp: WordPress | undefined, own: string): PictureEntry {
  const base = { nodeId: im.nodeId, fileName: im.fileName, assetId };
  // The picture's own web address wins over the board's hosting.
  if (own) {
    const p = imageUrlProblem(own);
    return p ? { ...base, url: own, status: 'fix', text: p } : { ...base, url: own, status: 'ok', text: shortUrl(own) };
  }
  if (h.mode === 'wordpress') {
    if (wp === undefined) return { ...base, status: 'ok', text: 'Checking WordPress…' };
    if (!wp) return { ...base, status: 'wait', text: 'Uploads once WordPress is connected' };
    return { ...base, status: 'ok', text: `Uploads to ${shortUrl(wp.site)} on export` };
  }
  if (h.mode === 'base') {
    const b = h.baseUrl?.trim() ?? '';
    if (!b || pictureUrlProblem(b)) return { ...base, status: 'wait', text: 'Waiting on the pictures folder URL' };
    return { ...base, status: 'ok', text: 'Goes in your pictures folder' };
  }
  const url = h.urls?.[im.nodeId]?.trim() ?? '';
  if (!url) return { ...base, url, status: 'fix', text: 'No web address yet' };
  const p = pictureUrlProblem(url);
  return p ? { ...base, url, status: 'fix', text: p } : { ...base, url, status: 'ok', text: shortUrl(url) };
}

/** What's wrong with the board's hosting as a whole (no folder URL, WordPress not connected), or null. */
export function hostingIssue(h: PictureHosting, wp: WordPress | undefined, pictures: number): string | null {
  if (!pictures) return null;
  const n = `${pictures} picture${pictures === 1 ? '' : 's'}`;
  if (h.mode === 'wordpress') return wp === null ? `Connect WordPress so Spread can upload the ${n}.` : null;
  if (h.mode === 'base') {
    const b = h.baseUrl?.trim() ?? '';
    if (!b) return `Add the folder URL the ${n} will be uploaded to.`;
    return pictureUrlProblem(b);
  }
  return null;
}

function statusOf(it: Omit<LinkItem, 'status' | 'fix'>): { fix: boolean; status: string } {
  const pic = it.pictures.find((p) => p.status === 'fix');
  if (it.link?.issue) return { fix: true, status: LINK_ISSUE_TEXT[it.link.issue] };
  if (pic) return { fix: true, status: pic.text };
  if (it.suggested) return { fix: false, status: 'Looks like a button. Add a link?' };
  if (it.link) return { fix: false, status: shortUrl(it.link.url) };
  return { fix: false, status: it.pictures[0]?.text ?? '' };
}

/**
 * Every link and picture on an email board, top to bottom. Pass the pictures if you already compiled
 * the email; otherwise they are worked out from the layout.
 */
export function linkItems(doc: Doc, root: FrameNode, layout: LayoutMap, hosting: PictureHosting, wp: WordPress | undefined, images?: EmailImage[]): LinkItem[] {
  const pics = new Map((images ?? collectEmailImages(root, layout)).map((im) => [im.nodeId, im]));
  const dismissed = new Set(doc.email?.noLink ?? []);
  const items: Omit<LinkItem, 'status' | 'fix'>[] = [];
  const byId = new Map<string, Omit<LinkItem, 'status' | 'fix'>>();

  const add = (n: SceneNode, section: string, link: LinkItem['link'], suggested = false) => {
    const it: Omit<LinkItem, 'status' | 'fix'> = { id: n.id, section, name: labelOf(n), pictures: [], link, suggested };
    items.push(it);
    byId.set(n.id, it);
    return it;
  };

  const visit = (n: SceneNode, section: string, linkedAncestor: string | null) => {
    if (!n.visible) return;
    const own = nodeLink(n);
    let owner = linkedAncestor;
    if (own !== undefined) {
      add(n, section, { url: own, issue: linkIssue(own) });
      owner = n.id;
    }
    const im = pics.get(n.id);
    if (im) {
      const entry = pictureState(im, n.type === 'image' ? n.assetId : null, hosting, wp, doc.email?.imageUrls?.[n.id]?.trim() ?? '');
      const host = owner ? byId.get(owner) : undefined;
      if (host) host.pictures.push(entry);
      else add(n, section, null).pictures.push(entry);
      // A flattened frame is one picture: what's inside doesn't reach the inbox on its own.
      if (n.type === 'frame') return;
    }
    if (own === undefined && !owner && !dismissed.has(n.id)) {
      if ((n.type === 'frame' && isButtonFrame(n)) || (n.type === 'text' && isCtaText(n))) {
        add(n, section, null, true);
        return;
      }
    }
    if (n.type === 'frame') for (const c of n.children) visit(c, section, owner);
  };

  // The root's own link (rare) covers everything; its children are the sections.
  const rootLink = nodeLink(root);
  if (rootLink !== undefined) add(root, 'Email', { url: rootLink, issue: linkIssue(rootLink) });
  for (const s of root.children) visit(s, sectionName(s), rootLink !== undefined ? root.id : null);

  return items.map((it) => ({ ...it, ...statusOf(it) }));
}

/** How many entries need fixing, and how many are only suggestions. */
export function linkCounts(items: LinkItem[]) {
  return { fix: items.filter((i) => i.fix).length, suggested: items.filter((i) => i.suggested).length };
}

/** The next entry that needs fixing after `id` (wrapping), or null when none is left. */
export function nextToFix(items: LinkItem[], id: string | null): LinkItem | null {
  const open = items.filter((i) => i.fix);
  if (!open.length) return null;
  const at = id ? items.findIndex((i) => i.id === id) : -1;
  return items.slice(at + 1).find((i) => i.fix) ?? open.find((i) => i.id !== id) ?? null;
}
