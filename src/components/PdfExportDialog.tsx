import { useMemo, useState } from 'react';
import { exportPdf, letterBreaks, type PdfPages } from '../pdf';
import { exportSlides } from '../exporter';
import { lintBoard } from '../lint';
import { useActiveBrand } from '../brand';
import { isElectron, native, revealInFolder, saveBytes, saveFilesToFolder } from '../platform';
import { currentLayout, useStore } from '../store';
import { Button, Modal, Segmented } from '../ui/controls';
import { ICON_DENSE, IconExport } from '../ui/icons';
import './io.css';
import { ExportFolderRow, useExportFolder } from './ExportFolder';

// Export for document boards: a PDF with real text (the default), or one PNG per page at a print
// resolution. The layout check runs first so problems show up before anything is saved.
// Email boards come here from "Save as PDF": one long page the size of the email, or Letter pages.

const DPIS = [150, 300, 600] as const;

function slug(s: string) {
  return s.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'document';
}

export default function PdfExportDialog() {
  const doc = useStore((s) => s.doc);
  const fontsVersion = useStore((s) => s.fontsVersion);
  const toast = useStore((s) => s.toast);
  const close = () => useStore.getState().set({ modal: null });
  const isEmail = doc.kind === 'email';
  const [format, setFormat] = useState<'pdf' | 'png'>('pdf');
  const [emailPages, setEmailPages] = useState<PdfPages>('one');
  const [dpi, setDpi] = useState<(typeof DPIS)[number]>(300);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const projectName = useStore((s) => s.project.name);
  const dest = useExportFolder(projectName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const brand = useActiveBrand();
  const lint = useMemo(() => lintBoard(doc, currentLayout(), brand), [doc, fontsVersion, brand]);
  const errors = lint.issues.filter((i) => i.severity === 'error');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const letterCount = useMemo(() => (isEmail && emailPages === 'letter' ? letterBreaks(doc, currentLayout()).length : 0), [doc, fontsVersion, isEmail, emailPages]);
  const pages = letterCount || doc.slides.length;
  const inches = letterCount ? 'US Letter' : `${+(doc.slideWidth / 72).toFixed(2)} × ${+(doc.slideHeight / 72).toFixed(2)} in`;

  const run = async () => {
    setSaved(null);
    try {
      if (format === 'pdf') {
        setBusy('Building PDF…');
        const { bytes, pages } = await exportPdf(doc.id, { pages: isEmail ? emailPages : undefined });
        setBusy(dest.folder ? 'Saving…' : 'Choose where to save…');
        const name = `${slug(doc.name)}.pdf`;
        const path = native && dest.folder ? await native.writeFile({ path: `${dest.folder}/${name}`, data: bytes }) : await saveBytes({ suggestedName: name, data: bytes, mime: 'application/pdf', ext: 'pdf' });
        if (path) {
          setSaved(path);
          toast(`Saved ${pages}-page PDF`, 'success');
        }
      } else {
        setBusy('Rendering…');
        const files = await exportSlides({ scale: dpi / 72, format: 'png', prefix: slug(doc.name), onProgress: (d, t) => setBusy(`Rendering ${d} / ${t}…`) });
        setBusy(dest.folder ? 'Saving…' : 'Choose a folder…');
        const r = await saveFilesToFolder(files, { folder: dest.folder });
        if (r) {
          setSaved(r.folder);
          toast(`Exported ${files.length} page${files.length === 1 ? '' : 's'}`, 'success');
        }
      }
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={isEmail ? 'Save email as PDF' : 'Export'}
      onClose={close}
      width={460}
      footer={
        <>
          <span className="muted" aria-live="polite">
            {busy ?? `${pages} page${pages === 1 ? '' : 's'} · ${inches}${format === 'png' ? ` · ${Math.round((doc.slideWidth / 72) * dpi)}×${Math.round((doc.slideHeight / 72) * dpi)} px` : ''}`}
          </span>
          <Button onClick={close}>{saved ? 'Close' : 'Cancel'}</Button>
          <Button primary onClick={run} disabled={!!busy || (format === 'pdf' && !isElectron)} title={format === 'pdf' && !isElectron ? 'PDF export needs the desktop app' : 'Export'}>
            <IconExport size={ICON_DENSE} /> Export {format.toUpperCase()}
          </Button>
        </>
      }
    >
      {isEmail ? (
        <div className="io-field">
          <div className="io-label">Pages</div>
          <Segmented
            value={emailPages}
            onChange={setEmailPages}
            options={[
              { value: 'one', label: 'One long page' },
              { value: 'letter', label: 'Letter pages' },
            ]}
          />
          <div className="hint">
            {emailPages === 'one' ? 'The whole email on one page, exactly as the canvas shows it.' : 'Fitted to the page width, with breaks between lines of text, never through them.'} Text stays
            selectable and linked layers stay clickable.
          </div>
        </div>
      ) : (
        <div className="io-field">
          <div className="io-label">Format</div>
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: 'pdf', label: 'PDF · real text' },
              { value: 'png', label: 'PNG per page' },
            ]}
          />
        </div>
      )}
      {format === 'png' && (
        <div className="io-field">
          <div className="io-label">Resolution</div>
          <Segmented value={String(dpi) as '300'} onChange={(v) => setDpi(Number(v) as (typeof DPIS)[number])} options={DPIS.map((d) => ({ value: String(d) as '300', label: `${d} dpi` }))} />
        </div>
      )}
      {dest.folder && <ExportFolderRow folder={dest.folder} onChange={dest.change} disabled={!!busy} />}
      {!isEmail && (
        <div className="io-field">
          <div className="io-label">Layout check</div>
          {lint.issues.length === 0 ? (
            <div className="hint">No issues: margins, spacing, alignment, contrast and overflow all check out.</div>
          ) : (
            <div className="lint-list">
              <div className={`hint ${errors.length ? 'warn' : ''}`}>{lint.summary} You can still export.</div>
              <ul>
                {lint.issues.slice(0, 8).map((i, k) => (
                  <li key={k} className={i.severity}>
                    {i.page !== null && <span className="muted">P{i.page + 1} · </span>}
                    {i.message}
                  </li>
                ))}
                {lint.issues.length > 8 && <li className="muted">…and {lint.issues.length - 8} more.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      {saved && (
        <button className="link-btn left" onClick={() => revealInFolder(saved)}>
          Show in folder
        </button>
      )}
    </Modal>
  );
}
