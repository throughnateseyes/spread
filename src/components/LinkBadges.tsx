import { useMemo } from 'react';
import { boardFrames, useStore, type BoardFrame } from '../store';
import { getLayout } from '../layout';
import { absoluteBoxes } from '../render';
import { nextToFix, type LinkItem } from '../email/linkmap';
import type { Doc } from '../types';
import { IconImage, IconLink } from '../ui/icons';
import { closeLinkItem, itemClass, ItemEditor, openLinkItem, pictureClass, revealLinkItem, useLinkItems } from './LinkEditor';

// Link and picture pills over email boards: plain HTML above the Konva stage, like the comment pins,
// so they follow the view but never end up in an export.
//
// Normally only what needs fixing shows (red). Links mode (L) dims the design, outlines everything
// that links or needs hosting, and shows every pill: green done, red to fix, dashed "looks like it
// should link". Clicking a pill opens a small editor; Enter saves and moves to the next one to fix.

/** Zoomed out further than this, pills would pile up. The Links panel still has them all. */
const MIN_ZOOM = 0.2;
const PILL_H = 18;

export default function LinkBadges() {
  const project = useStore((s) => s.project);
  const zoom = useStore((s) => s.view.zoom);
  const frames = boardFrames(project);
  if (zoom < MIN_ZOOM) return null;
  return (
    <>
      {project.boards.map((b) => {
        const f = frames.get(b.id);
        return b.kind === 'email' && f ? <BoardPills key={b.id} board={b} frame={f} /> : null;
      })}
    </>
  );
}

interface Placed {
  item: LinkItem;
  /** The layer's box in screen px. */
  box: { x: number; y: number; w: number; h: number };
  /** The pill's top-left in screen px. */
  px: number;
  py: number;
  w: number;
}

function BoardPills({ board, frame }: { board: Doc; frame: BoardFrame }) {
  const view = useStore((s) => s.view);
  const fv = useStore((s) => s.fontsVersion);
  const linksMode = useStore((s) => s.linksMode);
  const edit = useStore((s) => s.linkEdit);
  const items = useLinkItems(board);

  // Where the layers sit doesn't change while panning; only the screen transform does.
  const boxes = useMemo(() => absoluteBoxes(board.nodes, getLayout(board.nodes, fv)), [board.nodes, fv]);

  const shown = items.filter((i) => linksMode || i.fix || edit?.id === i.id);
  const placed: Placed[] = [];
  for (const item of shown) {
    const b = boxes.get(item.id);
    if (!b) continue;
    const box = { x: (frame.x + b.x) * view.zoom + view.panX, y: (frame.y + b.y) * view.zoom + view.panY, w: b.w * view.zoom, h: b.h * view.zoom };
    const w = 10 + 16 * ((item.pictures.length ? 1 : 0) + (item.link || item.suggested ? 1 : 0));
    // Straddle the layer's top-right corner. When small links sit close together (a footer row),
    // try the other corners of the same layer before giving up and overlapping.
    const right = box.x + box.w - w + 4;
    const left = box.x - 4;
    const top = box.y - PILL_H / 2;
    const bottom = box.y + box.h - PILL_H / 2;
    const free = (x: number, y: number) => !placed.some((p) => x < p.px + p.w + 2 && x + w + 2 > p.px && y < p.py + PILL_H + 1 && y + PILL_H + 1 > p.py);
    const spots: [number, number][] = [[right, top], [right, bottom], [left, top], [left, bottom], [box.x + box.w + 2, box.y + box.h / 2 - PILL_H / 2]];
    const [px, py] = spots.find(([x, y]) => free(x, y)) ?? spots[0];
    placed.push({ item, box, px, py, w });
  }

  const editing = edit?.boardId === board.id && edit.from === 'canvas' ? placed.find((p) => p.item.id === edit.id) : undefined;
  const fx = frame.x * view.zoom + view.panX;
  const fy = frame.y * view.zoom + view.panY;

  const goNext = (id: string) => {
    const next = nextToFix(items, id);
    if (!next) return closeLinkItem();
    openLinkItem(board.id, next.id, 'canvas');
    revealLinkItem(board.id, next.id, true);
  };

  return (
    <>
      {linksMode && <div className="lk-dim" style={{ transform: `translate(${fx}px, ${fy}px)`, width: frame.w * view.zoom, height: frame.h * view.zoom }} />}
      {placed
        .filter(({ item }) => linksMode || item.id === edit?.id)
        .map(({ item, box }) => (
          <div
            key={`z-${item.id}`}
            className={`lk-zone ${itemClass(item)} ${edit?.id === item.id ? 'on' : ''}`}
            style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }}
          />
        ))}
      {placed.map(({ item, px, py }) => (
        <button
          key={item.id}
          className={`lk-pill ${itemClass(item)} ${edit?.id === item.id ? 'on' : ''}`}
          style={{ transform: `translate(${px}px, ${py}px)` }}
          title={`${item.name}: ${item.status}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => (edit?.id === item.id && edit.from === 'canvas' ? closeLinkItem() : openLinkItem(board.id, item.id, 'canvas'))}
        >
          {item.pictures.length > 0 && (
            <span className={pictureClass(item) === 'bad' ? 'bad' : ''}>
              <IconImage size={11} />
            </span>
          )}
          {(item.link || item.suggested) && (
            <span className={item.link?.issue ? 'bad' : ''}>
              <IconLink size={11} />
            </span>
          )}
        </button>
      ))}
      {editing && (
        <div
          className="lk-pop"
          data-own-wheel
          // Below the layer, clear of the selection's size label; above it when that would run under the dock.
          style={{
            transform:
              editing.box.y + editing.box.h + 30 + 190 > (document.querySelector('.canvas-wrap')?.clientHeight ?? Infinity) - 70
                ? `translate(${Math.max(8, editing.box.x + editing.box.w - 280)}px, ${editing.py - 6}px) translateY(-100%)`
                : `translate(${Math.max(8, editing.box.x + editing.box.w - 280)}px, ${editing.box.y + editing.box.h + 30}px)`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="lk-pop-head">
            <b className="ellipsis">{editing.item.name}</b>
            <span className="muted">{editing.item.section}</span>
          </div>
          <ItemEditor key={editing.item.id} board={board} item={editing.item} onNext={() => goNext(editing.item.id)} onClose={closeLinkItem} />
          <p className="lk-pop-foot">Enter saves and goes to the next one · Esc closes</p>
        </div>
      )}
    </>
  );
}
