import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Tooltip, type TooltipSide } from './Tooltip';
import { IconChevronDown, IconClose } from './icons';

// Small Figma-style form controls shared by every panel. Styling lives in styles.css.
//
// Keyboard contract for every text-like field: Enter commits (and leaves the field), Escape
// reverts (and leaves the field without letting the Escape reach global shortcuts or modals),
// Tab / Shift+Tab move between fields (blur commits).

export function Section({
  title,
  actions,
  children,
  className = '',
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`section ${children ? '' : 'collapsed'} ${className}`}>
      <div className="section-head">
        <span className="section-title">{title}</span>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children && <div className="section-body">{children}</div>}
    </div>
  );
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`row ${className}`}>{children}</div>;
}

/** Centered placeholder for empty panels / lists. */
export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {children && <div className="empty-state-text">{children}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}

/** Evaluates simple arithmetic typed into a number field ("1080/2", "24*3", "10+4"). */
function evalNumber(raw: string): number {
  const s = raw.trim().replace(/,/g, '.').replace(/[a-z%°]+$/i, '').trim();
  if (!s) return NaN;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  if (!/^[\d+\-*/(). ]+$/.test(s)) return NaN;
  try {
    const v = Function(`"use strict";return (${s})`)();
    return typeof v === 'number' ? v : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Numeric input with a scrubbable label (drag the label left/right like Figma; click it to edit).
 * `onChange(value, key)` — key is stable during a scrub so the store can coalesce undo.
 * Scrub: 1 step per pixel, Shift ×10, Alt ×0.1. Arrow keys: ±step, Shift ×10.
 * `label` can be text ("X", "W") or a small icon; `title` names the field (tooltip + aria-label).
 */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  title,
  precision = 2,
  mixedLabel = 'Mixed',
  className = '',
}: {
  label?: ReactNode;
  value: number | 'mixed';
  onChange: (v: number, key?: string) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  title?: string;
  precision?: number;
  /** Placeholder shown when the value is 'mixed' (e.g. "Auto" for space-between gap). */
  mixedLabel?: string;
  className?: string;
}) {
  const round = (v: number) => Math.round(v * 10 ** precision) / 10 ** precision;
  const fmt = (v: number | 'mixed') => (v === 'mixed' ? '' : String(round(v)));
  const [text, setText] = useState(fmt(value));
  const textRef = useRef(text);
  textRef.current = text;
  const focused = useRef(false);
  const skipCommit = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    if (!focused.current) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, precision]);

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  const commit = () => {
    const raw = textRef.current.trim();
    if (!raw) return setText(fmt(value));
    const v = evalNumber(raw);
    if (Number.isFinite(v)) {
      const c = round(clamp(v));
      if (value === 'mixed' || c !== round(value)) onChange(c);
      setText(fmt(c));
    } else setText(fmt(value));
  };

  const onLabelPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    let lastX = e.clientX;
    let started = false;
    let v = value === 'mixed' ? NaN : value;
    const key = 'scrub-' + Math.random().toString(36).slice(2);
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (Number.isNaN(v)) return;
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 3) return;
        started = true;
        lastX = ev.clientX;
        setScrubbing(true);
        document.body.classList.add('is-scrubbing');
        inputRef.current?.blur();
        return;
      }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      v = clamp(v + (ev.clientX - lastX) * step * mult);
      lastX = ev.clientX;
      onChange(round(v), key);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-scrubbing');
      setScrubbing(false);
      if (!started) {
        // A plain click on the label focuses the field, like Figma.
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const labelEl =
    label !== undefined ? (
      <span
        className={`field-label scrub ${typeof label === 'string' && label.length > 2 ? 'wide' : ''}`}
        onPointerDown={onLabelPointerDown}
        // Stop the surrounding <label> from focusing the input after a scrub; plain clicks focus it in `up`.
        onClick={(e) => e.preventDefault()}
      >
        {label}
      </span>
    ) : null;

  return (
    <label className={`field num ${scrubbing ? 'scrubbing' : ''} ${className}`}>
      {labelEl && title ? (
        <Tooltip label={title} side="top">
          {labelEl}
        </Tooltip>
      ) : (
        labelEl
      )}
      <input
        ref={inputRef}
        value={text}
        placeholder={value === 'mixed' ? mixedLabel : undefined}
        inputMode="decimal"
        spellCheck={false}
        aria-label={title ?? (typeof label === 'string' ? label : undefined)}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          if (skipCommit.current) {
            skipCommit.current = false;
            setText(fmt(value));
            return;
          }
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            skipCommit.current = true;
            e.currentTarget.blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== 'mixed') {
            e.preventDefault();
            const base = evalNumber(textRef.current);
            const from = Number.isFinite(base) ? base : value;
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = round(clamp(from + d));
            onChange(v, 'arrow');
            setText(fmt(v));
          }
        }}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </label>
  );
}

