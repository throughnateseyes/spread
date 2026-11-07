import { normaliseSpans, remapSpans, resolveSpanInput } from './richtext';
import { emailHandlers } from './email/automation';
import { createFromTemplate, libraryForClaude, saveReference, saveTemplate } from './library';
import { useStore, currentLayout, boardFrames, asClaude, fitVariations, type BoardEditLog } from './store';
import { collectLinks, nodeLink, setNodeLink, withTracking } from './links';
import { cloneBoard, cloneWithNewIds, collectAssetIds, findNode, findParent, makeDoc, makeDocumentBoard, makeEmailBoard, makeFrame, makeImage, makeProject, makeShape, makeText, uid, walk } from './tree';
import { absoluteBoxes } from './render';
import { makeEffect } from './effects';
import { normalizePaint } from './gradients';
import { clearAssets, isFontFile, isHeic, isImageFile, registerFont, registerImage, guessMime } from './assets';
import { applyArrange, arrangeBoxes, ARRANGE_MODES, type ArrangeMode } from './arrange';
import { exportSlides, renderBoardStripBase64, renderSlidesBase64 } from './exporter';
import { exportPdf } from './pdf';
import { describeBoardEdits, filterChanges, timeAgo } from './history';
import { lintBoard } from './lint';
import { compareOverlay, overlayFromBoard, overlayFromLibrary, overlayFromPath, overlaySummary, patchOverlay, removeOverlay } from './overlay';
import { photoCell } from './importer';
import { fieldNamed, photoFields, repeatHost, setRows, startRepeat, stopRepeat } from './repeat';
import { STYLE_PROPS, addSpace, addTextStyle, applyStyle, freeName, linkMatches, linkSpace, spaceNamed, styleDiffs, styleUses, styleValues, textStyleNamed, unstyledGroups } from './tokens';
import { activeBrand, brandById, normalizeBrand, saveBrand, setProjectBrand, slugify, useBrands } from './brand';
import { clearAutosave, loadProjectBytes, safeFileName, serializeProject } from './project';
import { focusForClaude, newProjectOfKind, openInTab, projectsForClaude } from './workspace';
import { BUNDLED_FONTS, SYSTEM_FONTS, uploadedFonts } from './fonts';
import { homeDir, isElectron, listFiles, onAutomationRequest, picturesDir, readFile, respondAutomation, writeFiles, writeToPath } from './platform';
import { PAGE_PRESETS, type AssetMeta, type Doc, type FrameNode, type ImageNode, type Paint, type SceneNode, type SpaceSlot, type TextNode } from './types';

// Renderer side of the local automation bridge (electron/main.cjs ⇄ mcp/server.mjs).
// Each method takes JSON params and returns JSON. Coordinates are strip-space px.

type Params = Record<string, any>;

function toPaint(v: unknown): Paint | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 'none') return null;
  if (typeof v === 'string') return { kind: 'solid', color: v };
  return normalizePaint(v as Paint);
}

function toEffect(e: Params) {
  if (e.type !== 'dither' && e.type !== 'grain' && e.type !== 'blur') throw new Error(`Unknown effect "${e.type}". Use 'dither', 'grain' or 'blur'.`);
  return makeEffect(e as Parameters<typeof makeEffect>[0]);
}

/** Normalises friendly spec values (fill as a colour string, padding as a number…) in place. */
function normalisePatch(type: SceneNode['type'], p: Params) {
  const out: Params = { ...p };
  delete out.id;
  delete out.type;
  delete out.children;
  if ((type === 'rect' || type === 'ellipse' || type === 'frame') && 'fill' in out) {
    const f = toPaint(out.fill);
    if (type !== 'frame' && f === null) out.fill = { kind: 'solid', color: '#00000000' };
    else out.fill = f;
  }
  if (type === 'frame' && typeof out.padding === 'number') out.padding = { t: out.padding, r: out.padding, b: out.padding, l: out.padding };
  if (type === 'frame' && out.padding && typeof out.padding === 'object' && ('x' in out.padding || 'y' in out.padding)) {
    const { x = 0, y = 0 } = out.padding;
    out.padding = { t: y, r: x, b: y, l: x };
  }
  if (out.shadow && typeof out.shadow === 'object') out.shadow = { enabled: true, color: '#00000040', x: 0, y: 8, blur: 24, ...out.shadow };
  if (type === 'image' && out.crop) out.crop = { zoom: 1, cx: 0.5, cy: 0.5, ...out.crop };
  if (type === 'image' && out.adjust) out.adjust = { brightness: 0, contrast: 0, saturation: 0, ...out.adjust };
  if (type === 'image' && out.effects) out.effects = (out.effects as Params[]).map(toEffect);
  delete out.textStyle;
  delete out.space;
  delete out.spans;
  return out;
}

/**
 * Styled ranges on a text layer after a spec was applied. `spans` in the spec replaces them
 * (located by match text or offsets); otherwise a text change carries them along with the words.
 */
function applySpans(n: SceneNode, spec: Params, before: string | null) {
  if (n.type !== 'text') return;
  if ('spans' in spec) n.spans = spec.spans ? resolveSpanInput(n.text, spec.spans) : undefined;
  else if (before !== null && before !== n.text) n.spans = remapSpans(before, n.text, n.spans);
  n.spans = n.spans ? normaliseSpans(n) : undefined;
  if (!n.spans) delete n.spans;
}

function resolveAssetId(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const d = useStore.getState().doc;
  if (d.assets[v]) return v;
  const byName = Object.values(d.assets).find((a) => a.name === v || a.name.replace(/\.[^.]+$/, '') === v);
  if (byName) return byName.id;
  throw new Error(`Unknown photo "${v}" — use an id or file name from get_state.photos`);
}

const namesOf = (list: { name: string }[] | undefined) => list?.map((x) => x.name).join(', ') || 'none yet';

function textStyleOf(ref: string) {
  const p = useStore.getState().project;
  const s = textStyleNamed(p, ref);
  if (!s) throw new Error(`Unknown text style "${ref}". This project has: ${namesOf(p.textStyles)}. Add it with spread_save_styles.`);
  return s;
}

function spaceOf(ref: string) {
  const p = useStore.getState().project;
  const t = spaceNamed(p, ref);
  if (!t) throw new Error(`Unknown spacing token "${ref}". This project has: ${namesOf(p.spacing)}. Add it with spread_save_styles.`);
  return t;
}

const SPACE_SPEC: Record<string, SpaceSlot[]> = { gap: ['gap'], padding: ['t', 'r', 'b', 'l'], paddingX: ['l', 'r'], paddingY: ['t', 'b'] };

/** textStyle and space in a spec. They go first, so any value set beside them wins for that layer. */
function linkTokens(n: SceneNode, spec: Params) {
  if (n.type === 'text' && 'textStyle' in spec) {
    if (spec.textStyle) applyStyle(n, textStyleOf(spec.textStyle));
    else delete n.textStyle;
  }
  if (n.type === 'frame' && spec.space && typeof spec.space === 'object') {
    for (const [name, ref] of Object.entries(spec.space as Record<string, string | null>)) {
      const slots = SPACE_SPEC[name];
      if (!slots) throw new Error(`Unknown space "${name}". Use gap, padding, paddingX or paddingY.`);
      for (const slot of slots) linkSpace(n, slot, ref ? spaceOf(ref) : null);
    }
  }
}

