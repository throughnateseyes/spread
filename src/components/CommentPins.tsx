import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { boardFrames, useStore } from '../store';
import { commitDraft, inFlight, patchComment, pinLabel, pinPoint, removeComments, STATUS_TEXT } from '../comments';
import { sendNote } from '../chat';
import { toggleChat } from './ClaudePanel';
import { Floating } from '../ui/Floating';
import { Button } from '../ui/controls';
import { ICON_DENSE, IconArrowUp, IconCheck, IconSpinner, IconWarning } from '../ui/icons';
import type { CanvasComment, CommentStatus, Doc } from '../types';
import './comments.css';

// Comment pins over the canvas: plain HTML above the Konva stage, like the row headers, so they
// follow the view but are never part of what a board draws. Everything about the notes themselves
// is in comments.ts; sending is sendNote in chat.ts.

const PIN = 28;
const POP_W = 280;
const GAP = 8;

/** The note leaves for Claude, and the panel opens so the user can see it arrive. */
function send(id: string) {
  void sendNote(id);
  if (!useStore.getState().chatOpen) toggleChat(true, false);
}

/** A press on the popover's padding would otherwise take focus out of its field, and Esc with it. */
const keepFocus = (e: React.MouseEvent) => {
  if (!(e.target as HTMLElement).closest('textarea, button, .comment-text')) e.preventDefault();
};

/** Canvas-space point → px inside the canvas element. */
const toScreen = (x: number, y: number, v: { zoom: number; panX: number; panY: number }) => ({ left: x * v.zoom + v.panX, top: y * v.zoom + v.panY });

export default function CommentPins({ wrap }: { wrap: HTMLElement | null }) {
  const comments = useStore((s) => s.comments);
  const draft = useStore((s) => s.commentDraft);
  const openId = useStore((s) => s.openComment);
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const fv = useStore((s) => s.fontsVersion);
  const visible = useStore((s) => s.showComments || s.tool === 'comment');

  // The view changes every frame of a pan; what a pin is attached to doesn't.
  const pins = useMemo(() => {
    const frames = boardFrames(project);
    const out: { c: CanvasComment; b: Doc; x: number; y: number }[] = [];
    for (const c of comments) {
      const b = project.boards.find((x) => x.id === c.boardId);
      const f = b && frames.get(b.id);
      if (!b || !f) continue;
      const p = pinPoint(b, c, fv);
      out.push({ c, b, x: f.x + p.x, y: f.y + p.y });
    }
    return out;
  }, [comments, project, fv]);

  const draftAt = useMemo(() => {
    const b = draft && project.boards.find((x) => x.id === draft.boardId);
    const f = b && boardFrames(project).get(b.id);
    if (!draft || !b || !f) return null;
    const p = pinPoint(b, draft, fv);
    return { b, x: f.x + p.x, y: f.y + p.y };
  }, [draft, project, fv]);

  const open = openId ? pins.find((p) => p.c.id === openId) : null;
  const rect = wrap?.getBoundingClientRect();
  // The popover opens beside the pin where there's room. With both panels open the canvas can be too
  // narrow for that, so it goes below (or above) instead: it never covers the pin it belongs to.
  const beside = (x: number, y: number) => {
    const s = toScreen(x, y, view);
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    const need = POP_W + GAP * 2;
    if (s.left + PIN + need <= (rect?.width ?? 0)) return { x: left + s.left + PIN + GAP, y: top + s.top - PIN };
    if (s.left >= need) return { x: left + s.left - GAP, y: top + s.top - PIN, anchor: 'top-right' as const };
    return { x: left + s.left, y: top + s.top + GAP, altY: top + s.top - PIN - GAP };
  };

  return (
    <>
      {visible &&
        pins.map(({ c, x, y }) => (
          <Pin
            key={c.id}
            n={c.n}
            status={c.status}
            active={c.id === openId}
            at={toScreen(x, y, view)}
            onClick={() => {
              const s = useStore.getState();
              // A half-written note stays put: a stray click shouldn't cost the text.
              if (s.commentDraft?.text.trim()) return;
              s.set({ commentDraft: null, openComment: s.openComment === c.id ? null : c.id });
            }}
          />
        ))}
      {draftAt && (
        <>
          <Pin active at={toScreen(draftAt.x, draftAt.y, view)} />
          <Floating {...beside(draftAt.x, draftAt.y)} bounds={wrap} interactive className="comment-pop" data-own-wheel onMouseDown={keepFocus}>
            {/* A new spot is a new note: remounting puts focus back in the field. */}
            <Composer key={`${draft!.boardId}:${draft!.x}:${draft!.y}`} label={pinLabel(draftAt.b, draft!, fv)} />
          </Floating>
        </>
      )}
      {open && visible && (
        <Floating {...beside(open.x, open.y)} bounds={wrap} interactive className="comment-pop" data-own-wheel onMouseDown={keepFocus}>
          <Thread key={open.c.id} c={open.c} label={pinLabel(open.b, open.c, fv)} />
        </Floating>
      )}
    </>
  );
}

