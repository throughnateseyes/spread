import { useEffect, useRef, useState } from 'react';
import { getAsset } from '../assets';
import { emailRootOf } from '../email/boards';
import { boardHosting, checkWordPress, pictureUrlProblem, setBoardHosting, setImageUrls, useWordPress, type WordPress } from '../email/hosting';
import { hostingIssue, linkItems, type LinkItem, type PictureEntry } from '../email/linkmap';
import { getLayout } from '../layout';
import { LINK_ISSUE_TEXT, linkIssue, nodeLink, normaliseLink, setNodeLink } from '../links';
import { findNode } from '../tree';
import { isElectron, native } from '../platform';
import { boardFrames, useStore } from '../store';
import { absoluteBoxes } from '../render';
import type { Doc, PictureHostMode } from '../types';
import { Button, Segmented } from '../ui/controls';
import { IconCheck, IconClose, IconImage, IconLink, IconPlus } from '../ui/icons';

// The pieces the Links panel, the canvas pills and the export dialog share: the list of links and
// pictures for a board, opening one, the editor for one entry, and the picture hosting choice.

/** Every link and picture on an email board, recomputed after a short pause (it compiles the email). */
export function useLinkItems(board: Doc | undefined): LinkItem[] {
  const fv = useStore((s) => s.fontsVersion);
  const wp = useWordPress((s) => s.wp);
  const [items, setItems] = useState<LinkItem[]>([]);
  useEffect(() => checkWordPress(), []);
  useEffect(() => {
    const root = board && emailRootOf(board);
    if (!board || !root) return setItems([]);
    const t = setTimeout(() => setItems(linkItems(board, root, getLayout(board.nodes, fv), boardHosting(board), wp)), 150);
    return () => clearTimeout(t);
  }, [board, fv, wp]);
  return items;
}

/** The board-wide hosting problem (no folder URL, WordPress not connected), if any. */
export function useHostingIssue(board: Doc | undefined, items: LinkItem[]): string | null {
  const wp = useWordPress((s) => s.wp);
  if (!board) return null;
  // Pictures with their own web address don't need the board's hosting.
  return hostingIssue(boardHosting(board), wp, items.reduce((n, i) => n + i.pictures.filter((p) => !p.url?.trim()).length, 0));
}

/** ok, bad (this picture needs a URL) or hint (waiting on the board's hosting). */
export function pictureClass(item: LinkItem) {
  return item.pictures.some((p) => p.status === 'fix') ? 'bad' : item.pictures.some((p) => p.status === 'wait') ? 'hint' : 'ok';
}

/** Pill and outline colour on the canvas. */
export function itemClass(item: LinkItem) {
  return item.fix ? 'bad' : item.suggested || pictureClass(item) === 'hint' ? 'hint' : 'ok';
}

/** Selects the entry's layer and opens its editor, on the canvas (popover) or in the panel (inline). */
export function openLinkItem(boardId: string, id: string, from: 'canvas' | 'panel') {
  const s = useStore.getState();
  if (s.project.activeBoardId !== boardId) s.setActiveBoard(boardId);
  // From the panel, the layer is only highlighted: selecting it would swap the panel for the layer's properties.
  useStore.getState().select(from === 'canvas' ? [id] : []);
  useStore.getState().set({ linkEdit: { boardId, id, from } });
}

/**
 * Centres an entry's layer on the canvas at a readable zoom, without the big jump zoom-to-selection
 * makes on a small text link. With `ifHidden`, leaves the view alone when it's already on screen.
 */
export function revealLinkItem(boardId: string, id: string, ifHidden = false) {
  const s = useStore.getState();
  const board = s.project.boards.find((b) => b.id === boardId);
  const frame = boardFrames(s.project).get(boardId);
  const wrap = document.querySelector<HTMLElement>('.canvas-wrap');
  if (!board || !frame || !wrap) return;
  const b = absoluteBoxes(board.nodes, getLayout(board.nodes, s.fontsVersion)).get(id);
  if (!b) return;
  const { zoom, panX, panY } = s.view;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const x = (frame.x + b.x) * zoom + panX;
  const y = (frame.y + b.y) * zoom + panY;
  if (ifHidden && x > 20 && x + b.w * zoom < W - 20 && y > 60 && y + b.h * zoom < H - 240) return;
  // Readable but not huge: keep the current zoom between 60% and 150%, and fit tall layers.
  const z = Math.min(Math.max(zoom, 0.6), 1.5, (H - 300) / Math.max(1, b.h));
  // A little above centre, so the editor below it has room.
  s.setView({ zoom: z, panX: W / 2 - (frame.x + b.x + b.w / 2) * z, panY: H * 0.38 - (frame.y + b.y + b.h / 2) * z });
}

export function closeLinkItem() {
  useStore.getState().set({ linkEdit: null });
}