function fromSpec(spec: Params): SceneNode {
  const x = spec.x ?? 0;
  const y = spec.y ?? 0;
  let n: SceneNode;
  switch (spec.type) {
    case 'text':
      n = makeText(x, y, spec.text ?? 'Text');
      if (spec.w !== undefined && spec.sizingH === undefined) n.sizingH = 'fixed';
      break;
    case 'image':
      n = makeImage(x, y, spec.w ?? 540, spec.h ?? 675, null);
      spec = { ...spec, assetId: resolveAssetId(spec.assetId ?? spec.photo) };
      delete spec.photo;
      if (n.type === 'image' && spec.assetId) n.name = useStore.getState().doc.assets[spec.assetId]?.name ?? n.name;
      break;
    case 'rect':
    case 'ellipse':
      n = makeShape(spec.type, x, y, spec.w ?? 200, spec.h ?? 200);
      break;
    case 'frame':
      // The app's Frame tool gives a white card with comfortable spacing. Frames made by spec start
      // empty, so they only look the way the spec asks for.
      n = makeFrame(x, y, spec.w ?? 400, spec.h ?? 400, { fill: null, gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 } });
      if (spec.layout && spec.layout !== 'none') {
        if (spec.w === undefined && spec.sizingH === undefined) n.sizingH = 'hug';
        if (spec.h === undefined && spec.sizingV === undefined) n.sizingV = 'hug';
      }
      break;
    default:
      throw new Error(`Unknown node type "${spec.type}" (use text, image, rect, ellipse, frame)`);
  }
  linkTokens(n, spec);
  Object.assign(n, normalisePatch(n.type, spec));
  applySpans(n, spec, null);
  if (n.type === 'frame' && Array.isArray(spec.children)) n.children = spec.children.map(fromSpec);
  return n;
}

function findByKey(nodes: SceneNode[], key: string): SceneNode[] {
  const out: SceneNode[] = [];
  walk(nodes, (n) => {
    if (n.key === key) out.push(n);
  });
  return out;
}

function nodeBrief(n: SceneNode) {
  return { id: n.id, key: n.key ?? null, name: n.name, type: n.type, text: n.type === 'text' ? n.text : undefined };
}

function serialiseNodes(nodes: SceneNode[]): unknown[] {
  const abs = absoluteBoxes(nodes, currentLayout());
  const rec = (list: SceneNode[]): unknown[] =>
    list.map((n) => {
      const { ...rest } = n as any;
      const out: any = { ...rest, box: roundBox(abs.get(n.id)) };
      if (n.type === 'frame') out.children = rec(n.children);
      return out;
    });
  return rec(nodes);
}

/** The tree with only what's needed to find a layer: ids, names and boxes, not every stored prop. */
function outlineNodes(nodes: SceneNode[]): unknown[] {
  const abs = absoluteBoxes(nodes, currentLayout());
  const rec = (list: SceneNode[]): unknown[] =>
    list.map((n) => ({
      id: n.id,
      ...(n.key ? { key: n.key } : {}),
      name: n.name,
      type: n.type,
      box: roundBox(abs.get(n.id)),
      ...(n.type === 'text' ? { text: n.text.length > 60 ? `${n.text.slice(0, 60)}…` : n.text } : {}),
      ...(n.type === 'text' && n.textStyle ? styleBrief(n) : {}),
      ...(n.visible ? {} : { hidden: true }),
      ...(nodeLink(n) !== undefined ? { link: nodeLink(n) } : {}),
      // A repeat is one card and a table. The other cards are copies of it, so they'd only add noise.
      ...(n.type === 'frame' && n.repeat ? { repeat: { fields: n.repeat.fields, columns: n.repeat.columns, cards: n.repeat.rows.length }, children: rec(n.children.slice(0, 1).map((l) => (l.type === 'frame' ? { ...l, children: l.children.slice(0, 1) } : l))) } : n.type === 'frame' ? { children: rec(n.children) } : {}),
    }));
  return rec(nodes);
}

function styleBrief(n: TextNode) {
  const s = useStore.getState().project.textStyles?.find((x) => x.id === n.textStyle);
  if (!s) return {};
  const differs = styleDiffs(n, s);
  return { style: s.name, ...(differs.length ? { differs } : {}) };
}

function stylesReport() {
  const p = useStore.getState().project;
  const uses = styleUses(p);
  return {
    textStyles: (p.textStyles ?? []).map((s) => ({ ...s, layers: uses.get(s.id) ?? 0 })),
    spacing: (p.spacing ?? []).map((t) => ({ ...t, frames: uses.get(t.id) ?? 0 })),
    unstyled: unstyledGroups(p).slice(0, 20),
  };
}

function roundBox(b?: { x: number; y: number; w: number; h: number }) {
  return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null;
}

function summary(detail: 'full' | 'outline' = 'full') {
  const s = useStore.getState();
  const d = s.doc;
  const used = new Map<string, number>();
  walk(d.nodes, (n) => {
    if (n.type === 'image' && n.assetId) used.set(n.assetId, (used.get(n.assetId) ?? 0) + 1);
  });
  return {
    boardId: d.id,
    kind: d.kind,
    note: d.note ?? null,
    boards: boardsSummary(),
    brand: brandBrief(),
    ...(s.project.textStyles?.length || s.project.spacing?.length ? { styles: { text: s.project.textStyles?.map((x) => ({ id: x.id, name: x.name })) ?? [], spacing: s.project.spacing ?? [] } } : {}),
    name: d.name,
    slideWidth: d.slideWidth,
    slideHeight: d.slideHeight,
    slideCount: d.slides.length,
    background: d.background,
    ...(d.kind === 'email' ? { email: { subject: d.email?.subject ?? null, preheader: d.email?.preheader ?? null } } : {}),
    ...(d.overlay ? { overlay: { name: d.overlay.name, mode: d.overlay.mode, visible: d.overlay.visible } } : {}),
    slides: d.slides.map((sl, index) => ({ index, background: sl.background ?? d.background })),
    ...(d.page ? { page: d.page, units: d.page.units } : {}),
    grid: d.grid,
    selection: s.selection,
    filePath: s.filePath,
    nodes: detail === 'outline' ? outlineNodes(d.nodes) : serialiseNodes(d.nodes),
    photos: d.assetOrder.map((id) => {
      const a = d.assets[id];
      return { id, name: a?.name, width: a?.width, height: a?.height, usedCount: used.get(id) ?? 0 };
    }),
  };
}

/** The project's brand in one line, so every turn knows whether to design on-brand. */
function brandBrief() {
  const b = activeBrand();
  if (b) return { id: b.id, name: b.name, ...(b.designDoc ? { designDoc: b.designDoc } : {}), hint: `This project uses a brand: call spread_get_brand and design with only its fonts, colors, scale and rules.${b.designDoc ? ' Read its design doc first.' : ''}` };
  const n = useBrands.getState().brands.length;
  return { id: null, hint: `No brand: a personal project. Don't use any brand's fonts, colors or rules.${n ? ` (${n} brand${n > 1 ? 's' : ''} in the library; switch only if the user asks.)` : ''}` };
}