function Pin({ n, status, active, at, onClick }: { n?: number; status?: CommentStatus; active?: boolean; at: { left: number; top: number }; onClick?: () => void }) {
  const title = n ? `Note ${n}: ${STATUS_TEXT[status!]}` : 'New note';
  return (
    <button
      className={`comment-pin ${status ?? 'draft'} ${active ? 'open' : ''}`}
      style={{ transform: `translate(${Math.round(at.left)}px, ${Math.round(at.top) - PIN}px)` }}
      aria-label={title}
      title={title}
      data-status={status ?? 'draft'}
      // A press here mustn't take focus out of a half-written note, or Esc stops reaching its field.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="comment-pin-face">{status === 'done' ? <IconCheck size={14} weight="bold" /> : status === 'stopped' ? <IconWarning size={14} weight="bold" /> : n}</span>
    </button>
  );
}

function Field({ value, onChange, onSubmit, onCancel }: { value: string; onChange: (t: string) => void; onSubmit: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // <Floating> stays hidden until it's measured, and a hidden field can't take focus.
  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="comment-input"
      rows={1}
      placeholder="Note for Claude…"
      aria-label="Note for Claude"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

/** The popover on a new pin. */
function Composer({ label }: { label: string }) {
  const text = useStore((s) => s.commentDraft?.text ?? '');
  const set = useStore((s) => s.set);
  const submit = () => {
    const c = commitDraft();
    if (c) send(c.id);
  };
  return (
    <>
      <div className="comment-on">{label}</div>
      <div className="comment-box">
        <Field
          value={text}
          onChange={(t) => {
            const d = useStore.getState().commentDraft;
            if (d) set({ commentDraft: { ...d, text: t } });
          }}
          onSubmit={submit}
          onCancel={() => set({ commentDraft: null })}
        />
        <button className="chat-send" aria-label="Send to Claude" title="Send to Claude (Enter)" disabled={!text.trim()} onClick={submit}>
          <IconArrowUp size={14} weight="bold" />
        </button>
      </div>
    </>
  );
}

/** The popover on a pin that's already been sent. */
function Thread({ c, label }: { c: CanvasComment; label: string }) {
  const set = useStore((s) => s.set);
  const doneIds = useStore((s) => s.comments).filter((x) => x.status === 'done').map((x) => x.id);
  const [text, setText] = useState(c.text);
  const again = () => {
    const t = text.trim();
    if (!t) return;
    patchComment(c.id, { text: t });
    set({ openComment: null });
    send(c.id);
  };
  return (
    <>
      <div className={`comment-status ${c.status}`}>
        {c.status === 'working' ? <IconSpinner size={ICON_DENSE} className="spin" /> : c.status === 'done' ? <IconCheck size={ICON_DENSE} /> : c.status === 'stopped' ? <IconWarning size={ICON_DENSE} /> : <span className="comment-dot" />}
        <span>{STATUS_TEXT[c.status]}</span>
      </div>
      <div className="comment-on">
        Note {c.n} · {label}
      </div>
      {c.status === 'stopped' ? <Field value={text} onChange={setText} onSubmit={again} onCancel={() => set({ openComment: null })} /> : <div className="comment-text">{c.text}</div>}
      {/* A sent note can't be taken back from Claude, so it can't be deleted until Claude's done with it. */}
      {!inFlight(c.status) && (
        <div className="comment-actions">
          {c.status === 'stopped' && (
            <Button primary disabled={!text.trim()} onClick={again}>
              Send again
            </Button>
          )}
          <Button onClick={() => removeComments([c.id])}>Delete</Button>
          {c.status === 'done' && doneIds.length > 1 && <Button onClick={() => removeComments(doneIds)}>Clear {doneIds.length} done</Button>}
        </div>
      )}
    </>
  );
}
