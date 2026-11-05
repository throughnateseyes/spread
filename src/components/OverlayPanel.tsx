import { useRef, useState, type DragEvent } from 'react';
import { getAsset } from '../assets';
import { useLibrary } from '../library';
import { compareOverlay, overlayFromBoard, overlayFromFile, overlayFromLibrary, overlayKey, overlaySummary, overlayUrl, patchOverlay, removeOverlay, useOverlayReports } from '../overlay';
import { boardFrames, useStore } from '../store';
import { Button, IconButton, NumberField, Section, Segmented, Select, Slider } from '../ui/controls';
import { IconEye, IconEyeOff, IconPlus, IconTrash } from '../ui/icons';
import type { BoardOverlay } from '../types';

// The Reference section and what it draws. The picture sits in HTML above the canvas, like the
// link badges, so it follows the view, lets clicks through, and never ends up in an export.

export function ReferenceOverlay() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const reports = useOverlayReports();
  const frames = boardFrames(project);
  return (
    <>
      {project.boards.map((b) => {
        const o = b.overlay;
        const f = frames.get(b.id);
        if (!o?.visible || !f) return null;
        if (o.mode === 'changes') {
          const r = reports[b.id];
          if (!r) return null;
          const at = `translate(${f.x * view.zoom + view.panX}px, ${f.y * view.zoom + view.panY}px) scale(${view.zoom / r.ratio})`;
          return <img key={b.id} className="ref-overlay" src={r.url} alt="" style={{ transform: at }} />;
        }
        const url = overlayUrl(o.assetId);
        if (!url) return null;
        const at = `translate(${(f.x + o.x) * view.zoom + view.panX}px, ${(f.y + o.y) * view.zoom + view.panY}px) scale(${o.scale * view.zoom})`;
        return <img key={b.id} className="ref-overlay" src={url} alt="" style={{ transform: at, opacity: o.mode === 'fade' ? o.opacity : 1, mixBlendMode: o.mode === 'difference' ? 'difference' : 'normal' }} />;
      })}
    </>
  );
}

export function OverlaySection() {
  const doc = useStore((s) => s.doc);
  const boards = useStore((s) => s.project.boards);
  const references = useLibrary((s) => s.references);
  const report = useOverlayReports((s) => s[doc.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const o = doc.overlay;
  const id = doc.id;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const addFile = (file: File | undefined) => file && void run('Adding…', () => overlayFromFile(id, file));
  const compare = () => run('Comparing…', () => compareOverlay(id));
  const setMode = (mode: BoardOverlay['mode']) => {
    patchOverlay(id, { mode, visible: true });
    if (mode === 'changes' && !fresh) void compare();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    addFile(e.dataTransfer.files[0]);
  };

  const sources = [
    ...boards.filter((b) => b.id !== id).map((b) => ({ value: `board:${b.id}`, label: b.name })),
    ...references.filter((r) => r.boardKind === doc.kind).map((r) => ({ value: `saved:${r.id}`, label: `Saved: ${r.name}` })),
  ];
  const pickSource = (v: string) => {
    if (v.startsWith('board:')) void run('Rendering…', () => overlayFromBoard(id, v.slice(6)));
    else if (v.startsWith('saved:')) void run('Adding…', () => overlayFromLibrary(id, v.slice(6)));
  };
  const fresh = !!report && report.key === overlayKey(doc);
  const meta = o ? getAsset(o.assetId)?.meta : undefined;

  return (
    <Section title="Reference">
      <div className={`ref-drop ${over ? 'over' : ''}`} onDragOver={(e) => (e.preventDefault(), e.stopPropagation(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <input ref={input} type="file" hidden accept="image/*,.html,.htm" onChange={(e) => (addFile(e.target.files?.[0]), (e.target.value = ''))} />
        {!o ? (
          <>
            <Button className="block" onClick={() => input.current?.click()} disabled={!!busy}>
              <IconPlus size={14} /> {busy ?? 'Add a past design'}
            </Button>
            {sources.length > 0 && <Select title="Use a board or saved reference" value="" options={[{ value: '', label: 'Or use a board…' }, ...sources]} onChange={pickSource} />}
            <div className="hint">Drop a picture or an email's HTML file here to fade it over this board and measure the difference.</div>
          </>
        ) : (
          <>
            <div className="ref-head">
              <span className="ref-name" title={o.name}>
                {o.name}
              </span>
              <IconButton className="small" title={o.visible ? 'Hide reference' : 'Show reference'} onClick={() => patchOverlay(id, { visible: !o.visible })}>
                {o.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
              </IconButton>
              <IconButton className="small" title="Remove reference" onClick={() => removeOverlay(id)}>
                <IconTrash size={14} />
              </IconButton>
            </div>
            {!meta && <div className="hint warn">This picture is missing. Remove it and add it again.</div>}
            <Segmented
              value={o.mode}
              options={[
                { value: 'fade', label: 'Fade' },
                { value: 'difference', label: 'Difference' },
                { value: 'changes', label: 'Changes' },
              ]}
              onChange={setMode}
            />
            {o.mode === 'fade' && <Slider label="Opacity" value={Math.round(o.opacity * 100)} min={0} max={100} suffix="%" reset={50} onChange={(v, k) => patchOverlay(id, { opacity: v / 100 }, k)} />}
            <div className="grid3">
              <NumberField label="X" title="Reference left edge" value={o.x} precision={1} onChange={(x, k) => patchOverlay(id, { x }, k)} />
              <NumberField label="Y" title="Reference top edge" value={o.y} precision={1} onChange={(y, k) => patchOverlay(id, { y }, k)} />
              <NumberField title="Reference size" value={Math.round(o.scale * 1000) / 10} min={1} max={1000} precision={1} suffix="%" onChange={(v, k) => patchOverlay(id, { scale: v / 100 }, k)} />
            </div>
            <Button className="block" primary={!fresh} onClick={() => void compare()} disabled={!!busy || !meta}>
              {busy ?? (report ? 'Compare again' : 'Compare')}
            </Button>
            {report && (
              <div className="ref-report">
                {!fresh && <div className="hint">The board has changed since this comparison.</div>}
                {overlaySummary(report).map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {report.regions.map((r) => (
                  <button
                    key={`${r.x},${r.y}`}
                    className="ref-area"
                    title={`${r.w}×${r.h} at ${r.x}, ${r.y}. ${r.percent}% of it differs.`}
                    onClick={() => {
                      if (!r.layers.length) return;
                      useStore.getState().select([r.layers[0].id]);
                      window.dispatchEvent(new Event('spread:zoom-selection'));
                    }}
                  >
                    <span>{r.layers[0]?.name ?? 'No layer here'}</span>
                    <span>
                      {r.w}×{r.h}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {error && <div className="hint warn">{error}</div>}
      </div>
    </Section>
  );
}
