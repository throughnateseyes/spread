import { useEffect, useState } from 'react';
import { emailRootOf } from '../email/boards';
import { sendChecks, type SendCheck, type SendCheckId } from '../email/checklist';
import { startLiveCheck, useLiveCheck, type LiveGroup } from '../email/livecheck';
import { native } from '../platform';
import { useLayout, useStore } from '../store';
import { findNode } from '../tree';
import type { Doc } from '../types';
import { IconCheck, IconInfo, IconSpinner, IconWarning } from '../ui/icons';
import { openLinkItem, revealLinkItem } from './LinkEditor';

// The send checklist, pinned above the Design panel so it stays put whatever is selected.
// Each chip says how one check stands, and clicking it goes to the problem.

/** Goes to what a check is about: the subject field, or the layers on the canvas. */
export function goToCheck(check: SendCheck) {
  const s = useStore.getState();
  if (check.id === 'subject') {
    s.select([]);
    // The field only exists once the panel has swapped back to the board.
    requestAnimationFrame(() => window.dispatchEvent(new Event('spread:focus-subject')));
  } else if (check.id === 'links' && check.ids.length) {
    // Broken links are fixed one after another in Links mode.
    s.set({ linksMode: true });
    openLinkItem(s.doc.id, check.ids[0], 'canvas');
    revealLinkItem(s.doc.id, check.ids[0]);
  } else if (check.ids.length) {
    s.select(check.ids);
    window.dispatchEvent(new Event('spread:zoom-selection'));
  }
}

export function SendChecklist() {
  const doc = useStore((s) => s.doc);
  const layout = useLayout();
  const [checks, setChecks] = useState<SendCheck[]>([]);
  const [open, setOpen] = useState<SendCheckId | null>(null);

  // It compiles the email, so it waits for a pause rather than running on every frame of a drag.
  useEffect(() => {
    const root = emailRootOf(doc);
    if (!root) return setChecks([]);
    const t = setTimeout(() => setChecks(sendChecks(doc, root, layout)), 250);
    return () => clearTimeout(t);
  }, [doc, layout]);

  if (doc.kind !== 'email' || !checks.length) return null;
  const toFix = checks.filter((c) => c.level === 'fix').length;
  const shown = checks.find((c) => c.id === open);
  return (
    <div className="send-strip">
      <div className="send-head">
        <span>Send check</span>
        <span className={toFix ? 'link-count warn' : 'send-ready'}>{toFix ? `${toFix} to fix` : 'Ready'}</span>
      </div>
      <div className="send-chips">
        {checks.map((c) => (
          <button
            key={c.id}
            className={`send-chip ${c.level} ${open === c.id ? 'on' : ''}`}
            title={c.title}
            aria-expanded={open === c.id}
            onClick={() => {
              setOpen(open === c.id ? null : c.id);
              if (open !== c.id) goToCheck(c);
            }}
          >
            {c.level === 'ok' ? <IconCheck size={12} /> : <IconWarning size={12} />}
            {c.label}
          </button>
        ))}
      </div>
      {shown && (
        <p className="send-detail">
          <strong>{shown.title}.</strong> {shown.detail}
        </p>
      )}
      <LiveCheck doc={doc} />
    </div>
  );
}

const GROUPS: { id: LiveGroup; label: string }[] = [
  { id: 'pictures', label: 'Pictures' },
  { id: 'links', label: 'Links' },
  { id: 'shapes', label: 'Photo shapes' },
];

function goToLayer(id: string | null) {
  const s = useStore.getState();
  if (!id || !findNode(s.doc.nodes, id)) return;
  s.select([id]);
  window.dispatchEvent(new Event('spread:zoom-selection'));
}

/**
 * The live check: loads every picture and link in the email, on demand only. Its findings stay
 * until the board changes, since any edit could change what they say.
 */
function LiveCheck({ doc }: { doc: Doc }) {
  const layout = useLayout();
  const entry = useLiveCheck((s) => s.byBoard[doc.id]);
  const running = !!entry?.progress;
  const fresh = !!entry && entry.doc === doc;
  const result = fresh ? entry.result : null;
  const stale = !!entry?.result && !fresh && !running;
  const toFix = result ? result.items.filter((i) => i.level === 'fix').length : 0;

  const run = () => {
    const root = emailRootOf(doc);
    // Failures land in the store and show below.
    if (root) startLiveCheck(doc, root, layout).catch(() => {});
  };

  return (
    <div className="live-check">
      <div className="live-head">
        <button
          className="live-run"
          onClick={run}
          disabled={running || !native}
          title={native ? 'Loads every picture and link in the email, and checks each listing card against its page' : 'The live check needs the Spread desktop app'}
        >
          {running ? (
            <>
              <IconSpinner size={12} className="spin" />
              {entry.progress!.total ? `Checking ${entry.progress!.done} of ${entry.progress!.total}…` : 'Checking…'}
            </>
          ) : result ? (
            'Check again'
          ) : (
            'Live check'
          )}
        </button>
        {result && !running ? (
          <span className={toFix ? 'link-count warn' : 'send-ready'}>{toFix ? `${toFix} to fix` : 'All load'}</span>
        ) : (
          !running && <span className="live-hint">Loads every picture and link</span>
        )}
      </div>
      {fresh && entry.error && !running && <p className="send-detail">{entry.error}.</p>}
      {stale && <p className="send-detail">The board changed since the last live check.</p>}
      {result && !running && (
        <div className="live-results">
          {GROUPS.map(({ id, label }) => {
            const problems = result.items.filter((i) => i.group === id && i.level !== 'ok');
            const level = problems.some((i) => i.level === 'fix') ? 'fix' : problems.length ? 'note' : 'ok';
            return (
              <div className="live-group" key={id}>
                <div className={`live-sum ${level}`}>
                  {level === 'ok' ? <IconCheck size={12} /> : level === 'fix' ? <IconWarning size={12} /> : <IconInfo size={12} />}
                  <span>
                    <strong>{label}</strong> {result.summary[id]}
                  </span>
                </div>
                {problems.map((i, k) => (
                  <button key={k} className={`live-item ${i.level}`} title={i.url} onClick={() => goToLayer(i.nodeId)}>
                    <span className="live-name">{i.name}</span>
                    <span className="live-text">{i.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
