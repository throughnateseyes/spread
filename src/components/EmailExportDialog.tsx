import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowLeft as ArrowLeft, IconCheck as Check, IconCopy as Copy, IconDownload as Download, IconFolder as FolderOpen, IconLink as Link2, IconUpload as Upload, IconWarning as TriangleAlert } from '../ui/icons';
import type { FrameNode, SceneNode } from '../types';
import { computeLayout } from '../layout';
import { isElectron, revealInFolder, saveFilesToFolder } from '../platform';
import { boardHosting, hostEmailImages, pictureSrc, useWordPress } from '../email/hosting';
import { Button, Modal } from '../ui/controls';
import { buildEmailHtml, GMAIL_CLIP_BYTES, parseNameTags } from '../email/html';
import { renderEmailImages, type RenderedEmailImage } from '../email/images';
import { sendChecks } from '../email/checklist';
import { linkCounts } from '../email/linkmap';
import './email.css';
import { useStore } from '../store';
import { ExportFolderRow, useExportFolder } from './ExportFolder';
import { InboxChecks, InboxStage, useInboxPreview } from './InboxPreview';
import { HostingField, openLinkItem, revealLinkItem, useHostingIssue, useLinkItems } from './LinkEditor';
import { goToCheck } from './SendChecklist';
import { blobToDataUrl } from '../pdf';
import EmailPdfButton from './EmailPdfButton';

// Email export. Step one is short on purpose: how the send check stands, anything still to fix
// (fixed on the canvas, not here), where the pictures live, and the HTML size. Subject, preview
// text and every link and picture are edited on the board itself (the Inbox and Links panels).
// Step two renders the pictures at 2x, previews the real HTML on desktop and phone, then uploads
// and copies it, or writes pictures + email.html to a folder.

interface Props {
  onClose: () => void;
  /** The email's root auto-layout frame. */
  root: FrameNode;
  /** The board's top-level nodes (context only; layout is computed from `root`). */
  nodes: SceneNode[];
}

/** "3 links and 1 picture still need attention." */
function fixSummary(items: ReturnType<typeof useLinkItems>) {
  const open = items.filter((i) => i.fix);
  const links = open.filter((i) => i.link?.issue).length;
  const pics = open.length - links;
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return `${[part(links, 'link'), part(pics, 'picture')].filter(Boolean).join(' and ')} still need${open.length === 1 ? 's' : ''} attention.`;
}

