import type { LayoutMap } from '../layout';
import { collectLinks, LINK_ISSUE_TEXT, linkIssue, nodeLink, type LinkIssue } from '../links';
import type { Doc, FrameNode, SceneNode } from '../types';
import { buildEmailHtml, parseNameTags } from './html';
import { imagesCheck, rowCheck, type CheckLevel } from './preview';

// The send checklist: the five things that have to be right before an email goes out, worked out
// from the board as it stands so they can stay on screen while you work. Subject and alt text use
// the inbox preview's checks and alt text comes from the export compiler, so all three agree.

export type SendCheckId = 'subject' | 'unsubscribe' | 'address' | 'links' | 'alt';

export interface SendCheck {
  id: SendCheckId;
  label: string;
  level: CheckLevel;
  title: string;
  detail: string;
  /** Layers this is about. */
  ids: string[];
}

/** Tags a sending tool fills in itself, which is different from a {{TOKEN}} nobody has filled yet. */
const MERGE_TAG = /%%[^%]+%%|\*\|[^|]+\|\*/;
const TOKEN = /\{\{[^}]*\}\}/;

interface Seen {
  node: SceneNode;
  /** The link on this layer or the nearest frame around it. */
  link: string | undefined;
}

function visible(nodes: SceneNode[], link?: string, out: Seen[] = []) {
  for (const node of nodes) {
    if (!node.visible) continue;
    const own = nodeLink(node) ?? link;
    out.push({ node, link: own });
    if (node.type === 'frame') visible(node.children, own, out);
  }
  return out;
}

const textOf = (n: SceneNode) => (n.type === 'text' ? n.text.replace(/\s+/g, ' ').trim() : '');
const nameOf = (n: SceneNode) => parseNameTags(n.name).clean;

function unsubscribeCheck(root: FrameNode): SendCheck {
  const base = { id: 'unsubscribe', label: 'Unsubscribe' } as const;
  const found = visible([root]).filter(({ node, link }) => /unsub/i.test(link ?? '') || /unsubscribe/i.test(textOf(node)));
  const live = found.find(({ node, link }) => MERGE_TAG.test(textOf(node)) || (link !== undefined && !linkIssue(link)));
  if (live) return { ...base, level: 'ok', title: 'Unsubscribe link is set', detail: live.link ? live.link.replace(/^https?:\/\/(www\.)?/, '') : 'Your sending tool fills this in.', ids: [live.node.id] };
  const linked = found.find(({ link }) => link !== undefined);
  if (linked) return { ...base, level: 'fix', title: 'Unsubscribe link isn\'t finished', detail: `${LINK_ISSUE_TEXT[linkIssue(linked.link!) as LinkIssue]}: give it the real link from your sending tool.`, ids: [linked.node.id] };
  const token = found.find(({ node }) => TOKEN.test(textOf(node)));
  if (token) return { ...base, level: 'fix', title: 'Unsubscribe is still a placeholder', detail: `Replace “${textOf(token.node).slice(0, 40)}”.`, ids: [token.node.id] };
  if (found.length) return { ...base, level: 'fix', title: 'Unsubscribe has no link', detail: `“${textOf(found[0].node).slice(0, 40)}” needs a link.`, ids: [found[0].node.id] };
  return { ...base, level: 'fix', title: 'No unsubscribe link', detail: 'Bulk email needs one. Add it to the footer.', ids: [] };
}