function boardsSummary() {
  const p = useStore.getState().project;
  const frames = boardFrames(p);
  return p.boards.map((b, index) => ({
    id: b.id,
    index,
    name: b.name,
    kind: b.kind,
    note: b.note ?? null,
    active: b.id === p.activeBoardId,
    slideCount: b.slides.length,
    slideWidth: b.slideWidth,
    slideHeight: b.slideHeight,
    nodeCount: b.nodes.length,
    canvasOrigin: frames.get(b.id) ? { x: frames.get(b.id)!.x, y: frames.get(b.id)!.y } : null,
  }));
}

/** Methods that act on the project as a whole rather than one board. */
const PROJECT_METHODS = new Set(['get_history', 'list_styles', 'list_projects', 'list_library', 'create_from_template', 'save_template', 'save_reference', 'batch', 'list_brands', 'get_brand', 'save_brand', 'use_brand', 'make_variants', 'list_email_templates', 'create_email', 'get_feedback', 'list_boards', 'create_board', 'duplicate_board', 'delete_board', 'update_board', 'render_overview', 'new_project', 'open_project', 'save_project', 'undo', 'redo', 'list_fonts', 'import_photos']);

/** Methods whose purpose is to bring a board into focus. */
const ACTIVATES = new Set(['create_email', 'activate_board', 'create_board', 'duplicate_board', 'select', 'export_slides']);

/** Methods that only look: they leave the active board and selection exactly as the user had them. */
const READ_ONLY = new Set(['send_check', 'get_history', 'compare_overlay', 'preview_email', 'list_styles', 'list_links', 'list_projects', 'list_library', 'list_brands', 'get_brand', 'lint', 'email_html', 'list_email_templates', 'get_feedback', 'get_state', 'list_boards', 'render_slides', 'render_overview', 'list_fonts', 'unused_photos']);

function requireBoard(id: unknown): string {
  const p = useStore.getState().project;
  if (typeof id !== 'string' || !p.boards.some((b) => b.id === id)) {
    throw new Error(`Unknown boardId "${String(id)}". Boards: ${p.boards.map((b) => `${b.id} (${b.name})`).join(', ')}`);
  }
  return id;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultDir() {
  const base = picturesDir ?? homeDir ?? '.';
  return `${base}/Spread`;
}

/** Row letter by position: A, B, … Z, AA … (matches the board header chip). */
function rowLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : rowLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
}

/** Maps every node id of `src` to the node at the same tree position in `copy` (a cloneBoard of it). */
function idMapOf(src: SceneNode[], copy: SceneNode[], m = new Map<string, string>()) {
  src.forEach((n, i) => {
    const c = copy[i];
    if (!c) return;
    m.set(n.id, c.id);
    if (n.type === 'frame' && c.type === 'frame') idMapOf(n.children, c.children, m);
  });
  return m;
}

/**
 * Re-lays out a detached board's top-level photos in place (keys, crops and type are kept). The slide count
 * becomes what the new layout needs (or `slides`), and every other top-level layer is carried along so nothing
 * is left on an empty slide:
 * - a caption on a middle slide that sits inside a photo follows that photo, at the same relative spot;
 * - anything on the last slide (price, CTA) moves to the new last slide, with that slide's background;
 * - everything else keeps its slide and its offset within it (clamped to the new last slide).
 */
function rearrangeInPlace(d: Doc, a: Params) {
  const mode = (a.mode ?? 'one-per-slide') as ArrangeMode;
  if (!ARRANGE_MODES.some((m) => m.id === mode)) throw new Error(`Unknown arrange mode "${a.mode}" (use ${ARRANGE_MODES.map((m) => m.id).join(', ')})`);
  const tray = useStore.getState().doc.assets;
  const meta = (id: string) => d.assets[id] ?? tray[id];
  const imgs = d.nodes.filter((n): n is ImageNode => n.type === 'image' && !!n.assetId && !!meta(n.assetId));
  if (!imgs.length) return;
  const aspects = imgs.map((n) => meta(n.assetId!).width / Math.max(1, meta(n.assetId!).height));
  const W = d.slideWidth;
  const oldCount = d.slides.length;
  const oldBoxes = new Map(imgs.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
  const { boxes, slides } = arrangeBoxes(mode, aspects, W, d.slideHeight, a.gap ?? 0, a.margin ?? 0, a.slides);
  imgs.forEach((n, i) => {
    const b = boxes[i];
    Object.assign(n, { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), rotation: 0, sizingH: 'fixed', sizingV: 'fixed' });
    if (typeof a.radius === 'number') n.radius = a.radius;
  });
  const newCount = Math.max(1, slides);
  const last = oldCount - 1;
  const moved = new Set<string>(imgs.map((n) => n.id));
  for (const n of d.nodes) {
    if (moved.has(n.id)) continue;
    const w = Math.max(1, n.w);
    const h = Math.max(1, n.h);
    const s = Math.min(last, Math.max(0, Math.floor((n.x + w / 2) / W)));
    const caption = (n.type === 'text' || n.type === 'frame') && s > 0 && s < last;
    const host = caption ? imgs.find((img) => {
      const o = oldBoxes.get(img.id)!;
      return n.x >= o.x && n.y >= o.y && n.x + w <= o.x + o.w && n.y + h <= o.y + o.h;
    }) : undefined;
    if (host) {
      const o = oldBoxes.get(host.id)!;
      const fx = (n.x - o.x) / Math.max(1, o.w - w);
      const fy = (n.y - o.y) / Math.max(1, o.h - h);
      n.x = Math.round(host.x + Math.max(0, host.w - w) * Math.min(1, Math.max(0, fx)));
      n.y = Math.round(host.y + Math.max(0, host.h - h) * Math.min(1, Math.max(0, fy)));
      continue;
    }
    const to = s === last ? newCount - 1 : Math.min(s, newCount - 1);
    n.x = Math.round(n.x + (to - s) * W);
  }
  const old = d.slides;
  const next = Array.from({ length: newCount }, (_, i) => old[i] ?? { id: uid(), background: null });
  if (newCount !== oldCount && old[last]?.background) {
    next[newCount - 1] = { ...next[newCount - 1], background: old[last].background };
    if (last < newCount) next[last] = { ...next[last], background: null };
  }
  d.slides = next;
}

/** update_nodes semantics on a detached board (by key, or by source-board id via idMap). Returns refs that matched nothing. */
function applyChanges(d: Doc, changes: Params[], idMap: Map<string, string>): string[] {
  const missing: string[] = [];
  for (const u of changes) {
    const targets = u.key ? findByKey(d.nodes, u.key) : u.id ? ([findNode(d.nodes, idMap.get(u.id) ?? u.id)].filter(Boolean) as SceneNode[]) : [];
    if (!targets.length) {
      missing.push(u.key ? 'key:' + u.key : (u.id ?? '(change has no key or id)'));
      continue;
    }
    for (const n of targets) {
      const patch = normalisePatch(n.type, u);
      delete patch.key;
      if (n.type === 'image' && ('assetId' in u || 'photo' in u)) {
        patch.assetId = resolveAssetId(u.assetId ?? u.photo);
        delete patch.photo;
      }
      if (n.type === 'text' && 'w' in u && !('sizingH' in u) && n.sizingH === 'hug') patch.sizingH = 'fixed';
      if (n.type === 'frame' && Array.isArray(u.children)) n.children = u.children.map(fromSpec);
      linkTokens(n, u);
      const before = n.type === 'text' ? n.text : null;
      Object.assign(n, patch);
      applySpans(n, u, before);
    }
  }
  return missing;
}

