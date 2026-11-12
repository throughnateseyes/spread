import { useState } from 'react';
import { linkCounts, nextToFix, type LinkItem } from '../email/linkmap';
import { linkIssue, normaliseLink, setNodeLink } from '../links';
import { useStore } from '../store';
import { Section } from '../ui/controls';
import { IconLink, IconPaste } from '../ui/icons';
import { closeLinkItem, HostingField, ItemEditor, openLinkItem, revealLinkItem, StatusMarks, Thumb, useHostingIssue, useLinkItems } from './LinkEditor';

// "Links and pictures" in the right panel: every link and picture on the email, grouped by section,
// each row showing whether its picture has a home and whether it goes somewhere. Click a row to
// edit it in place; Enter moves on to the next one to fix. Below: where pictures are hosted, and
// the tracking tags every link shares.

export function LinksPanel() {
  const doc = useStore((s) => s.doc);
  const edit = useStore((s) => s.linkEdit);
  const linksMode = useStore((s) => s.linksMode);
  const items = useLinkItems(doc);
  const [filter, setFilter] = useState<'all' | 'fix'>('all');
  const counts = linkCounts(items);
  const suggested = counts.suggested;
  const hostIssue = useHostingIssue(doc, items);
  const fix = counts.fix + (hostIssue ? 1 : 0);
  const shown = filter === 'fix' ? items.filter((i) => i.fix || i.suggested || edit?.id === i.id) : items;
  const sections = [...new Set(shown.map((i) => i.section))];
  const setTracking = (tracking: string) => useStore.getState().updateBoard(doc.id, { email: { ...doc.email, tracking } });

  const open = (it: LinkItem) => {
    if (edit?.id === it.id && edit.from === 'panel') return closeLinkItem();
    openLinkItem(doc.id, it.id, 'panel');
    revealLinkItem(doc.id, it.id, true);
  };
  const goNext = (id: string) => {
    const next = nextToFix(items, id);
    if (!next) return closeLinkItem();
    openLinkItem(doc.id, next.id, 'panel');
    revealLinkItem(doc.id, next.id, true);
  };

  return (
    <Section
      title="Links and pictures"
      actions={<span className={fix ? 'link-count warn' : 'send-ready'}>{fix ? `${fix} to fix` : items.length ? 'All set' : ''}</span>}
    >
      <div className="lk-tools">
        <div className="lk-filter">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All {items.length}
          </button>
          <button className={filter === 'fix' ? 'on' : ''} onClick={() => setFilter('fix')}>
            To fix {fix}
            {suggested ? ` · ${suggested} hint${suggested === 1 ? '' : 's'}` : ''}
          </button>
        </div>
        <button
          className={`lk-mode ${linksMode ? 'on' : ''}`}
          title="Links mode (L): show every link and picture on the canvas"
          onClick={() => useStore.getState().set({ linksMode: !linksMode })}
        >
          <IconLink size={12} /> L
        </button>
      </div>

      {hostIssue && (
        <button className="lk-host-issue" onClick={() => document.querySelector('.lk-foot')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <b>Pictures need a home.</b> {hostIssue}
        </button>
      )}
      {items.length === 0 && <p className="link-empty">Nothing links anywhere yet. Select a layer and add a link below.</p>}
      {shown.length === 0 && items.length > 0 && <p className="link-empty">Every link is set and every picture has a home.</p>}

      {sections.map((sec) => {
        const rows = shown.filter((i) => i.section === sec);
        const open_ = items.filter((i) => i.section === sec && i.fix).length;
        const slots = items.filter((i) => i.section === sec && i.link);
        return (
          <div key={sec} className="lk-sec">
            <div className="lk-sec-head">
              <span className="ellipsis">{sec}</span>
              {slots.length > 1 && (
                <button className="lk-paste" title={`Paste a column of ${slots.length} links (e.g. from a spreadsheet) into ${sec}, top to bottom`} onClick={() => void pasteColumn(slots)}>
                  <IconPaste size={12} />
                </button>
              )}
              <span className={open_ ? 'bad' : 'muted'}>{open_ ? `${open_} to fix` : 'Done'}</span>
            </div>
            {rows.map((it) => {
              const on = edit?.id === it.id;
              return (
                <div key={it.id} className={`lk-row-wrap ${on ? 'on' : ''}`}>
                  <button className={`lk-row ${it.fix ? 'bad' : ''} ${it.suggested ? 'hint' : ''}`} onClick={() => open(it)}>
                    <Thumb item={it} />
                    <span className="lk-row-text">
                      <span className="ellipsis">{it.name}</span>
                      <span className="lk-row-status ellipsis">{it.status}</span>
                    </span>
                    <StatusMarks item={it} />
                  </button>
                  {on && edit.from === 'panel' && <ItemEditor key={it.id} board={doc} item={it} onNext={() => goNext(it.id)} onClose={closeLinkItem} />}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="lk-foot">
        <span className="inbox-label">Pictures host</span>
        <HostingField board={doc} compact />
      </div>
      <label className="inbox-field">
        <span className="inbox-label">Tracking tags</span>
        <div className="field">
          <input value={doc.email?.tracking ?? ''} placeholder="utm_source=…&utm_campaign=…" spellCheck={false} onChange={(e) => setTracking(e.target.value)} />
        </div>
      </label>
    </Section>
  );
}

/**
 * Fills a section's links from a pasted column (one URL per line), top to bottom. To stay safe it
 * needs a clear match: one URL per link in the section (replaces them all), one per link still to
 * fix, or a row open in the editor to start from (fills the open ones from there down).
 */
async function pasteColumn(slots: LinkItem[]) {
  const s = useStore.getState();
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return s.toast('Couldn’t read the clipboard', 'error');
  }
  const urls = text
    .split(/[\r\n\t]+/)
    .map((l) => normaliseLink(l))
    .filter((l) => l && !linkIssue(l));
  if (!urls.length) return s.toast('Copy a column of links first, one per line', 'info');
  const open = slots.filter((i) => i.link?.issue);
  const from = slots.findIndex((i) => i.id === s.linkEdit?.id);
  const targets =
    urls.length === slots.length ? slots : urls.length === open.length ? open : from >= 0 ? slots.slice(from).filter((i, k) => k === 0 || i.link?.issue).slice(0, urls.length) : null;
  if (!targets?.length) {
    return s.toast(`You copied ${urls.length} link${urls.length === 1 ? '' : 's'}, but ${open.length} here still need one. Open the row to start from, then paste again.`, 'info');
  }
  const by = new Map(targets.map((it, i) => [it.id, urls[i]] as const));
  s.updateNodes([...by.keys()], (n) => setNodeLink(n, by.get(n.id)!));
  s.toast(`Filled ${by.size} link${by.size === 1 ? '' : 's'}: ${targets[0].name} to ${targets[targets.length - 1].name}. Undo to put them back.`, 'success');
}
