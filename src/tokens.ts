import { produce } from 'immer';
import { uid, walk } from './tree';
import type { Doc, FrameNode, Project, SceneNode, SpaceSlot, SpaceToken, TextNode, TextStyle } from './types';

// Text styles and spacing tokens: named values a project shares across its boards.
//
// A layer keeps its own real values and only points at the style, so the canvas, lint and every
// exporter work as they always did. A linked value follows the style for as long as the two match.
// Anything set by hand on one layer stops matching, so it stays put when the style changes and the
// panel can offer to reset it. That one rule covers both text styles and spacing tokens, and there
// is no list of overrides to keep in step.
//
// syncTokens runs on every edit, ahead of syncRepeats. It skips repeat copies: the first card moves
// and syncRepeats carries that to the others.

export const STYLE_PROPS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'uppercase'] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];

export const STYLE_LABEL: Record<StyleProp, string> = {
  fontFamily: 'font',
  fontWeight: 'weight',
  italic: 'italic',
  fontSize: 'size',
  lineHeight: 'line height',
  letterSpacing: 'letter spacing',
  uppercase: 'case',
};

export const SPACE_SLOTS: SpaceSlot[] = ['gap', 't', 'r', 'b', 'l'];

const equal = (a: unknown, b: unknown) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6);

export const styleValues = (n: TextNode | TextStyle) => Object.fromEntries(STYLE_PROPS.map((k) => [k, n[k]])) as Pick<TextStyle, StyleProp>;

/** What a layer sets differently from its style. */
export const styleDiffs = (n: TextNode, s: TextStyle) => STYLE_PROPS.filter((k) => !equal(n[k], s[k]));

export const sameValues = (n: TextNode, s: TextStyle) => styleDiffs(n, s).length === 0;

export function applyStyle(n: TextNode, s: TextStyle) {
  n.textStyle = s.id;
  Object.assign(n, styleValues(s));
}

export const slotValue = (f: FrameNode, slot: SpaceSlot) => (slot === 'gap' ? f.gap : f.padding[slot]);

function setSlot(f: FrameNode, slot: SpaceSlot, v: number) {
  if (slot === 'gap') f.gap = v;
  else f.padding[slot] = v;
}

/** The token a frame's gap or padding side follows, if it still matches. */
export function tokenAt(f: FrameNode, slot: SpaceSlot, tokens: SpaceToken[]) {
  const t = tokens.find((x) => x.id === f.space?.[slot]);
  return t && equal(t.value, slotValue(f, slot)) ? t : undefined;
}

export function linkSpace(f: FrameNode, slot: SpaceSlot, t: SpaceToken | null) {
  if (t) {
    f.space = { ...f.space, [slot]: t.id };
    setSlot(f, slot, t.value);
    return;
  }
  if (!f.space) return;
  const { [slot]: _gone, ...rest } = f.space;
  if (Object.keys(rest).length) f.space = rest;
  else delete f.space;
}

/** Carries changed styles and tokens to the layers that follow them. */
export function syncTokens(next: Project, prev: Project): { project: Project; moved: boolean } {
  if (next.textStyles === prev.textStyles && next.spacing === prev.spacing) return { project: next, moved: false };
  const styles = new Map<string, { k: StyleProp; from: unknown; to: unknown }[]>();
  const gone = new Set<string>();
  for (const old of prev.textStyles ?? []) {
    const now = next.textStyles?.find((s) => s.id === old.id);
    if (!now) gone.add(old.id);
    else if (now !== old) styles.set(old.id, STYLE_PROPS.filter((k) => !equal(old[k], now[k])).map((k) => ({ k, from: old[k], to: now[k] })));
  }
  const spaces = new Map<string, { from: number; to: number }>();
  for (const old of prev.spacing ?? []) {
    const now = next.spacing?.find((s) => s.id === old.id);
    if (!now) gone.add(old.id);
    else if (now.value !== old.value) spaces.set(old.id, { from: old.value, to: now.value });
  }
  if (!gone.size && !spaces.size && ![...styles.values()].some((c) => c.length)) return { project: next, moved: false };
  const project = produce(next, (p) => {
    for (const b of p.boards)
      walk(b.nodes, (n) => {
        if (n.cloneOf) return;
        if (n.type === 'text' && n.textStyle) {
          if (gone.has(n.textStyle)) delete n.textStyle;
          else for (const c of styles.get(n.textStyle) ?? []) if (equal(n[c.k], c.from)) Object.assign(n, { [c.k]: c.to });
        }
        if (n.type === 'frame' && n.space)
          for (const slot of SPACE_SLOTS) {
            const id = n.space[slot];
            if (!id) continue;
            const c = spaces.get(id);
            if (gone.has(id)) linkSpace(n, slot, null);
            else if (c && equal(slotValue(n, slot), c.from)) setSlot(n, slot, c.to);
          }
      });
  });
  return { project, moved: true };
}

// ---------- reading ----------

/** Where a style or token is used: real layers only, so a repeat counts as its one card. */
function eachLayer(boards: Doc[], fn: (n: SceneNode) => void) {
  for (const b of boards) walk(b.nodes, (n) => void (n.cloneOf || fn(n)));
}

