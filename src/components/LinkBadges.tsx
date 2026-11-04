import { useMemo } from 'react';
import { boardFrames, useStore } from '../store';
import { getLayout } from '../layout';
import { absoluteBoxes } from '../render';
import { LINK_ISSUE_TEXT, collectLinks, type LinkEntry } from '../links';
import { IconLink } from '../ui/icons';

// Link badges over the canvas: plain HTML above the Konva stage, like the comment pins, so they
// follow the view but never end up in an export. Red means the link needs attention.

/** Just past the layer's right edge, so a badge never sits on the text it marks. */
const GAP = 4;
/** Zoomed out further than this, badges would pile up over the layers they mark. The Links list still has them all. */
const MIN_ZOOM = 0.3;

export default function LinkBadges() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const fv = useStore((s) => s.fontsVersion);

  // The view changes every frame of a pan; where the layers sit doesn't.
  const badges = useMemo(() => {
    const frames = boardFrames(project);
    const out: { boardId: string; link: LinkEntry; x: number; y: number }[] = [];
    for (const b of project.boards) {
      const f = frames.get(b.id);
      if (b.kind !== 'email' || !f) continue;
      const boxes = absoluteBoxes(b.nodes, getLayout(b.nodes, fv));
      for (const link of collectLinks(b.nodes)) {
        const box = boxes.get(link.id);
        if (box) out.push({ boardId: b.id, link, x: f.x + box.x + box.w, y: f.y + box.y });
      }
    }
    return out;
  }, [project, fv]);

  const open = (boardId: string, id: string) => {
    const s = useStore.getState();
    if (s.project.activeBoardId !== boardId) s.setActiveBoard(boardId);
    useStore.getState().select([id]);
  };

  if (view.zoom < MIN_ZOOM) return null;

  return (
    <>
      {badges.map(({ boardId, link, x, y }) => (
        <button
          key={`${boardId}:${link.id}`}
          className={`link-badge ${link.issue ? 'warn' : ''}`}
          style={{ transform: `translate(${x * view.zoom + view.panX + GAP}px, ${y * view.zoom + view.panY}px)` }}
          title={link.issue ? `${link.name}: ${LINK_ISSUE_TEXT[link.issue]}` : link.url}
          onClick={() => open(boardId, link.id)}
        >
          <IconLink size={12} />
        </button>
      ))}
    </>
  );
}
