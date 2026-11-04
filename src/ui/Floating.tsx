/**
 * <Floating> — portal-positioned overlay pinned to a viewport point and kept inside a bounds rect.
 *
 * Use it for anything that floats over the canvas or panels and must never be clipped by an
 * `overflow: hidden` ancestor or pushed off-screen: the selection size badge, the crop HUD,
 * context menus, popovers.
 *
 *   <Floating x={cx} y={selBottom + 8} anchor="top-center" altY={selTop - 8}
 *             bounds={canvasEl} margin={8}>
 *     <div className="size-badge">1080 × 1350</div>
 *   </Floating>
 *
 * Props
 * - x, y        Viewport coordinates (clientX/clientY space). For canvas overlays convert from
 *               canvas-local coords by adding canvasEl.getBoundingClientRect().left/top.
 * - anchor      Which point OF THE FLOATING BOX sits on (x, y). Default 'top-left'.
 *                 'top-left' | 'top-center' | 'top-right'
 *                 'center-left' | 'center' | 'center-right'
 *                 'bottom-left' | 'bottom-center' | 'bottom-right'
 *               e.g. 'top-center' at (midX, bottom + 8) puts a badge centred under a selection;
 *               'bottom-center' at (midX, top - 8) puts a HUD centred above it.
 * - altY        Optional y to flip to when the box would overflow vertically at `y`. The anchor's
 *               vertical part is mirrored (top <-> bottom), so the box ends up on the other side of
 *               the subject instead of overlapping it after clamping.
 * - bounds      Rect to stay inside: a DOMRect-like {left, top, right, bottom}, an HTMLElement
 *               (its client rect is read on every layout) or 'window' (default).
 * - margin      Minimum distance from the bounds edges. Default 8.
 * - interactive false (default) = pointer-events: none, so it never steals canvas input.
 *               true = clickable (crop HUD, menus).
 * - zIndex      Default 50: above panels and canvas, below modals (100), context menus (150),
 *               toasts (200) and tooltips (1000). Pass more for overlays opened from a modal.
 * - className / style / any other div props (onMouseDown, onWheel, role, …) go to the box.
 *               Put existing overlay classes straight on <Floating className="size-badge">: the
 *               inline position: fixed + transform: none override their `position: absolute;
 *               transform: translateX(-50%)`, which the anchor now replaces.
 *
 * The box is measured with a layout effect (and a ResizeObserver for content changes), so it never
 * flashes at the wrong spot. Position is rounded to whole pixels for crisp text.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type FloatingAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface BoundsRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  x: number;
  y: number;
  anchor?: FloatingAnchor;
  altY?: number;
  bounds?: BoundsRect | HTMLElement | 'window' | null;
  margin?: number;
  interactive?: boolean;
  zIndex?: number;
  style?: CSSProperties;
  children?: ReactNode;
}

function readBounds(b: FloatingProps['bounds']): BoundsRect {
  if (!b || b === 'window') return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (b instanceof HTMLElement) {
    const r = b.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return b;
}

function factors(anchor: FloatingAnchor): [number, number] {
  const [v, h = 'center'] = anchor === 'center' ? ['center', 'center'] : anchor.split('-');
  const fx = h === 'left' ? 0 : h === 'right' ? 1 : 0.5;
  const fy = v === 'top' ? 0 : v === 'bottom' ? 1 : 0.5;
  return [fx, fy];
}

/**
 * Pure placement math, exported for callers that position things themselves.
 * Returns the top-left corner for a w×h box.
 */
export function placeFloating(
  x: number,
  y: number,
  w: number,
  h: number,
  anchor: FloatingAnchor = 'top-left',
  bounds: BoundsRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  margin = 8,
  altY?: number,
): { left: number; top: number; flipped: boolean } {
  const [fx, fy] = factors(anchor);
  let left = x - w * fx;
  let top = y - h * fy;
  let flipped = false;
  const minY = bounds.top + margin;
  const maxY = bounds.bottom - margin - h;
  if (altY !== undefined && (top < minY || top > maxY)) {
    const t2 = altY - h * (1 - fy);
    if (t2 >= minY && t2 <= maxY) {
      top = t2;
      flipped = true;
    }
  }
  const minX = bounds.left + margin;
  const maxX = bounds.right - margin - w;
  left = maxX < minX ? minX : Math.min(Math.max(left, minX), maxX);
  top = maxY < minY ? minY : Math.min(Math.max(top, minY), maxY);
  return { left: Math.round(left), top: Math.round(top), flipped };
}

export function Floating({
  x,
  y,
  anchor = 'top-left',
  altY,
  bounds = 'window',
  margin = 8,
  interactive = false,
  zIndex = 50,
  className = '',
  style,
  children,
  ...rest
}: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [, bump] = useState(0);

  // Measure synchronously before paint, and again whenever the content resizes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onResize = () => bump((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const pos = size ? placeFloating(x, y, size.w, size.h, anchor, readBounds(bounds), margin, altY) : null;

  return createPortal(
    <div
      ref={ref}
      {...rest}
      className={`floating ${className}`}
      data-flipped={pos?.flipped || undefined}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? undefined : 'hidden',
        pointerEvents: interactive ? 'auto' : 'none',
        zIndex,
        transform: 'none',
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
