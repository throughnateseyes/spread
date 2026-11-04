import type { SceneNode } from './types';
import { walk } from './tree';

// Links on layers. A layer's `link` is the real property; a `[link:URL]` tag in its name is the older
// form, still read so saved templates and projects keep working. Setting a link moves it off the name.

const LINK_TAG = /\s*\[link(?::([^\]]*))?\]/i;

export type LinkIssue = 'empty' | 'placeholder' | 'invalid';

export interface LinkEntry {
  id: string;
  key: string | null;
  name: string;
  type: SceneNode['type'];
  url: string;
  issue: LinkIssue | null;
}

export const LINK_ISSUE_TEXT: Record<LinkIssue, string> = {
  empty: 'No URL yet',
  placeholder: 'Still a placeholder',
  invalid: 'Needs https://, mailto: or tel:',
};

/** The layer's own link: undefined when it has none, '' when one was added but not filled in. */
export function nodeLink(n: SceneNode): string | undefined {
  if (n.link !== undefined && n.link !== null) return n.link;
  const m = LINK_TAG.exec(n.name);
  return m ? (m[1] ?? '').trim() : undefined;
}

/** Sets or (with null) removes a layer's link. Call inside a store change. */
export function setNodeLink(n: SceneNode, url: string | null) {
  n.name = n.name.replace(LINK_TAG, '').trim() || n.name;
  if (url === null) delete n.link;
  else n.link = url;
}

export function linkIssue(url: string): LinkIssue | null {
  const u = url.trim();
  if (!u || u === '#') return 'empty';
  if (/\{\{.*\}\}/.test(u)) return 'placeholder';
  return /^(https?:\/\/\S+|mailto:\S+|tel:\S+)$/i.test(u) ? null : 'invalid';
}

/** "example.com/x" → "https://example.com/x". Anything else is left as typed. */
export function normaliseLink(url: string) {
  const u = url.trim();
  return /^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(u) ? `https://${u}` : u;
}

/** Every link on a board, top to bottom. */
export function collectLinks(nodes: SceneNode[]): LinkEntry[] {
  const out: LinkEntry[] = [];
  walk(nodes, (n) => {
    const url = nodeLink(n);
    if (url === undefined) return;
    const label = n.type === 'text' ? n.text.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    out.push({ id: n.id, key: n.key ?? null, name: label || n.name.replace(/\s*\[[^\]]*\]/g, '').trim(), type: n.type, url, issue: linkIssue(url) });
  });
  return out;
}

/**
 * Adds tracking tags ("utm_source=x&utm_campaign=y") to a web link. Tags the URL already has win.
 * Placeholders, mailto:, tel: and unsubscribe links are left alone.
 */
export function withTracking(url: string, tracking = ''): string {
  const pairs = tracking.trim().replace(/^[?&]+/, '').split('&').filter(Boolean);
  if (!pairs.length || !/^https?:\/\//i.test(url) || /\{\{|unsub/i.test(url)) return url;
  const [head, ...hash] = url.split('#');
  const query = head.split('?').slice(1).join('?');
  const have = new Set(query.split('&').map((p) => p.split('=')[0]));
  const add = pairs.filter((p) => !have.has(p.split('=')[0]));
  if (!add.length) return url;
  return head + (head.includes('?') ? '&' : '?') + add.join('&') + (hash.length ? `#${hash.join('#')}` : '');
}
