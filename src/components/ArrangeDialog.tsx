import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { getAsset } from '../assets';
import { ARRANGE_MODES, applyArrange, arrangeBoxes, type ArrangeMode, type ArrangeOptions } from '../arrange';
import { Button, EmptyState, Modal, NumberField, Segmented, Toggle } from '../ui/controls';
import { ICON_DENSE, IconArrange, IconGapH, IconPaddingH, IconPhotos, IconRadius } from '../ui/icons';
import './panels.css';
import './io.css';

function Diagram({ mode, ids, gap, margin, radius, big }: { mode: ArrangeMode; ids: string[]; gap: number; margin: number; radius: number; big?: boolean }) {
  const doc = useStore((s) => s.doc);
  const W = doc.slideWidth;
  const H = doc.slideHeight;
  const metas = ids.map((id) => doc.assets[id]).filter(Boolean);
  const { boxes, slides } = arrangeBoxes(mode, metas.map((m) => m.width / Math.max(1, m.height)), W, H, gap, margin);
  const n = Math.max(1, slides);
  const pad = 30;
  return (
    <svg className={`arrange-svg ${big ? 'big' : ''}`} viewBox={`${-pad} ${-pad} ${n * W + pad * 2} ${H + pad * 2}`} preserveAspectRatio="xMidYMid meet">
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={i * W} y={0} width={W} height={H} style={{ fill: 'var(--text)' }} opacity={0.08} />
      ))}
      {boxes.map((b, i) => {
        const thumb = getAsset(metas[i].id)?.thumbUrl;
        const clipId = `clip-${mode}-${big ? 'b' : 's'}-${i}`;
        return (
          <g key={i}>
            <clipPath id={clipId}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={radius} />
            </clipPath>
            {thumb ? (
              <image href={thumb} x={b.x} y={b.y} width={b.w} height={b.h} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
            ) : (
              <rect x={b.x} y={b.y} width={b.w} height={b.h} style={{ fill: 'var(--faint)' }} rx={radius} />
            )}
          </g>
        );
      })}
      {Array.from({ length: n - 1 }, (_, i) => (
        <line key={i} x1={(i + 1) * W} x2={(i + 1) * W} y1={-pad / 2} y2={H + pad / 2} stroke="#0d99ff" strokeWidth={Math.max(4, W / 160)} strokeDasharray={`${W / 40} ${W / 60}`} />
      ))}
    </svg>
  );
}

export default function ArrangeDialog() {
  const set = useStore((s) => s.set);
  const doc = useStore((s) => s.doc);
  const traySelection = useStore((s) => s.traySelection);
  const ids = useMemo(() => {
    const pool = traySelection.length ? traySelection : doc.assetOrder;
    return doc.assetOrder.filter((id) => pool.includes(id) && doc.assets[id]?.kind === 'image');
  }, [traySelection, doc.assetOrder, doc.assets]);
  const [opts, setOpts] = useState<ArrangeOptions>(() => ({
    mode: 'panorama',
    gap: 0,
    margin: 0,
    radius: 0,
    addText: false,
    where: doc.nodes.length ? 'append' : 'replace',
  }));
  const patch = (p: Partial<ArrangeOptions>) => setOpts((o) => ({ ...o, ...p }));
  const close = () => set({ modal: null });
  const slides = arrangeBoxes(
    opts.mode,
    ids.map((id) => doc.assets[id].width / Math.max(1, doc.assets[id].height)),
    doc.slideWidth,
    doc.slideHeight,
    opts.gap,
    opts.margin,
  ).slides;

  const apply = () => {
    if (ids.length) applyArrange(ids, opts);
  };

  // Enter anywhere in the dialog applies, unless a field / button has focus (they handle Enter themselves).
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Enter' || e.defaultPrevented || t?.closest('button, select, textarea, input')) return;
      e.preventDefault();
      applyRef.current();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <Modal
      title={ids.length ? `Arrange ${ids.length} photo${ids.length === 1 ? '' : 's'} across slides` : 'Arrange photos'}
      onClose={close}
      width={760}
      footer={
        ids.length ? (
          <>
            <span className="muted">
              {slides} slide{slides === 1 ? '' : 's'} · {doc.slideWidth}×{doc.slideHeight}
              {slides > 20 && <span className="io-error"> · Instagram allows 20 per carousel</span>}
            </span>
            <Button onClick={close} title="Close and leave the photos in the Photos tab">
              Not now
            </Button>
            <Button primary onClick={apply} shortcut="Enter" title={opts.where === 'replace' ? 'Replaces every layer on the canvas' : 'Adds new slides after the last one'}>
              <IconArrange size={ICON_DENSE} /> Arrange
            </Button>
          </>
        ) : (
          <Button onClick={close}>Close</Button>
        )
      }
    >
      {!ids.length ? (
        <EmptyState icon={<IconPhotos size={28} weight="light" />} title="No photos to arrange yet">
          Drop a folder of photos anywhere on the window, or use Photos → Folder.
        </EmptyState>
      ) : (
        <div className="arrange-body">
          <div className="io-field">
            <div className="io-label">Layout</div>
            <div className="arrange-modes" role="radiogroup" aria-label="Layout">
              {ARRANGE_MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={opts.mode === m.id} className={`arrange-card ${opts.mode === m.id ? 'on' : ''}`} onClick={() => patch({ mode: m.id })} onDoubleClick={apply}>
                  <Diagram mode={m.id} ids={ids} gap={opts.gap} margin={opts.margin} radius={opts.radius} />
                  <div className="arrange-card-label">{m.label}</div>
                  <div className="hint">{m.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="arrange-preview">
            <Diagram mode={opts.mode} ids={ids} gap={opts.gap} margin={opts.margin} radius={opts.radius} big />
          </div>
          <div className="io-field">
            <div className="io-label">Spacing</div>
            <div className="arrange-options">
              <NumberField label={<IconGapH size={ICON_DENSE} />} title="Gap between photos" value={opts.gap} min={0} onChange={(v) => patch({ gap: v })} suffix="px" precision={0} />
              <NumberField label={<IconPaddingH size={ICON_DENSE} />} title="Margin around the slides" value={opts.margin} min={0} onChange={(v) => patch({ margin: v })} suffix="px" precision={0} />
              <NumberField label={<IconRadius size={ICON_DENSE} />} title="Corner radius" value={opts.radius} min={0} onChange={(v) => patch({ radius: v })} suffix="px" precision={0} />
            </div>
          </div>
          <div className="arrange-row">
            <Toggle checked={opts.addText} onChange={(v) => patch({ addText: v })} label="Add headline placeholder" />
            <Segmented
              value={opts.where}
              onChange={(v) => patch({ where: v })}
              options={[
                { value: 'replace', label: 'Replace everything', title: 'Clear the canvas and start from these photos' },
                { value: 'append', label: 'Append after last slide', title: 'Keep what is there and add new slides' },
              ]}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
