import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { contextChips, currentChatKey, sendChat, useChat } from '../chat';
import { native, type ChatItem, type ChatQuestion, type ChatThumb } from '../platform';
import { isChatImage, prepareChatImage, type ChatImage } from '../chatImages';
import { MOD, useStore } from '../store';
import { useActiveBrand } from '../brand';
import { Button, IconButton } from '../ui/controls';
import { Menu, useMenuButton, type MenuItem } from '../ui/Menu';
import { ICON_DENSE, IconArrowUp, IconAttach, IconCheck, IconClose, IconComment, IconFile, IconImage, IconMore, IconNewChat, IconSparkle, IconSpinner, IconStop, IconWarning } from '../ui/icons';
import './claude-panel.css';

// The Claude side panel: a conversation with the user's own Claude Code, docked beside the canvas.
// Every message carries what the user is looking at (see chat.ts), Spread's tools need no approval,
// and anything else Claude wants to do shows up here as an Allow / Deny card.

const WIDTH_KEY = 'spread.chatWidth';
const MIN_W = 300;
const MAX_W = 640;

export function chatWidth() {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w >= MIN_W && w <= MAX_W ? w : 360;
  } catch {
    return 360;
  }
}

export function toggleChat(open = !useStore.getState().chatOpen, focus = true) {
  useStore.getState().set({ chatOpen: open });
  try {
    localStorage.setItem('spread.chatOpen', open ? '1' : '');
  } catch {
    // storage unavailable
  }
  if (open && focus) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus());
}

/** Pictures one message can carry (Claude reads up to 100; more than a handful is slow and costly). */
const MAX_PICTURES = 10;

const focusInput = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus());

export default function ClaudePanel() {
  const state = useChat((s) => s.state);
  const items = state?.items ?? [];
  const working = state?.status === 'working';
  const queued = state?.queued ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [images, setImages] = useState<ChatImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const toast = useStore((s) => s.toast);

  // Stay at the bottom while Claude streams, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = (text = draft) => {
    const t = text.trim();
    // Starter flows and ideas send their own text; the box sends what's in it, pictures included.
    const pics = text === draft ? images : [];
    if ((!t && !pics.length) || (text === draft && preparing)) return;
    pinned.current = true;
    void sendChat(t, files, pics);
    setDraft('');
    setFiles([]);
    if (pics.length) setImages([]);
  };

  // Whatever Claude hadn't read yet comes back to the box, so Stop never loses it. Notes stay on
  // their pins, which offer to send them again with their layer still attached.
  const stop = () => {
    const unread = queued.filter((q) => !q.noteId);
    if (unread.length) setDraft([...unread.map((q) => q.text), draft].filter(Boolean).join('\n\n'));
    void native?.chatStop(currentChatKey());
  };

  // Pictures ride along as images Claude can see (a Finder file also keeps its path, so Claude can
  // place it on the canvas). Anything else is attached by its path for Claude to open.
  const addFiles = (list: FileList | File[]) => {
    if (!native) return;
    const all = Array.from(list);
    const room = Math.max(0, MAX_PICTURES - images.length - preparing);
    const pics = all.filter(isChatImage).slice(0, room);
    const rest = all.filter((f) => !pics.includes(f));
    const paths = rest.map((f) => native!.pathForFile(f)).filter(Boolean);
    if (rest.some((f) => isChatImage(f) && !native!.pathForFile(f))) toast(`Up to ${MAX_PICTURES} pictures per message`);
    if (paths.length) setFiles((cur) => [...new Set([...cur, ...paths])]);
    if (!pics.length) return;
    setPreparing((n) => n + pics.length);
    for (const f of pics) {
      const path = native.pathForFile(f) || undefined;
      void prepareChatImage(f, f.name || 'Pasted picture', path).then((im) => {
        setPreparing((n) => n - 1);
        if (im) setImages((cur) => (path && cur.some((x) => x.path === path) ? cur : [...cur, im]));
        else toast(`Couldn’t read ${f.name || 'that picture'}`, 'error');
      });
    }
  };

  // ⌘V of a screenshot, a copied picture or a Finder file attaches it. Text pastes as text; pasted
  // outside the box (into the transcript, say), it goes into the box.
  const onPaste = (e: React.ClipboardEvent) => {
    const dt = e.clipboardData;
    const pasted = Array.from(dt.files);
    const text = dt.getData('text/plain');
    const fromDisk = pasted.some((f) => native?.pathForFile(f));
    // A spreadsheet or a web page copies its words as a picture too: then the words win.
    if (pasted.length && (fromDisk || !text.trim())) {
      e.preventDefault();
      addFiles(pasted);
      focusInput();
      return;
    }
    const t = e.target as HTMLElement;
    if (text && !t.closest('textarea, input, [contenteditable]')) {
      e.preventDefault();
      setDraft(draft ? `${draft}${/\s$/.test(draft) ? '' : ' '}${text}` : text);
      focusInput();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
      focusInput();
    }
  };

  return (
    <aside
      className={`panel chat ${dragging ? 'drop-hover' : ''}`}
      aria-label="Claude"
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <ResizeHandle />
      <Header empty={!items.length} working={working} />
      {/* Focusable and a select-all scope: once clicked, ⌘A selects the conversation (see editCommand). */}
      <div className="chat-scroll" ref={scroller} tabIndex={-1} onScroll={onScroll} data-select-scope>
        {items.length ? <Transcript items={items} working={working} /> : <EmptyState onPick={(t) => setDraft(t)} onStart={(t) => send(t)} />}
      </div>
      <Composer
        draft={draft}
        setDraft={setDraft}
        files={files}
        setFiles={setFiles}
        images={images}
        setImages={setImages}
        preparing={preparing}
        working={working}
        queued={queued}
        onSend={() => send()}
        onStop={stop}
        onAttach={addFiles}
      />
    </aside>
  );
}

