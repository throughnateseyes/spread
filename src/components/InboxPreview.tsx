import { useEffect, useMemo, useRef, useState } from 'react';
import type { FrameNode } from '../types';
import { computeLayout } from '../layout';
import { activeBrand } from '../brand';
import { blobToDataUrl, fontFaceCss } from '../pdf';
import { useStore } from '../store';
import { Button, Modal, Segmented } from '../ui/controls';
import { IconCheck, IconDesktop, IconExport, IconMobile, IconWarning } from '../ui/icons';
import { buildEmailHtml, parseNameTags } from '../email/html';
import { renderEmailImages } from '../email/images';
import { firstWords, fontSwaps, inboxChecks, inboxHtml, inboxMetrics, measureDoc, viewWidth, type InboxCheck, type InboxSource, type InboxView } from '../email/preview';
import './email.css';

// The inbox preview, shared by the Preview button and the last step of Export: the line the
// inbox list shows, the compiled email at a real width, and what changes across setups.

export function useInboxPreview(src: InboxSource) {
  const [view, setView] = useState<InboxView>({ device: 'desktop', fonts: 'fallback', images: true });
  const [fontCss, setFontCss] = useState<string | null>(null);
  const [height, setHeight] = useState(600);
  const [checks, setChecks] = useState<InboxCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const compiled = useMemo(() => buildEmailHtml(src.root, src.layout, { title: '', imageUrl: (_id, f) => f, tracking: src.tracking }), [src.root, src.layout, src.tracking]);
  const fontKey = compiled.fonts.join('|');
  const swaps = useMemo(() => fontSwaps(compiled.fonts), [fontKey]);

  useEffect(() => {
    let alive = true;
    void fontFaceCss(new Set(swaps.map((s) => s.family)))
      .catch(() => '')
      .then((css) => alive && setFontCss(css));
    return () => {
      alive = false;
    };
  }, [swaps]);

  // Subject and preview text show in the inbox line, so typing them doesn't reload the email.
  const html = useMemo(() => inboxHtml(src, view, fontCss ?? ''), [src.root, src.layout, src.tracking, src.pictures, view, fontCss]);

  useEffect(() => {
    if (fontCss === null) return;
    let alive = true;
    inboxMetrics(src, fontCss, swaps.length > 0)
      .then((m) => {
        if (!alive) return;
        setChecks(inboxChecks(src, src.title, compiled.images, compiled.fonts, m));
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [src.root, src.layout, src.title, src.preheader, compiled, fontCss, swaps]);

  return { view, setView: (patch: Partial<InboxView>) => setView((v) => ({ ...v, ...patch })), html, height, setHeight, checks, error, swaps, subject: src.title, preheader: src.preheader, root: src.root };
}

export type InboxPreviewState = ReturnType<typeof useInboxPreview>;

function InboxRow({ p, sender }: { p: InboxPreviewState; sender: string }) {
  const subject = p.subject.trim() || 'No subject';
  const shown = p.preheader.trim() || firstWords(p.root);
  if (p.view.device === 'mobile') {
    return (
      <div className="ib-row ib-row-phone" style={{ width: viewWidth('mobile') }}>
        <div className="ib-row-top">
          <b>{sender}</b>
          <span>9:41 AM</span>
        </div>
        <div className="ib-subject">{subject}</div>
        <div className="ib-snippet">{shown}</div>
      </div>
    );
  }
  return (
    <div className="ib-row" style={{ width: viewWidth('desktop') }}>
      <b className="ib-sender">{sender}</b>
      <div className="ib-line">
        <span className="ib-subject">{subject}</span>
        {shown && <span className="ib-snippet"> – {shown}</span>}
      </div>
      <span className="ib-time">9:41 AM</span>
    </div>
  );
}

/** Device, font and picture switches, plus the inbox line and the email at that width. */
export function InboxStage({ p, status }: { p: InboxPreviewState; status?: string | null }) {
  const { view, setView } = p;
  const frame = useRef<HTMLIFrameElement>(null);
  const width = viewWidth(view.device);
  const sender = activeBrand()?.name ?? 'Your name';

  const fit = async () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    void doc.body.offsetHeight;
    await doc.fonts.ready;
    p.setHeight(measureDoc(doc).height);
  };
  // Width alone doesn't reload the frame, but text rewraps and pictures resize.
  useEffect(() => void fit(), [width]);

  return (
    <div className="em-preview-col">
      <div className="em-preview-bar">
        <Segmented
          className="em-device"
          value={view.device}
          options={[
            { value: 'desktop', label: <IconDesktop size={14} />, title: `Desktop (${viewWidth('desktop')}px)` },
            { value: 'mobile', label: <IconMobile size={14} />, title: `Phone (${viewWidth('mobile')}px)` },
          ]}
          onChange={(device) => setView({ device })}
        />
        {p.swaps.length > 0 && (
          <Segmented
            className="em-device"
            value={view.fonts}
            options={[
              { value: 'fallback', label: 'Fallback fonts', title: p.swaps.map((s) => `${s.label} → ${s.shows}`).join(', ') },
              { value: 'design', label: 'Your fonts', title: 'Only people with these fonts installed see this' },
            ]}
            onChange={(fonts) => setView({ fonts })}
          />
        )}
        <Segmented
          className="em-device"
          value={view.images ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Images on' },
            { value: 'off', label: 'Images off' },
          ]}
          onChange={(v) => setView({ images: v === 'on' })}
        />
        <span className="muted">{status ?? `${width}px wide`}</span>
      </div>
      <div className="em-preview-stage">
        <InboxRow p={p} sender={sender} />
        <iframe ref={frame} className="em-preview" title="Email preview" sandbox="allow-same-origin" srcDoc={p.html} onLoad={() => void fit()} style={{ width, height: p.height }} />
      </div>
    </div>
  );
}

/** What changes between inboxes. Each row jumps the preview to the view that shows it. */
export function InboxChecks({ p }: { p: InboxPreviewState }) {
  return (
    <div className="em-field">
      <span className="em-label">Across inboxes</span>
      {p.error && <div className="hint em-error">{p.error}</div>}
      {!p.checks && !p.error && <div className="hint">Checking…</div>}
      {p.checks?.map((c) => (
        <button key={c.id} className={`ib-check ib-${c.level}`} onClick={() => p.setView(c.view)}>
          {c.level === 'ok' ? <IconCheck size={14} /> : <IconWarning size={14} />}
          <span>
            <b>{c.title}</b>
            {c.detail}
          </span>
        </button>
      ))}
    </div>
  );
}

const NO_PICTURES: Record<string, string> = {};

/** The Preview button on email boards. */
export default function InboxPreviewDialog({ root, onClose }: { root: FrameNode; onClose: () => void }) {
  const board = useStore((s) => s.doc);
  const layout = useMemo(() => computeLayout([root]), [root]);
  const subject = board.email?.subject ?? '';
  const preheader = board.email?.preheader ?? '';
  const tracking = board.email?.tracking;
  const [pictures, setPictures] = useState(NO_PICTURES);
  const [busy, setBusy] = useState<string | null>('Rendering pictures…');
  const [warning, setWarning] = useState<string | null>(null);
  const p = useInboxPreview({ root, layout, title: subject, preheader, tracking, pictures });
  const setMeta = (patch: { subject?: string; preheader?: string }) => useStore.getState().updateBoard(board.id, { email: { ...board.email, subject, preheader, ...patch } });

  useEffect(() => {
    let alive = true;
    const { images } = buildEmailHtml(root, layout, { title: '', imageUrl: (_id, f) => f });
    (async () => {
      const warnings: string[] = [];
      const files = await renderEmailImages(root, layout, images, 2, { warnings, onProgress: (d, t) => alive && setBusy(t ? `Rendering pictures ${d} / ${t}…` : 'Rendering…') });
      const urls: Record<string, string> = {};
      for (const f of files) urls[f.nodeId] = await blobToDataUrl(f.blob);
      if (!alive) return;
      setPictures(urls);
      setWarning(warnings[0] ?? null);
      setBusy(null);
    })().catch((e) => {
      if (!alive) return;
      setWarning(`Couldn't render the pictures: ${(e as Error).message}`);
      setBusy(null);
    });
    return () => {
      alive = false;
    };
  }, [root, layout]);

  const name = parseNameTags(root.name).clean.replace(/^email\s*\/\s*/i, '') || 'Email';
  return (
    <Modal title={`Preview: ${name}`} onClose={onClose} width={1040}>
      <div className="em-review">
        <InboxStage p={p} status={busy} />
        <div className="em-side">
          <label className="em-field">
            <span className="em-label">Subject</span>
            <div className="field">
              <input value={subject} onChange={(e) => setMeta({ subject: e.target.value })} placeholder="What makes them open it" />
            </div>
          </label>
          <label className="em-field">
            <span className="em-label">Preview text</span>
            <div className="field">
              <input value={preheader} onChange={(e) => setMeta({ preheader: e.target.value })} placeholder="The line after the subject" />
            </div>
          </label>
          <InboxChecks p={p} />
          {warning && <div className="hint em-error">{warning}</div>}
          <div className="hint">This is your real HTML in one browser engine. Outlook and Gmail each bend it a little, so still send yourself a test.</div>
          <Button className="block" primary onClick={() => useStore.getState().set({ modal: 'export' })}>
            <IconExport size={14} /> Export
          </Button>
        </div>
      </div>
    </Modal>
  );
}
