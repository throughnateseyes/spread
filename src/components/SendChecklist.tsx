import { useEffect, useState } from 'react';
import { emailRootOf } from '../email/boards';
import { sendChecks, type SendCheck, type SendCheckId } from '../email/checklist';
import { useLayout, useStore } from '../store';
import { IconCheck, IconWarning } from '../ui/icons';

// The send checklist, pinned above the Design panel so it stays put whatever is selected.
// Each chip says how one check stands, and clicking it goes to the problem.

function go(check: SendCheck) {
  const s = useStore.getState();
  if (check.id === 'subject') {
    s.select([]);
    // The field only exists once the panel has swapped back to the board.
    requestAnimationFrame(() => window.dispatchEvent(new Event('spread:focus-subject')));
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
              if (open !== c.id) go(c);
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
    </div>
  );
}
