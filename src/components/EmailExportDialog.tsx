import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowLeft as ArrowLeft, IconCheck as Check, IconCopy as Copy, IconDownload as Download, IconFolder as FolderOpen, IconImage as ImageIcon, IconLink as Link2, IconDesktop as Monitor, IconMobile as Smartphone, IconUpload as Upload, IconWarning as TriangleAlert } from '../ui/icons';
import type { FrameNode, SceneNode } from '../types';
import { computeLayout } from '../layout';
import { getAsset } from '../assets';
import { isElectron, native, revealInFolder, saveFilesToFolder, type HostingStatus } from '../platform';
import { hostEmailImages } from '../email/hosting';
import { Button, Modal, Segmented } from '../ui/controls';
import { buildEmailHtml, GMAIL_CLIP_BYTES, joinUrl, parseNameTags, type EmailImage } from '../email/html';
import { renderEmailImages, type RenderedEmailImage } from '../email/images';
import './email.css';
import { useStore } from '../store';
import { ExportFolderRow, useExportFolder } from './ExportFolder';

// Email export: choose where the pictures will live (one base URL, or a URL per picture),
// then render the pictures at 2x, preview the compiled HTML (desktop / phone), copy it, and
// write pictures + email.html to a folder for upload.

interface Props {
  onClose: () => void;
  /** The email's root auto-layout frame. */
  root: FrameNode;
  /** The board's top-level nodes (context only; layout is computed from `root`). */
  nodes: SceneNode[];
}

type HostMode = 'wordpress' | 'base' | 'each';
type WordPress = HostingStatus['wordpress'];

const K_BASE = 'spread.email.baseUrl';
const K_MODE = 'spread.email.hosting';
const K_URLS = 'spread.email.imageUrls';
const K_META = 'spread.email.meta.';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage unavailable (private window etc.); the dialog still works
  }
}
function lsJson<T>(k: string, fallback: T): T {
  try {
    const raw = lsGet(k);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(b);
  });
}

const BAD_HOST = /drive\.google\.com|docs\.google\.com|\bbox\.com|dropbox\.com|onedrive\.live\.com|1drv\.ms/i;