/**
 * What the user changed on a board by hand since Claude last touched it, in plain lines. These are
 * corrections to Claude's work (tightened a gap, swapped a weight), the raw material for design notes.
 */
function handEditsOf(b: Doc, log: BoardEditLog | undefined): string[] {
  if (!log?.userEditsSinceClaude) return [];
  if (log.claudeBoard) return describeBoardEdits(log.claudeBoard, b);
  // Reopened since Claude's edit: fall back to the saved change log.
  const s = useStore.getState();
  const mine = s.changes.filter((c) => c.boardId === b.id);
  const lastClaude = mine.map((c) => c.who).lastIndexOf('claude');
  return mine
    .slice(lastClaude + 1)
    .filter((c) => c.who === 'you' && !c.undo)
    .flatMap((c) => c.lines.map((l) => (l.layer ? `${l.layer}: ${l.what}` : l.what)))
    .slice(-60);
}

const handlers: Record<string, (p: Params) => Promise<unknown> | unknown> = {
  get_state: (p) => summary(p.detail === 'outline' ? 'outline' : 'full'),

  list_links() {
    const d = useStore.getState().doc;
    const links = collectLinks(d.nodes).map((l) => ({ ...l, shipsAs: withTracking(l.url, d.email?.tracking) }));
    return { tracking: d.email?.tracking ?? null, links, needAttention: links.filter((l) => l.issue).length };
  },

  // ---------- boards (rows of variations) ----------
  list_boards: () => ({ activeBoardId: useStore.getState().project.activeBoardId, boards: boardsSummary() }),

  activate_board(p) {
    useStore.getState().setActiveBoard(requireBoard(p.boardId));
    window.dispatchEvent(new Event('spread:fit'));
    return { activeBoardId: p.boardId };
  },

  create_board(p) {
    const s = useStore.getState();
    const kind = p.kind === 'email' || p.kind === 'document' ? p.kind : 'carousel';
    if (kind === 'document') {
      const preset = p.preset ? PAGE_PRESETS.find((x) => x.id === p.preset) : undefined;
      if (p.preset && !preset) throw new Error(`Unknown preset "${p.preset}" (use ${PAGE_PRESETS.map((x) => x.id).join(', ')}, or pass slideWidth/slideHeight)`);
      let w = p.slideWidth ?? preset?.w ?? 612;
      let h = p.slideHeight ?? preset?.h ?? 792;
      if (p.landscape && h > w) [w, h] = [h, w];
      const m = typeof p.margins === 'number' ? { t: p.margins, r: p.margins, b: p.margins, l: p.margins } : p.margins;
      const units = p.units === 'px' || p.units === 'pt' ? p.units : preset?.group === 'Screen' ? 'px' : 'pt';
      const b = makeDocumentBoard({ name: p.name, w, h, units, pages: p.pageCount ?? p.slideCount, margins: m, baseline: p.baseline });
      if (p.note) b.note = p.note;
      if (p.background) b.background = p.background;
      const id = s.addBoard(b, p.afterBoardId);
      window.dispatchEvent(new CustomEvent('spread:fit', { detail: 'all' }));
      return { boardId: id, slideWidth: b.slideWidth, slideHeight: b.slideHeight, page: b.page, boards: boardsSummary() };
    }
    const b = kind === 'email' ? makeEmailBoard(p.name ?? 'Untitled email') : makeDoc();
    if (kind === 'carousel') {
      b.name = p.name ?? 'Untitled carousel';
      if (p.slideWidth) b.slideWidth = Math.round(p.slideWidth);
      if (p.slideHeight) b.slideHeight = Math.round(p.slideHeight);
      if (p.slideCount) b.slides = Array.from({ length: Math.max(1, Math.min(40, Math.round(p.slideCount))) }, () => ({ id: uid(), background: null }));
    }
    if (p.note) b.note = p.note;
    if (p.background) b.background = p.background;
    const id = s.addBoard(b, p.afterBoardId);
    window.dispatchEvent(new CustomEvent('spread:fit', { detail: 'all' }));
    return { boardId: id, boards: boardsSummary() };
  },

  duplicate_board(p) {
    const s = useStore.getState();
    const src = p.boardId ? requireBoard(p.boardId) : s.project.activeBoardId;
    const count = Math.max(1, Math.min(10, Math.round(p.count ?? 1)));
    const names: string[] = Array.isArray(p.names) ? p.names : [];
    const notes: string[] = Array.isArray(p.notes) ? p.notes : [];
    const ids: string[] = [];
    let after = src;
    for (let i = 0; i < count; i++) {
      const id = useStore.getState().duplicateBoard(src, names[i] ?? (count === 1 ? p.name : undefined), notes[i] ?? (count === 1 ? p.note : undefined));
      // Keep variations in order right below the source.
      if (after !== src) {
        const st = useStore.getState();
        const from = st.project.boards.findIndex((b) => b.id === id);
        const to = st.project.boards.findIndex((b) => b.id === after) + 1;
        if (from !== to) st.changeProject((pr) => {
          const [b] = pr.boards.splice(from, 1);
          pr.boards.splice(to > from ? to - 1 : to, 0, b);
        });
      }
      after = id;
      ids.push(id);
    }
    fitVariations();
    return { boardIds: ids, boards: boardsSummary() };
  },

  /**
   * The ideation batch: one copy of the source board per variant, in order right below it. Each copy
   * gets its name/note, then arrange (photos re-laid out in place), then changes by key (or by source
   * id), then added nodes, applied as ONE undo step per variant. The user's active row and selection
   * are left alone.
   */
  make_variants(p) {
    const s0 = useStore.getState();
    const srcId = p.boardId ? requireBoard(p.boardId) : s0.project.activeBoardId;
    const variants: Params[] = Array.isArray(p.variants) ? p.variants : [];
    if (!variants.length || variants.length > 10) throw new Error('Pass variants: [{ name, note, changes?, add?, arrange? }] (1–10)');
    const boardIds: string[] = [];
    const missing: { boardId: string; variant: number; refs: string[] }[] = [];
    let after = srcId;
    variants.forEach((v, vi) => {
      const src = useStore.getState().project.boards.find((b) => b.id === srcId)!;
      const copy = cloneBoard(src, typeof v.name === 'string' && v.name ? v.name : `${src.name} — v${vi + 2}`);
      const idMap = idMapOf(src.nodes, copy.nodes);
      delete copy.status;
      if (typeof v.note === 'string') copy.note = v.note;
      if (v.arrange && typeof v.arrange === 'object') rearrangeInPlace(copy, v.arrange);
      const refs = Array.isArray(v.changes) ? applyChanges(copy, v.changes, idMap) : [];
      if (Array.isArray(v.add) && v.add.length) copy.nodes.push(...v.add.map(fromSpec));
      if (refs.length) missing.push({ boardId: copy.id, variant: vi, refs });
      const anchor = after;
      useStore.getState().changeProject((pr) => {
        // Copies share the photo tray, like boards made with duplicate_board.
        const tray = pr.boards.find((b) => b.id === pr.activeBoardId) ?? pr.boards[0];
        copy.assets = { ...tray.assets, ...copy.assets };
        copy.assetOrder = [...new Set([...tray.assetOrder, ...copy.assetOrder])];
        pr.boards.splice(pr.boards.findIndex((b) => b.id === anchor) + 1, 0, copy);
      });
      after = copy.id;
      boardIds.push(copy.id);
    });
    fitVariations();
    const boards = useStore.getState().project.boards;
    return {
      boardIds,
      boards: boardIds.map((id) => {
        const i = boards.findIndex((b) => b.id === id);
        return { boardId: id, row: i + 1, letter: rowLetter(i), name: boards[i].name };
      }),
      missing,
    };
  },

  update_board(p) {
    const id = p.boardId ? requireBoard(p.boardId) : useStore.getState().project.activeBoardId;
    const patch: Params = {};
    if (typeof p.name === 'string') patch.name = p.name;
    if (typeof p.note === 'string') patch.note = p.note;
    if (p.status === 'picked' || p.status === 'rejected' || p.status === null) {
      patch.status = p.status;
      if (p.status === null) patch.statusReason = null;
    }
    if (typeof p.statusReason === 'string' || p.statusReason === null) patch.statusReason = p.statusReason;
    if (typeof p.subject === 'string' || typeof p.preheader === 'string' || typeof p.tracking === 'string') {
      const b = useStore.getState().project.boards.find((x) => x.id === id)!;
      if (b.kind !== 'email') throw new Error('subject, preheader and tracking are for email boards.');
      patch.email = { ...b.email, ...(typeof p.subject === 'string' ? { subject: p.subject } : {}), ...(typeof p.preheader === 'string' ? { preheader: p.preheader } : {}), ...(typeof p.tracking === 'string' ? { tracking: p.tracking } : {}) };
    }
    useStore.getState().updateBoard(id, patch);
    return { boards: boardsSummary() };
  },

  list_library: (p) => libraryForClaude({ boardKind: p.boardKind }),

  async create_from_template(p) {
    const boardId = await createFromTemplate(String(p.templateId ?? ''), { name: p.name, note: p.note, photoIds: p.photoIds });
    return { boardId, boards: boardsSummary() };
  },

  async save_template(p) {
    const t = await saveTemplate({ boardId: p.boardId ? requireBoard(p.boardId) : undefined, sectionId: p.sectionId, name: String(p.name ?? ''), description: p.description });
    return { templateId: `saved:${t.id}`, name: t.name, scope: t.scope };
  },

  async save_reference(p) {
    if (!String(p.why ?? '').trim()) throw new Error('Say why it is good (why): that is what makes a reference useful later.');
    const r = await saveReference({ boardId: p.boardId ? requireBoard(p.boardId) : undefined, name: p.name, why: String(p.why) });
    return { referenceId: r.id, name: r.name, images: r.images.map((f) => `${r.dir}/${f}`) };
  },

  delete_board(p) {
    const s = useStore.getState();
    const id = requireBoard(p.boardId);
    if (s.project.boards.length <= 1) throw new Error("Can't delete the only board");
    s.deleteBoard(id);
    return { boards: boardsSummary() };
  },

  /** What the user has said with the mouse: selection, picks/rejects, notes and hand edits since Claude's last change. */
  get_feedback() {
    const s = useStore.getState();
    const p = s.project;
    return {
      activeBoardId: p.activeBoardId,
      brand: brandBrief(),
      selection: s.selection.map((id) => findNode(s.doc.nodes, id)).filter(Boolean).map((n) => nodeBrief(n as SceneNode)),
      boards: p.boards.map((b, index) => {
        const log = s.editLog[b.id];
        return {
          id: b.id,
          row: index + 1,
          name: b.name,
          note: b.note ?? null,
          status: b.status ?? null,
          statusReason: b.statusReason ?? null,
          claudeLastEditedAt: log?.claudeAt ? new Date(log.claudeAt).toISOString() : null,
          userEditsSinceClaude: log?.userEditsSinceClaude ?? 0,
          userTouched: (log?.userTouchedIds ?? []).map((id) => findNode(b.nodes, id)).filter(Boolean).map((n) => nodeBrief(n as SceneNode)),
          handEdits: handEditsOf(b, log),
        };
      }),
    };
  },

  async render_overview(p) {
    const s = useStore.getState();
    const prev = s.project.activeBoardId;
    const ids: string[] = p.boardIds?.length ? p.boardIds.map(requireBoard) : s.project.boards.map((b) => b.id);
    const images = [];
    for (const id of ids) {
      const b = useStore.getState().project.boards.find((x) => x.id === id)!;
      const img = await renderBoardStripBase64(id, p.maxSide ?? 2000);
      images.push({ ...img, name: b.name, note: b.note ?? null, slideCount: b.slides.length });
    }
    useStore.getState().setActiveBoard(prev);
    return { images };
  },

  async import_photos(p) {
    const paths: string[] = Array.isArray(p.paths) ? p.paths : p.path ? [p.path] : [];
    if (!paths.length) throw new Error('Pass paths: [file or folder paths]');
    const files = await listFiles(paths);
    const metas: AssetMeta[] = [];
    const skipped: string[] = [];
    const fonts: string[] = [];
    for (const f of files) {
      const name = f.split(/[\\/]/).pop()!;
      try {
        const nf = await readFile(f);
        const blob = new Blob([nf.data as BlobPart], { type: guessMime(name) });
        // HEIC is converted to JPEG inside registerImage.
        if (isImageFile({ name }) || isHeic({ name })) metas.push(await registerImage(blob, name));
        else if (isFontFile({ name })) {
          const m = await registerFont(blob, name);
          metas.push(m);
          fonts.push(m.family!);
        } else skipped.push(name);
      } catch (e) {
        skipped.push(`${name} (${(e as Error).message})`);
      }
    }
    const s = useStore.getState();
    s.addAssets(metas);
    if (fonts.length) s.bumpFonts();
    s.set({ leftTab: 'photos' });
    return { assetIds: metas.filter((m) => m.kind === 'image').map((m) => m.id), photos: metas.filter((m) => m.kind === 'image').map((m) => ({ id: m.id, name: m.name, width: m.width, height: m.height })), fonts, skipped };
  },

  arrange(p) {
    const s = useStore.getState();
    const ids: string[] = (p.assetIds?.length ? p.assetIds : s.doc.assetOrder).map((v: string) => resolveAssetId(v)!);
    if (!ids.length) throw new Error('No photos — import_photos first');
    const before = s.doc.nodes.length;
    applyArrange(ids, {
      mode: (p.mode ?? 'one-per-slide') as ArrangeMode,
      gap: p.gap ?? 0,
      margin: p.margin ?? 0,
      radius: p.radius ?? 0,
      addText: !!p.addText,
      slides: typeof p.slides === 'number' ? p.slides : undefined,
      where: p.replace === false ? 'append' : p.replace === true || before === 0 ? 'replace' : 'append',
    });
    const d = useStore.getState().doc;
    return { slideCount: d.slides.length, nodeIds: d.nodes.map((n) => n.id) };
  },

  add_nodes(p) {
    const specs: Params[] = Array.isArray(p.nodes) ? p.nodes : [];
    if (!specs.length) throw new Error('Pass nodes: [...]');
    const nodes = specs.map(fromSpec);
    const s = useStore.getState();
    if (p.parentId && findNode(s.doc.nodes, p.parentId)?.type !== 'frame') throw new Error('parentId must be a frame');
    s.addNodes(nodes, p.parentId ?? null);
    const ids: string[] = [];
    walk(nodes, (n) => void ids.push(n.id));
    return { ids: nodes.map((n) => n.id), allIds: ids };
  },

  update_nodes(p) {
    const ups: Params[] = Array.isArray(p.updates) ? p.updates : [];
    const s = useStore.getState();
    let updated = 0;
    const missing: string[] = [];
    s.change((d) => {
      for (const u of ups) {
        // Address a layer by id, or by its stable key (same key in every variation row).
        const targets = u.id ? [findNode(d.nodes, u.id)].filter(Boolean) as SceneNode[] : u.key ? findByKey(d.nodes, u.key) : [];
        if (!targets.length) {
          missing.push(u.id ?? 'key:' + u.key);
          continue;
        }
        for (const n of targets) {
        const patch = normalisePatch(n.type, u);
        delete patch.key;
        if (n.type === 'image' && ('assetId' in u || 'photo' in u)) {
          patch.assetId = resolveAssetId(u.assetId ?? u.photo);
          delete patch.photo;
        }
        if (n.type === 'text' && 'w' in u && !('sizingH' in u) && n.sizingH === 'hug') patch.sizingH = 'fixed';
        if (n.type === 'frame' && Array.isArray(u.children)) n.children = u.children.map(fromSpec);
        linkTokens(n, u);
        const before = n.type === 'text' ? n.text : null;
        Object.assign(n, patch);
        applySpans(n, u, before);
        if ('link' in u) setNodeLink(n, u.link ?? null);
        updated++;
        }
      }
    });
    return { updated, missing };
  },

  wrap_nodes(p) {
    const s = useStore.getState();
    const { ids: wanted = [], keys = [], ...spec } = p as Params;
    const nodes: SceneNode[] = [...(wanted as string[]).map((id) => findNode(s.doc.nodes, id)).filter((n): n is SceneNode => !!n), ...(keys as string[]).flatMap((k) => findByKey(s.doc.nodes, k))];
    if (!nodes.length) throw new Error('Pass ids or keys of the layers to wrap.');
    const ids = [...new Set(nodes.map((n) => n.id))];
    const parents = new Set(ids.map((id) => findParent(s.doc.nodes, id)?.id ?? null));
    if (parents.size > 1) throw new Error('These layers have different parents. Wrap layers that sit side by side in the same frame.');
    const auto = spec.layout !== 'none';
    delete spec.boardId;
    const id = s.wrapNodes(ids, auto, normalisePatch('frame', { padding: 0, ...spec }) as Partial<FrameNode>);
    return { id, wrapped: ids.length };
  },

  async repeat(p) {
    const s = useStore.getState();
    const target = p.key ? findByKey(s.doc.nodes, p.key)[0] : findNode(s.doc.nodes, p.id ?? '');
    if (!target) throw new Error('Pass the id or key of the card, or of a repeat frame.');
    const host = target.type === 'frame' && target.repeat ? target : repeatHost(s.doc.nodes, target.id);
    if (p.stop) {
      if (!host) throw new Error("That layer isn't in a repeat.");
      s.change((d) => stopRepeat(findNode(d.nodes, host.id) as FrameNode));
      return { id: host.id, stopped: true };
    }
    let id = host?.id ?? '';
    if (!host) {
      const layers = (m?: Record<string, string>) => {
        if (!m) return undefined;
        return (d: Doc) =>
          Object.fromEntries(
            Object.entries(m).map(([field, ref]) => {
              const n = findByKey(d.nodes, ref)[0] ?? findNode(d.nodes, ref);
              if (!n) throw new Error(`No layer "${ref}" for the field "${field}".`);
              return [field, n];
            }),
          );
      };
      s.change((d) => {
        id = startRepeat(d, target.id, { columns: p.columns, gap: p.gap, fields: layers(p.fields)?.(d), links: layers(p.links)?.(d) });
      });
    }
    const frame = () => findNode(useStore.getState().doc.nodes, id) as FrameNode;
    const failed: { card: number; field: string; value: string; why: string }[] = [];
    let rows: Record<string, string>[] | undefined;
    if (Array.isArray(p.rows)) {
      if (!p.rows.length) throw new Error('A repeat needs at least one row. Pass stop: true to end it.');
      const spec = frame().repeat!;
      const unknown = [...new Set((p.rows as Params[]).flatMap((r) => Object.keys(r)))].filter((k) => !fieldNamed(spec, k));
      if (unknown.length) throw new Error(`No field called ${unknown.join(', ')}. This repeat has: ${spec.fields.join(', ')}.`);
      const photos = photoFields(frame());
      const seen = new Map<string, string>();
      rows = [];
      for (const [i, row] of (p.rows as Params[]).entries()) {
        const out: Record<string, string> = {};
        for (const [k, raw] of Object.entries(row)) {
          const field = fieldNamed(spec, k)!;
          const value = String(raw ?? '');
          out[field] = value;
          if (!photos.includes(field)) continue;
          try {
            if (!seen.has(value)) seen.set(value, await photoCell(value));
            out[field] = seen.get(value)!;
          } catch (e) {
            out[field] = '';
            failed.push({ card: i + 1, field, value, why: (e as Error).message });
          }
        }
        rows.push(out);
      }
    }
    useStore.getState().change((d) => {
      const f = findNode(d.nodes, id) as FrameNode;
      if (p.columns !== undefined) f.repeat!.columns = p.columns;
      if (p.gap !== undefined) f.gap = p.gap;
      if (rows) setRows(f.repeat!, rows);
    });
    const done = frame();
    return { id, cardId: done.children[0]?.type === 'frame' ? done.children[0].children[0]?.id : null, fields: done.repeat?.fields, columns: done.repeat?.columns, cards: done.repeat?.rows.length, failed };
  },

  delete_nodes(p) {
    const s = useStore.getState();
    const ids: string[] = [...(p.ids ?? [])];
    for (const k of (p.keys ?? []) as string[]) ids.push(...findByKey(s.doc.nodes, k).map((n) => n.id));
    s.select(ids.filter((id) => findNode(s.doc.nodes, id)));
    const n = useStore.getState().selection.length;
    s.deleteSelection();
    return { deleted: n };
  },

  duplicate_nodes(p) {
    const s = useStore.getState();
    const ids: string[] = [];
    const nodes = (p.ids as string[]).map((id) => findNode(s.doc.nodes, id)).filter(Boolean) as SceneNode[];
    const copies = nodes.map((n) => {
      const c = cloneWithNewIds(n);
      c.x += p.dx ?? 0;
      c.y += p.dy ?? 0;
      ids.push(c.id);
      return c;
    });
    s.addNodes(copies, null);
    return { ids };
  },

  set_document(p) {
    const s = useStore.getState();
    s.change((d) => {
      if (typeof p.name === 'string') d.name = p.name;
      if (p.slideWidth) d.slideWidth = Math.round(p.slideWidth);
      if (p.slideHeight) d.slideHeight = Math.round(p.slideHeight);
      if (p.background) d.background = p.background;
      if (p.grid) d.grid = { ...d.grid, ...p.grid, columns: { ...d.grid.columns, ...p.grid.columns }, rows: { ...d.grid.rows, ...p.grid.rows } };
      if (p.slideCount) {
        const n = Math.max(1, Math.min(40, Math.round(p.slideCount)));
        while (d.slides.length < n) d.slides.push({ id: uid(), background: null });
        d.slides.length = n;
      }
      if (Array.isArray(p.slideBackgrounds)) p.slideBackgrounds.forEach((c: string | null, i: number) => d.slides[i] && (d.slides[i].background = c));
      if (d.kind === 'document' && (p.margins !== undefined || p.baseline !== undefined)) {
        const page = d.page ?? { units: 'pt' as const, margins: { t: 54, r: 54, b: 54, l: 54 }, baseline: 0 };
        if (typeof p.margins === 'number') page.margins = { t: p.margins, r: p.margins, b: p.margins, l: p.margins };
        else if (p.margins) page.margins = { ...page.margins, ...p.margins };
        if (typeof p.baseline === 'number') page.baseline = Math.max(0, p.baseline);
        d.page = page;
        d.grid.columns.margin = page.margins.l;
        d.grid.rows.margin = page.margins.t;
      }
    });
    window.dispatchEvent(new Event('spread:fit'));
    const { nodes, ...rest } = summary();
    return rest;
  },

  select(p) {
    useStore.getState().select(p.ids ?? []);
    if (p.ids?.length) window.dispatchEvent(new Event('spread:zoom-selection'));
    return {};
  },

  /** Who changed what, newest first. */
  get_history(p) {
    const s = useStore.getState();
    const ids: string[] = p.layerId ? [p.layerId] : [];
    if (p.key) {
      for (const b of s.project.boards) {
        walk(b.nodes, (n) => {
          if (n.key === p.key) ids.push(n.id);
        });
      }
      if (!ids.length) throw new Error(`No layer has the key "${p.key}".`);
    }
    const all = filterChanges(s.changes, { who: p.who, boardId: p.boardId, layerIds: ids.length ? ids : undefined, query: p.query });
    return {
      total: all.length,
      entries: all.slice(0, p.limit ?? 30).map(({ id: _id, at, lines, ...e }) => ({ at: new Date(at).toISOString(), ago: timeAgo(at), ...e, lines: lines.map(({ ids: layerIds, ...l }) => ({ ...l, ...(layerIds?.length === 1 ? { layerId: layerIds[0] } : {}) })) })),
    };
  },

  async set_overlay(p) {
    const id = useStore.getState().doc.id;
    if (p.remove) {
      removeOverlay(id);
      return { overlay: null };
    }
    if (p.path) await overlayFromPath(id, p.path);
    else if (p.fromBoardId) await overlayFromBoard(id, p.fromBoardId);
    else if (p.referenceId) await overlayFromLibrary(id, p.referenceId);
    if (!useStore.getState().doc.overlay) throw new Error('This board has no reference yet. Pass path, fromBoardId or referenceId.');
    const patch = Object.fromEntries((['x', 'y', 'scale', 'opacity', 'mode', 'visible'] as const).filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
    if (Object.keys(patch).length) patchOverlay(id, patch);
    return { overlay: useStore.getState().doc.overlay };
  },

  async compare_overlay() {
    const { url: _url, ratio: _ratio, key: _key, base64, ...report } = await compareOverlay(useStore.getState().doc.id, { picture: true });
    return { ...report, summary: overlaySummary({ ...report, url: '', ratio: 1, key: '' }), images: base64 ? [{ base64, mime: 'image/jpeg' }] : [] };
  },

  async render_slides(p) {
    const n = useStore.getState().doc.slides.length;
    const idx: number[] = (p.slides?.length ? p.slides : [...Array(n).keys()]).filter((i: number) => i >= 0 && i < n);
    return { images: await renderSlidesBase64(idx, p.scale ?? 0.4) };
  },

  async export_slides(p) {
    const s = useStore.getState();
    const folder: string = p.folder ?? `${defaultDir()}/${safeFileName(s.doc.name)}-${today()}`;
    const files = await exportSlides({
      scale: p.scale ?? 2,
      format: p.format === 'jpeg' || p.format === 'jpg' ? 'jpeg' : 'png',
      quality: p.quality,
      slides: p.slides,
      prefix: p.prefix ?? safeFileName(s.doc.name),
      includeStrip: !!p.includeStrip,
    });
    await writeFiles(folder, files.map((f) => ({ name: f.name, data: f.blob })));
    s.toast(`Exported ${files.length} files`, 'success');
    return { folder, files: files.map((f) => f.name) };
  },

  lint() {
    const s = useStore.getState();
    const d = s.doc;
    return { boardId: d.id, brand: activeBrand()?.name ?? null, ...lintBoard(d, currentLayout(), activeBrand(), s.project) };
  },

  list_styles() {
    return stylesReport();
  },

  save_styles(p) {
    const s = useStore.getState();
    const texts: Params[] = Array.isArray(p.textStyles) ? p.textStyles : [];
    const spaces: Params[] = Array.isArray(p.spacing) ? p.spacing : [];
    const drop: string[] = Array.isArray(p.delete) ? p.delete : [];
    if (!texts.length && !spaces.length && !drop.length) throw new Error('Pass textStyles, spacing or delete.');
    // Layers to copy a look from, found before anything changes.
    const looks = new Map<Params, TextNode>();
    for (const t of texts) {
      if (!t.from) continue;
      const n = findNode(s.doc.nodes, t.from) ?? findByKey(s.doc.nodes, t.from)[0];
      if (n?.type !== 'text') throw new Error(`"${t.from}" isn't a text layer on this board.`);
      looks.set(t, n);
    }
    let linked = 0;
    s.changeProject((pr) => {
      for (const t of texts) {
        if (typeof t.name !== 'string' || !t.name.trim()) throw new Error('Every text style needs a name.');
        const values = { ...(looks.has(t) ? styleValues(looks.get(t)!) : {}), ...Object.fromEntries(STYLE_PROPS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])) };
        let style = textStyleNamed(pr, t.id ?? t.name);
        if (style) Object.assign(style, values);
        else {
          if (values.fontFamily === undefined || values.fontSize === undefined) throw new Error(`New style "${t.name}" needs fontFamily and fontSize, or from: a text layer to copy.`);
          style = addTextStyle(pr, t.name, { ...styleValues(makeText(0, 0)), fontWeight: 400, ...values });
        }
        if (t.rename) style.name = freeName(pr.textStyles!.filter((x) => x !== style), t.rename);
        if (t.linkMatching) linked += linkMatches(pr, style);
      }
      for (const t of spaces) {
        if (typeof t.name !== 'string' || !t.name.trim()) throw new Error('Every spacing token needs a name.');
        let token = spaceNamed(pr, t.id ?? t.name);
        if (token) {
          if (typeof t.value === 'number') token.value = t.value;
        } else {
          if (typeof t.value !== 'number') throw new Error(`New token "${t.name}" needs a value.`);
          token = addSpace(pr, t.name, t.value);
        }
        if (t.rename) token.name = freeName(pr.spacing!.filter((x) => x !== token), t.rename);
      }
      for (const ref of drop) {
        const style = textStyleNamed(pr, ref);
        const token = spaceNamed(pr, ref);
        if (!style && !token) throw new Error(`Nothing named "${ref}" to delete.`);
        if (style) pr.textStyles = pr.textStyles!.filter((x) => x.id !== style.id);
        if (token) pr.spacing = pr.spacing!.filter((x) => x.id !== token.id);
      }
    });
    return { ...stylesReport(), linked };
  },

  async export_pdf(p) {
    const s = useStore.getState();
    const { bytes, pages, name } = await exportPdf(s.doc.id);
    const path: string = p.path ?? `${defaultDir()}/${safeFileName(name)}-${today()}.pdf`;
    await writeToPath(path, bytes);
    s.toast(`Saved ${pages}-page PDF`, 'success');
    return { path, pages, bytes: bytes.byteLength };
  },

  async save_project(p) {
    const s = useStore.getState();
    const path: string = p.path ?? s.filePath ?? `${defaultDir()}/${safeFileName(s.doc.name)}.spread`;
    await writeToPath(path, await serializeProject());
    s.set({ filePath: path, dirty: false });
    return { path };
  },

  async open_project(p) {
    if (!p.path) throw new Error('Pass path');
    if (isElectron) {
      await openInTab(p.path);
      return {};
    }
    const f = await readFile(p.path);
    await loadProjectBytes(f.data, p.path);
    return {};
  },

  list_projects() {
    return { projects: projectsForClaude() };
  },

  async new_project(p) {
    if (isElectron) {
      await newProjectOfKind('carousel', { name: p.name ? String(p.name) : undefined, dialog: false });
      return {};
    }
    const s = useStore.getState();
    if (s.dirty && s.doc.nodes.length && !p.discard) throw new Error('The open project has unsaved changes. Call save_project first, or pass discard: true.');
    clearAssets();
    s.replaceProject(makeProject());
    if (p.name) s.change((d) => void (d.name = p.name));
    await clearAutosave();
    window.dispatchEvent(new Event('spread:fit'));
    return {};
  },

  // ---------- brands ----------

  list_brands() {
    const s = useStore.getState();
    return {
      projectBrandId: s.project.brandId ?? null,
      brands: useBrands.getState().brands.map((b) => ({ id: b.id, name: b.name, description: b.description ?? null, colors: b.colors.length, fonts: b.fonts.map((f) => f.family), rules: b.rules.length, source: b.source ?? null })),
    };
  },

  get_brand(p) {
    const id = p.brandId ?? useStore.getState().project.brandId;
    if (!id) return { brand: null, note: 'This project has no brand (a personal project). Design without any brand.' };
    const b = brandById(id);
    if (!b) throw new Error(`No brand "${id}" in the library. Brands: ${useBrands.getState().brands.map((x) => x.id).join(', ') || 'none'}`);
    const { dir: _dir, ...brand } = b;
    return { brand, inUse: useStore.getState().project.brandId === b.id };
  },

  async save_brand(p) {
    if (!p.id && !p.name) throw new Error('Pass name (new brand) or id (existing brand)');
    const prev = p.id ? brandById(p.id) : brandById(slugify(p.name));
    if (p.id && !prev && !p.name) throw new Error(`No brand "${p.id}" to update`);
    const base = normalizeBrand({ ...p, name: p.name ?? prev!.name }, prev);
    const now = Date.now();
    const removed = new Set<string>(p.removeRuleIds ?? []);
    base.rules = [
      ...base.rules.filter((r) => !removed.has(r.id)),
      ...(Array.isArray(p.addRules) ? p.addRules : []).map((r: Params) => ({ id: uid(), kind: r.kind === 'dont' ? 'dont' : 'do', text: String(r.text ?? '').trim(), source: r.source === 'brand' ? 'brand' : 'learned', addedAt: now })).filter((r: Params) => r.text),
    ] as typeof base.rules;
    const saved = await saveBrand(base, Array.isArray(p.fontFiles) ? p.fontFiles : undefined);
    if (p.use) await setProjectBrand(saved.id);
    const { dir: _dir, ...brand } = saved;
    return { brand, inUse: useStore.getState().project.brandId === saved.id };
  },

  async use_brand(p) {
    const id = p.brandId ?? null;
    if (id && !brandById(id)) throw new Error(`No brand "${id}". Brands: ${useBrands.getState().brands.map((x) => x.id).join(', ') || 'none'}`);
    await setProjectBrand(id);
    return { brand: brandBrief() };
  },

  /** Several methods in one call (one permission prompt, one round trip). Stops at the first error. */
  async batch(p) {
    if (!Array.isArray(p.steps) || !p.steps.length) throw new Error('Pass steps: [{ method, params }]');
    const results: unknown[] = [];
    for (const [i, step] of (p.steps as Params[]).entries()) {
      if (!step?.method || step.method === 'batch') throw new Error(`Step ${i + 1}: pass a method (not batch)`);
      try {
        results.push({ method: step.method, result: await runAutomation(step.method, step.params ?? {}) });
      } catch (e) {
        return { completed: i, results, error: { step: i + 1, method: step.method, message: (e as Error).message } };
      }
    }
    return { completed: results.length, results };
  },

  undo: () => (useStore.getState().undo(), {}),
  redo: () => (useStore.getState().redo(), {}),

  list_fonts() {
    const d = useStore.getState().doc;
    return { families: [...BUNDLED_FONTS, ...uploadedFonts(d), ...SYSTEM_FONTS].map((f) => f.family) };
  },

  unused_photos() {
    const d = useStore.getState().doc;
    const used = collectAssetIds(d.nodes);
    return { ids: d.assetOrder.filter((id) => !used.has(id)) };
  },
};

