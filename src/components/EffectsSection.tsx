import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getAsset } from '../assets';
import { EFFECT_LIBRARY, EFFECTS, makeEffect, renderStack, type LibraryLook, type Setting } from '../effects';
import type { ImageNode, PhotoEffect } from '../types';
import { IconButton, Section, Slider } from '../ui/controls';
import { Floating } from '../ui/Floating';
import { IconEye, IconEyeOff, IconMinus, IconPlus, IconSwap } from '../ui/icons';
import './effects.css';

type Im = (fn: (n: ImageNode) => void, key?: string) => void;

const D = 16;

/** Stands in for the photo when a layer is still an empty placeholder. */
let sample: HTMLCanvasElement | null = null;
function sampleImage() {
  if (sample) return sample;
  sample = document.createElement('canvas');
  sample.width = 480;
  sample.height = 320;
  const c = sample.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, 480, 320);
  g.addColorStop(0, '#E9E4DA');
  g.addColorStop(1, '#3A3A40');
  c.fillStyle = g;
  c.fillRect(0, 0, 480, 320);
  return sample;
}

/** The layer's own photo with `effects`, sized for a thumbnail. */
function preview(n: ImageNode, w: number, h: number, effects: PhotoEffect[]) {
  const src = (n.assetId && getAsset(n.assetId)?.preview) || sampleImage();
  const scaled = effects.map((e) => EFFECTS[e.type].demo({ ...e, enabled: true }) as PhotoEffect);
  return renderStack({ ...n, fit: 'fill' }, w, h, src, 2, scaled);
}

function Bitmap({ source, className }: { source: HTMLCanvasElement; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d')!.drawImage(source, 0, 0);
  }, [source]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** Two versions of the same picture with a line sweeping between them. */
function Wipe({ from, to, labels, play }: { from: HTMLCanvasElement; to: HTMLCanvasElement; labels?: [string, string]; play: boolean }) {
  return (
    <div className={`wipe ${play ? 'play' : ''}`}>
      <Bitmap source={from} />
      <Bitmap source={to} className="wipe-to" />
      <i className="wipe-line" />
      {labels && (
        <>
          <span className="wipe-tag from">{labels[0]}</span>
          <span className="wipe-tag to">{labels[1]}</span>
        </>
      )}
    </div>
  );
}

// ---------- hover card ----------

interface Peek {
  y: number;
  x: number;
  title: string;
  body: string;
  from: HTMLCanvasElement;
  to: HTMLCanvasElement;
  labels: [string, string];
}

const CARD_W = 216;
const CARD_H = 144;

/** Hover or focus a setting to see what it does. Holding the mouse down hides it, so it never covers a drag. */
function usePeek() {
  const [peek, setPeek] = useState<Peek | null>(null);
  const timer = useRef(0);
  const warm = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hide = () => {
    clearTimeout(timer.current);
    setPeek(null);
    timer.current = window.setTimeout(() => (warm.current = false), 300);
  };
  const on = (make: () => Omit<Peek, 'x' | 'y'>) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (e.buttons) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = e.currentTarget.closest('.panel')?.getBoundingClientRect().left ?? r.left;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => {
          warm.current = true;
          setPeek({ ...make(), x: x - 8, y: r.top + r.height / 2 });
        },
        warm.current ? 0 : 250,
      );
    },
    onMouseLeave: hide,
    onMouseDown: hide,
  });
  return { peek, on };
}

function PeekCard({ peek }: { peek: Peek }) {
  return createPortal(
    <Floating x={peek.x} y={peek.y} anchor="center-right" margin={8} className="peek" zIndex={60}>
      <Wipe from={peek.from} to={peek.to} labels={peek.labels} play />
      <div className="peek-text">
        <strong>{peek.title}</strong>
        <span>{peek.body}</span>
      </div>
    </Floating>,
    document.body,
  );
}

// ---------- library ----------

const TILE_W = 132;
const TILE_H = 88;

function LookTile({ look, n, onPick, onHint }: { look: LibraryLook; n: ImageNode; onPick: () => void; onHint: (t: string | null) => void }) {
  const [hover, setHover] = useState(false);
  const after = useMemo(() => preview(n, TILE_W, TILE_H, [makeEffect(look.effect)]), [n.assetId, n.crop, n.adjust, look]);
  const before = useMemo(() => preview(n, TILE_W, TILE_H, []), [n.assetId, n.crop, n.adjust]);
  const enter = () => (setHover(true), onHint(look.blurb));
  const leave = () => (setHover(false), onHint(null));
  return (
    <button type="button" className="look" onClick={onPick} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
      <Wipe from={before} to={after} play={hover} />
      <span>{look.name}</span>
    </button>
  );
}