const STREET = /\b\d{1,6}\s+[\p{L}\d.'’-]+(\s+[\p{L}\d.'’-]+){0,4}?\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq|terrace|ter|circle|cir|trail|trl|suite|ste)\b/iu;
const PLACE = /\bp\.?\s*o\.?\s*box\s+\d+|\b[A-Z]{2},?\s+\d{5}(-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b|\b[A-Z]\d[A-Z]\s+\d[A-Z]\d\b/;
const NAMED = /mailing address|postal address/i;

/** Listings have street addresses too, so only the footer counts, or a layer named for the job. */
function addressCheck(root: FrameNode): SendCheck {
  const base = { id: 'address', label: 'Address' } as const;
  const sections = root.children.filter((n) => n.visible);
  const footers = sections.filter((n, i) => i === sections.length - 1 || /footer/i.test(nameOf(n)));
  const candidates = [...visible(footers), ...visible([root]).filter(({ node }) => NAMED.test(nameOf(node)))].map((s) => s.node).filter((n) => textOf(n));
  const token = candidates.find((n) => /\{\{[^}]*(address|addr)[^}]*\}\}/i.test(textOf(n)));
  const real = candidates.find((n) => !TOKEN.test(textOf(n)) && (STREET.test(textOf(n)) || PLACE.test(textOf(n)) || NAMED.test(nameOf(n)) || (MERGE_TAG.test(textOf(n)) && /addr/i.test(textOf(n)))));
  if (real) return { ...base, level: 'ok', title: 'Mailing address found', detail: `“${textOf(real).slice(0, 60)}”`, ids: [real.id] };
  if (token) return { ...base, level: 'fix', title: 'Mailing address is still a placeholder', detail: `Replace “${textOf(token).slice(0, 40)}”.`, ids: [token.id] };
  return { ...base, level: 'fix', title: 'No mailing address found', detail: 'Bulk email needs one in the footer. If yours is there, name its layer “Mailing address”.', ids: footers.map((n) => n.id) };
}

function linksCheck(doc: Doc): SendCheck {
  const base = { id: 'links', label: 'Links' } as const;
  const links = collectLinks(doc.nodes);
  if (!links.length) return { ...base, level: 'note', title: 'No links yet', detail: 'Nothing in this email goes anywhere.', ids: [] };
  const open = links.filter((l) => l.issue);
  if (!open.length) return { ...base, level: 'ok', title: 'All links are set', detail: `${links.length} link${links.length === 1 ? '' : 's'}, none left to fill in.`, ids: [] };
  const counts = new Map<LinkIssue, number>();
  for (const l of open) counts.set(l.issue!, (counts.get(l.issue!) ?? 0) + 1);
  const detail = counts.size === 1 ? LINK_ISSUE_TEXT[open[0].issue!] : [...counts].map(([issue, n]) => `${n}: ${LINK_ISSUE_TEXT[issue].toLowerCase()}`).join(', ');
  return { ...base, level: 'fix', title: `${open.length} link${open.length === 1 ? '' : 's'} to fix`, detail, ids: open.map((l) => l.id) };
}

/** RentCafe adds the unsubscribe link and mailing address when it sends, so the design doesn't need them. */
function sentBy(doc: Doc, id: 'unsubscribe' | 'address'): SendCheck | null {
  if (doc.email?.platform !== 'rentcafe') return null;
  const what = id === 'unsubscribe' ? { label: 'Unsubscribe', title: 'RentCafe adds the unsubscribe link' } : { label: 'Address', title: 'RentCafe adds the mailing address' };
  return { id, ...what, level: 'ok', detail: 'Sending through RentCafe, which puts it in every email.', ids: [] };
}

export function sendChecks(doc: Doc, root: FrameNode, layout: LayoutMap): SendCheck[] {
  const { images } = buildEmailHtml(root, layout, { title: '', imageUrl: (_id, file) => file, tracking: doc.email?.tracking });
  const row = rowCheck(root, doc.email?.subject ?? '', doc.email?.preheader ?? '');
  const alt = imagesCheck(root, images);
  return [
    { id: 'subject', label: 'Subject', level: row.level, title: row.title, detail: row.detail, ids: [] },
    sentBy(doc, 'unsubscribe') ?? unsubscribeCheck(root),
    sentBy(doc, 'address') ?? addressCheck(root),
    linksCheck(doc),
    // The preview treats this as a note, but “Ready” shouldn't sit next to pictures with no alt text.
    { id: 'alt', label: 'Alt text', level: alt.level === 'ok' ? 'ok' : 'fix', title: alt.title, detail: alt.detail, ids: alt.ids ?? [] },
  ];
}