function urlProblems(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (BAD_HOST.test(u)) return 'Drive, Box, Dropbox and OneDrive share links don’t work as email images. Use the WordPress media library or the sender’s own hosting.';
  if (/^http:\/\//i.test(u)) return 'Use https://. Many inboxes block or warn on plain http images.';
  if (!/^https:\/\//i.test(u)) return 'Image URLs must be full public addresses starting with https://.';
  return null;
}

function formatKb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function EmailExportDialog({ onClose, root, nodes }: Props) {
  const layout = useMemo(() => computeLayout([root]), [root]);
  const defaultTitle = parseNameTags(root.name).clean.replace(/^email\s*\/\s*/i, '') || 'Email';
  const metaKey = K_META + root.id;
  const savedMeta = useMemo(() => lsJson(metaKey, { title: '', preheader: '' }), [metaKey]);

  const [step, setStep] = useState<'setup' | 'review'>('setup');
  // Subject and preview text live on the board (Inbox in the right panel); older exports kept them here.
  const board = useStore((s) => s.doc);
  const title = board.email?.subject ?? savedMeta.title;
  const preheader = board.email?.preheader ?? savedMeta.preheader;
  const htmlTitle = title.trim() || defaultTitle;
  const setMeta = (patch: { subject?: string; preheader?: string }) => useStore.getState().updateBoard(board.id, { email: { subject: title, preheader, ...patch } });
  const setTitle = (subject: string) => setMeta({ subject });
  const setPreheader = (v: string) => setMeta({ preheader: v });
  const [mode, setMode] = useState<HostMode>(() => {
    const m = lsGet(K_MODE);
    return m === 'base' || m === 'each' ? m : isElectron ? 'wordpress' : 'base';
  });
  const [wp, setWp] = useState<WordPress | undefined>(undefined);
  const [hosted, setHosted] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState(() => lsGet(K_BASE) ?? '');
  const [urls, setUrls] = useState<Record<string, string>>(() => lsJson<Record<string, string>>(K_URLS, {}));
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [rendered, setRendered] = useState<{ files: RenderedEmailImage[]; dataUrls: Record<string, string>; warnings: string[]; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<{ folder: string; count: number } | null>(null);
  const projectName = useStore((s) => s.project.name);
  const dest = useExportFolder(projectName);

  useEffect(() => {
    if (!native) return;
    void native.hostingStatus().then((r) => setWp(r.ok ? r.wordpress : null));
  }, []);
  useEffect(() => lsSet(K_MODE, mode), [mode]);
  useEffect(() => lsSet(K_BASE, baseUrl), [baseUrl]);
  useEffect(() => lsSet(K_URLS, JSON.stringify(urls)), [urls]);

  const urlFor = (map: Record<string, string>) => (nodeId: string, fileName: string) =>
    mode === 'wordpress' ? (map[nodeId] ?? fileName) : mode === 'base' ? joinUrl(baseUrl, fileName) : urls[nodeId]?.trim() || fileName;
  const imageUrl = urlFor(hosted);

  const compiled = useMemo(
    () => buildEmailHtml(root, layout, { title: htmlTitle, preheader, imageUrl }),
    // imageUrl closes over mode / baseUrl / urls / hosted
    [root, layout, htmlTitle, preheader, mode, baseUrl, urls, hosted],
  );
  const images = compiled.images;
  const imagesKey = images.map((i) => `${i.nodeId}:${i.fileName}:${i.width}x${i.height}:${i.matte}`).join('|');

  const hostingWarnings = useMemo(() => {
    const w: string[] = [];
    if (!images.length) return w;
    if (mode === 'wordpress') {
      if (wp === null) w.push('Connect WordPress so Spread can upload the pictures for you.');
    } else if (mode === 'base') {
      if (!baseUrl.trim()) w.push('Enter the base URL where you’ll upload the pictures, or the email will point at local file names.');
      else {
        const p = urlProblems(baseUrl);
        if (p) w.push(p);
      }
    } else {
      const missing = images.filter((im) => !urls[im.nodeId]?.trim());
      if (missing.length) w.push(`${missing.length} picture${missing.length === 1 ? ' has' : 's have'} no URL yet: ${missing.map((m) => m.fileName).join(', ')}.`);
      const bad = new Set(images.map((im) => urlProblems(urls[im.nodeId] ?? '')).filter((x): x is string => !!x));
      w.push(...bad);
    }
    return w;
  }, [images, mode, baseUrl, urls, wp]);

  // Pictures for the preview (data URLs, so the sandboxed iframe can show them before upload).
  const previewHtml = useMemo(() => {
    if (!rendered) return compiled.html;
    return buildEmailHtml(root, layout, {
      title: htmlTitle,
      preheader,
      imageUrl: (id, f) => rendered.dataUrls[id] ?? imageUrl(id, f),
    }).html;
  }, [rendered, compiled.html, root, layout, htmlTitle, preheader, mode, baseUrl, urls, hosted]);

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
      const html = buildEmailHtml(root, layout, { title: htmlTitle, preheader, imageUrl: urlFor(r.urls) }).html;
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

  const warnings = [...hostingWarnings, ...compiled.warnings, ...(rendered?.warnings ?? [])];
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
    <div className="em-warnings">
      <div className="em-label">
        <TriangleAlert size={12} /> {warnings.length} thing{warnings.length === 1 ? '' : 's'} to check
      </div>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );

  const thumbFor = (im: EmailImage) => {
    if (rendered?.dataUrls[im.nodeId]) return rendered.dataUrls[im.nodeId];
    const n = findImageAsset(root, im.nodeId);
    return n ? getAsset(n)?.thumbUrl ?? null : null;
  };

  if (step === 'setup') {
    return (
      <Modal title="Export email" onClose={onClose} width={640}>
        <div className="em-grid2">
          <label className="em-field">
            <span className="em-label">Subject</span>
            <div className="field">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What makes them open it" />
            </div>
          </label>
          <label className="em-field">
            <span className="em-label">Preview text</span>
            <div className="field">
              <input value={preheader} onChange={(e) => setPreheader(e.target.value)} placeholder="The line after the subject in the inbox" />
            </div>
          </label>
        </div>

        <div className="em-field">
          <span className="em-label">Picture hosting</span>
          <Segmented
            value={mode}
            options={[
              ...(isElectron ? [{ value: 'wordpress' as const, label: 'Upload to WordPress' }] : []),
              { value: 'base', label: 'One folder URL' },
              { value: 'each', label: 'URL per picture' },
            ]}
            onChange={setMode}
          />
          {mode === 'wordpress' ? (
            <WordPressConnect wp={wp} onChange={setWp} />
          ) : mode === 'base' ? (
            <>
              <div className="field">
                <span className="field-label">
                  <Link2 size={12} />
                </span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/wp-content/uploads/2026/10/" spellCheck={false} />
              </div>
              <div className="hint">
                Upload the exported pictures to this folder with the same file names.
                {images[0] && (
                  <>
                    {' '}
                    First picture: <code className="em-code">{joinUrl(baseUrl || 'https://…/', images[0].fileName)}</code>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="hint">Upload each picture first (e.g. to the WordPress media library), then paste its URL below.</div>
          )}
        </div>

        <div className="em-field">
          <span className="em-label">
            {images.length} picture{images.length === 1 ? '' : 's'} · exported at 2× ({images.reduce((a, i) => a + (i.format === 'png' ? 1 : 0), 0)} PNG)
          </span>
          {images.length === 0 && <div className="hint">This email has no pictures. Only email.html will be written.</div>}
          <div className="em-images">
            {images.map((im) => {
              const thumb = thumbFor(im);
              const own = urls[im.nodeId] ?? '';
              const problem = mode === 'each' ? urlProblems(own) : null;
              return (
                <div key={im.nodeId} className="em-image">
                  <div className="em-thumb">{thumb ? <img src={thumb} alt="" /> : <ImageIcon size={16} />}</div>
                  <div className="em-image-main">
                    <div className="em-image-name">
                      <b>{im.fileName}</b>
                      <span className="muted">
                        {im.width * 2}×{im.height * 2}
                        {im.rasterize ? ' · flattened' : ''}
                      </span>
                    </div>
                    {mode === 'each' ? (
                      <div className={`field ${problem ? 'em-invalid' : ''}`}>
                        <input
                          value={own}
                          spellCheck={false}
                          placeholder="https://…"
                          onChange={(e) => setUrls((u) => ({ ...u, [im.nodeId]: e.target.value }))}
                        />
                      </div>
                    ) : (
                      <div className="hint em-alt">{im.alt ? `Alt: ${im.alt}` : 'No alt text (rename the layer to describe the photo)'}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {sizeMeter}
        {warningList}
        {error && <div className="hint em-error">{error}</div>}

        <div className="em-actions">
          <span className="muted">
            {root.w}×{Math.round(height)} · {formatKb(compiled.bytes)}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={goReview} disabled={!!busy}>
            Preview &amp; export
          </Button>
        </div>
      </Modal>
    );
  }

  const frameW = device === 'desktop' ? 600 : 375;
  return (
    <Modal title="Export email" onClose={onClose} width={1000}>
      <div className="em-review">
        <div className="em-preview-col">
          <div className="em-preview-bar">
            <Segmented
              className="em-device"
              value={device}
              options={[
                { value: 'desktop', label: <Monitor size={14} />, title: 'Desktop (600px)' },
                { value: 'mobile', label: <Smartphone size={14} />, title: 'Phone (375px)' },
              ]}
              onChange={setDevice}
            />
            <span className="muted">{busy ?? (rendered ? `${frameW}px wide` : 'Pictures not rendered')}</span>
          </div>
          <div className="em-preview-stage">
            <iframe className="em-preview" title="Email preview" sandbox="" srcDoc={previewHtml} style={{ width: frameW }} />
          </div>
        </div>

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
                  ? `Upload ${images.length} picture${images.length === 1 ? '' : 's'} to ${baseUrl.trim() || 'your base URL'}`
                  : `${images.length} picture${images.length === 1 ? '' : 's'}, linked one by one`
                : 'No pictures'}
            </div>
          </div>
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

function findImageAsset(root: SceneNode, id: string): string | null {
  if (root.id === id) return root.type === 'image' ? root.assetId : null;
  if (root.type === 'frame') {
    for (const c of root.children) {
      const r = findImageAsset(c, id);
      if (r) return r;
    }
  }
  return null;
}

/** Connect or show the WordPress site pictures upload to (an Application Password, kept in the Keychain). */
function WordPressConnect({ wp, onChange }: { wp: WordPress | undefined; onChange: (wp: WordPress) => void }) {
  const [site, setSite] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (wp === undefined) return <div className="hint">Checking the connection…</div>;
  if (wp) {
    return (
      <div className="em-wp-on">
        <Check size={14} />
        <span>
          Uploads go to <b>{wp.site.replace(/^https:\/\//, '')}</b> as {wp.name}
        </span>
        <button
          className="link"
          onClick={async () => {
            const r = await native!.hostingDisconnect();
            if (r.ok) onChange(null);
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
    onChange(r.wordpress);
  };
  return (
    <div className="em-wp">
      <div className="em-grid3">
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
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="hint">
          In WordPress: Users → Profile → Application Passwords → name it “Spread” → Add. It’s stored in your Mac’s Keychain, not your login password.
        </span>
        <Button primary onClick={connect} disabled={busy || !site.trim() || !user.trim() || !password.trim()}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
      {error && <div className="hint em-error">{error}</div>}
    </div>
  );
}
