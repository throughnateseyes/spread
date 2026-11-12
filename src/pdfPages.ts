// Splitting a tall board (an email) across fixed-size pages without cutting through a line of text.
// Pure on purpose (no DOM, no store) so it can be checked with plain node.

/** US Letter in points, and the white margin around the email on each page. */
export const LETTER = { w: 612, h: 792, margin: 36 } as const;

/**
 * Something a page break should stay out of, in board units: 1 = a line of text (always kept
 * whole when possible), 2 = a picture, button or other small piece, 3 = a whole section.
 */
export interface KeepTogether {
  top: number;
  bottom: number;
  level: 1 | 2 | 3;
}

/**
 * How full a page must still be when the break moves up to keep something whole. Keeping a section
 * together is only worth losing a quarter of a page; a line of text is worth almost any amount.
 */
const MIN_FILL: Record<KeepTogether['level'], number> = { 3: 0.75, 2: 0.5, 1: 0.05 };

/**
 * Where each page starts and ends, as [start, end) ranges in board units covering 0..total. Each
 * page holds at most `pageH`. The break goes at the page bottom unless that cuts through something
 * in `keep`; then it moves up to the top of it. It first tries to keep everything whole (sections,
 * pictures and lines), then pictures and lines, then lines only, each while the page stays full
 * enough, and only cuts straight through when a single line is taller than the page allows.
 */
export function pageBreaks(total: number, pageH: number, keep: KeepTogether[]): [number, number][] {
  const out: [number, number][] = [];
  if (!(total > 0) || !(pageH > 0)) return [[0, Math.max(0, total)]];
  const eps = 0.5;
  let start = 0;
  while (total - start > eps) {
    const ideal = start + pageH;
    if (ideal >= total - eps) {
      out.push([start, total]);
      break;
    }
    let end = ideal;
    for (const level of [3, 2, 1] as const) {
      let at = ideal;
      // Moving up past one block can land inside another, so repeat until nothing is cut.
      for (let moved = true; moved; ) {
        moved = false;
        for (const k of keep) {
          if (k.level <= level && k.top + eps < at && at < k.bottom - eps) {
            at = k.top;
            moved = true;
          }
        }
      }
      if (at - start >= pageH * MIN_FILL[level]) {
        end = at;
        break;
      }
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}