function formatKb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function EmailExportDialog({ onClose, root }: Props) {
  const layout = useMemo(() => computeLayout([root]), [root]);
  const defaultTitle = parseNameTags(root.name).clean.replace(/^email\s*\/\s*/i, '') || 'Email';
  const [step, setStep] = useState<'setup' | 'review'>('setup');
  const board = useStore((s) => s.doc);
  const title = board.email?.subject ?? '';
  const preheader = board.email?.preheader ?? '';
  const htmlTitle = title.trim() || defaultTitle;
  const hosting = boardHosting(board);
  const mode = hosting.mode;
  const wp = useWordPress((s) => s.wp);
  /** WordPress URLs from this session's upload. */
  const [hosted, setHosted] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<{ files: RenderedEmailImage[]; dataUrls: Record<string, string>; warnings: string[]; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<{ folder: string; count: number } | null>(null);
  const projectName = useStore((s) => s.project.name);
  const tracking = board.email?.tracking;
  const dest = useExportFolder(projectName);
  const items = useLinkItems(board);
  const toFix = linkCounts(items).fix;
  const hostIssue = useHostingIssue(board, items);

  const urlFor = (map: Record<string, string>) => (nodeId: string, fileName: string) => pictureSrc(hosting, nodeId, fileName, map);
  const imageUrl = urlFor(hosted);

  const compiled = useMemo(
    () => buildEmailHtml(root, layout, { title: htmlTitle, preheader, imageUrl, tracking }),
    // imageUrl closes over the board's hosting and this session's uploads
    [root, layout, htmlTitle, preheader, tracking, hosting, hosted], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const images = compiled.images;
  const imagesKey = images.map((i) => `${i.nodeId}:${i.fileName}:${i.width}x${i.height}:${i.matte}`).join('|');
  const checks = useMemo(() => sendChecks(board, root, layout), [board, root, layout]);

  /** Closes the dialog and opens the first thing to fix on the canvas, in Links mode. */
  const fixOnCanvas = () => {
    const first = items.find((i) => i.fix);
    onClose();
    useStore.getState().set({ linksMode: true });
    if (first) {
      openLinkItem(board.id, first.id, 'canvas');
      revealLinkItem(board.id, first.id);
    }
  };

  // Pictures for the preview (data URLs, so the frame can show them before upload).
  const pictures = useMemo(() => rendered?.dataUrls ?? {}, [rendered]);
  const preview = useInboxPreview({ root, layout, title: title ?? '', preheader, tracking, pictures, imageUrl });

  const renderPictures = async () => {
    setError(null);
    setBusy('Rendering pictures…');
    try {
      const warnings: string[] = [];
      const files = await renderEmailImages(root, layout, images, 2, {
        warnings,
        onProgress: (d, t) => setBusy(t ? `Rendering pictures ${d} / ${t}…` : 'Rendering…'),
      });
      const dataUrls: Record<string, string> = {};
      for (const f of files) dataUrls[f.nodeId] = await blobToDataUrl(f.blob);
      setRendered({ files, dataUrls, warnings, key: imagesKey });
      return files;
    } catch (e) {
      setError(`Couldn't render the pictures: ${(e as Error).message}`);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const goReview = async () => {
    setStep('review');
    if (!rendered || rendered.key !== imagesKey) await renderPictures();
  };

  const exportFiles = async () => {
    setError(null);
    setDone(null);
    const files = rendered && rendered.key === imagesKey ? rendered.files : await renderPictures();
    if (!files) return;
    setBusy(dest.folder ? 'Saving…' : 'Choose a folder…');
    try {
      const out = [...files.map((f) => ({ name: f.fileName, blob: f.blob })), { name: 'email.html', blob: new Blob([compiled.html], { type: 'text/html' }) }];
      const r = await saveFilesToFolder(out, { folder: dest.folder });
      if (r) setDone({ folder: r.folder, count: out.length });
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const copyTimer = useRef<number | undefined>(undefined);
  const copyHtml = async (html = compiled.html) => {
    try {
      try {
        await navigator.clipboard.writeText(html);
      } catch {
        // Older Electron / insecure contexts: fall back to a hidden textarea.
        const ta = document.createElement('textarea');
        ta.value = html;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('clipboard unavailable');
      }
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError(`Couldn't copy: ${(e as Error).message}`);
    }
  };
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const allHosted = images.every((im) => hosted[im.nodeId]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  /** Renders (if needed), uploads to WordPress, then copies HTML that points at the uploaded pictures. */
  const uploadAndCopy = async () => {
    setError(null);
    setUploadNote(null);
    const files = rendered && rendered.key === imagesKey ? rendered.files : await renderPictures();
    if (!files) return;
    setBusy('Uploading pictures…');
    try {
      const r = await hostEmailImages(files, setBusy);
      setHosted(r.urls);
      const html = buildEmailHtml(root, layout, { title: htmlTitle, preheader, tracking, imageUrl: urlFor(r.urls) }).html;
      await copyHtml(html);
      setUploadNote(
        `${r.uploaded ? `Uploaded ${r.uploaded} picture${r.uploaded === 1 ? '' : 's'}` : 'No new pictures to upload'}${r.reused ? ` · ${r.reused} already on the site` : ''}. HTML copied.`,
      );
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const warnings = [...compiled.warnings, ...(rendered?.warnings ?? [])];
  const sizePct = Math.min(100, (compiled.bytes / GMAIL_CLIP_BYTES) * 100);
  const sizeLevel = compiled.bytes > GMAIL_CLIP_BYTES ? 'over' : compiled.bytes > GMAIL_CLIP_BYTES * 0.8 ? 'near' : 'ok';
  const height = layout.get(root.id)?.h ?? 0;

  const sizeMeter = (
    <div className={`em-size em-size-${sizeLevel}`} title="Gmail clips emails over about 102 KB of HTML (pictures don't count).">
      <div className="em-size-row">
        <span>HTML size</span>
        <b>
          {formatKb(compiled.bytes)} <span className="muted">/ 102 KB</span>
        </b>
      </div>
      <div className="em-size-track">
        <div className="em-size-fill" style={{ width: `${sizePct}%` }} />
      </div>
    </div>
  );

  const warningList = warnings.length > 0 && (
    <details className="em-warnings">
      <summary className="em-label">
        <TriangleAlert size={12} /> {warnings.length} note{warnings.length === 1 ? '' : 's'} on how it will look
      </summary>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );

  if (step === 'setup') {
    const open = checks.filter((c) => c.level === 'fix');
    return (
      <Modal title="Export email" onClose={onClose} width={560}>
        <div className="em-checks">
          {checks.map((c) => (
            <button
              key={c.id}
              className={`send-chip ${c.level}`}
              title={`${c.title}. ${c.detail}`}
              onClick={() => {
                onClose();
                goToCheck(c);
              }}
            >
              {c.level === 'ok' ? <Check size={12} /> : <TriangleAlert size={12} />}
              {c.label}
            </button>
          ))}
        </div>

        {toFix > 0 ? (
          <div className="em-fix">
            <span>
              <b>{fixSummary(items)}</b>{' '}
              {items.find((i) => i.fix)?.name}: {items.find((i) => i.fix)?.status.toLowerCase()}.
            </span>
            <Button onClick={fixOnCanvas}>
              <Link2 size={14} /> Fix on canvas
            </Button>
          </div>
        ) : (
          open.length > 0 && (
            <div className="em-fix">
              <span>
                <b>{open[0].title}.</b> {open[0].detail}
              </span>
              <Button
                onClick={() => {
                  onClose();
                  goToCheck(open[0]);
                }}
              >
                Show me
              </Button>
            </div>
          )
        )}

        {images.length > 0 && (
          <div className="em-field">
            <span className="em-label">
              Pictures ({images.length}, exported at 2×)
            </span>
            <HostingField board={board} />
            {hostIssue && <div className="hint em-error">{hostIssue}</div>}
          </div>
        )}

        {sizeMeter}
        {warningList}
        {error && <div className="hint em-error">{error}</div>}

        <div className="em-actions">
          <span className="muted">
            {root.w}×{Math.round(height)} · {formatKb(compiled.bytes)}
          </span>
          <EmailPdfButton />
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={goReview} disabled={!!busy}>
            Preview &amp; export
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Export email" onClose={onClose} width={1040}>
      <div className="em-review">
        <InboxStage p={preview} status={busy ?? (rendered ? null : 'Pictures not rendered')} />

        <div className="em-side">
          {sizeMeter}
          <div className="em-field">
            <span className="em-label">Pictures</span>
            <div className="hint">
              {images.length
                ? mode === 'wordpress'
                  ? allHosted
                    ? `${images.length} picture${images.length === 1 ? '' : 's'} on ${wp?.site.replace(/^https:\/\//, '') ?? 'WordPress'}`
                    : `${images.length} picture${images.length === 1 ? '' : 's'} will upload to ${wp?.site.replace(/^https:\/\//, '') ?? 'WordPress'} (unchanged ones are reused)`
                  : mode === 'base'
                  ? `Upload ${images.length} picture${images.length === 1 ? '' : 's'} to ${hosting.baseUrl?.trim() || 'your folder URL'}`
                  : `${images.length} picture${images.length === 1 ? '' : 's'}, linked one by one`
                : 'No pictures'}
            </div>
          </div>
          <InboxChecks p={preview} />
          {warningList}
          {error && <div className="hint em-error">{error}</div>}
          {uploadNote && (
            <div className="em-done">
              <Check size={16} />
              <div className="em-done-text">{uploadNote}</div>
            </div>
          )}
          {done && (
            <div className="em-done">
              <Check size={16} />
              <div className="em-done-text">
                Saved {done.count} file{done.count === 1 ? '' : 's'} to <b>{done.folder}</b>
              </div>
              {isElectron && (
                <Button onClick={() => revealInFolder(done.folder)} title="Show in folder">
                  <FolderOpen size={14} />
                </Button>
              )}
            </div>
          )}
          {dest.folder && <ExportFolderRow folder={dest.folder} onChange={dest.change} disabled={!!busy} />}
          <div className="em-side-actions">
            {mode === 'wordpress' && images.length > 0 && (
              <Button className="block" primary onClick={uploadAndCopy} disabled={!!busy || !wp}>
                {copied && allHosted ? <Check size={14} /> : <Upload size={14} />} {allHosted ? (copied ? 'Copied' : 'Upload changes & copy HTML') : 'Upload & copy HTML'}
              </Button>
            )}
            {(mode !== 'wordpress' || !images.length || allHosted) && (
              <Button className="block" primary={mode !== 'wordpress' || !images.length} onClick={() => void copyHtml()} disabled={!!busy}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy HTML'}
              </Button>
            )}
            <Button className="block" onClick={exportFiles} disabled={!!busy}>
              <Download size={14} /> Export pictures + HTML
            </Button>
            <Button className="block" onClick={() => setStep('setup')} disabled={!!busy}>
              <ArrowLeft size={14} /> Back
            </Button>
          </div>
          <div className="hint">
            {mode === 'wordpress'
              ? 'Paste the HTML into your email tool and send yourself a test. Check it on a phone, and once with images off.'
              : 'Paste the HTML into your email tool after the pictures are uploaded. Send yourself a test and check it on a phone with images off.'}
          </div>
        </div>
      </div>
    </Modal>
  );
}