export function styleUses(p: Project) {
  const uses = new Map<string, number>();
  const up = (id: string) => uses.set(id, (uses.get(id) ?? 0) + 1);
  eachLayer(p.boards, (n) => {
    if (n.type === 'text' && n.textStyle) up(n.textStyle);
    if (n.type === 'frame' && n.space) for (const id of new Set(Object.values(n.space))) up(id);
  });
  return uses;
}

/** Text layers that look exactly like a style but don't follow it yet. */
export function unlinkedMatches(p: Project, s: TextStyle) {
  const out: string[] = [];
  eachLayer(p.boards, (n) => {
    if (n.type === 'text' && n.textStyle !== s.id && !isLinked(p, n) && sameValues(n, s)) out.push(n.id);
  });
  return out;
}

const isLinked = (p: Project, n: TextNode) => !!n.textStyle && !!p.textStyles?.some((s) => s.id === n.textStyle);

export interface UnstyledGroup extends Pick<TextStyle, StyleProp> {
  layers: number;
  sample: string;
}

/** Text with no style, grouped by look, most used first: the styles a project is already using. */
export function unstyledGroups(p: Project): UnstyledGroup[] {
  const groups = new Map<string, UnstyledGroup>();
  eachLayer(p.boards, (n) => {
    if (n.type !== 'text' || isLinked(p, n)) return;
    const v = styleValues(n);
    const key = JSON.stringify(v);
    const g = groups.get(key);
    if (g) g.layers++;
    else groups.set(key, { ...v, layers: 1, sample: n.text.replace(/\s+/g, ' ').slice(0, 40) });
  });
  return [...groups.values()].sort((a, b) => b.layers - a.layers || b.fontSize - a.fontSize);
}

// ---------- changing ----------

const named = <T extends { name: string }>(list: T[] | undefined, name: string) => list?.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());

export const textStyleNamed = (p: Project, ref: string) => p.textStyles?.find((s) => s.id === ref) ?? named(p.textStyles, ref);
export const spaceNamed = (p: Project, ref: string) => p.spacing?.find((s) => s.id === ref) ?? named(p.spacing, ref);

/** A name nothing else in the list has. */
export function freeName<T extends { name: string }>(list: T[] | undefined, name: string) {
  const base = name.trim() || 'Style';
  let out = base;
  for (let i = 2; named(list, out); i++) out = `${base} ${i}`;
  return out;
}

export function addTextStyle(p: Project, name: string, values: Pick<TextStyle, StyleProp>): TextStyle {
  const s: TextStyle = { id: uid(), name: freeName(p.textStyles, name), ...values };
  (p.textStyles ??= []).push(s);
  return p.textStyles[p.textStyles.length - 1];
}

export function addSpace(p: Project, name: string, value: number): SpaceToken {
  const t: SpaceToken = { id: uid(), name: freeName(p.spacing, name), value };
  (p.spacing ??= []).push(t);
  return p.spacing[p.spacing.length - 1];
}

/** Links the layers that match a style, on every board. Returns how many. */
export function linkMatches(p: Project, s: TextStyle) {
  const ids = new Set(unlinkedMatches(p, s));
  eachLayer(p.boards, (n) => {
    if (n.type === 'text' && ids.has(n.id)) n.textStyle = s.id;
  });
  return ids.size;
}

// ---------- moving between projects ----------

export interface CarriedTokens {
  textStyles?: TextStyle[];
  spacing?: SpaceToken[];
}

/** The styles and tokens some layers use, so they can travel with them. */
export function carriedBy(p: Project, nodes: SceneNode[]): CarriedTokens {
  const ids = new Set<string>();
  walk(nodes, (n) => {
    if (n.type === 'text' && n.textStyle) ids.add(n.textStyle);
    if (n.type === 'frame' && n.space) for (const id of Object.values(n.space)) ids.add(id);
  });
  const textStyles = p.textStyles?.filter((s) => ids.has(s.id));
  const spacing = p.spacing?.filter((s) => ids.has(s.id));
  return { ...(textStyles?.length ? { textStyles } : {}), ...(spacing?.length ? { spacing } : {}) };
}

/**
 * Brings styles into a project along with their layers. A style the project already has by name
 * wins, so pasted layers join it, and any value that differs shows as a difference on the layer.
 */
export function adoptTokens(p: Project, carried: CarriedTokens | undefined, nodes: SceneNode[]) {
  if (!carried) return;
  const remap = new Map<string, string>();
  const merge = <T extends { id: string; name: string }>(have: T[], incoming: T[] = []) => {
    for (const c of incoming) {
      if (have.some((x) => x.id === c.id)) continue;
      const same = named(have, c.name);
      if (same) remap.set(c.id, same.id);
      else have.push(c);
    }
  };
  if (carried.textStyles?.length) merge((p.textStyles ??= []), carried.textStyles);
  if (carried.spacing?.length) merge((p.spacing ??= []), carried.spacing);
  if (!remap.size) return;
  walk(nodes, (n) => {
    if (n.type === 'text' && n.textStyle) n.textStyle = remap.get(n.textStyle) ?? n.textStyle;
    if (n.type === 'frame' && n.space) for (const slot of SPACE_SLOTS) if (n.space[slot]) n.space[slot] = remap.get(n.space[slot]!) ?? n.space[slot];
  });
}
