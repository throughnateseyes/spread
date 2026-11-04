import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { exportSlides } from '../exporter';
import { isElectron, revealInFolder, saveFilesToFolder } from '../platform';
import { MOD, useStore } from '../store';
import { Button, Modal, NumberField, Row, Segmented, Toggle } from '../ui/controls';
import { Tooltip } from '../ui/Tooltip';
import { ICON_DENSE, IconCheckCircle, IconExport, IconOpen } from '../ui/icons';
import { ExportFolderRow, useExportFolder } from './ExportFolder';
import './io.css';

interface Saved {
  scale: number;
  format: 'png' | 'jpeg';
  quality: number;
  includeStrip: boolean;
}

const KEY = 'spread.exportOptions';
const DEFAULTS: Saved = { scale: 1, format: 'png', quality: 95, includeStrip: false };

function loadSaved(): Saved {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } as Saved;
    // Guard against stale / hand-edited values.
    if (![1, 2, 3].includes(s.scale)) s.scale = 1;
    if (s.format !== 'png' && s.format !== 'jpeg') s.format = 'png';
    s.quality = Math.min(100, Math.max(70, Number(s.quality) || 95));
    return s;
  } catch {
    return DEFAULTS;
  }
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'carousel'
  );
}

/** Parses "1-3,5" into zero-based slide indices. Returns null when invalid. */
export function parseSlideRange(text: string, count: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > count || b > count) return null;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="io-field">
      <div className="io-label">{label}</div>
      {children}
      {hint}
    </div>
  );
}