function ResizeHandle() {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing-chat');
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, startW + startX - ev.clientX)));
      document.documentElement.style.setProperty('--chat-w', `${w}px`);
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        // storage unavailable
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing-chat');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return <div className="chat-resize" onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" aria-label="Resize the Claude panel" />;
}

function Header({ empty, working }: { empty: boolean; working: boolean }) {
  const { at, close, triggerProps } = useMenuButton();
  const set = useStore((s) => s.set);
  const items: MenuItem[] = [
    { label: 'New chat', fn: () => native?.chatReset(currentChatKey()) },
    null,
    { label: 'Use Spread in the Claude app…', fn: () => set({ modal: 'claude' }) },
    { label: 'Brands and design docs…', fn: () => set({ modal: 'brands' }) },
  ];
  return (
    <div className="chat-head">
      <IconSparkle size={ICON_DENSE} weight="fill" className="chat-mark" />
      <span className="chat-title">Claude</span>
      {working && <span className="chat-working">working</span>}
      <span className="spacer" />
      <IconButton title="New chat" className="small" disabled={empty || working} onClick={() => native?.chatReset(currentChatKey())}>
        <IconNewChat size={ICON_DENSE} />
      </IconButton>
      <button className="icon-btn small" aria-label="More" {...triggerProps}>
        <IconMore size={ICON_DENSE} />
      </button>
      {at && <Menu at={at} items={items} onClose={close} />}
      <IconButton title="Close" shortcut={`${MOD}+J`} className="small" onClick={() => toggleChat(false)}>
        <IconClose size={ICON_DENSE} />
      </IconButton>
    </div>
  );
}

// ---------- the transcript ----------

type Block = { kind: 'item'; item: ChatItem } | { kind: 'steps'; items: Extract<ChatItem, { kind: 'tool' }>[] };

/** Consecutive tool calls fold into one "steps" block; everything else stands alone. */
function blocksOf(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === 'text' && !it.text.trim()) continue;
    const last = out[out.length - 1];
    if (it.kind === 'tool') {
      if (last?.kind === 'steps') last.items.push(it);
      else out.push({ kind: 'steps', items: [it] });
    } else {
      out.push({ kind: 'item', item: it });
    }
  }
  return out;
}

function Transcript({ items, working }: { items: ChatItem[]; working: boolean }) {
  const blocks = useMemo(() => blocksOf(items), [items]);
  const lastUser = items.map((it) => it.kind).lastIndexOf('user');
  const answered = items.slice(lastUser + 1).some((it) => it.kind !== 'user');
  return (
    <div className="chat-list">
      {blocks.map((b) => (b.kind === 'steps' ? <Steps key={b.items[0].id} items={b.items} live={working && b.items.some((t) => t.status === 'running')} /> : <Item key={b.item.id} item={b.item} />))}
      {working && !answered && (
        <div className="chat-thinking">
          <IconSpinner size={ICON_DENSE} className="spin" /> Thinking…
        </div>
      )}
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="chat-user">
          {item.images?.length ? <Thumbs images={item.images} /> : null}
          {item.text && <div className="chat-bubble">{item.text}</div>}
          {item.label && <div className="chat-ctx">{item.label}</div>}
        </div>
      );
    case 'text':
      return item.text.trim() ? <Markdown text={item.text} /> : null;
    case 'approval':
      return <Approval item={item} />;
    case 'notice':
      return <Notice item={item} />;
    case 'question':
      return <Questions item={item} />;
    default:
      return null;
  }
}

