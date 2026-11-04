import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Floating } from './Floating';
import { IconCheck } from './icons';

// One dropdown menu for the app: the Spread menu, the zoom menu, the shape picker and the row ⋯
// menu. Styled like the canvas right-click menu (.ctx-menu). Closes on Escape, a click outside,
// window blur or a wheel.

export type MenuItem = null | {
  label: string;
  kbd?: string;
  fn: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Shows a check in the left gutter when true; any item with `checked` set gives the menu a gutter. */
  checked?: boolean;
};

export function Menu({ at, items, onClose, className = '' }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const gutter = items.some((it) => it && it.checked !== undefined);
  return (
    <Floating x={at.x} y={at.y} anchor="top-left" interactive zIndex={150} margin={8}>
      <div className={`ctx-menu ${gutter ? 'has-checks' : ''} ${className}`} role="menu" style={{ position: 'static' }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it, i) =>
          it ? (
            <button
              key={i}
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked}
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                it.fn();
                onClose();
              }}
            >
              <span className="menu-label">
                {gutter && <span className="menu-check">{it.checked && <IconCheck size={12} weight="bold" />}</span>}
                {it.label}
              </span>
              {it.kbd && <span className="kbd">{it.kbd}</span>}
            </button>
          ) : (
            <hr key={i} />
          ),
        )}
      </div>
    </Floating>
  );
}

/** Open / close state for a menu dropped from a trigger button (opens under its bottom-left corner). */
export function useMenuButton() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const toggle = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }));
  }, []);
  // The trigger swallows its own mousedown so the menu's outside-click close doesn't race the toggle.
  const triggerProps = { onMouseDown: (e: ReactMouseEvent) => e.stopPropagation(), onClick: toggle, 'aria-haspopup': 'menu' as const, 'aria-expanded': !!at };
  return { at, close, triggerProps };
}