function folderName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export default function ExportDialog() {
  const doc = useStore((s) => s.doc);
  const close = () => useStore.getState().set({ modal: null });
  const toast = useStore((s) => s.toast);

  const [opts, setOpts] = useState<Saved>(loadSaved);
  const [which, setWhich] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('1');
  const [prefix, setPrefix] = useState(() => slugify(doc.name));
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<{ folder: string; count: number } | null>(null);
  const out = useExportFolder(doc.name);

  const count = doc.slides.length;
  const slides = useMemo(() => (which === 'all' ? null : parseSlideRange(range, count)), [which, range, count]);
  const rangeInvalid = which === 'range' && !slides;

  const update = (patch: Partial<Saved>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage unavailable
    }
  };

  const w = doc.slideWidth * opts.scale;
  const h = doc.slideHeight * opts.scale;
  const n = which === 'all' ? count : (slides?.length ?? 0);
  const canRun = !progress && !rangeInvalid && n > 0;
  const ext = opts.format === 'jpeg' ? 'jpg' : 'png';

  const run = async () => {
    if (!canRun) return;
    setDone(null);
    setProgress('Rendering…');
    try {
      const files = await exportSlides({
        scale: opts.scale,
        format: opts.format,
        quality: opts.quality / 100,
        slides: slides ?? undefined,
        includeStrip: opts.includeStrip,
        // Keep the user's casing, but strip characters Windows/macOS reject in file names.
        prefix: prefix.trim().replace(/[\\/:*?"<>|]+/g, '-') || slugify(doc.name),
        onProgress: (d, t) => setProgress(`Rendering ${d} / ${t}…`),
      });
      setProgress(out.folder ? 'Saving…' : 'Choose a folder…');
      const r = await saveFilesToFolder(files, { folder: out.folder });
      setProgress(null);
      if (!r) return;
      setDone({ folder: r.folder, count: files.length });
      toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      setProgress(null);
      toast(`Export failed: ${(e as Error).message}`, 'error');
    }
  };

  const enterRuns = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void run();
    }
  };

  // Enter anywhere in the dialog (except on a button / number field, which handle it) exports.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Enter' || e.defaultPrevented || t?.closest('button, select, textarea, input')) return;
      e.preventDefault();
      void runRef.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <Modal
      title="Export slides"
      onClose={close}
      width={440}
      footer={
        <>
          <span className="muted" aria-live="polite">
            {progress ?? `${n} slide${n === 1 ? '' : 's'}${opts.includeStrip ? ' + strip' : ''} · ${w}×${h} ${ext.toUpperCase()}`}
          </span>
          <Button onClick={close}>{done ? 'Close' : 'Cancel'}</Button>
          <Button primary onClick={run} disabled={!canRun} shortcut="Enter" title={out.folder ? `Render and save to ${out.folder}` : "Render and choose a folder"}>
            <IconExport size={ICON_DENSE} /> Export
          </Button>
        </>
      }
    >
      <Field
        label="Scale"
        hint={
          <div className="hint">
            {w} × {h} px per slide{opts.scale === 1 ? ' · Instagram native size' : ' · extra-sharp, Instagram downsizes to 1080 wide'}
          </div>
        }
      >
        <Segmented
          value={String(opts.scale) as '1' | '2' | '3'}
          options={[
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
            { value: '3', label: '3×' },
          ]}
          onChange={(v) => update({ scale: Number(v) })}
        />
      </Field>

      <Field label="Format">
        <Segmented
          value={opts.format}
          options={[
            { value: 'png', label: 'PNG', title: 'Lossless. Best for type and graphics.' },
            { value: 'jpeg', label: 'JPG', title: 'Smaller files. Fine for photo-only slides.' },
          ]}
          onChange={(v) => update({ format: v })}
        />
        {opts.format === 'jpeg' && (
          <Row>
            <span className="io-sub">Quality</span>
            <input
              type="range"
              className="io-range"
              aria-label="JPG quality"
              min={70}
              max={100}
              value={opts.quality}
              style={{ ['--fill' as any]: `${((opts.quality - 70) / 30) * 100}%` }}
              onChange={(e) => update({ quality: Number(e.target.value) })}
            />
            <NumberField value={opts.quality} title="JPG quality" min={70} max={100} suffix="%" precision={0} className="io-narrow" onChange={(v) => update({ quality: v })} />
          </Row>
        )}
      </Field>

      <Field label="Slides" hint={rangeInvalid ? <div className="hint io-error">Use slide numbers 1–{count}, like “1-3, 5”.</div> : undefined}>
        <Segmented
          value={which}
          options={[
            { value: 'all', label: `All (${count})` },
            { value: 'range', label: 'Pick…' },
          ]}
          onChange={setWhich}
        />
        {which === 'range' && (
          <div className={`field ${rangeInvalid ? 'io-invalid' : ''}`}>
            <input value={range} autoFocus placeholder="e.g. 1-3, 5" aria-label="Slides to export" spellCheck={false} onChange={(e) => setRange(e.target.value)} onKeyDown={enterRuns} />
          </div>
        )}
      </Field>

      <Field label="File name">
        <div className="field">
          <input value={prefix} aria-label="File name prefix" spellCheck={false} onChange={(e) => setPrefix(e.target.value)} onKeyDown={enterRuns} />
          <span className="field-suffix">-01.{ext}</span>
        </div>
      </Field>

      {out.folder && <ExportFolderRow folder={out.folder} onChange={out.change} disabled={!!progress} />}

      <Toggle checked={opts.includeStrip} onChange={(v) => update({ includeStrip: v })} label="Also export the full strip (panorama preview)" />

      {done && (
        <div className="io-done">
          <IconCheckCircle size={18} weight="fill" />
          <div className="io-done-text">
            <div className="ellipsis">
              Saved {done.count} file{done.count === 1 ? '' : 's'} to{' '}
              <Tooltip label={done.folder} side="top">
                <b>{folderName(done.folder)}</b>
              </Tooltip>
            </div>
            <div className="hint">Keep these as your backup. The project itself doesn’t need to live in the cloud.</div>
          </div>
          {isElectron && (
            <Button onClick={() => revealInFolder(done.folder)} title={`Show in ${MOD === '⌘' ? 'Finder' : 'Explorer'}`}>
              <IconOpen size={ICON_DENSE} /> Show
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