export function Thumb({ item }: { item: LinkItem }) {
  const pic = item.pictures[0];
  const url = pic?.assetId ? getAsset(pic.assetId)?.thumbUrl : null;
  if (url) return <img className="lk-thumb" src={url} alt="" />;
  return <span className={`lk-thumb ${pic ? '' : 'lk-thumb-link'}`}>{pic ? <IconImage size={12} /> : <IconLink size={12} />}</span>;
}

/** The two status marks: picture hosted? link set? */
export function StatusMarks({ item }: { item: LinkItem }) {
  return (
    <span className="lk-marks">
      {item.pictures.length > 0 && (
        <span className={pictureClass(item)} title={item.pictures.map((p) => p.text).join('\n')}>
          <IconImage size={12} />
        </span>
      )}
      {(item.link || item.suggested) && (
        <span className={item.suggested ? 'hint' : item.link?.issue ? 'bad' : 'ok'}>
          <IconLink size={12} />
        </span>
      )}
    </span>
  );
}

/**
 * Edits one entry: its click link, and in "URL per picture" hosting each picture's URL.
 * Enter saves and asks for the next entry to fix; Escape closes.
 */
export function ItemEditor({ board, item, onNext, onClose }: { board: Doc; item: LinkItem; onNext: () => void; onClose: () => void }) {
  const hosting = boardHosting(board);
  // The layer's link as it is now (the list is a moment behind, and a paste or undo can change it).
  const live = useStore((s) => {
    const n = findNode(s.doc.nodes, item.id);
    return n ? nodeLink(n) : undefined;
  });
  const [val, setVal] = useState(live ?? '');
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hasLink = live !== undefined;
  useEffect(() => {
    if (document.activeElement !== input.current || live === undefined) setVal(live ?? '');
    else if (live !== val && live !== normaliseLink(val)) setVal(live);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Placeholders are selected so a paste replaces them.
    if (input.current) {
      input.current.focus();
      if (/\{\{/.test(input.current.value)) input.current.select();
    }
  }, [hasLink]);

  const write = (v: string | null, key?: string) => useStore.getState().updateNode(item.id, (n) => setNodeLink(n, v), key);
  const save = () => {
    const v = normaliseLink(val);
    if (v !== val) setVal(v);
    if (v !== live) write(v, 'link');
    return v;
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>, commit: () => string | null) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const problem = commit();
      if (problem) setErr(problem);
      else onNext();
    }
  };

  return (
    <div className="lk-editor" onKeyDown={(e) => e.stopPropagation()}>
      {item.pictures.map((p) => (
        <PictureLine key={p.nodeId} board={board} pic={p} mode={hosting.mode} onKey={keys} />
      ))}
      {hasLink ? (
        <>
          <div className={`field ${err ? 'em-invalid' : ''}`}>
            <IconLink size={12} />
            <input
              ref={input}
              value={val}
              placeholder="https://… (or mailto:, tel:)"
              spellCheck={false}
              onChange={(e) => {
                setVal(e.target.value);
                setErr(null);
                write(e.target.value, 'link');
              }}
              onBlur={save}
              onKeyDown={(e) =>
                keys(e, () => {
                  const issue = linkIssue(save());
                  return issue ? LINK_ISSUE_TEXT[issue] : null;
                })
              }
            />
            <button className="lk-x" title="Remove link" onClick={() => write(null)}>
              <IconClose size={12} />
            </button>
          </div>
          {err && <p className="link-issue">{err}</p>}
        </>
      ) : (
        <div className="lk-editor-actions">
          <Button onClick={() => write('')}>
            <IconPlus size={12} /> Add link
          </Button>
          {item.suggested && (
            <button
              className="link-btn muted-link"
              onClick={() => {
                useStore.getState().updateBoard(board.id, { email: { ...board.email, noLink: [...(board.email?.noLink ?? []), item.id] } });
                onClose();
              }}
            >
              No link needed
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PictureLine({
  board,
  pic,
  mode,
  onKey,
}: {
  board: Doc;
  pic: PictureEntry;
  mode: PictureHostMode;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>, commit: () => string | null) => void;
}) {
  const [url, setUrl] = useState(pic.url ?? '');
  const field = useRef<HTMLInputElement>(null);
  // Follow the address set elsewhere (right panel, Export window, Claude), but not while typing here.
  useEffect(() => {
    if (document.activeElement !== field.current) setUrl(pic.url ?? '');
  }, [pic.url]);
  const thumb = pic.assetId ? getAsset(pic.assetId)?.thumbUrl : null;
  // Saved as the picture's own web address, which every hosting mode respects.
  const save = (v: string) => setImageUrls(board.id, { [pic.nodeId]: v });
  const own = mode === 'each' || !!pic.url;
  return (
    <div className="lk-pic">
      <div className="lk-pic-head">
        {thumb ? <img className="lk-thumb" src={thumb} alt="" /> : <span className="lk-thumb"><IconImage size={12} /></span>}
        <div className="lk-pic-text">
          <span className="ellipsis">{pic.fileName}</span>
          <span className={`ellipsis ${pic.status === 'fix' ? 'bad' : pic.status === 'wait' ? 'warn' : 'muted'}`} title={pic.text}>
            {pic.text}
          </span>
        </div>
      </div>
      {own && (
        <div className={`field ${pictureUrlProblem(url) ? 'em-invalid' : ''}`}>
          <IconImage size={12} />
          <input
            ref={field}
            value={url}
            placeholder={mode === 'each' ? 'Web address, https://…' : 'Web address (optional)'}
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              save(e.target.value);
            }}
            onKeyDown={(e) => onKey(e, () => (url.trim() ? pictureUrlProblem(url) : mode === 'each' ? 'Paste the picture’s web address' : null))}
          />
        </div>
      )}
    </div>
  );
}

/** Where the board's pictures live. Saved on the board; the panel and the export dialog both show it. */
export function HostingField({ board, compact }: { board: Doc; compact?: boolean }) {
  const h = boardHosting(board);
  const wp = useWordPress((s) => s.wp);
  const [base, setBase] = useState(h.baseUrl ?? '');
  useEffect(() => checkWordPress(), []);
  useEffect(() => setBase(boardHosting(board).baseUrl ?? ''), [board.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = h.mode === 'base' ? pictureUrlProblem(base) : null;
  return (
    <div className="lk-hosting">
      <Segmented
        value={h.mode}
        options={[
          ...(isElectron ? [{ value: 'wordpress' as const, label: compact ? 'WordPress' : 'Upload to WordPress', title: 'Spread uploads the pictures for you' }] : []),
          { value: 'base' as const, label: compact ? 'Folder' : 'One folder URL', title: 'You upload the exported pictures to one folder' },
          { value: 'each' as const, label: compact ? 'Each' : 'URL per picture', title: 'Paste a URL for each picture' },
        ]}
        onChange={(mode) => setBoardHosting(board.id, { mode })}
      />
      {h.mode === 'wordpress' ? (
        <WordPressConnect wp={wp} compact={compact} />
      ) : h.mode === 'base' ? (
        <>
          <div className={`field ${problem ? 'em-invalid' : ''}`}>
            <IconLink size={12} />
            <input
              value={base}
              placeholder="https://example.com/wp-content/uploads/2026/11/"
              spellCheck={false}
              onChange={(e) => {
                setBase(e.target.value);
                setBoardHosting(board.id, { baseUrl: e.target.value });
              }}
            />
          </div>
          <p className="hint">{problem ?? 'Upload the exported pictures here, with the same file names.'}</p>
        </>
      ) : (
        <p className="hint">Paste each picture’s URL in its row above, or on the canvas in Links mode.</p>
      )}
    </div>
  );
}

/** Connect or show the WordPress site pictures upload to (an Application Password, kept in the Keychain). */
export function WordPressConnect({ wp, compact }: { wp: WordPress | undefined; compact?: boolean }) {
  const [site, setSite] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = useWordPress((s) => s.set);
  if (wp === undefined) return <p className="hint">Checking the connection…</p>;
  if (wp) {
    return (
      <div className="em-wp-on">
        <IconCheck size={14} />
        <span className="ellipsis">
          Uploads go to <b>{wp.site.replace(/^https:\/\//, '')}</b>
          {compact ? '' : ` as ${wp.name}`}
        </span>
        <button
          className="link"
          onClick={async () => {
            const r = await native!.hostingDisconnect();
            if (r.ok) set(null);
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }
  const connect = async () => {
    setBusy(true);
    setError(null);
    const r = await native!.hostingConnect({ site, user, password });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setPassword('');
    set(r.wordpress);
  };
  return (
    <div className="em-wp">
      <div className={compact ? 'em-stack' : 'em-grid3'}>
        <div className="field">
          <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Site, e.g. example.com" spellCheck={false} />
        </div>
        <div className="field">
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="WordPress username" spellCheck={false} autoComplete="off" />
        </div>
        <div className="field">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Application password" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && void connect()} />
        </div>
      </div>
      <p className="hint">In WordPress: Users → Profile → Application Passwords → name it “Spread” → Add. It’s kept in your Mac’s Keychain.</p>
      <Button primary className={compact ? 'block' : ''} onClick={connect} disabled={busy || !site.trim() || !user.trim() || !password.trim()}>
        {busy ? 'Checking…' : 'Connect WordPress'}
      </Button>
      {error && <p className="hint em-error">{error}</p>}
    </div>
  );
}