// Email-board methods live with the email engine.
Object.assign(handlers, emailHandlers);

/**
 * Runs one automation method exactly as the bridge does (focus restore, Claude attribution) and
 * returns its result (throws on error). Also handy for dev testing from the page:
 *   (await import('/src/automation.ts')).runAutomation('get_feedback', {})
 */
export async function runAutomation(method: string, params: Params = {}): Promise<unknown> {
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method "${method}". Known: ${Object.keys(handlers).join(', ')}`);
  // Read-only calls must not disturb the user: restore their active board and selection afterwards.
  const before = useStore.getState();
  // Writes aimed at another row also hand focus back, so Claude never yanks the user's active board.
  const targetsOther = !!params.boardId && params.boardId !== before.project.activeBoardId && !ACTIVATES.has(method);
  const restore = READ_ONLY.has(method) || targetsOther ? { board: before.project.activeBoardId, selection: before.selection } : null;
  // Board-scoped methods accept boardId: switch to that board first (the user sees it light up).
  if (params.boardId && !PROJECT_METHODS.has(method) && method !== 'activate_board') {
    useStore.getState().setActiveBoard(requireBoard(params.boardId));
  }
  try {
    return (await asClaude(() => fn(params), `spread_${method}`)) ?? {};
  } finally {
    if (restore) {
      const st = useStore.getState();
      if (st.project.activeBoardId !== restore.board) st.setActiveBoard(restore.board);
      useStore.setState({ selection: restore.selection.filter((id) => !!findNode(useStore.getState().doc.nodes, id)) });
    }
  }
}

export function installAutomation() {
  return onAutomationRequest(async (req) => {
    try {
      await focusForClaude(req.project ?? null, READ_ONLY.has(req.method) || req.method === 'open_project' || req.method === 'new_project' || req.method === 'list_projects');
      respondAutomation({ id: req.id, result: await runAutomation(req.method, req.params ?? {}) });
    } catch (e) {
      respondAutomation({ id: req.id, error: (e as Error).message ?? String(e) });
    }
  });
}
