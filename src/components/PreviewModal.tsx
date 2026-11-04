import { useEffect, useRef, useState } from 'react';
import { IconButton, Segmented } from '../ui/controls';
import { IconBookmark, IconChevronLeft, IconChevronRight, IconClose, IconComment, IconHeart, IconMore, IconShare } from '../ui/icons';
import { renderPreviews } from '../exporter';
import { useStore } from '../store';
import './io.css';

const PHONE_W = 390;

export default function PreviewModal() {
  const doc = useStore((s) => s.doc);
  const close = () => useStore.getState().set({ modal: null });
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<'post' | 'grid'>('post');
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; id: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let made: string[] = [];
    renderPreviews(0.5)
      .then((u) => {
        made = u;
        if (alive) setUrls(u);
        else u.forEach((x) => URL.revokeObjectURL(x));
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
      made.forEach((x) => URL.revokeObjectURL(x));
    };
  }, []);

  const count = urls?.length ?? doc.slides.length;
  const goTo = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const n = Math.max(0, Math.min(count - 1, i));
    el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' });
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(index + (e.key === 'ArrowRight' ? 1 : -1));
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  const onScroll = () => {
    const el = scroller.current;
    if (el) setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  // Mouse drag-to-swipe (trackpads and touch already scroll natively).
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !scroller.current) return;
    drag.current = { x: e.clientX, left: scroller.current.scrollLeft, id: e.pointerId };
    scroller.current.setPointerCapture(e.pointerId);
    scroller.current.classList.add('dragging');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !scroller.current) return;
    scroller.current.scrollLeft = d.left - (e.clientX - d.x);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = scroller.current;
    if (!d || !el) return;
    drag.current = null;
    el.releasePointerCapture(d.id);
    el.classList.remove('dragging');
    const moved = e.clientX - d.x;
    const start = Math.round(d.left / el.clientWidth);
    const target = Math.abs(moved) > el.clientWidth * 0.15 ? start + (moved < 0 ? 1 : -1) : start;
    goTo(target);
  };

  const mediaH = Math.round((PHONE_W * doc.slideHeight) / doc.slideWidth);

  return (
    <div className="modal-backdrop preview-backdrop" data-theme="dark" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="preview-top">
        <Segmented
          value={mode}
          options={[
            { value: 'post', label: 'Post' },
            { value: 'grid', label: 'Profile grid' },
          ]}
          onChange={setMode}
          className="preview-mode"
        />
        <IconButton title="Close" shortcut="Esc" onClick={close}>
          <IconClose />
        </IconButton>
      </div>

      {error && <div className="preview-msg">Couldn't render preview: {error}</div>}
      {!error && !urls && (
        <div className="preview-msg">
          <span className="preview-spinner" /> Rendering preview…
        </div>
      )}

      {urls && mode === 'post' && (
        <div className="phone" style={{ width: PHONE_W }}>
          <div className="ig-head">
            <span className="ig-avatar" />
            <span className="ig-user">your_account</span>
            <IconMore size={20} weight="bold" className="ig-more" />
          </div>
          <div className="ig-media" style={{ height: mediaH }}>
            <div
              ref={scroller}
              className="ig-scroller"
              onScroll={onScroll}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {urls.map((u, i) => (
                <img key={i} src={u} draggable={false} alt={`Slide ${i + 1}`} style={{ width: PHONE_W, height: mediaH }} />
              ))}
            </div>
            {count > 1 && <div className="ig-counter">{index + 1}/{count}</div>}
            {index > 0 && (
              <button className="ig-chev left" onClick={() => goTo(index - 1)} aria-label="Previous slide">
                <IconChevronLeft size={16} weight="bold" />
              </button>
            )}
            {index < count - 1 && (
              <button className="ig-chev right" onClick={() => goTo(index + 1)} aria-label="Next slide">
                <IconChevronRight size={16} weight="bold" />
              </button>
            )}
          </div>
          <div className="ig-actions">
            <IconHeart size={24} />
            <IconComment size={24} />
            <IconShare size={24} />
            <div className="ig-dots">
              {urls.map((_, i) => (
                <span key={i} className={i === index ? 'on' : ''} />
              ))}
            </div>
            <IconBookmark size={24} />
          </div>
          <div className="ig-caption">
            <b>your_account</b> Caption goes here…
            <div className="ig-muted">View all comments</div>
          </div>
        </div>
      )}

      {urls && mode === 'grid' && (
        <div className="phone grid-phone" style={{ width: PHONE_W }}>
          <div className="ig-profile">
            <span className="ig-avatar big" />
            <div>
              <div className="ig-user">your_account</div>
              <div className="ig-muted">How the first slide crops on your profile (3:4)</div>
            </div>
          </div>
          <div className="ig-grid">
            <div className="ig-cell">
              <img src={urls[0]} alt="First slide" draggable={false} />
            </div>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="ig-cell placeholder" />
            ))}
          </div>
        </div>
      )}

      {urls && mode === 'post' && <div className="preview-hint">Swipe, drag or use ← → to check every seam.</div>}
    </div>
  );
}
