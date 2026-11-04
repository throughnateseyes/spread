import { useContext, useEffect, useRef, useState } from 'react';
import { GRADIENT_PRESETS, paintCanvas, shuffleMesh } from '../gradients';
import type { Paint } from '../types';
import { Button, ColorField, IconButton, NumberField, Row, Segmented, Slider, SwatchContext } from '../ui/controls';
import { IconMinus, IconPlus, IconRotation, IconShuffle } from '../ui/icons';
import { Tooltip } from '../ui/Tooltip';
import './effects.css';

type Gradient = Exclude<Paint, { kind: 'solid' }>;
type Mesh = Extract<Gradient, { kind: 'mesh' }>;

const D = 16;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const thumbs = new Map<string, string>();
function presetThumb(name: string, paint: Paint) {
  let url = thumbs.get(name);
  if (!url) thumbs.set(name, (url = paintCanvas({ ...(paint as Gradient), grain: 0 }, 32, 32).toDataURL()));
  return url;
}

/** A live picture of the gradient, with its colors as handles you can drag. */
function Pad({ paint, selected, onSelect, onMove, onAdd }: { paint: Gradient; selected: number; onSelect: (i: number) => void; onMove: (i: number, x: number, y: number, key: string) => void; onAdd: (x: number, y: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // One undo step per drag, however long it takes.
  const drag = useRef(0);
  useEffect(() => {
    // Grain sized for a full layer turns blotchy at this size, so the pad shows just the colors.
    const src = paintCanvas({ ...paint, grain: 0 }, 240, 150);
    const c = canvas.current!;
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
  }, [paint]);
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)] as const;
  };
  const handles = paint.kind === 'mesh' ? paint.points : paint.kind === 'radial' ? [{ x: paint.cx, y: paint.cy, color: paint.from }] : [];
  return (
    <div className="grad-pad" ref={box} onDoubleClick={(e) => paint.kind === 'mesh' && e.target === canvas.current && onAdd(...at(e))}>
      <canvas ref={canvas} aria-hidden />
      {handles.map((h, i) => (
        <button
          key={i}
          type="button"
          className={`grad-dot ${i === selected ? 'on' : ''}`}
          style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, background: h.color }}
          aria-label={`Color ${i + 1}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current++;
            onSelect(i);
          }}
          onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && onMove(i, ...at(e), `g:grad-${drag.current}`)}
        />
      ))}
    </div>
  );
}

export function GradientField({ paint, onChange }: { paint: Gradient; onChange: (p: Paint, key?: string) => void }) {
  const brand = useContext(SwatchContext);
  const [selected, setSelected] = useState(0);
  const point = paint.kind === 'mesh' ? Math.min(selected, paint.points.length - 1) : 0;
  const setPoints = (p: Mesh, points: Mesh['points'], key?: string) => onChange({ ...p, points }, key);

  const switchTo = (kind: Gradient['kind']) => {
    if (kind === paint.kind) return;
    const from = paint.kind === 'mesh' ? paint.points[0].color : paint.from;
    const to = paint.kind === 'mesh' ? paint.points[paint.points.length - 1].color : paint.to;
    if (kind === 'mesh') onChange(structuredClone(GRADIENT_PRESETS[0].paint));
    else if (kind === 'radial') onChange({ kind, cx: 0.5, cy: 0.5, radius: 0.75, from, to, grain: paint.grain });
    else onChange({ kind, angle: 180, from, to, grain: paint.grain });
  };

  const grain = (
    <Slider label="Grain" value={Math.round((paint.grain ?? 0) * 100)} min={0} max={100} reset={0} onChange={(v, k) => onChange({ ...paint, grain: v / 100 }, k ?? 'paint-grain')} />
  );

  return (
    <>
      <Pad
        paint={paint}
        selected={point}
        onSelect={setSelected}
        onMove={(i, x, y, key) => {
          if (paint.kind === 'mesh') setPoints(paint, paint.points.map((p, k) => (k === i ? { ...p, x, y } : p)), key);
          else if (paint.kind === 'radial') onChange({ ...paint, cx: x, cy: y }, key);
        }}
        onAdd={(x, y) => {
          if (paint.kind !== 'mesh' || paint.points.length >= 6) return;
          setPoints(paint, [...paint.points, { x, y, color: paint.points[point].color }]);
          setSelected(paint.points.length);
        }}
      />
      <Segmented
        value={paint.kind}
        onChange={switchTo}
        options={[
          { value: 'linear', label: 'Linear', title: 'Blends in a straight line' },
          { value: 'radial', label: 'Radial', title: 'Blends out from a center' },
          { value: 'mesh', label: 'Mesh', title: 'Several colors melting together' },
        ]}
      />
      {paint.kind === 'mesh' ? (
        <>
          <div className="grad-presets">
            {GRADIENT_PRESETS.map((g) => (
              <Tooltip key={g.name} label={g.name} side="top">
                <button type="button" aria-label={g.name} style={{ backgroundImage: `url(${presetThumb(g.name, g.paint)})` }} onClick={() => onChange(structuredClone(g.paint))} />
              </Tooltip>
            ))}
          </div>
          <ColorField value={paint.points[point].color} onChange={(c, k) => setPoints(paint, paint.points.map((p, i) => (i === point ? { ...p, color: c } : p)), k ?? 'grad-color')} />
          <Slider label="Softness" value={Math.round(paint.softness * 100)} min={0} max={100} reset={55} onChange={(v, k) => onChange({ ...paint, softness: v / 100 }, k ?? 'grad-soft')} />
          {grain}
          <Row>
            <Button className="block" title="New positions, same colors. With a brand kit, uses its colors." onClick={() => onChange(shuffleMesh(paint, brand.map((c) => c.hex)))}>
              <IconShuffle size={D} /> Shuffle
            </Button>
            <IconButton title="Add a color (or double-click the gradient)" disabled={paint.points.length >= 6} onClick={() => {
              setPoints(paint, [...paint.points, { x: 0.5, y: 0.5, color: paint.points[point].color }]);
              setSelected(paint.points.length);
            }}>
              <IconPlus size={D} />
            </IconButton>
            <IconButton title="Remove this color" disabled={paint.points.length <= 2} onClick={() => setPoints(paint, paint.points.filter((_, i) => i !== point))}>
              <IconMinus size={D} />
            </IconButton>
          </Row>
        </>
      ) : (
        <>
          <ColorField label="From" value={paint.from} onChange={(c, k) => onChange({ ...paint, from: c }, k ?? 'paint-from')} />
          <ColorField label="To" value={paint.to} onChange={(c, k) => onChange({ ...paint, to: c }, k ?? 'paint-to')} />
          {paint.kind === 'linear' ? (
            <NumberField label={<IconRotation size={D} />} title="Direction: 0° runs up, 180° runs down" value={paint.angle} suffix="°" precision={0} onChange={(a, k) => onChange({ ...paint, angle: ((a % 360) + 360) % 360 }, k ?? 'paint-angle')} />
          ) : (
            <Slider label="Size" value={Math.round(paint.radius * 100)} min={10} max={150} reset={75} onChange={(v, k) => onChange({ ...paint, radius: v / 100 }, k ?? 'grad-radius')} />
          )}
          {grain}
        </>
      )}
    </>
  );
}