/** Pictures sent with a message, as saved: thumbnails only. */
function Thumbs({ images }: { images: ChatThumb[] }) {
  return (
    <div className="chat-pics sent">
      {images.map((im, i) =>
        im.thumb ? (
          <img key={i} className="chat-pic" src={im.thumb} alt={im.name} title={im.name} draggable={false} />
        ) : (
          <span key={i} className="chat-pic missing" title={im.name}>
            <IconImage size={16} />
          </span>
        ),
      )}
    </div>
  );
}

function Steps({ items, live }: { items: Extract<ChatItem, { kind: 'tool' }>[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const errors = items.filter((t) => t.status === 'error').length;
  const show = open || live ? items : [];
  const current = items[items.length - 1];
  return (
    <div className={`chat-steps ${errors ? 'has-error' : ''}`}>
      <button className="chat-steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {live ? <IconSpinner size={12} className="spin" /> : errors ? <IconWarning size={12} /> : <IconCheck size={12} />}
        <span>{live ? stepText(items.find((t) => t.status === 'running') ?? current) : `${items.length} step${items.length > 1 ? 's' : ''}${errors ? ` · ${errors} failed` : ''}`}</span>
      </button>
      {show.length > 0 && !live && (
        <ul className="chat-step-list">
          {show.map((t) => (
            <li key={t.id} className={t.status}>
              {stepText(t)}
              {t.error && <div className="chat-step-error">{t.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const stepText = (t: { label: string; detail?: string }) => (t.detail ? `${t.label} · ${t.detail}` : t.label);

function Approval({ item }: { item: Extract<ChatItem, { kind: 'approval' }> }) {
  const decide = (decision: 'allow' | 'always' | 'deny') => native?.chatApprove({ key: currentChatKey(), requestId: item.requestId, decision });
  const pending = item.status === 'pending';
  return (
    <div className={`chat-approval ${item.status}`}>
      <div className="chat-approval-head">
        {pending ? 'Claude wants to' : item.status === 'allowed' ? 'Allowed:' : item.status === 'denied' ? 'Declined:' : 'Expired:'} <b>{item.label.toLowerCase()}</b>
        {item.detail ? <span className="muted"> {item.detail}</span> : null}
      </div>
      {pending && item.preview && <pre className="chat-approval-preview">{item.preview}</pre>}
      {pending && (
        <div className="chat-approval-actions">
          <Button primary onClick={() => decide('allow')}>
            Allow
          </Button>
          <Button onClick={() => decide('always')} title="Don’t ask again for this kind of step in this chat">
            Allow for this chat
          </Button>
          <span className="spacer" />
          <Button onClick={() => decide('deny')}>Deny</Button>
        </div>
      )}
    </div>
  );
}

function Notice({ item }: { item: Extract<ChatItem, { kind: 'notice' }> }) {
  const toast = useStore((s) => s.toast);
  const [signingIn, setSigningIn] = useState(false);
  const login = async () => {
    const r = await native?.chatLogin();
    if (r && !r.ok) toast(r.error ?? 'Couldn’t open the sign-in', 'error');
    else setSigningIn(true);
  };
  return (
    <div className={`chat-notice ${item.tone}`}>
      <IconWarning size={ICON_DENSE} />
      <div className="chat-notice-body">
        <div>{signingIn && item.action === 'login' ? 'Finish signing in in the Terminal window (it opens your browser), then try again.' : item.text}</div>
        {item.action === 'login' && (
          <div className="chat-notice-actions">
            <Button primary={!signingIn} onClick={login}>
              {signingIn ? 'Open sign-in again' : 'Sign in'}
            </Button>
            <Button primary={signingIn} onClick={() => native?.chatRetry(currentChatKey())}>
              Try again
            </Button>
          </div>
        )}
        {item.action === 'install' && (
          <a className="link-btn left" href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">
            Install Claude Code
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- empty state and composer ----------

// Starter flows: each opens with the creative director's brief (spread-director), not a pile of output.
const ASK = 'Read the canvas first, then ask only what’s still open, in one card.';
const FLOWS: { label: string; hint: string; text: string }[] = [
  { label: 'Listing carousel', hint: 'Photos to a 7–9 slide post', text: `New job: a listing carousel from the photos in the tray (if it’s empty, ask me for the folder). ${ASK}` },
  { label: 'Open house flyer', hint: 'Poster or Letter, one message', text: `New job: an open house flyer. ${ASK}` },
  { label: 'E-blast', hint: 'One CTA, inbox-safe HTML', text: `New job: an e-blast. ${ASK}` },
  { label: 'Campaign', hint: 'One idea across post, story, email', text: `New job: a small campaign, one idea across a few formats. ${ASK}` },
  { label: 'Resume or one-pager', hint: 'Print-ready PDF', text: `New job: a resume or one-pager (I’ll attach my current version). ${ASK}` },
];

function EmptyState({ onPick, onStart }: { onPick: (t: string) => void; onStart: (t: string) => void }) {
  const hasSelection = useStore((s) => s.selection.length > 0);
  const hasWork = useStore((s) => s.project.boards.some((b) => b.nodes.length > 0));
  const brand = useActiveBrand();
  const ideas = hasSelection ? ['Tighten the spacing in this', 'Give me 3 directions for this', 'What’s weak about this?'] : hasWork ? ['Critique this row', brand ? `Check this row against ${brand.name}` : 'Give me 3 directions for this row'] : [];
  return (
    <div className="chat-empty">
      <IconSparkle size={20} weight="fill" className="chat-mark" />
      <div className="chat-empty-title">What are we making?</div>
      <p>Claude asks a few questions, shows you directions to pick from, then builds on the canvas.</p>
      <div className="chat-flows">
        {FLOWS.map((f) => (
          <button key={f.label} onClick={() => onStart(f.text)}>
            <b>{f.label}</b>
            <span>{f.hint}</span>
          </button>
        ))}
      </div>
      {ideas.length > 0 && (
        <div className="chat-ideas">
          {ideas.map((t) => (
            <button key={t} onClick={() => onPick(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Claude's brief questions as cards: tap an option (or write your own), then Send. */
/** Claude's recommendation comes pre-selected, so "Go with these" is one tap. */
const recommended = (qs: ChatQuestion[]) =>
  Object.fromEntries(qs.map((q) => [q.question, q.options.filter((o) => /\(recommended\)/i.test(o.label)).slice(0, q.multiSelect ? undefined : 1).map((o) => o.label)]));

function Questions({ item }: { item: Extract<ChatItem, { kind: 'question' }> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>(() => recommended(item.questions));
  const [other, setOther] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const pending = item.status === 'pending';
  // An unanswered question is left to Claude rather than blocking the whole card.
  const answerOf = (q: ChatQuestion) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(', ') || '(your call)';
  const submit = (answers: Record<string, string>) => native?.chatAnswer({ key: currentChatKey(), requestId: item.requestId, answers });
  const toggle = (q: ChatQuestion, label: string) => {
    setTouched(true);
    const cur = picked[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [q.question]: next });
    // A single one-choice question answers on the tap (unless they've started typing their own).
    if (!q.multiSelect && item.questions.length === 1 && !other[q.question]?.trim()) void submit({ [q.question]: label });
  };

  if (!pending) {
    return (
      <div className="chat-questions done">
        {item.status === 'answered' && item.answers ? (
          item.questions.map((q) => (
            <div key={q.question} className="chat-answer">
              <span className="muted">{q.header || q.question}</span> {item.answers![q.question] ?? '—'}
            </div>
          ))
        ) : (
          <div className="muted">{item.status === 'skipped' ? 'Skipped the questions' : 'Questions expired'}</div>
        )}
      </div>
    );
  }
  return (
    <div className="chat-questions">
      {item.questions.map((q) => (
        <div key={q.question} className="chat-q">
          {q.header && <div className="chat-q-header">{q.header}</div>}
          <div className="chat-q-text">{q.question}</div>
          <div className="chat-q-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} className={on ? 'on' : ''} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                  <b>{o.label}</b>
                  {o.description && <span>{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            className="chat-q-other"
            placeholder="Or in your own words…"
            value={other[q.question] ?? ''}
            onChange={(e) => {
              setTouched(true);
              setOther({ ...other, [q.question]: e.target.value });
            }}
          />
        </div>
      ))}
      <div className="chat-approval-actions">
        <Button primary onClick={() => submit(Object.fromEntries(item.questions.map((q) => [q.question, answerOf(q)])))}>
          {touched ? 'Send answers' : 'Go with these'}
        </Button>
        <span className="spacer" />
        <Button onClick={() => native?.chatAnswer({ key: currentChatKey(), requestId: item.requestId, answers: null })} title="Let Claude decide">
          Skip
        </Button>
      </div>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  files,
  setFiles,
  images,
  setImages,
  preparing,
  working,
  queued,
  onSend,
  onStop,
  onAttach,
}: {
  draft: string;
  setDraft: (t: string) => void;
  files: string[];
  setFiles: (f: string[]) => void;
  images: ChatImage[];
  setImages: (f: ChatImage[]) => void;
  preparing: number;
  working: boolean;
  queued: { id: string; text: string; noteId?: string; images?: ChatThumb[] }[];
  onSend: () => void;
  onStop: () => void;
  onAttach: (f: FileList) => void;
}) {
  // Re-read the chips whenever the canvas state they describe changes.
  useStore((s) => s.selection);
  useStore((s) => s.traySelection);
  useStore((s) => s.project.activeBoardId);
  useStore((s) => s.doc.name);
  useActiveBrand();
  const chips = contextChips();
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  return (
    <div className="chat-composer">
      {queued.length > 0 && (
        <div className="chat-queue" aria-label="Waiting for Claude">
          <span className="chat-queue-label">Claude reads {queued.length > 1 ? 'these' : 'this'} at its next step</span>
          {queued.map((q) => (
            <div key={q.id} className="chat-queued">
              {q.noteId && <IconComment size={12} className="chat-queued-note" aria-label="Canvas note" />}
              {q.text}
              {q.images?.length ? <span className="muted">{`${q.text ? ' · ' : ''}${q.images.length} picture${q.images.length > 1 ? 's' : ''}`}</span> : null}
            </div>
          ))}
        </div>
      )}
      <div className="chat-chips" title="Sent with your message so Claude knows what you mean">
        {chips.row && <span className="chat-chip">{chips.row}</span>}
        {chips.selection && <span className="chat-chip on">{chips.selection}</span>}
        {chips.photos && <span className="chat-chip on">{chips.photos}</span>}
        <span className="chat-chip">{chips.brand}</span>
      </div>
      {(images.length > 0 || preparing > 0) && (
        <div className="chat-pics" aria-label="Pictures to send">
          {images.map((im) => (
            <span key={im.id} className="chat-pic-wrap" title={`${im.name} · ${im.width}×${im.height}`}>
              <img className="chat-pic" src={im.thumb} alt={im.name} draggable={false} />
              <button aria-label={`Remove ${im.name}`} onClick={() => setImages(images.filter((x) => x.id !== im.id))}>
                <IconClose size={10} />
              </button>
            </span>
          ))}
          {Array.from({ length: preparing }, (_, i) => (
            <span key={`p${i}`} className="chat-pic missing" aria-label="Getting the picture ready">
              <IconSpinner size={14} className="spin" />
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="chat-files">
          {files.map((f) => (
            <span key={f} className="chat-file" title={f}>
              <IconFile size={12} /> {f.split(/[\\/]/).pop()}
              <button aria-label="Remove" onClick={() => setFiles(files.filter((x) => x !== f))}>
                <IconClose size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-box">
        <textarea
          ref={input}
          className="chat-input"
          rows={1}
          placeholder={working ? 'Add to this while Claude works…' : 'Ask Claude to design, refine or critique. Paste or drop pictures to show it.'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
            if (e.key === 'Escape') (e.target as HTMLElement).blur();
          }}
        />
        <div className="chat-box-row">
          <IconButton title="Attach files or pictures" className="small" onClick={() => picker.current?.click()}>
            <IconAttach size={ICON_DENSE} />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) onAttach(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="spacer" />
          {working && (
            <button className="chat-send stop" aria-label="Stop" title="Stop" onClick={onStop}>
              <IconStop size={12} weight="fill" />
            </button>
          )}
          {(!working || draft.trim() || images.length > 0) && (
            <button className="chat-send" aria-label="Send" title={preparing ? 'Getting the pictures ready…' : 'Send (Enter)'} disabled={(!draft.trim() && !images.length) || preparing > 0} onClick={onSend}>
              <IconArrowUp size={14} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- a small Markdown renderer (Claude's replies) ----------

function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)}</p>);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(<pre key={out.length}>{code.join('\n')}</pre>);
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) continue;
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      }
      i--;
      out.push(
        <div key={out.length} className="md-table">
          <table>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const lis: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) lis.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      i--;
      const L = ordered ? 'ol' : 'ul';
      out.push(
        <L key={out.length}>
          {lis.map((l, li) => (
            <li key={li}>{inline(l)}</li>
          ))}
        </L>,
      );
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push(
        <p key={out.length} className="md-h">
          {inline(line.replace(/^#+\s*/, ''))}
        </p>,
      );
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return <div className="chat-text">{out}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:[^)\s]+)\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={m.index}>{t.slice(2, -2)}</b>);
    else if (m[3])
      out.push(
        <a key={m.index} href={m[4]} target="_blank" rel="noreferrer">
          {t.slice(1, t.indexOf(']'))}
        </a>,
      );
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
