import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowLeft as ArrowLeft, IconCheck as Check, IconCopy as Copy, IconDownload as Download, IconFolder as FolderOpen, IconLink as Link2, IconUpload as Upload, IconWarning as TriangleAlert } from '../ui/icons';
import type { Doc, EmailPlatform, FrameNode, SceneNode } from '../types';
import { computeLayout } from '../layout';
import { isElectron, revealInFolder, saveFilesToFolder } from '../platform';
import {
  hostEmailImages,
  missingAddressText,
  ownAddress,
  pictureFileName,
  pictureSources,
  pictureSrc,
  picturesToRender,
  picturesWithoutAddress,
  platformWarnings,
  renderedNames,
  RENTCAFE_NOTE,
  RENTCAFE_STEPS,
  setEmailPlatform,
  useWordPress,
  type PictureSources,
} from '../email/hosting';
import { Button, Modal, Segmented } from '../ui/controls';
import { buildEmailHtml, GMAIL_CLIP_BYTES, parseNameTags, type EmailImage } from '../email/html';
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
import { getAsset } from '../assets';
import { findNode } from '../tree';
import { PictureAddressField } from './PictureAddress';
import EmailPdfButton from './EmailPdfButton';

// Email export. Step one is short on purpose: how the send check stands, anything still to fix
// (fixed on the canvas, not here), where the pictures live, and the HTML size. Subject, preview
// text and every link and picture are edited on the board itself (the Inbox and Links panels).
// Step two renders the pictures at 2x, previews the real HTML on desktop and phone, then uploads
// and copies it, or writes pictures + email.html to a folder.
//
// Picture addresses come from the same resolver Claude's export uses (pictureSources/pictureSrc),
// and nothing is copied or saved as email.html while a picture would be a bare file name.

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

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Every picture in the email: thumbnail, exported name, and its own web address (optional). */
function PictureList({ board, root, images, sources }: { board: Doc; root: FrameNode; images: EmailImage[]; sources: PictureSources }) {
  const own = images.filter((im) => ownAddress(sources, im.nodeId)).length;
  return (
    <details className="em-pics">
      <summary className="em-label">
        Each picture{own ? ` (${own} with ${own === 1 ? 'its own address' : 'their own addresses'})` : ''}
      </summary>
      <div className="em-images">
        {images.map((im) => {
          const n = findNode([root], im.nodeId);
          const thumb = n?.type === 'image' && n.assetId ? getAsset(n.assetId)?.thumbUrl : null;
          const name = parseNameTags(n?.name ?? '').clean || im.fileName;
          return (
            <div key={im.nodeId} className="em-image">
              <span className="em-thumb">{thumb ? <img src={thumb} alt="" /> : null}</span>
              <div className="em-image-main">
                <div className="em-image-name">
                  <b>{name}</b>
                  <span className="muted">{ownAddress(sources, im.nodeId) ? 'not exported' : pictureFileName(sources, im.nodeId, im.fileName)}</span>
                </div>
                <PictureAddressField board={board} nodeId={im.nodeId} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint">A picture that’s already online (a listing photo, say) can use its address as is. Spread then leaves it out of the export.</p>
    </details>
  );
}

export default function EmailExportDialog({ onClose, root }: Props) {
  const layout = useMemo(() => computeLayout([root]), [root]);
  const defaultTitle = parseNameTags(root.name).clean.replace(/^email\s*\/\s*/i, '') || 'Email';
  const [step, setStep] = useState<'setup' | 'review'>('setup');
  const board = useStore((s) => s.doc);
  const title = board.email?.subject ?? '';
  const preheader = board.email?.preheader ?? '';
  const htmlTitle = title.trim() || defaultTitle;
  const wp = useWordPress((s) => s.wp);
  const platform: EmailPlatform = board.email?.platform ?? 'other';
  const rentcafe = platform === 'rentcafe';
  /** WordPress URLs from this session's upload. */
  const [hosted, setHosted] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState<{ files: RenderedEmailImage[]; dataUrls: Record<string, string>; warnings: string[]; key: string } | null>(null);
  // One resolver for every picture address, the same one Claude's export uses.
  const sources = useMemo(() => pictureSources(board, { uploaded: hosted, files: rendered ? renderedNames(rendered.files) : undefined }, wp), [board, hosted, rendered, wp]);
  const hosting = sources.hosting;
  const mode = hosting.mode;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<{ folder: string; count: number; html: boolean } | null>(null);
  /** Shows the RentCafe paste steps after a copy. */
  const [pasteSteps, setPasteSteps] = useState(false);
  const projectName = useStore((s) => s.project.name);
  const tracking = board.email?.tracking;
  const dest = useExportFolder(projectName);
  const items = useLinkItems(board);
  const toFix = linkCounts(items).fix;
  const hostIssue = useHostingIssue(board, items);

  const urlFor = (s: PictureSources) => (nodeId: string, fileName: string) => pictureSrc(s, nodeId, fileName);
  const imageUrl = urlFor(sources);

  const compiled = useMemo(
    () => buildEmailHtml(root, layout, { title: htmlTitle, preheader, imageUrl, tracking }),
    // imageUrl closes over the picture sources
    [root, layout, htmlTitle, preheader, tracking, sources], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const images = compiled.images;
  /** The pictures Spread renders and exports: the ones without their own web address. */
  const toRender = useMemo(() => picturesToRender(sources, images), [sources, images]);
  const imagesKey = toRender.map((i) => `${i.nodeId}:${i.fileName}:${i.width}x${i.height}:${i.matte}`).join('|');
  const isRendered = !toRender.length || (!!rendered && rendered.key === imagesKey);
  /** Pictures that would be a bare file name in the HTML, with their layer names. */
  const missing = useMemo(
    () => picturesWithoutAddress(sources, images).map((m) => ({ ...m, name: parseNameTags(findNode([root], m.nodeId)?.name ?? '').clean || undefined })),
    [sources, images, root],
  );
  const missingText = missing.length ? missingAddressText(sources, missing, 'app', wp) : null;
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
      const files = await renderEmailImages(root, layout, toRender, 2, {
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
    if (!isRendered) await renderPictures();
  };

  /** The final HTML for a set of rendered files, or null (with the reason shown) while a picture has no web address. */
  const finalHtml = (s: PictureSources) => {
    const lacking = picturesWithoutAddress(s, images);
    if (lacking.length) {
      setError(missingAddressText(s, lacking, 'app', wp));
      return null;
    }
    return buildEmailHtml(root, layout, { title: htmlTitle, preheader, tracking, imageUrl: urlFor(s) }).html;
  };

  const exportFiles = async () => {
    setError(null);
    setDone(null);
    const files = isRendered ? (toRender.length ? rendered!.files : []) : await renderPictures();
    if (!files) return;
    // email.html only once every picture has a web address: a copy with bare file names is what breaks in the inbox.
    const s = { ...sources, files: renderedNames(files) };
    const html = picturesWithoutAddress(s, images).length ? null : buildEmailHtml(root, layout, { title: htmlTitle, preheader, tracking, imageUrl: urlFor(s) }).html;
    setBusy(dest.folder ? 'Saving…' : 'Choose a folder…');
    try {
      const out = [...files.map((f) => ({ name: f.fileName, blob: f.blob })), ...(html ? [{ name: 'email.html', blob: new Blob([html], { type: 'text/html' }) }] : [])];
      const r = await saveFilesToFolder(out, { folder: dest.folder });
      if (r) setDone({ folder: r.folder, count: out.length, html: !!html });
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const copyTimer = useRef<number | undefined>(undefined);
  const copyHtml = async (html: string | null) => {
    if (html === null) return;
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
      if (rentcafe) setPasteSteps(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError(`Couldn't copy: ${(e as Error).message}`);
    }
  };
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const allHosted = toRender.every((im) => hosted[im.nodeId]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  /** Renders (if needed), uploads to WordPress, then copies HTML that points at the uploaded pictures. */
  const uploadAndCopy = async () => {
    setError(null);
    setUploadNote(null);
    const files = isRendered ? (toRender.length ? rendered!.files : []) : await renderPictures();
    if (!files) return;
    setBusy('Uploading pictures…');
    try {
      const r = await hostEmailImages(files, setBusy);
      setHosted(r.urls);
      const html = finalHtml({ ...sources, uploaded: r.urls, files: renderedNames(files) });
      if (!html) return;
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

  const warnings = [...platformWarnings(board, compiled.warnings), ...(rendered?.warnings ?? [])];
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

        <div className="em-field">
          <span className="em-label">Sending through</span>
          <Segmented
            value={platform}
            options={[
              { value: 'other' as const, label: 'Any email tool' },
              { value: 'rentcafe' as const, label: 'RentCafe', title: 'Copy for RentCafe, and RentCafe adds the unsubscribe link and mailing address' },
            ]}
            onChange={(v) => setEmailPlatform(board.id, v === 'other' ? null : v)}
          />
          {rentcafe && <p className="hint">{RENTCAFE_NOTE}</p>}
        </div>

        {images.length > 0 && (
          <div className="em-field">
            <span className="em-label">
              Pictures ({images.length}, exported at 2×)
            </span>
            <HostingField board={board} />
            {hostIssue && toRender.length > 0 && <div className="hint em-error">{hostIssue}</div>}
            <PictureList board={board} root={root} images={images} sources={sources} />
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
              {!images.length
                ? 'No pictures'
                : !toRender.length
                  ? `${plural(images.length, 'picture')}, each with its own web address`
                  : (mode === 'wordpress'
                      ? allHosted
                        ? `${plural(toRender.length, 'picture')} on ${wp?.site.replace(/^https:\/\//, '') ?? 'WordPress'}`
                        : `${plural(toRender.length, 'picture')} will upload to ${wp?.site.replace(/^https:\/\//, '') ?? 'WordPress'} (unchanged ones are reused)`
                      : mode === 'base'
                        ? `Upload ${plural(toRender.length, 'picture')} to ${hosting.baseUrl?.trim() || 'your folder URL'}, with the exported names`
                        : `${plural(toRender.length, 'picture')}, linked one by one`) +
                    (toRender.length < images.length ? ` · ${images.length - toRender.length} with their own address` : '')}
            </div>
          </div>
          {missingText && isRendered && (mode !== 'wordpress' || !wp) && <div className="hint em-error">{missingText}</div>}
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
                {!done.html && '. No email.html yet: it needs a web address for every picture.'}
              </div>
              {isElectron && (
                <Button onClick={() => revealInFolder(done.folder)} title="Show in folder">
                  <FolderOpen size={14} />
                </Button>
              )}
            </div>
          )}
          {dest.folder && <ExportFolderRow folder={dest.folder} onChange={dest.change} disabled={!!busy} />}
          {pasteSteps && (
            <div className="em-steps">
              <b>Paste into RentCafe</b>
              <ol>
                {RENTCAFE_STEPS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            </div>
          )}
          <div className="em-side-actions">
            {mode === 'wordpress' && toRender.length > 0 && (
              <Button className="block" primary onClick={uploadAndCopy} disabled={!!busy || !wp}>
                {copied && allHosted ? <Check size={14} /> : <Upload size={14} />}{' '}
                {allHosted ? (copied ? 'Copied' : `Upload changes & copy${rentcafe ? ' for RentCafe' : ' HTML'}`) : `Upload & copy${rentcafe ? ' for RentCafe' : ' HTML'}`}
              </Button>
            )}
            {(mode !== 'wordpress' || !toRender.length || allHosted) && (
              <Button
                className="block"
                primary={mode !== 'wordpress' || !toRender.length}
                onClick={() => void copyHtml(finalHtml(sources))}
                disabled={!!busy || !isRendered || missing.length > 0}
                title={missingText ?? (rentcafe ? 'Copies the final HTML for RentCafe’s Source view' : undefined)}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : rentcafe ? 'Copy for RentCafe' : 'Copy HTML'}
              </Button>
            )}
            <Button className="block" onClick={exportFiles} disabled={!!busy}>
              <Download size={14} /> {missing.length && mode !== 'wordpress' ? 'Export pictures' : 'Export pictures + HTML'}
            </Button>
            <Button className="block" onClick={() => setStep('setup')} disabled={!!busy}>
              <ArrowLeft size={14} /> Back
            </Button>
          </div>
          <div className="hint">
            {rentcafe
              ? RENTCAFE_NOTE
              : mode === 'wordpress' || !toRender.length
                ? 'Paste the HTML into your email tool and send yourself a test. Check it on a phone, and once with images off.'
                : 'Upload the exported pictures with the same names, then copy the HTML. Send yourself a test and check it on a phone with images off.'}
          </div>
        </div>
      </div>
    </Modal>
  );
}