function Library({ at, n, onPick, onClose }: { at: { x: number; y: number }; n: ImageNode; onPick: (l: LibraryLook) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  const groups = [...new Set(EFFECT_LIBRARY.map((l) => l.group))];
  return createPortal(
    <Floating x={at.x} y={at.y} anchor="top-right" margin={8} interactive className="fx-library" zIndex={60}>
      <div ref={ref} role="dialog" aria-label="Add effect">
        <div className="fx-library-scroll">
          {groups.map((g) => (
            <section key={g}>
              <h3>{g}</h3>
              <div className="fx-library-grid">
                {EFFECT_LIBRARY.filter((l) => l.group === g).map((l) => (
                  <LookTile key={l.id} look={l} n={n} onPick={() => onPick(l)} onHint={setHint} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="fx-library-hint">{hint ?? 'Hover a look to see it on your photo.'}</div>
      </div>
    </Floating>,
    document.body,
  );
}

// ---------- settings ----------

function SettingRow({ s, e, n, set, on }: { s: Setting; e: any; n: ImageNode; set: (patch: Record<string, unknown>, key?: string) => void; on: ReturnType<typeof usePeek>['on'] }): ReactNode {
  const with_ = (patch: Record<string, unknown>) => [{ ...e, ...patch }] as PhotoEffect[];
  const shot = (effects: PhotoEffect[]) => preview(n, CARD_W, CARD_H, effects);
  if (s.when && !s.when(e)) return null;
  if (s.kind === 'choice') {
    return (
      <div className="segmented" role="group" aria-label={s.label}>
        {s.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={e[s.key] === o.value}
            className={e[s.key] === o.value ? 'on' : ''}
            onClick={() => set({ [s.key]: o.value })}
            {...on(() => ({ title: o.label, body: o.hint, from: shot([]), to: shot(with_({ [s.key]: o.value })), labels: ['Before', 'After'] }))}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (s.kind === 'slider') {
    const k = s.percent ? 100 : 1;
    return (
      <div {...on(() => ({ title: s.label, body: s.hint, from: shot(with_({ [s.key]: s.demo[0] })), to: shot(with_({ [s.key]: s.demo[1] })), labels: s.demoLabels }))}>
        <Slider
          label={s.label}
          value={Math.round(e[s.key] * k)}
          min={s.min * k}
          max={s.max * k}
          reset={Math.round((EFFECTS[e.type as PhotoEffect['type']].defaults[s.key] as number) * k)}
          onChange={(v, key) => set({ [s.key]: v / k }, key ?? `fx-${s.key}`)}
        />
      </div>
    );
  }
  const [a, b] = s.keys;
  return (
    <div className="fx-colors">
      {s.keys.map((key, i) => (
        <label key={key} className="fx-color">
          <span className="swatch" style={{ ['--c' as any]: e[key] }}>
            <input type="color" value={String(e[key]).slice(0, 7)} aria-label={s.names[i]} onChange={(ev) => set({ [key]: ev.target.value }, `fx-${key}`)} />
          </span>
          {s.names[i]}
        </label>
      ))}
      <IconButton className="small" title="Swap colors" onClick={() => set({ [a]: e[b], [b]: e[a] })}>
        <IconSwap size={D} />
      </IconButton>
    </div>
  );
}

function EffectRow({ e, i, n, open, onToggle, im, on }: { e: PhotoEffect; i: number; n: ImageNode; open: boolean; onToggle: () => void; im: Im; on: ReturnType<typeof usePeek>['on'] }) {
  const def = EFFECTS[e.type];
  const set = (patch: Record<string, unknown>, key?: string) =>
    im((node) => {
      const t = node.effects?.[i];
      if (t?.type === e.type) Object.assign(t, patch);
    }, key);
  const thumb = useMemo(() => preview(n, 28, 28, [e]), [n.assetId, n.crop, n.adjust, e]);
  return (
    <div className={`fx ${open ? 'open' : ''} ${e.enabled ? '' : 'off'}`}>
      <div className="fx-head">
        <button type="button" className="fx-title" aria-expanded={open} onClick={onToggle}>
          <Bitmap source={thumb} className="fx-thumb" />
          <span className="fx-name">{e.name ?? def.label}</span>
          <span className="fx-summary">{def.summary(e)}</span>
        </button>
        <IconButton className="small fx-eye" title={e.enabled ? 'Hide effect' : 'Show effect'} onClick={() => set({ enabled: !e.enabled })}>
          {e.enabled ? <IconEye size={D} /> : <IconEyeOff size={D} />}
        </IconButton>
        <IconButton className="small" title="Remove effect" onClick={() => im((node) => void node.effects?.splice(i, 1))}>
          <IconMinus size={D} />
        </IconButton>
      </div>
      {open && (
        <div className="fx-settings">
          {def.settings.map((s, k) => (
            <SettingRow key={k} s={s} e={e} n={n} set={set} on={on} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Effects on the selected photos. Empty until you add one from the library. */
export function EffectsSection({ sel, im }: { sel: ImageNode[]; im: Im }) {
  const n = sel[0];
  const effects = n.effects ?? [];
  const [library, setLibrary] = useState<{ x: number; y: number } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { peek, on } = usePeek();

  const add = (look: LibraryLook) => {
    const made = makeEffect({ ...look.effect, name: look.name });
    im((node) => void (node.effects = [...(node.effects ?? []), { ...made }]));
    setOpenId(made.id);
    setLibrary(null);
  };

  return (
    <Section
      title="Effects"
      actions={
        <IconButton
          className="small"
          title="Add effect"
          onClick={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect();
            const panel = ev.currentTarget.closest('.panel')?.getBoundingClientRect();
            setLibrary(library ? null : { x: (panel?.left ?? r.left) - 8, y: r.top - 8 });
          }}
        >
          <IconPlus size={D} />
        </IconButton>
      }
    >
      {effects.length > 0 && (
        <div className="fx-list">
          {effects.map((e, i) => (
            <EffectRow key={e.id} e={e} i={i} n={n} open={openId === e.id} onToggle={() => setOpenId(openId === e.id ? null : e.id)} im={im} on={on} />
          ))}
        </div>
      )}
      {library && <Library at={library} n={n} onPick={add} onClose={() => setLibrary(null)} />}
      {peek && <PeekCard peek={peek} />}
    </Section>
  );
}
