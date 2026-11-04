/**
 * Figma-style tooltip.
 *
 *   <Tooltip label="Frame" shortcut="F" side="bottom">
 *     <button aria-label="Frame">…</button>
 *   </Tooltip>
 *
 * - Dark #1e1e1e bubble, 11px label, optional muted shortcut ("Frame   F").
 * - Appears after 500ms of hover. Once one tooltip has shown, neighbours show instantly until
 *   800ms after the last one hid (warm-up / cool-down, like Figma's toolbar).
 * - Hides on pointerdown anywhere, on scroll/wheel, on window blur and on Escape. After a click it
 *   stays hidden until the pointer leaves and re-enters the trigger.
 * - Also shows on keyboard focus (:focus-visible), never on mouse focus.
 * - Rendered through a portal into document.body with position: fixed, flipped to the opposite
 *   side when there is no room and clamped 8px inside the window, so panels and overflow:hidden
 *   containers never clip it.
 *
 * The single child must be an element that accepts a ref and pointer/focus handlers (a DOM element
 * or a forwardRef component). Its own handlers and ref are preserved.
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** Tooltip text. Falsy = no tooltip (the child renders untouched). Newlines are kept. */
  label?: ReactNode;
  /** Keyboard shortcut shown muted after the label, e.g. "F" or "Ctrl+Shift+E". */
  shortcut?: string;
  /** Preferred side; flips automatically when there is no room. Default "bottom". */
  side?: TooltipSide;
  /** Hover delay when no tooltip is warm. Default 500ms. */
  delay?: number;
  /** Suppress the tooltip (e.g. while a menu opened by the same button is showing). */
  disabled?: boolean;
  children: ReactElement;
}

const MARGIN = 8; // min distance from window edges
const GAP = 6; // distance from trigger
const COOLDOWN = 800;

// Shared warm-up state across every tooltip instance.
let openCount = 0;
let lastHiddenAt = -Infinity;
const isWarm = () => openCount > 0 || performance.now() - lastHiddenAt < COOLDOWN;

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: T | null }).current = value;
}

export function Tooltip({ label, shortcut, side = 'bottom', delay = 500, disabled, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);
  const suppressed = useRef(false); // set by a click until the pointer leaves
  const id = useId();
  const active = !!label && !disabled;

  const clear = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const openRef = useRef(false);
  const hide = useCallback(() => {
    clear();
    if (!openRef.current) return;
    openRef.current = false;
    openCount = Math.max(0, openCount - 1);
    lastHiddenAt = performance.now();
    setOpen(false);
  }, []);

  const show = useCallback(() => {
    timer.current = null;
    if (openRef.current) return;
    openRef.current = true;
    openCount++;
    setOpen(true);
  }, []);

  const schedule = () => {
    if (!active || suppressed.current) return;
    clear();
    if (isWarm()) {
      setInstant(true);
      show();
    } else {
      setInstant(false);
      timer.current = window.setTimeout(show, delay);
    }
  };

  // Global dismissal while open (or pending).
  useEffect(() => {
    if (!open) return;
    const onDown = () => {
      suppressed.current = true;
      hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, hide]);

  // Close when disabled / label removed, and on unmount.
  useEffect(() => {
    if (!active) hide();
  }, [active, hide]);
  useEffect(() => () => hide(), [hide]);

  if (!isValidElement(children)) return children ?? null;
  if (!label) return children;

  const props = children.props as Record<string, any>;
  // React 19 passes ref as a prop; fall back to the legacy element.ref for older element shapes.
  const childRef: Ref<HTMLElement> | undefined = props.ref ?? (children as any).ref;

  const chain =
    <E,>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) =>
    (e: E) => {
      theirs?.(e);
      ours(e);
    };

  const trigger = cloneElement(children as ReactElement<any>, {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
      setRef(childRef, el);
      // Trigger swapped out or removed while open. React re-attaches inline refs (null, then the
      // element) within one commit, so only a ref still null a microtask later means it is gone.
      if (!el) queueMicrotask(() => !triggerRef.current && hide());
    },
    onPointerEnter: chain(props.onPointerEnter, (e: React.PointerEvent) => {
      if (e.pointerType === 'touch') return;
      schedule();
    }),
    onPointerLeave: chain(props.onPointerLeave, () => {
      suppressed.current = false;
      hide();
    }),
    onPointerDown: chain(props.onPointerDown, () => {
      suppressed.current = true;
      hide();
    }),
    onFocus: chain(props.onFocus, (e: React.FocusEvent<HTMLElement>) => {
      let kb = false;
      try {
        kb = e.currentTarget.matches(':focus-visible');
      } catch {
        kb = false;
      }
      if (kb && !suppressed.current) {
        setInstant(true);
        show();
      }
    }),
    onBlur: chain(props.onBlur, () => hide()),
    'aria-describedby': open ? [props['aria-describedby'], id].filter(Boolean).join(' ') : props['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {open && active && <TooltipBubble id={id} anchor={triggerRef.current} label={label} shortcut={shortcut} side={side} instant={instant} />}
    </>
  );
}

const OPPOSITE: Record<TooltipSide, TooltipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** Computes a fixed-position box for a bubble of size w×h next to rect r, flipping and clamping into the window. */
export function placeBeside(r: DOMRect, w: number, h: number, side: TooltipSide, gap = GAP, margin = MARGIN) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits = (s: TooltipSide) =>
    s === 'top' ? r.top - gap - h >= margin : s === 'bottom' ? r.bottom + gap + h <= vh - margin : s === 'left' ? r.left - gap - w >= margin : r.right + gap + w <= vw - margin;
  const s = fits(side) || !fits(OPPOSITE[side]) ? side : OPPOSITE[side];
  let x: number;
  let y: number;
  if (s === 'top' || s === 'bottom') {
    x = r.left + r.width / 2 - w / 2;
    y = s === 'top' ? r.top - gap - h : r.bottom + gap;
  } else {
    y = r.top + r.height / 2 - h / 2;
    x = s === 'left' ? r.left - gap - w : r.right + gap;
  }
  x = Math.min(Math.max(margin, x), Math.max(margin, vw - margin - w));
  y = Math.min(Math.max(margin, y), Math.max(margin, vh - margin - h));
  return { x: Math.round(x), y: Math.round(y), side: s };
}

function TooltipBubble({
  id,
  anchor,
  label,
  shortcut,
  side,
  instant,
}: {
  id: string;
  anchor: HTMLElement | null;
  label: ReactNode;
  shortcut?: string;
  side: TooltipSide;
  instant: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; side: TooltipSide } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    setPos(placeBeside(r, el.offsetWidth, el.offsetHeight, side));
  }, [anchor, side, label, shortcut]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`tooltip ${instant ? 'instant' : ''} ${pos ? 'placed side-' + pos.side : ''}`}
      style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span className="tooltip-label">{label}</span>
      {shortcut && <span className="tooltip-kbd">{shortcut}</span>}
    </div>,
    document.body,
  );
}
