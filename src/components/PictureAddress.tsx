import { useEffect, useRef, useState } from 'react';
import { imageUrlProblem, pictureUrlProblem, setImageUrls } from '../email/hosting';
import { useStore } from '../store';
import type { Doc, SceneNode } from '../types';
import { Section } from '../ui/controls';
import { IconClose, IconLink } from '../ui/icons';

// A picture's own web address on an email board (EmailMeta.imageUrls). It wins over the board's
// hosting (WordPress, folder, URL per picture), and Spread doesn't export or upload that picture.
// Used in the right panel for a selected photo and in the Export window's picture list.

/** The field: saves as you type once the address is usable (an unusable one stays here, unsaved, with why), clears with the x. */
export function PictureAddressField({ board, nodeId, placeholder = 'Web address (optional)' }: { board: Doc; nodeId: string; placeholder?: string }) {
  const saved = board.email?.imageUrls?.[nodeId] ?? '';
  const [val, setVal] = useState(saved);
  const input = useRef<HTMLInputElement>(null);
  // Follow undo, Claude and the other field, but not while typing here.
  useEffect(() => {
    if (document.activeElement !== input.current) setVal(saved);
  }, [saved, nodeId]);
  const blocking = val.trim() ? imageUrlProblem(val) : null;
  // Plain http is saved, with a nudge.
  const nudge = !blocking && val.trim() ? pictureUrlProblem(val) : null;
  const write = (v: string) => {
    setVal(v);
    if (!v.trim() || !imageUrlProblem(v)) setImageUrls(board.id, { [nodeId]: v });
  };
  return (
    <>
      <div className={`field ${blocking ? 'em-invalid' : ''}`}>
        <IconLink size={12} />
        <input
          ref={input}
          value={val}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => write(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.current?.blur();
          }}
        />
        {val && (
          <button className="lk-x" title="Clear web address" onClick={() => write('')}>
            <IconClose size={12} />
          </button>
        )}
      </div>
      {(blocking || nudge) && <p className="link-issue">{blocking ?? nudge}</p>}
    </>
  );
}

/** Right panel: shown when one photo on an email board is selected. */
export function PictureAddressSection({ sel }: { sel: SceneNode[] }) {
  const doc = useStore((s) => s.doc);
  const node = sel.length === 1 ? sel[0] : null;
  if (doc.kind !== 'email' || node?.type !== 'image') return null;
  return (
    <Section title="Web address (optional)">
      <PictureAddressField board={doc} nodeId={node.id} placeholder="https://…" />
      <p className="hint">Already online, like a listing photo? Paste its address and the email uses it as is. Spread won’t export or upload this picture.</p>
    </Section>
  );
}