// ---------- colour ----------

/** Splits #RGB / #RRGGBB / #RRGGBBAA / rgb[a]() into { hex: '#RRGGBB', alpha: 0..1 }. */
export function parseColor(c: string): { hex: string; alpha: number } {
  let s = (c || '#000000').trim();
  if (s.startsWith('rgb')) {
    const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
    const h = '#' + m.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return { hex: h.toUpperCase(), alpha: m[3] ?? 1 };
  }
  if (!s.startsWith('#')) s = '#' + s;
  if (s.length === 4 || s.length === 5) s = '#' + [...s.slice(1)].map((ch) => ch + ch).join('');
  const hex = s.slice(0, 7).toUpperCase();
  const alpha = s.length === 9 ? parseInt(s.slice(7, 9), 16) / 255 : 1;
  return { hex, alpha: Number.isFinite(alpha) ? alpha : 1 };
}

export function toColor(hex: string, alpha: number) {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return a >= 255 ? hex.toUpperCase() : hex.toUpperCase() + a.toString(16).padStart(2, '0').toUpperCase();
}

/** Named colors offered on every color field below it (the project's brand palette). */
export const SwatchContext = createContext<{ name: string; hex: string }[]>([]);

export function ColorField({ value, onChange, label }: { value: string; onChange: (c: string, key?: string) => void; label?: ReactNode }) {
  const { hex, alpha } = parseColor(value);
  const swatches = useContext(SwatchContext);
  const [pop, setPop] = useState<null | { x: number; y: number }>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const off = (e: MouseEvent) => !popRef.current?.contains(e.target as Node) && setPop(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), setPop(null));
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', off);
      window.removeEventListener('keydown', esc, true);
    };
  }, [pop]);
  const [text, setText] = useState(hex.slice(1));
  const textRef = useRef(text);
  textRef.current = text;
  const skipCommit = useRef(false);
  useEffect(() => setText(hex.slice(1)), [hex]);
  const keyRef = useRef('color-' + Math.random());
  const commit = () => {
    const t = textRef.current.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t)) {
      const next = toColor(parseColor('#' + t).hex, alpha);
      if (next !== toColor(hex, alpha)) onChange(next);
      setText(parseColor('#' + t).hex.slice(1));
    } else if (/^[0-9a-f]{8}$/i.test(t)) {
      const p = parseColor('#' + t);
      onChange(toColor(p.hex, p.alpha));
    } else setText(hex.slice(1));
  };
  return (
    <div className="field color">
      {label && <span className="field-label wide">{label}</span>}
      <span className="swatch" style={{ ['--c' as any]: value }}>
        <input type="color" value={hex} aria-label="Pick colour" onChange={(e) => onChange(toColor(e.target.value, alpha), keyRef.current)} />
      </span>
      <input
        className="hex"
        value={text}
        spellCheck={false}
        aria-label="Hex colour"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (skipCommit.current) {
            skipCommit.current = false;
            setText(hex.slice(1));
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            skipCommit.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <NumberField className="alpha" title="Opacity" value={Math.round(alpha * 100)} min={0} max={100} suffix="%" precision={0} onChange={(v, k) => onChange(toColor(hex, v / 100), k)} />
      {swatches.length > 0 && (
        <Tooltip label="Brand colors" disabled={!!pop}>
          <button
            type="button"
            className={`swatch-menu ${pop ? 'open' : ''}`}
            aria-label="Brand colors"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPop(pop ? null : { x: r.right, y: r.bottom + 4 });
            }}
          >
            {swatches.slice(0, 3).map((c, i) => (
              <i key={i} style={{ background: c.hex }} />
            ))}
          </button>
        </Tooltip>
      )}
      {pop && (
        <div className="swatch-pop" ref={popRef} style={{ left: pop.x, top: pop.y }} role="listbox" aria-label="Brand colors">
          {swatches.map((c) => (
            <button
              key={c.name + c.hex}
              type="button"
              role="option"
              aria-selected={c.hex.toUpperCase() === hex.toUpperCase()}
              className={c.hex.toUpperCase() === hex.toUpperCase() ? 'on' : ''}
              onClick={() => {
                onChange(toColor(c.hex.toLowerCase(), alpha));
                setPop(null);
              }}
            >
              <i style={{ background: c.hex }} />
              <span>{c.name}</span>
              <span className="muted">{c.hex}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Label + range + number, Figma-style. Double-click the range to reset to `reset`. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  reset,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number, key?: string) => void;
  suffix?: string;
  /** Value restored on double-click (defaults to 0 when in range, else min). */
  reset?: number;
}) {
  const [key] = useState(() => 'slider-' + Math.random());
  // One drag is one undo step, however long it's held. Arrow keys still merge by time.
  const drag = useRef<string | null>(null);
  const fill = `${((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100}%`;
  const resetTo = reset ?? (min <= 0 && max >= 0 ? 0 : min);
  return (
    <div className="slider-row">
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={typeof label === 'string' ? label : undefined}
        style={{ ['--fill' as any]: fill }}
        onPointerDown={() => (drag.current = 'g:slider-' + Math.random())}
        onKeyDown={() => (drag.current = null)}
        onChange={(e) => onChange(Number(e.target.value), drag.current ?? key)}
        onDoubleClick={() => onChange(resetTo)}
      />
      <NumberField className="slider-num" value={value} min={min} max={max} step={step} suffix={suffix} precision={2} title={typeof label === 'string' ? label : undefined} onChange={onChange} />
    </div>
  );
}

// ---------- choice controls ----------

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = '',
  title,
}: {
  value: T;
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  className?: string;
  title?: string;
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  const render = (o: { value: T; label: string }) => (
    <option key={String(o.value)} value={String(o.value)}>
      {o.label}
    </option>
  );
  return (
    <Tooltip label={title} side="top">
      <span className={`select-wrap ${className}`}>
        <select
          className="select"
          aria-label={title}
          value={String(value)}
          onChange={(e) => {
            const o = options.find((x) => String(x.value) === e.target.value);
            if (o) onChange(o.value);
          }}
        >
          {groups.length > 1
            ? groups.map((g) => (
                <optgroup key={g} label={g}>
                  {options.filter((o) => (o.group ?? '') === g).map(render)}
                </optgroup>
              ))
            : options.map(render)}
        </select>
        <IconChevronDown size={10} weight="bold" className="select-caret" />
      </span>
    </Tooltip>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T | null;
  options: { value: T; label: ReactNode; title?: string; shortcut?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`} role="group">
      {options.map((o) => (
        <Tooltip key={o.value} label={o.title} shortcut={o.shortcut} side="top">
          <button
            type="button"
            aria-label={typeof o.label === 'string' ? undefined : o.title}
            aria-pressed={o.value === value}
            className={o.value === value ? 'on' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  title,
  shortcut,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  /** Optional tooltip. */
  title?: string;
  shortcut?: string;
}) {
  return (
    <Tooltip label={title} shortcut={shortcut} side="top">
      <label className="toggle">
        <input type="checkbox" role="switch" aria-label={typeof label === 'string' ? undefined : title} checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-track" />
        {label && <span className="toggle-label">{label}</span>}
      </label>
    </Tooltip>
  );
}

export function IconButton({
  title,
  shortcut,
  side = 'bottom',
  active,
  onClick,
  children,
  disabled,
  className = '',
}: {
  /** Tooltip text and aria-label. */
  title: string;
  /** Shown muted in the tooltip, e.g. "F" or "Ctrl+Z". */
  shortcut?: string;
  side?: TooltipSide;
  active?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip label={title} shortcut={shortcut} side={side}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active === undefined ? undefined : active}
        className={`icon-btn ${active ? 'on' : ''} ${className}`}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  title,
  shortcut,
  side = 'bottom',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Optional tooltip. */
  title?: string;
  shortcut?: string;
  side?: TooltipSide;
  className?: string;
}) {
  return (
    <Tooltip label={title} shortcut={shortcut} side={side}>
      <button type="button" className={`btn ${primary ? 'primary' : ''} ${className}`} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    </Tooltip>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Optional sticky footer (actions). */
  footer?: ReactNode;
  width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // Move focus into the dialog (so global canvas shortcuts don't fire) and restore it on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" tabIndex={-1} ref={box}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <IconButton title="Close" shortcut="Esc" className="small" onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
