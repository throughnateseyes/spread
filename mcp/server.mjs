#!/usr/bin/env node
// Spread MCP server — lets Claude (Claude Code, the Claude desktop app, any MCP client) drive the
// running Spread desktop app.
//
// The Electron app exposes a local JSON-RPC bridge and writes its address to
// ~/.spread/bridge.json ({ port, token, pid }). Every tool call re-reads that file
// (the app may have restarted) and POSTs { method, params } to /rpc. The app also writes
// ~/.spread/app.json ({ command, args, cwd }) so spread_launch can start it from anywhere,
// including from the packaged Claude Desktop extension, which doesn't live in the repo.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// stdout carries the MCP protocol; anything a dependency logs (pdf.js warns via console.log) goes to stderr.
console.log = console.error;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HERE, '..');
// SPREAD_HOME points this server at a dev copy of the app (see electron/paths.cjs).
const SPREAD_DIR = process.env.SPREAD_HOME || join(homedir(), '.spread');
const BRIDGE_FILE = join(SPREAD_DIR, 'bridge.json');
const APP_FILE = join(SPREAD_DIR, 'app.json');
// What finished work taught Claude about this user's taste (spacing, type, detail), kept across projects.
const NOTES_FILE = join(SPREAD_DIR, 'design-notes.md');
const NOTE_AREAS = ['hierarchy', 'spacing', 'type', 'color', 'layout', 'detail', 'copy', 'process'];
async function readNotes() {
  try {
    return (await readFile(NOTES_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}
const NOT_RUNNING = `Spread isn't running. Call spread_launch, or ask the user to open the Spread app.`;

class BridgeError extends Error {}

async function readBridge() {
  try {
    const info = JSON.parse(await readFile(BRIDGE_FILE, 'utf8'));
    if (!info.port || !info.token) throw new Error('incomplete');
    return info;
  } catch {
    throw new BridgeError(NOT_RUNNING);
  }
}

async function rpc(method, params = {}, timeoutMs = 120_000) {
  const { port, token } = await readBridge();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-spread-client': clientName(), ...(process.env.SPREAD_PROJECT ? { 'x-spread-project': encodeURIComponent(process.env.SPREAD_PROJECT) } : {}) },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new BridgeError(`Spread took longer than ${timeoutMs / 1000}s to answer "${method}".`);
    throw new BridgeError(NOT_RUNNING);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new BridgeError(`Spread bridge returned HTTP ${res.status} with a non-JSON body.`);
  }
  if (body.error) throw new BridgeError(typeof body.error === 'string' ? body.error : body.error.message ?? JSON.stringify(body.error));
  if (!res.ok) throw new BridgeError(`Spread bridge returned HTTP ${res.status}.`);
  return body.result;
}

async function isRunning() {
  try {
    const { port } = await readBridge();
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Which MCP client is talking to us (e.g. 'claude-code', 'claude-ai'), so the app can show it. */
const clientName = () => server.server.getClientVersion()?.name ?? 'unknown';

/** How to start the app: what the app last recorded in app.json, else `npm run app` in the repo. */
async function launchSpec() {
  try {
    const a = JSON.parse(await readFile(APP_FILE, 'utf8'));
    if (a.command) return { command: a.command, args: a.args ?? [], cwd: a.cwd, shell: false };
  } catch {
    // never opened yet, fall through
  }
  if (existsSync(join(REPO_DIR, 'package.json'))) return { command: 'npm', args: ['run', 'app'], cwd: REPO_DIR, shell: true };
  return null;
}

// Design guides: the same text as the Claude Code skills, served as a tool and as prompts so any
// client (Claude Desktop has no skills folder) gets the workflow and the quality bar. The packaged
// extension carries copies in ./guides; in the repo they're read from .claude/skills.
const GUIDES = {
  director: { skill: 'spread-director', title: 'Creative director', about: 'how to run any new job: a short brief with options, a strategy line, direction concepts approved before building, then presenting and deciding', prompt: 'Start any new piece with Spread’s creative director: a short brief with options, direction concepts to approve, then the work.' },
  document: { skill: 'spread-document', title: 'Pages', about: 'resumes, one-pagers, flyers, posters, presentation slides, LinkedIn/X banners, thumbnails, business cards, single posts' },
  carousel: { skill: 'spread-carousel', title: 'Carousel', about: 'Instagram carousels and seamless multi-slide posts, design directions and variations' },
  eblast: { skill: 'spread-eblast', title: 'Email', about: 'e-blasts and newsletters built as email boards, exported as inbox-safe HTML' },
};

async function readGuide(topic) {
  const { skill } = GUIDES[topic];
  for (const p of [join(HERE, 'guides', `${skill}.md`), join(REPO_DIR, '.claude', 'skills', skill, 'SKILL.md')]) {
    let guide;
    try {
      guide = (await readFile(p, 'utf8')).replace(/^---\n[\s\S]*?\n---\n+/, '');
    } catch {
      continue; // try the next location
    }
    // Every guide ends with what this user's finished work has taught so far.
    const notes = await readNotes();
    return notes
      ? `${guide}\n\n## This user's design notes\n\nLearned from their finished work and hand edits. Follow them; where they disagree with the defaults above, they win.\n\n${notes}\n`
      : guide;
  }
  throw new BridgeError(`The ${topic} guide is missing from this install.`);
}

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

/** Wraps a handler so bridge failures come back as readable tool errors. */
const handle = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (e) {
    return fail(e instanceof BridgeError ? e.message : `Spread error: ${e?.message ?? e}`);
  }
};

/** Simple pass-through tool: params → rpc(method) → JSON text. */
const passthrough = (method, timeoutMs) => handle(async (args) => text(await rpc(method, args, timeoutMs)));

// ---------------------------------------------------------------------------
// Shared descriptions
// ---------------------------------------------------------------------------

const COORDS = `COORDINATES: Each board lays its slides side by side on one horizontal "strip". All x/y are that board's strip-space pixels at 1x export size (per board — the board's position on the shared canvas never matters). Slide i (0-based) spans x ∈ [i*slideWidth, (i+1)*slideWidth), y ∈ [0, slideHeight). Default slides are 1080×1350 (Instagram 4:5 portrait). Anything that crosses a seam at x = k*slideWidth is split across consecutive slides — that is how seamless carousels work (a photo or headline straddling the seam continues when the viewer swipes). Children of frames use coordinates relative to their parent frame; inside auto layout frames x/y are computed and ignored.`;

const BOARDS = `BOARDS: A project holds several boards stacked as rows on one canvas (emails next to each other share one row, side by side, so variations compare at a glance), lettered by position (row A at the top, then B, C…; "row C" = boards[2]). Each board has a status the user sets by hand: 'picked', 'rejected' or null. Each board is one design — kind 'carousel' (a strip of slides), 'email' (600px wide, height grows with content) or 'document' (pages of any size for any medium: resume, flyer, poster, one-pager, banner, single post; units are points, pages never bleed into each other, exports to PDF with real text or PNG) — with its own id, name, note, slide size and layers; the photo tray is shared by all boards. Board-scoped tools act on the ACTIVE board unless you pass boardId (the app then switches to that board, which the user sees highlighted). Board ids are stable; node ids are unique per board.`;

const BOARD_ID_DESC = 'Board to act on (from spread_list_boards / spread_get_state boards[].id). Omit for the active board. Passing it makes that board active.';
const boardId = z.string().optional().describe(BOARD_ID_DESC);

const COLORS = `COLORS: '#RRGGBB' or '#RRGGBBAA'. Text 'fill' is a color string. Shape/frame 'fill' is a Paint: {kind:'solid', color} or {kind:'linear', angle (deg), from, to, grain?} (gradient — great for darkening a photo behind text), {kind:'radial', cx, cy (0-1), radius (1 = the longer side), from, to, grain?}, or {kind:'mesh', points:[{x, y (0-1), color}, ...2-6], softness (0-1), grain?} (colors melting together). grain is 0-1; 0.2-0.4 keeps a gradient from looking digital. Angle is CSS-style, the direction the gradient runs from 'from' to 'to': 0 = to top, 90 = to right, 180 = to bottom, 270 = to left. A scrim that darkens toward the bottom of a slide is {kind:'linear', angle:180, from:'#00000000', to:'#000000B3'}.`;

const NODE_SPEC = `NODE SPEC fields (all optional except type):
- common: key (stable role name, see KEYS), name, link (email boards: the URL this layer and everything inside it goes to; null removes it), x, y, w, h, rotation (deg), opacity (0–1), visible, locked, sizingH/sizingV ('fixed'|'hug'|'fill'; 'fill' only inside auto layout; 'hug' for text and auto layout frames), shadow {enabled, color, x, y, blur}.
- text: text (use \\n for line breaks), fontFamily (call spread_list_fonts; bundled: 'Inter Variable', 'DM Sans Variable', 'Space Grotesk Variable', 'Archivo Variable', 'Playfair Display Variable', 'Fraunces Variable', 'DM Serif Display', 'Instrument Serif', 'Bebas Neue'), fontWeight (100–900; default 600, so always set it for body copy), italic, fontSize (px), lineHeight (multiplier, e.g. 1.1), letterSpacing (percent of size, Figma-style, e.g. -2), align ('left'|'center'|'right'|'justify'), fill (color), uppercase, decoration ('none'|'underline'|'line-through'). Text hugs its content by default; set sizingH:'fixed' and w to wrap at a width. textStyle: a style's name (see spread_list_styles) sets its font, weight, size, line height, letter spacing and case, and the layer follows later changes to it; values passed beside it stay as that layer's own; null unlinks. Color and alignment are never part of a style. spans: style part of the text, like one bold word in a sentence: [{ match: 'Resident Services', fontWeight: 700 }] (match = a piece of the text, first occurrence; all: true for every one), or [{ start, end, ... }] offsets. Each span sets any of fontWeight, italic, fill, decoration; the rest comes from the layer. Spans follow the words when the text changes; pass spans: null to clear them. Use this instead of splitting a sentence into several text layers.
- image: assetId (from spread_get_state photos / spread_import_photos; null = empty placeholder), fit ('fill' crops to cover | 'fit'), crop {zoom ≥1, cx, cy} (focal point 0–1), radius, flipX, flipY, adjust {brightness, contrast, saturation} (each -1..1), effects (array, run in order, non-destructive, omitted fields use defaults): [{ type:'dither', pattern 'ordered'|'diffusion'|'noise', size (cell in layer px, 1-24), levels (2-8), mode 'duotone'|'photo', ink, paper, enabled, name }, { type:'grain', amount 0-1, size (1-8), enabled, name }, { type:'blur', mode 'even'|'progressive', amount (radius in layer px, 1-120), direction 'top'|'bottom'|'left'|'right' (side the blur grows towards), start 0-0.9 (how much stays sharp), enabled, name }]. Send the whole array when changing it, stroke, strokeWidth.
- rect / ellipse: fill (Paint), stroke, strokeWidth, radius, backdropBlur (blurs what's behind it, layer px 0-120; needs a see-through fill, e.g. '#FFFFFF33').
- frame: space ({ gap, padding, paddingX, paddingY } naming spacing tokens; sets those values and follows later changes to the token; null unlinks), fill (Paint|null; default null, so a frame is see-through until you give it one), radius, clip, stroke, strokeWidth, backdropBlur, layout ('none'|'row'|'column' = auto layout), gap (default 0), padding (number, {x,y} or {t,r,b,l}; default 0), alignItems ('start'|'center'|'end'), justify ('start'|'center'|'end'|'between'), children (NodeSpec[]).`;

const KEYS = `KEYS: any node may carry key (a stable role name). Unlike ids, keys survive board duplication, so the same layer has the same key on every variation row. Give important layers keys like headline, subhead, address, price, cta, scrim-1, photo-1… so you can restyle the same layer across rows in one call (spread_make_variants changes, update/delete by key).`;

/** Row letter by position: A, B, … Z, AA … (matches the chip in each board header). */
const rowLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : rowLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

const nodeSpec = z
  .object({ type: z.enum(['text', 'image', 'rect', 'ellipse', 'frame']) })
  .passthrough()
  .describe('A node: { type, ...props }. See the tool description for fields. Frames may nest `children`.');

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'spread', version: '0.2.0' },
  {
    instructions: `Spread is the user's local design canvas (a Figma replacement): carousels, emails, and pages of any size (resumes, posters, slides, banners). These tools drive the running desktop app live — the user sees every change on their canvas and can tweak by hand afterwards. You design and iterate; the user directs and makes the final call.
STYLES: a project can have named text styles and spacing tokens (get_state lists them as styles). When it does, set textStyle on text and space on auto layout frames instead of raw values, and to change a type or spacing decision change the style once with spread_save_styles rather than editing layers.
BRAND: every project uses one brand kit or none (get_state/get_feedback report it). With a brand, call spread_get_brand and design with only its fonts, colors, type scale, spacing and rules; spread_lint flags anything off-brand. With none (a personal project), use no brand's assets. Never switch a project's brand unless the user asks.
FEWER CALLS: chain steps with spread_batch (e.g. update_nodes → lint → render_slides in one call). Each call may cost the user a permission click.
NEW WORK: act as the user's senior designer and marketing lead. Call spread_guide('director') first and run its brief: one round of questions with options (how many directions, which territory), a strategy line, and direction concepts the user approves before you build. Skip the questions only when the brief is already complete or the user says "just make it".
BEFORE DESIGNING ANYTHING, call spread_guide with the medium (document = any page-based work, carousel, eblast) and follow it: it is the workflow and the quality bar (setup, the lint Floor, the Bar, directions, export). If a guide is already loaded as a skill, you don't need to call it.
Quick post: spread_get_state → spread_import_photos(folder) → spread_arrange → spread_add_nodes (typography) → spread_render_slides (LOOK at the images) → spread_update_nodes to fix → spread_export_slides.
Ideation ("give me 3 directions"): plan each direction's idea first, then build each as its own board (spread_create_board with a name and note, then spread_add_nodes with keyed layers) → spread_render_overview to self-review → present rows with a recommendation → wait for the user's pick. spread_make_variants copies one board: use it for takes within one direction ("push C further"), never to fake different directions.
E-blast: spread_list_email_templates (the user's saved: templates first) → spread_create_email {template} → fill every {{TOKEN}} with spread_update_nodes → spread_update_board {subject, preheader} → spread_render_slides (look) → spread_preview_email (the real HTML on desktop and phone; fix its checks) → spread_email_html (fix warnings, stay under 100 KB) → spread_export_email {host: 'wordpress'} (or, without WordPress, export → user uploads → export again with baseUrl).
LIBRARY: the user's saved templates and references (spread_list_library). Before designing something new, look at the references of the same kind (Read their images) and follow what the user said makes them good. When the user loves a result, offer once to save it as a reference (spread_save_reference) or a template (spread_save_template).
When something looks unexpected, spread_history says who changed it and when.
DESIGN NOTES: the user's taste, learned from finished work, rides along at the end of every spread_guide. When a project wraps (a row picked as final, or "we're done"), read get_feedback's handEdits on that row: they are the corrections the user made to your work. Turn the ones that generalize into rules with spread_add_design_notes and say in a line what you saved.
Follow-up turns: call spread_get_feedback FIRST, unless a <spread-context> block (Spread's own chat panel) shows nothing changed since your last turn (picked/rejected rows, current selection, hand edits). Never overwrite layers listed in userTouched without asking; leave rejected rows alone.
When the user says "this", "the selected text" or "this row", the selection and activeBoardId from spread_get_feedback (or spread_get_state) are the referent. Rows are lettered A, B, C… from the top.
${BOARDS}
${COORDS}`,
  },
);

// Safety hints on every tool, so clients can ask less often: looking is read-only, and only a few
// tools can lose work (deleting rows or layers, replacing the open project).
const READ_ONLY_TOOLS = new Set(['spread_design_notes', 'spread_send_check', 'spread_history', 'spread_compare_overlay', 'spread_preview_email', 'spread_list_styles', 'spread_list_links', 'spread_list_projects', 'spread_list_library', 'spread_guide', 'spread_get_state', 'spread_list_boards', 'spread_get_feedback', 'spread_render_overview', 'spread_render_slides', 'spread_list_email_templates', 'spread_email_html', 'spread_list_fonts', 'spread_lint', 'spread_pdf_text', 'spread_list_brands', 'spread_get_brand']);
const DESTRUCTIVE_TOOLS = new Set(['spread_delete_board', 'spread_delete_nodes', 'spread_new_project', 'spread_open_project']);
function tool(name, config, cb) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  const annotations = { readOnlyHint: readOnly, destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(name), idempotentHint: readOnly, openWorldHint: false, ...config.annotations };
  return server.registerTool(name, { ...config, annotations }, cb);
}

tool(
  'spread_launch',
  {
    title: 'Launch Spread',
    description: `Starts the Spread desktop app if it isn't already running (first launch can take ~30s). Call this only after another spread_ tool reported that Spread isn't running.`,
    inputSchema: {},
  },
  handle(async () => {
    if (await isRunning()) return text('Spread is already running.');
    const spec = await launchSpec();
    if (!spec) return fail(`Spread has never been opened on this computer, so I don't know where it is. Ask the user to open the Spread app once.`);
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, detached: true, stdio: 'ignore', shell: spec.shell, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isRunning()) return text('Spread launched and the bridge is up.');
    }
    return fail(`Started Spread but the bridge didn't come up within 90s. Ask the user to check the Spread window.`);
  }),
);

tool(
  'spread_guide',
  {
    title: 'Design guide',
    description: `Returns Spread's design workflow and quality bar for a medium. Call it before designing anything and follow it. Topics: ${Object.entries(GUIDES)
      .map(([k, g]) => `'${k}' (${g.about})`)
      .join('; ')}. Read-only; works without the app running.`,
    inputSchema: { topic: z.enum(Object.keys(GUIDES)).describe('director for running any new job, or the medium to design for') },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ topic }) => text(await readGuide(topic))),
);

tool(
  'spread_design_notes',
  {
    title: 'Design notes',
    description: "Returns the user's design notes: what their finished work and hand edits have taught about their taste in spacing, hierarchy, type and detail, kept across every project. spread_guide already appends them; call this to review them before writing new ones. Read-only; works without the app running.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handle(async () => text((await readNotes()) || 'No design notes yet.')),
);

tool(
  'spread_add_design_notes',
  {
    title: 'Save design notes',
    description: `Saves lessons from a finished design to the user's design notes, which every later design turn reads (spread_guide appends them). Use it when a project wraps up (a row is picked as final, or the user says it's done) or when the user asks you to remember a design lesson. Source the notes from what actually happened: get_feedback's handEdits on the final row (what they corrected by hand after you), their pick and reject reasons, and what they said. Write each note as a rule with numbers that transfers to the next job ("Title and its meta line sit 8pt apart, 32pt to the body; hierarchy groups, not one even gap"), not a description of this one piece. One idea per note, no duplicates of notes already saved (read spread_design_notes first). Tell the user in a line what you saved. Pass rewrite instead to replace the whole file when merging or pruning notes the user asked to change. Returns the saved notes.`,
    inputSchema: {
      notes: z
        .array(z.object({ area: z.enum(NOTE_AREAS), note: z.string().min(8), from: z.string().optional().describe('The project or piece it came from') }))
        .optional(),
      rewrite: z.string().optional().describe('Replaces every note with this markdown (one "- [area] note" per line)'),
    },
  },
  handle(async ({ notes, rewrite }) => {
    await mkdir(SPREAD_DIR, { recursive: true });
    if (typeof rewrite === 'string') {
      await writeFile(NOTES_FILE, rewrite.trim() + '\n');
      return text(await readNotes());
    }
    if (!notes?.length) return fail('Pass notes: [{ area, note }] or rewrite.');
    const have = await readNotes();
    const day = new Date().toISOString().slice(0, 10);
    const fresh = notes.filter((n) => !have.toLowerCase().includes(n.note.trim().toLowerCase()));
    if (!fresh.length) return text('Those notes are already saved.');
    const lines = fresh.map((n) => `- [${n.area}] ${n.note.trim().replace(/\s+/g, ' ')}${n.from ? ` (${n.from.trim()}, ${day})` : ` (${day})`}`);
    await appendFile(NOTES_FILE, (have ? '\n' : '# Design notes\n\n') + lines.join('\n'));
    return text(await readNotes());
  }),
);

// The same guides as prompts, so a newcomer can pick "Spread: Pages" from the client's prompt menu.
for (const [topic, g] of Object.entries(GUIDES)) {
  server.registerPrompt(
    `spread-${topic}`,
    {
      title: `Spread: ${g.title}`,
      description: g.prompt ?? `Design ${g.about} in Spread, following Spread's workflow and quality bar.`,
      argsSchema: { brief: z.string().optional().describe('What to make, for whom, and where the content is') },
    },
    async ({ brief }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `${await readGuide(topic)}\n\n---\n\nFollow the guide above to design this in Spread: ${brief?.trim() || 'ask me what to make (one short message), then start.'}` },
        },
      ],
    }),
  );
}

tool(
  'spread_get_state',
  {
    title: 'Get Spread document',
    description: `Returns one board (the active one, or boardId): boardId, kind, note, name, slideWidth, slideHeight, slideCount, background, slides [{index, background}], layout grid, selection (node ids the user has selected on the active board), the full node tree (every stored prop plus \`box\` {x,y,w,h} = resolved absolute strip coordinates, and children for frames), the photo tray [{id, name, width, height, usedCount}], and boards[] (every board: id, index, name, kind, note, active, slideCount, nodeCount). Call this first and again whenever you need fresh ids or positions (the user may have edited by hand). When the user says "this", "the selected text", "this row", etc., call this and treat the current selection / active board as what they mean (pass no boardId, so you read the board they are on). Read it BEFORE anything that switches boards — switching (another boardId, render_overview) clears the selection.
${BOARDS}
${COORDS}`,
    inputSchema: {
      boardId,
      detail: z.enum(['full', 'outline']).optional().describe("'outline' trims the node tree to id, key, name, type, box, text (first 60 characters), link and children: use it to find layers on a big board, then 'full' (the default) when you need their props."),
    },
    annotations: { readOnlyHint: true },
  },
  passthrough('get_state'),
);

// ---------------------------------------------------------------------------
// Boards (rows of variations)
// ---------------------------------------------------------------------------

tool(
  'spread_list_links',
  {
    title: 'List every link and picture on a board',
    description: "Lists every linked layer on a board, top to bottom: { tracking, needAttention, links: [{ id, key, name, type, url, shipsAs (url with tracking), issue }] }. issue is null, 'empty', 'placeholder' (still a {{TOKEN}}) or 'invalid'. Email boards also get what the user's Links panel shows: { pictureHosting (the board's saved choice: mode 'wordpress' | 'base' with baseUrl | 'each' with urls), toFix, items: [{ id, section, name, link, suggested (looks like a button but has no link: ask the user, don't invent a URL), fix, status, pictures: [{ nodeId, fileName, status, text }] }] }. Fix links with spread_update_nodes { updates: [{ id, link }] }.",
    inputSchema: { boardId },
  },
  passthrough('list_links'),
);

tool(
  'spread_list_styles',
  {
    title: 'List text styles and spacing',
    description: "Lists the project's named styles, shared by every board: { textStyles: [{ id, name, fontFamily, fontWeight, italic, fontSize, lineHeight, letterSpacing, uppercase, layers }], spacing: [{ id, name, value, frames }], unstyled: [{ ...look, layers, sample }] }. unstyled groups text with no style by how it looks, most used first: the styles the project is already using without names. Read-only.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  passthrough('list_styles'),
);

tool(
  'spread_save_styles',
  {
    title: 'Save text styles and spacing',
    description: "Adds or changes named styles in one undo step. One change here replaces editing every layer: all linked layers on every board follow, except a value set by hand on a layer, which stays (get_state detail 'outline' shows those as differs; spread_lint flags them under text-style). textStyles match by id or name: an existing style changes only the fields you pass; a new one needs fontFamily and fontSize, or from (a text layer's id or key on the active board, or boardId, to copy its look). linkMatching: true also links every layer on every board that already looks exactly like it, which is how to name what spread_list_styles reports as unstyled. spacing tokens need a value when new. rename gives either a new name. delete takes names or ids; layers keep their values and just stop following. Link layers with textStyle and space on spread_add_nodes / spread_update_nodes. Returns the same as spread_list_styles, plus linked.",
    inputSchema: {
      boardId,
      textStyles: z
        .array(
          z.object({
            name: z.string(),
            id: z.string().optional(),
            rename: z.string().optional(),
            from: z.string().optional().describe("A text layer's id or key to copy the look from."),
            linkMatching: z.boolean().optional(),
            fontFamily: z.string().optional(),
            fontWeight: z.number().optional(),
            italic: z.boolean().optional(),
            fontSize: z.number().positive().optional(),
            lineHeight: z.number().positive().optional().describe('Multiplier, e.g. 1.4.'),
            letterSpacing: z.number().optional().describe('Percent of the size.'),
            uppercase: z.boolean().optional(),
          }),
        )
        .optional(),
      spacing: z.array(z.object({ name: z.string(), id: z.string().optional(), rename: z.string().optional(), value: z.number().min(0).optional() })).optional(),
      delete: z.array(z.string()).optional().describe('Names or ids of styles and tokens to remove.'),
    },
  },
  passthrough('save_styles'),
);

tool(
  'spread_repeat',
  {
    title: 'Repeat a card from a table',
    description: "Fills a grid from data: build ONE card, then pass rows instead of building each card by hand. Pass the card's id or key. It stays as the first card, wrapped in a repeat frame in the same spot. Without fields, every text and photo in the card changes per card, each named after its layer's key or name. To choose, pass fields { field: layer key or id } for text and photos and links { field: layer key or id } for links, and write {{field}} inside any text or link in the card, like '{{beds}} bed · {{baths}} bath', to build a line from several fields, and in a photo's layer name for alt text per card ('Photo [alt:{{unit}} living room]'). Layers with no field stay the same on every card. rows: [{ field: value }], one per card, replacing the table; a field left out of a row keeps the first row's value. Photo values can be a photo id or name, a web link or a file path; Spread downloads them. Call again on the repeat frame or any card to change rows, columns or gap, or with stop: true to keep the cards as plain layers. After that, change the design with spread_update_nodes on any card: style changes reach every card, a value change goes to that card's row. get_state detail 'outline' shows a repeat as one card plus its fields. Returns { id, cardId, fields, columns, cards, failed }, where failed lists photos that couldn't be fetched.",
    inputSchema: {
      boardId,
      id: z.string().optional(),
      key: z.string().optional(),
      columns: z.number().int().min(1).max(6).optional().describe('Cards per line (default 1).'),
      gap: z.number().optional().describe('Space between cards, both ways (default 16).'),
      fields: z.record(z.string()).optional(),
      links: z.record(z.string()).optional(),
      rows: z.array(z.record(z.any())).optional(),
      stop: z.boolean().optional(),
    },
    annotations: { openWorldHint: true }, // photo values can be web links
  },
  passthrough('repeat'),
);

tool(
  'spread_wrap_nodes',
  {
    title: 'Wrap layers in a frame',
    description: "Wraps existing layers in a new frame without rebuilding them; they keep their ids, keys and content. Pass ids and/or keys of layers that share a parent. Auto layout keeps the arrangement, like Figma's Shift+A: the direction comes from how the layers are stacked (or pass layout 'row' or 'column'), the gap is the space already between them (two layers keep their exact gap; three or more get one even gap), and the cross alignment is the edge they share. layout 'none' makes a plain frame that keeps them where they are. The frame starts with no fill and padding 0; pass gap, padding or any other frame props to override. Returns { id, wrapped }.",
    inputSchema: {
      boardId,
      ids: z.array(z.string()).optional(),
      keys: z.array(z.string()).optional(),
      layout: z.enum(['none', 'row', 'column']).optional(),
      gap: z.number().optional(),
      padding: z.union([z.number(), z.object({}).passthrough()]).optional(),
      fill: z.any().optional().describe('Paint, a color string, or null.'),
      name: z.string().optional(),
      key: z.string().optional(),
      alignItems: z.enum(['start', 'center', 'end']).optional(),
      justify: z.enum(['start', 'center', 'end', 'between']).optional(),
      radius: z.number().optional(),
      link: z.string().optional(),
    },
  },
  passthrough('wrap_nodes'),
);

tool(
  'spread_list_boards',
  {
    title: 'List boards (rows)',
    description: `Lists every board in the project, top row first: { activeBoardId, boards: [{ id, index (0-based row), name, kind, note, active, slideCount, slideWidth, slideHeight, nodeCount }] }. Cheaper than spread_get_state when you only need the rows. Row letter = index (A = 0); "row 3" = index 2.
${BOARDS}`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  passthrough('list_boards'),
);

tool(
  'spread_activate_board',
  {
    title: 'Activate board',
    description: 'Makes a board the active one (the app highlights it and fits it in view). Tools called without boardId then act on it. Useful to point the user at the row you are talking about. Returns { activeBoardId }.',
    inputSchema: { boardId: z.string().describe('Board id to activate.') },
  },
  passthrough('activate_board'),
);

tool(
  'spread_create_board',
  {
    title: 'Create board',
    description: `Adds a new, empty board as a row — right after afterBoardId, or at the bottom when omitted — and makes it active. kind 'carousel' (default; slideWidth/slideHeight default 1080×1350, slideCount default 3), 'email' (600px wide, height grows with content; slide size params ignored) or 'document' (pages: preset 'letter' 612×792 by default, or slideWidth/slideHeight in pt; pageCount; margins in pt, default 54 = 0.75in; baseline grid step in pt, 0 = off). Document units are points (72/in): fontSize 10 = 10pt. Screen sizes work too (e.g. 1584×396 for a LinkedIn banner): units then map 1:1 to PNG pixels at 1x. The shared photo tray carries over. Use this for a genuinely different design; for variations of an existing one prefer spread_duplicate_board. Always give a name and, for a variation or alternative, a note. Returns { boardId, boards }.
${BOARDS}`,
    inputSchema: {
      kind: z.enum(['carousel', 'email', 'document']).optional(),
      name: z.string().optional(),
      preset: z.enum(['letter', 'legal', 'tabloid', 'a5', 'a4', 'a3', 'poster-18x24', 'poster-24x36', 'business-card', 'presentation', 'instagram-post', 'story', 'linkedin-post', 'linkedin-banner', 'x-header', 'youtube-thumbnail']).optional().describe("Document page size (kind 'document'). Print presets are in points; screen presets in px."),
      landscape: z.boolean().optional().describe('Document: swap the preset to landscape.'),
      units: z.enum(['pt', 'px']).optional().describe("Document units: 'pt' for print (default; PDF page = size/72 in), 'px' for screen (default for screen presets)."),
      pageCount: z.number().int().min(1).max(40).optional().describe('Document: number of pages (default 1).'),
      margins: z.union([z.number(), z.object({ t: z.number().optional(), r: z.number().optional(), b: z.number().optional(), l: z.number().optional() })]).optional().describe('Document margins in pt (one number for all sides).'),
      baseline: z.number().optional().describe('Document baseline grid step in pt (e.g. 4 or 6). Text tops and gaps should land on multiples of it; spread_lint checks.'),
      note: z.string().optional().describe('One or two sentences explaining the idea of this board.'),
      slideWidth: z.number().optional(),
      slideHeight: z.number().optional(),
      slideCount: z.number().int().min(1).max(40).optional(),
      background: z.string().optional().describe("Board background color, e.g. '#FFFFFF'."),
      afterBoardId: z.string().optional().describe('Insert the new row right after this board.'),
    },
  },
  passthrough('create_board'),
);

tool(
  'spread_duplicate_board',
  {
    title: 'Duplicate board (make variations)',
    description: `Copies a board (boardId, default the active one) count times (1–10). Copies land as rows directly below the source, in order, and the last copy becomes active. For takes on a direction prefer spread_make_variants (copies AND restyles in one call without moving the user's focus); use this for a plain copy. Copies share the photo tray; every layer gets a NEW id but keeps its key — address layers by key, or call spread_get_state {boardId} on each copy for ids.
Name each copy for its direction (names[i], e.g. "B — Collage, Bebas + Inter, warm") and ALWAYS give each a note (notes[i]) explaining the idea in one or two sentences — the user compares rows by these notes. For a single copy you may use name/note instead of names/notes. Returns { boardIds (in row order), boards }.`,
    inputSchema: {
      boardId: z.string().optional().describe('Board to copy (default: the active board).'),
      count: z.number().int().min(1).max(10).optional().describe('Number of copies (default 1).'),
      name: z.string().optional().describe('Name for a single copy.'),
      note: z.string().optional().describe('Note for a single copy.'),
      names: z.array(z.string()).optional().describe('One name per copy, in order.'),
      notes: z.array(z.string()).optional().describe('One note per copy, in order.'),
    },
  },
  passthrough('duplicate_board'),
);

tool(
  'spread_update_board',
  {
    title: 'Rename board / edit note / set status',
    description: "Sets a board's name, note, status, and for email boards the subject, preheader and link tracking (boardId, default the active board). Update the note whenever you change a variation's direction so it still describes what the row shows. status: 'picked' | 'rejected' | null. The user normally sets status (Ctrl+Enter / Ctrl+Backspace); set it yourself only when they tell you to (\"go with C\" → picked). Returns { boards }.",
    inputSchema: {
      boardId,
      name: z.string().optional(),
      note: z.string().optional(),
      status: z.enum(['picked', 'rejected']).nullable().optional().describe("'picked', 'rejected', or null to clear."),
      statusReason: z.string().nullable().optional().describe('Why the user picked or rejected it, in their words. Normally the user sets this in the row header.'),
      subject: z.string().optional().describe('Email boards: the subject line (under ~60 characters; also the HTML title).'),
      preheader: z.string().optional().describe('Email boards: the inbox preview text after the subject (40–90 characters, not repeating the subject).'),
      tracking: z.string().optional().describe('Email boards: tags added to every web link at export, e.g. "utm_source=newsletter&utm_campaign=october". Layers keep their plain URLs; tags a URL already has, mailto:, tel:, placeholders and unsubscribe links are left alone. "" clears it.'),
    },
  },
  passthrough('update_board'),
);

tool(
  'spread_get_feedback',
  {
    title: 'Get user feedback (picks, rejects, selection, hand edits)',
    description: `What the user has said with the mouse since your last change. Call this FIRST on every follow-up turn of an ideation loop, before changing anything. Returns { activeBoardId, selection: [{ id, key, name, type, text }] (layers selected on the active row — what "this" means), boards: [{ id, row (1-based; letter A = row 1), name, note, status ('picked'|'rejected'|null), claudeLastEditedAt, userEditsSinceClaude, userTouched: [{ id, key, name, type, text }], handEdits: ['“Title block”: Gap 16 → 12', …] (the net changes the user made by hand since your last edit) }] }.
Rules: treat picked rows as the direction to push; leave rejected rows alone unless asked; never overwrite a userTouched layer (or redo a row with userEditsSinceClaude > 0) without asking. Learn from hand edits — e.g. if the user moved the price on B, offer to apply that to the other rows; when the work is final, save what they teach with spread_add_design_notes. Read-only: does not move the user's focus.`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  passthrough('get_feedback'),
);

const changeSpec = z
  .object({ key: z.string().optional(), id: z.string().optional() })
  .passthrough()
  .describe('{ key | id, ...props }: a NODE SPEC patch. key hits every layer with that key on the copy; id = a layer id from the SOURCE board (remapped to the copy).');

tool(
  'spread_make_variants',
  {
    title: 'Make variations (ideation batch)',
    description: `Makes takes on ONE direction: copies a source board (boardId, default the active one) once per variant and restyles each copy, all in one call. Copies land as rows directly below the source, in order. The user's active row and selection are untouched; each variant is one undo step.
Per variant, applied in this order: name + note → arrange (re-lays out the copy's existing photos in place: mode 'one-per-slide'|'panorama'|'collage'|'brick', gap, margin, radius, slides; keys, crops and text survive. The slide count becomes what the layout needs (or slides). Captions inside a photo on a middle slide follow that photo; layers on the last slide (price, CTA) move to the new last slide with its background; everything else keeps its slide. Still render and check: a new layout can put type over a busy area) → changes (patches addressed by key, or by source-board id) → add (new layers, NODE SPECs, may carry keys).
Build the base with keyed layers first (headline, subhead, price, cta, photo-1…), then vary on purpose: layout, type pairing, color, crop emphasis, text placement. Name rows "<idea in 2–4 words>" (e.g. "Brick, Fraunces, warm"); note = one sentence of intent + one of the tradeoff.
Returns { boardIds, boards: [{ boardId, row, letter, name }], missing: [{ boardId, variant, refs }] } — missing lists keys/ids that matched nothing (fix with spread_update_nodes {boardId}). Follow with spread_render_overview.
${KEYS}
${COLORS}`,
    inputSchema: {
      boardId: z.string().optional().describe('Source board (default: the active board). It is not modified.'),
      variants: z
        .array(
          z.object({
            name: z.string().describe('Row name, e.g. "Collage, Bebas + Inter, warm".'),
            note: z.string().describe('Intent + tradeoff, one sentence each.'),
            arrange: z
              .object({
                mode: z.enum(['one-per-slide', 'panorama', 'collage', 'brick']),
                gap: z.number().optional(),
                margin: z.number().optional(),
                radius: z.number().optional(),
                slides: z.number().int().min(1).max(20).optional().describe('Target slide count (panorama, collage, brick). Default: what the photos need.'),
              })
              .optional(),
            changes: z.array(changeSpec).optional(),
            add: z.array(nodeSpec).optional(),
          }),
        )
        .min(1)
        .max(10),
    },
  },
  passthrough('make_variants', 180_000),
);

tool(
  'spread_delete_board',
  {
    title: 'Delete board',
    description: "Deletes a board (row) and its layers; the shared photo tray is kept. The last remaining board can't be deleted. Undoable in the app, but confirm with the user before deleting a row they made or edited by hand. Returns { boards }.",
    inputSchema: { boardId: z.string().describe('Board id to delete.') },
    annotations: { destructiveHint: true },
  },
  passthrough('delete_board'),
);

tool(
  'spread_render_overview',
  {
    title: 'Render rows overview (compare variations)',
    description: `Renders each board as one full-strip image (all slides side by side) so you can compare variations at a glance — use it after building a set of variations to self-review (consistency, which rows are weak or too similar), and to show the user what each row looks like. boardIds = subset (default every board). maxSide = longest side of each image in px (default 2000; use ~1400 when comparing many rows, render single slides with spread_render_slides for fine type). Each image is preceded by "Row <letter> (n) — name — [status] — note — boardId".`,
    inputSchema: {
      boardIds: z.array(z.string()).optional(),
      maxSide: z.number().int().min(200).max(4000).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  handle(async (args) => {
    const r = await rpc('render_overview', args, 300_000);
    const images = r?.images ?? [];
    let rowOf = new Map();
    let statusOf = new Map();
    try {
      const fb = await rpc('get_feedback', {});
      (fb?.boards ?? []).forEach((b, i) => {
        rowOf.set(b.id, i);
        statusOf.set(b.id, b.status);
      });
    } catch {
      /* row letters are a nicety */
    }
    const content = [{ type: 'text', text: `Rendered ${images.length} board(s).` }];
    images.forEach((img, i) => {
      const idx = rowOf.has(img.boardId) ? rowOf.get(img.boardId) : i;
      const note = img.note ? img.note : '(no note)';
      const status = statusOf.get(img.boardId) ? ` [${statusOf.get(img.boardId)}]` : '';
      content.push({ type: 'text', text: `Row ${rowLetter(idx)} (${idx + 1}) — ${img.name}${status} — ${note} — ${img.boardId} (${img.slideCount} slide${img.slideCount === 1 ? '' : 's'}, ${img.width}×${img.height})` });
      content.push({ type: 'image', data: img.base64, mimeType: img.mime ?? 'image/jpeg' });
    });
    return { content };
  }),
);

tool(
  'spread_import_photos',
  {
    title: 'Import photos / folders',
    description: `Imports image files and/or whole folders (recursive) into the Spread photo tray, plus font files (.ttf/.otf/.woff/.woff2), which become usable fontFamily values. Use absolute paths — e.g. the folder of listing photos another skill produced. Returns { assetIds (in natural filename order), fonts (family names), skipped (unsupported files) }. iPhone HEIC photos are converted to JPEG automatically. The tray is shared by every board, so import once and reuse the same assetIds on all variations. Importing does NOT place photos on slides — follow with spread_arrange or spread_add_nodes (type:'image', assetId).`,
    inputSchema: { paths: z.array(z.string()).min(1).describe('Absolute file or folder paths.') },
  },
  passthrough('import_photos', 300_000),
);

tool(
  'spread_arrange',
  {
    title: 'Auto-arrange photos across slides',
    description: `Lays photos out across slides in a seamless carousel pattern and sets the slide count to fit. Modes:
- 'one-per-slide': each photo full-bleed on its own slide.
- 'panorama': photos edge-to-edge in one continuous full-height row, scaled to fill whole slides — seams cut through photos (the classic SCRL look).
- 'collage': full-height tiles with a repeating wide/narrow/medium rhythm so seams land inside photos.
- 'brick': two rows, the second offset by half a slide — strong cross-seam continuity.
assetIds defaults to the whole tray (or the tray selection). gap/margin/radius are px. replace:true clears ALL existing layers on the board first (text too — re-add type afterwards); otherwise new slides are appended after the last one (an empty board is always replaced). Returns { slideCount, nodeIds }. After arranging, add text on top with spread_add_nodes and check with spread_render_slides.`,
    inputSchema: {
      mode: z.enum(['one-per-slide', 'panorama', 'collage', 'brick']),
      assetIds: z.array(z.string()).optional(),
      gap: z.number().optional().describe('Gap between photos in px (default 0).'),
      margin: z.number().optional().describe('Outer margin in px (default 0).'),
      radius: z.number().optional().describe('Corner radius in px (default 0).'),
      slides: z.number().int().min(1).max(20).optional().describe("Target slide count for panorama, collage and brick (photos widen or narrow to fill it). Default: what the photos naturally need — 8 landscape photos in panorama is about 15 slides, so pass this whenever the brief names a count. Ignored by 'one-per-slide'."),
      replace: z.boolean().optional().describe('Replace everything instead of appending.'),
      boardId,
    },
  },
  passthrough('arrange'),
);

tool(
  'spread_add_nodes',
  {
    title: 'Add layers',
    description: `Adds layers (text, image, rect, ellipse, frame) to a board (active, or boardId), top-most last. Optional parentId adds them inside that frame (coordinates then relative to the frame; ignored if it uses auto layout). Returns { ids } in the same order (nested children's ids are in get_state).
${KEYS}
${COORDS}
${COLORS}
${NODE_SPEC}
Design tips: keep text inside a 60–80px safe margin from slide edges; avoid putting words across a seam unless the split is intentional; put a linear-gradient rect between a photo and white text for legibility; use auto layout frames (layout:'column', sizingH/V:'hug', gap) for stacked text blocks so spacing stays consistent.`,
    inputSchema: {
      nodes: z.array(nodeSpec).min(1),
      parentId: z.string().optional().describe('Frame id to add into.'),
      boardId,
    },
  },
  passthrough('add_nodes'),
);

tool(
  'spread_update_nodes',
  {
    title: 'Update layers',
    description: `Patches existing layers on one board (active, or boardId — ids are per board): updates = [{ id | key, ...props }]. A key patches every layer with that key on the board. Any NODE SPEC prop can be patched (x, y, w, h, text, fontSize, fill, crop, adjust, layout, ...). Nested objects (padding, crop, adjust, shadow, fill) are replaced wholesale — send the full object. Setting w/h on a 'hug' axis has no effect until you set sizingH/sizingV to 'fixed'. Returns { updated, missing (refs that matched nothing) }. One call = one undo step for the user.
${KEYS}
${COORDS}
${COLORS}`,
    inputSchema: {
      updates: z.array(z.object({ id: z.string().optional(), key: z.string().optional() }).passthrough()).min(1).describe('[{ id | key, ...props }]'),
      boardId,
    },
  },
  passthrough('update_nodes'),
);

tool(
  'spread_delete_nodes',
  {
    title: 'Delete layers',
    description: 'Deletes layers by id and/or key on one board (active, or boardId; a key deletes every layer with that key; deleting a frame deletes its children). Photos stay in the tray. To remove a whole row use spread_delete_board. Returns { deleted }.',
    inputSchema: { ids: z.array(z.string()).optional(), keys: z.array(z.string()).optional().describe('Layer keys, e.g. ["subhead"].'), boardId },
    annotations: { destructiveHint: true },
  },
  passthrough('delete_nodes'),
);

tool(
  'spread_set_document',
  {
    title: 'Set document settings',
    description: `Changes one board's settings (active, or boardId): name (also the default export filename prefix), slideWidth/slideHeight (presets: 1080×1350 portrait 4:5 [default], 1080×1440 tall 3:4, 1080×1080 square, 1080×1920 story 9:16, 1080×566 landscape), slideCount (1–40; removing slides drops them from the end), background (color), slideBackgrounds (per-slide color overrides by index, null = use the board background — e.g. a dark finale: [null, null, null, null, null, null, '#1F2A24']), grid ({ visible, columns: {count, gutter, margin}, rows: {count, gutter, margin}, color }). Changing slide size does not move existing layers. Returns a state summary.`,
    inputSchema: {
      name: z.string().optional(),
      slideWidth: z.number().optional(),
      slideHeight: z.number().optional(),
      slideCount: z.number().int().optional(),
      background: z.string().optional(),
      slideBackgrounds: z.array(z.string().nullable()).optional().describe('Per-slide background colors by slide index; null keeps the board background.'),
      margins: z.union([z.number(), z.object({ t: z.number().optional(), r: z.number().optional(), b: z.number().optional(), l: z.number().optional() })]).optional().describe('Document boards: page margins in pt.'),
      baseline: z.number().optional().describe('Document boards: baseline grid step in pt (0 = off).'),
      grid: z.object({}).passthrough().optional(),
      boardId,
    },
  },
  passthrough('set_document'),
);

tool(
  'spread_select',
  {
    title: 'Select layers',
    description: 'Selects layers on a board (active, or boardId; pass [] to clear) and zooms to them — useful to point the user at something you want them to tweak by hand.',
    inputSchema: { ids: z.array(z.string()), boardId },
  },
  passthrough('select'),
);

tool(
  'spread_render_slides',
  {
    title: 'Render slides (look at your work)',
    description: `Renders slides of one board (active, or boardId) to JPEG images and returns them so you can SEE the result. To compare whole rows use spread_render_overview. Always render after laying out and before exporting: check text legibility and contrast, safe margins, awkward words or faces cut by a seam, crop focal points, alignment across slides. slides = 0-based indices (default all); scale defaults to 0.4 (432px wide for a 1080 slide) — use 0.6–1 to inspect fine typography. Rendering every slide of a long carousel at high scale is large; render a subset when iterating.`,
    inputSchema: {
      slides: z.array(z.number().int().min(0)).optional(),
      scale: z.number().min(0.1).max(1).optional(),
      boardId,
    },
    annotations: { readOnlyHint: true },
  },
  handle(async (args) => {
    const r = await rpc('render_slides', args, 180_000);
    const images = r?.images ?? [];
    const content = [{ type: 'text', text: `Rendered ${images.length} slide(s): ${images.map((i) => i.index + 1).join(', ')} (1-based slide numbers, shown in order).` }];
    for (const img of images) {
      content.push({ type: 'text', text: `Slide ${img.index + 1}` });
      content.push({ type: 'image', data: img.base64, mimeType: img.mime ?? 'image/jpeg' });
    }
    return { content };
  }),
);

tool(
  'spread_history',
  {
    title: 'See who changed what',
    description: "The project's change log, newest first: who made each change (you, for the user's hand edits, or claude, with the tool in via), when, on which board, and what it was in plain words. Use it when something looks unexpected (\"where did this effect come from?\") before guessing. Filter with boardId, layerId or key (a layer), who, or query (words in the change, like 'Riso'). limit defaults to 30. Returns { total, entries: [{ at, ago, who, via?, boardId, boardName, undo?, lines: [{ layer?, what, layerId? }], more? }] }. It only knows changes made since it was added, and is kept with the project (the last 1000 changes). Read-only.",
    inputSchema: {
      boardId,
      layerId: z.string().optional(),
      key: z.string().optional(),
      who: z.enum(['you', 'claude']).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(300).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  passthrough('get_history'),
);

tool(
  'spread_set_overlay',
  {
    title: 'Set a board reference overlay',
    description: "Lays a past design over a board (active, or boardId) to compare against, for any board kind. It sits above the canvas, is saved with the board, and never reaches an export. Give one source: path (a PNG/JPG, or an .html email, photographed at 640px with its pictures found beside the file), fromBoardId (another board), or referenceId (a saved reference from spread_list_library). The picture is fitted to the board's width unless you pass scale. Call again without a source to adjust it: x, y (board px), scale (board px per picture px), opacity 0-1, mode ('fade', 'difference', 'changes'), visible. remove: true takes it off. Returns { overlay }.",
    inputSchema: {
      path: z.string().optional(),
      fromBoardId: z.string().optional(),
      referenceId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      scale: z.number().positive().optional(),
      opacity: z.number().min(0).max(1).optional(),
      mode: z.enum(['fade', 'difference', 'changes']).optional(),
      visible: z.boolean().optional(),
      remove: z.boolean().optional(),
      boardId,
    },
  },
  passthrough('set_overlay'),
);

tool(
  'spread_compare_overlay',
  {
    title: 'Measure a board against its reference',
    description: 'Compares a board (active, or boardId) with its reference from spread_set_overlay, pixel by pixel. Returns { summary, width, height, referenceHeight, changedPercent, uncoveredPercent, regionCount, regions: [{ x, y, w, h, percent, layers: [{ id, name }] }] (the 12 biggest, in board px), drift: [{ fromY, toY, shift }] (bands of the board that sit shift px lower than the reference, negative for higher) } plus a picture of the board with changes in magenta. A section that moved shows up in drift, so fix the drift from the top down before reading regions. Read-only.',
    inputSchema: { boardId },
    annotations: { readOnlyHint: true },
  },
  handle(async (args) => {
    const { images = [], ...r } = (await rpc('compare_overlay', args, 180_000)) ?? {};
    const content = [{ type: 'text', text: JSON.stringify(r) }];
    for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mime ?? 'image/jpeg' });
    return { content };
  }),
);

tool(
  'spread_export_slides',
  {
    title: 'Export slides',
    description: `Exports one board's slides (active, or boardId — e.g. the variation the user picked) as individual files ready to post (one file per slide, named <prefix>-01.png, -02, ...; prefix defaults to the board name, so pass a clean slug for variations). folder = absolute output folder (created if missing; default: the app asks/uses its last export folder — prefer passing a dated folder like ~/Pictures/Spread/2026-10-26-<post-name>). scale 1 = 1080px wide (Instagram native), 2 = 2160px (recommended high-res, default), 3 = 3240px. format 'png' (default) or 'jpeg'. slides = 0-based subset. Returns { folder, files }. Tell the user the folder path afterwards (they back exports up to Box/Monday).`,
    inputSchema: {
      folder: z.string().optional(),
      scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      format: z.enum(['png', 'jpeg']).optional(),
      prefix: z.string().optional(),
      slides: z.array(z.number().int().min(0)).optional(),
      boardId,
    },
  },
  passthrough('export_slides', 300_000),
);

// ---------------------------------------------------------------------------
// Email boards (e-blasts)
// ---------------------------------------------------------------------------

const EMAIL = `EMAIL BOARDS: kind 'email', 600px wide, height grows with content. One root auto-layout column frame whose children are sections (frames named "Section / …"). Edit with the normal node tools (spread_update_nodes by id/key; spread_add_nodes with parentId = a section or the root). Facts in template copy are {{TOKENS}} — replace every one with real values (export warns about leftovers). For grids of similar cards (listings, events), build one card and fill the rest with spread_repeat. Name repeated type (Body, Section heading) with spread_save_styles so one change reaches every layer. Set a layer's link with the link prop on spread_add_nodes / spread_update_nodes, and check them all with spread_list_links. Tracking tags for every link go on the board (spread_update_board tracking). Older [link:URL] name tags still work; setting link replaces them. Layer-name tags the compiler reads: [alt:…] (image alt text), [button], [stack]/[nostack] (row frames stack on phones or not), [raster] (flatten to a picture). Images must be on public URLs. The board remembers where (the user sets it in the Links panel; spread_list_links shows it): export with host: 'wordpress' when that's the choice and WordPress is connected (Spread uploads them and fills in the URLs); a saved folder URL or per-picture URLs are used automatically; otherwise export once, the user uploads the image folder, then re-export with baseUrl. The board carries the subject and preview text (spread_update_board subject/preheader); export uses them. spread_render_slides shows the canvas; spread_preview_email shows the real HTML on desktop and phone, with fallback fonts and with images off, so run it before export. To match a past email, lay it over the board with spread_set_overlay and measure with spread_compare_overlay instead of writing your own scripts.`;

const emailOpts = {
  baseUrl: z.string().optional().describe('Public folder URL the exported images will live at; image src = baseUrl + file name.'),
  urls: z.record(z.string()).optional().describe('Per-image URL overrides: { nodeId: url }.'),
  title: z.string().optional().describe("HTML <title> (default: the board's subject, else its name)."),
  preheader: z.string().optional().describe("Inbox preview text after the subject, 40–90 chars (default: the board's preheader)."),
  links: z.record(z.string()).optional().describe("Link overrides for this export only: { nodeId: href } (otherwise each layer's own link)."),
};

tool(
  'spread_list_email_templates',
  {
    title: 'List email templates and sections',
    description: `Lists email templates (whole emails) and sections (blocks you can insert): the user's saved ones first (ids start with saved:, prefer them: they're the house look), then the built-in ones. { templates: [{ id, name, description, saved? }], sections: [...] }.
${EMAIL}`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  passthrough('list_email_templates'),
);

tool(
  'spread_create_email',
  {
    title: 'Create email board',
    description: `Adds an email board (row) below the active one from a template ('blank', a built-in id, or a saved:… id from spread_list_email_templates) and makes it active. photoIds = tray asset ids, used in order for the template's photo slots. Returns { boardId }. Then call spread_get_state {boardId} to find the {{TOKEN}} layers and fill them with spread_update_nodes.
${EMAIL}`,
    inputSchema: {
      template: z.string().optional().describe("Template id, or 'blank' (default)."),
      name: z.string().optional(),
      note: z.string().optional(),
      photoIds: z.array(z.string()).optional(),
    },
  },
  passthrough('create_email'),
);

tool(
  'spread_add_email_section',
  {
    title: 'Add email section',
    description: 'Inserts a section (id from spread_list_email_templates sections) into an email board (active, or boardId) at index among the root\'s sections (0 = top; default = just above the footer, or the end if there is none). sectionId can be a saved:… section from spread_list_email_templates (the user\'s own). photoIds fill its photo slots in order. Returns { sectionId } (the new section frame).',
    inputSchema: {
      sectionId: z.string(),
      index: z.number().int().min(0).optional(),
      photoIds: z.array(z.string()).optional(),
      boardId,
    },
  },
  passthrough('add_email_section'),
);

tool(
  'spread_email_html',
  {
    title: 'Compile email HTML (check)',
    description: 'Compiles an email board (active, or boardId) to inbox-safe HTML without writing files, so you can check it. Returns { bytes, warnings, images: [{ nodeId, fileName, alt, width, height }], html (truncated at maxChars, default 60000) }. Fix every warning you can (unfilled {{TOKENS}}, missing alt text, links to "#", no unsubscribe) and keep bytes under ~100 KB (Gmail clips at 102 KB). Read-only.',
    inputSchema: { ...emailOpts, maxChars: z.number().int().optional(), boardId },
    annotations: { readOnlyHint: true },
  },
  passthrough('email_html'),
);

tool(
  'spread_send_check',
  {
    title: 'Check an email is ready to send',
    description: "The five things that must be right before an email goes out, the same list the user sees pinned in the app: subject (and preview text), unsubscribe, mailing address, links and alt text. Returns { ready, toFix, checks: [{ id, level: 'ok'|'note'|'fix', title, detail, ids }] }, where ids are the layers each check is about. ready means nothing is at 'fix'. The address check reads the footer, or a layer named 'Mailing address'. Read-only.",
    inputSchema: { boardId },
    annotations: { readOnlyHint: true },
  },
  passthrough('send_check'),
);

tool(
  'spread_preview_email',
  {
    title: 'Preview email as an inbox shows it',
    description: "Shows the compiled HTML of an email board (active, or boardId) the way inboxes will, unlike spread_render_slides, which shows the canvas. Lays it out at real widths (desktop 640, phone 375) and returns { subject, preheader, heights, checks: [{ id, level: ok|note|fix, title, detail }] } plus one picture per view. Checks cover the inbox line, sideways scrolling on phones, what the fallback fonts change, and what is lost with images off. views picks what to look at (default desktop and phone, fallback fonts, images on): fonts 'fallback' is what nearly everyone sees, 'design' only people with the font installed; images false draws each picture as the box a blocked image leaves, with its alt text. Fix every 'fix' check. One browser engine, not Outlook or Gmail themselves. Read-only.",
    inputSchema: {
      views: z
        .array(z.object({ device: z.enum(['desktop', 'mobile']).optional(), fonts: z.enum(['fallback', 'design']).optional(), images: z.boolean().optional() }))
        .max(6)
        .optional(),
      boardId,
    },
    annotations: { readOnlyHint: true },
  },
  handle(async (args) => {
    const { images = [], ...r } = (await rpc('preview_email', args, 300_000)) ?? {};
    const content = [{ type: 'text', text: JSON.stringify(r) }];
    for (const img of images) {
      content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', data: img.base64, mimeType: img.mime ?? 'image/jpeg' });
    }
    return { content };
  }),
);

tool(
  'spread_export_email',
  {
    title: 'Export email (HTML + images)',
    description: "Writes email.html plus the rendered images (at scale, default 2x) for an email board (active, or boardId) into folder (default ~/Pictures/Spread/<name>-email-<date>). host: 'wordpress' first uploads the images to the user's connected WordPress media library (unchanged images are reused, never re-uploaded) and writes their URLs into the HTML; it fails with a clear message if WordPress isn't connected (the user connects it once in Export → Upload to WordPress). Returns { folder, htmlFile, images, bytes, warnings, subject, preheader, hosted?, note }. Without host/baseUrl/urls, image src are bare file names: ask the user to connect WordPress, or to upload the files and give you the base URL, then export again.",
    inputSchema: { ...emailOpts, host: z.enum(['wordpress']).optional().describe("Upload the images to the connected WordPress site and use their URLs."), folder: z.string().optional(), scale: z.number().min(1).max(3).optional(), boardId },
  },
  passthrough('export_email', 300_000),
);

// ---------------------------------------------------------------------------
// The library: the user's saved templates and references
// ---------------------------------------------------------------------------

tool(
  'spread_list_library',
  {
    title: 'List saved templates and references',
    description: `The user's design library, kept outside any project. templates: boards or email sections to start from ({ id: 'saved:…', name, scope: 'board' | 'section', boardKind, description, size, thumb }). references: designs the user rates highly ({ id, name, boardKind, why, note, size, images: [absolute paths to renders], layers: path to the board's layers JSON }). Items from other brands are left out. Before designing something new, read the references of the same kind: open 1–3 images with Read, and treat "why" as the brief for quality. Read-only.`,
    inputSchema: { boardKind: z.enum(['carousel', 'email', 'document']).optional().describe('Only this kind of board.') },
    annotations: { readOnlyHint: true },
  },
  passthrough('list_library'),
);

tool(
  'spread_create_from_template',
  {
    title: 'New board from a saved template',
    description: "Adds a board from one of the user's saved templates (templateId 'saved:…' from spread_list_library, scope 'board') below the active row and makes it active. photoIds (tray asset ids) replace the template's photos in order; the rest keep the template's own. Its fonts come with it. Returns { boardId, boards }.",
    inputSchema: { templateId: z.string(), name: z.string().optional(), note: z.string().optional(), photoIds: z.array(z.string()).optional() },
  },
  passthrough('create_from_template', 120_000),
);

tool(
  'spread_save_template',
  {
    title: 'Save as template',
    description: 'Saves a board (boardId, default active), or one email section (sectionId: a frame in an email board), to the user\'s template library, with its photos and fonts, so any project can start from it. Only when the user asks or agrees. Returns { templateId, name, scope }.',
    inputSchema: { boardId, sectionId: z.string().optional(), name: z.string(), description: z.string().optional().describe('When to use it, in one line.') },
  },
  passthrough('save_template', 120_000),
);

tool(
  'spread_save_reference',
  {
    title: 'Save as reference',
    description: "Saves a board (boardId, default active) as a reference: renders of the whole board and each slide, its layers, and why it's good, so future jobs can match its quality. why is required: the user's words, made specific (what the cover does, the type, the pacing, the finish). Only when the user asks or agrees. Returns { referenceId, name, images }.",
    inputSchema: { boardId, name: z.string().optional(), why: z.string() },
  },
  passthrough('save_reference', 120_000),
);

tool(
  'spread_save_project',
  {
    title: 'Save project',
    description: 'Saves the project as a .spread file (zip with the layout + original photos). Pass an absolute path ending in .spread, or omit to save to the current file path (fails if the project was never saved). Returns { path }.',
    inputSchema: { path: z.string().optional() },
  },
  passthrough('save_project', 300_000),
);

tool(
  'spread_list_projects',
  {
    title: 'List projects',
    description: 'Lists every project on the Home page: name, path, kinds, board count, folder and last change. Use it to find past work to open or borrow ideas from.',
    inputSchema: {},
  },
  passthrough('list_projects'),
);

tool(
  'spread_open_project',
  {
    title: 'Open project',
    description: 'Opens a .spread project file (absolute path) in its own tab. Other open projects stay as they are, and they save themselves.',
    inputSchema: { path: z.string() },
    annotations: { destructiveHint: true },
  },
  passthrough('open_project', 300_000),
);

tool(
  'spread_new_project',
  {
    title: 'New project',
    description:
      'Starts a blank project in a new tab (one carousel board of 3 portrait slides, empty tray). Other open projects stay as they are.',
    inputSchema: {
      name: z.string().optional().describe('Project name (used for export file names)'),
      discard: z.boolean().optional().describe('Discard unsaved changes in the open project'),
    },
    annotations: { destructiveHint: true },
  },
  passthrough('new_project'),
);

tool(
  'spread_undo',
  { title: 'Undo', description: 'Undoes the last change in the app (same as Ctrl/Cmd+Z).', inputSchema: {} },
  passthrough('undo'),
);

tool(
  'spread_redo',
  { title: 'Redo', description: 'Redoes the last undone change in the app.', inputSchema: {} },
  passthrough('redo'),
);

tool(
  'spread_list_fonts',
  {
    title: 'List fonts',
    description: 'Lists font families usable as fontFamily: bundled fonts (always available offline), fonts uploaded into the project (e.g. brand fonts imported via spread_import_photos), system fonts and, when permitted, installed fonts. Use exact family strings.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  passthrough('list_fonts'),
);

tool(
  'spread_lint',
  {
    title: 'Check layout (lint)',
    description: `Runs the app's mechanical layout checks on a board (active, or boardId) and returns { issues: [{ severity 'error'|'warn', rule, message, page, ids, keys }], summary }. Rules: off-page, crosses-page (documents) / crosses-seam (carousels), margin (inside the page margins; carousels use 60), overflow (text cut off by a fixed-height box), tiny-text, line-length (body lines outside ~25–95 characters), widow (one word alone on a paragraph's last line), baseline (text top off the document baseline grid), contrast (below 4.5:1, or 3:1 for large type, against a solid background), overlap (text blocks colliding), text-style (layers that differ from their style), alignment (left edges 0.5–3 units apart: a near miss; right-aligned blocks are judged by their right edge), spacing (with a baseline grid: stacked gaps off the grid; without one: gaps that differ by ≤2 units), type-system (more than 2 families or 6 sizes), grouping (a heading, its subtitle or meta line and the body all one even gap apart, or a group spaced no tighter than the space around it), empty-page. Run it after every build pass and fix every error before showing the user; warnings need a reason to stay. Read-only.`,
    inputSchema: { boardId },
    annotations: { readOnlyHint: true },
  },
  passthrough('lint'),
);

tool(
  'spread_export_pdf',
  {
    title: 'Export PDF',
    description: `Exports a board (active, or boardId) as a PDF with real, selectable text and embedded fonts: one page per page/slide, page size = slide size in points. Emails work too: by default one continuous page the size of the email (600px wide prints 600pt wide, height grows with it), or pages: 'letter' to split it across US Letter pages (fitted to the width, breaks kept out of text lines and, where it costs little, pictures and sections). Linked layers stay clickable (email tracking tags included). Photos are embedded at 300 dpi with their crops and effects. Line breaks match the canvas exactly. path = absolute .pdf path (default: ~/Pictures/Spread/<name>-<date>.pdf). Returns { path, pages, bytes }. Follow with spread_pdf_text to check what an applicant-tracking system or screen reader will read.`,
    inputSchema: {
      boardId,
      path: z.string().optional().describe('Absolute output path ending in .pdf'),
      pages: z.enum(['one', 'letter']).optional().describe("Email boards only: 'one' = one long page the size of the email (default), 'letter' = US Letter pages"),
    },
  },
  passthrough('export_pdf', 180_000),
);

tool(
  'spread_pdf_text',
  {
    title: 'Read text from a PDF',
    description: `Extracts the text of a PDF file per page, in reading order, the way an applicant-tracking system or screen reader sees it. Use after spread_export_pdf to check that every word made it in, nothing is garbled, and the reading order makes sense (for a resume: name, contact, then sections top to bottom; side columns can interleave, so check). Returns { pages: [{ page, text }], fonts }. Read-only; runs locally, no app needed.`,
    inputSchema: { path: z.string().describe('Absolute path to a .pdf file') },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path: file }) => {
    // pdf.js builds a DOMMatrix at load. Text extraction never renders, so where the optional
    // @napi-rs/canvas isn't installed (the packaged extension) a placeholder is enough.
    globalThis.DOMMatrix ??= class DOMMatrix {};
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(file));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    const fonts = new Set();
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = '';
      let lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        else if (out && !out.endsWith(' ') && !out.endsWith('\n') && item.str && !item.str.startsWith(' ')) out += ' ';
        out += item.str;
        if (item.hasEOL) out += '\n';
        lastY = y;
        if (item.fontName && content.styles[item.fontName]) fonts.add(content.styles[item.fontName].fontFamily);
      }
      pages.push({ page: i, text: out.replace(/\n{2,}/g, '\n').trim() });
    }
    await doc.destroy();
    return text({ pages, fonts: [...fonts] });
  }),
);

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

const brandColor = z.object({ name: z.string(), hex: z.string().describe("'#RRGGBB'"), role: z.string().optional().describe('ink, paper, accent, support, muted…') });
const brandFont = z.object({ family: z.string().describe('Family name as Spread knows it (see spread_list_fonts), e.g. "DM Sans"'), role: z.string().optional().describe('display, text, mono…') });
const brandRule = z.object({ kind: z.enum(['do', 'dont']), text: z.string(), source: z.enum(['brand', 'learned']).optional().describe("'brand' = from the brand's guidelines (default for imports); 'learned' = from the user's verdicts and edits") });

tool(
  'spread_list_brands',
  {
    title: 'List brand kits',
    description: "Lists the brand kits in the user's library and which one the open project uses (projectBrandId, null = no brand). Read-only.",
    inputSchema: {},
  },
  passthrough('list_brands'),
);

tool(
  'spread_get_brand',
  {
    title: 'Get brand kit',
    description: "Returns a brand kit in full: colors with roles, fonts with roles, type scale (px for screens and carousels, pt for print), spacing unit, voice, description and rules (do/dont, from the brand or learned from the user). Default: the open project's brand. Call it at the start of any design turn on a branded project and follow it exactly. Read-only.",
    inputSchema: { brandId: z.string().optional().describe("Default: the open project's brand") },
  },
  passthrough('get_brand'),
);

tool(
  'spread_save_brand',
  {
    title: 'Create or update a brand kit',
    description: `Creates a brand kit (pass name) or updates one (pass id; only the fields you pass change). Use it to import a brand from the user's design system (a Claude Design System artifact, DESIGN.md, brand CSS, a style guide PDF): read the source yourself, then save colors with roles, fonts, typeScale, spacing, voice, description and the guideline rules (source 'brand'). Fonts must exist in Spread: bundled/system families work as-is; for custom fonts pass fontFiles with absolute paths to .ttf/.otf/.woff/.woff2 files. To record what you learned from the user (a reason they gave when rejecting or picking a row, a hand edit they keep repeating), FIRST ask them, then pass addRules with source 'learned'. use: true also switches the open project to this brand. Returns { brand, inUse }.`,
    inputSchema: {
      id: z.string().optional().describe('Existing brand id to update'),
      name: z.string().optional().describe('Brand name (required for a new brand)'),
      description: z.string().optional(),
      colors: z.array(brandColor).optional().describe('Replaces the palette'),
      fonts: z.array(brandFont).optional().describe('Replaces the font list'),
      fontFiles: z.array(z.object({ path: z.string(), family: z.string() })).optional().describe('Font files to copy into the kit'),
      typeScale: z.object({ px: z.array(z.number()).optional(), pt: z.array(z.number()).optional() }).optional(),
      spacing: z.object({ px: z.number().optional(), pt: z.number().optional() }).optional(),
      voice: z.string().optional(),
      rules: z.array(brandRule).optional().describe('Replaces all rules (prefer addRules/removeRuleIds)'),
      addRules: z.array(brandRule).optional(),
      removeRuleIds: z.array(z.string()).optional(),
      source: z.string().optional().describe('Where it came from (file path or link)'),
      use: z.boolean().optional().describe('Also switch the open project to this brand'),
    },
  },
  passthrough('save_brand'),
);

tool(
  'spread_use_brand',
  {
    title: 'Switch the project brand',
    description: "Switches the open project to a brand kit (brandId) or to no brand (null: a personal project). Only when the user asks. The design isn't changed; restyle it afterwards if they want it on-brand.",
    inputSchema: { brandId: z.string().nullable() },
  },
  passthrough('use_brand'),
);

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

tool(
  'spread_batch',
  {
    title: 'Run several steps',
    description: `Runs several Spread methods in order in ONE call, stopping at the first error: fewer round trips and fewer permission prompts for the user. Use it for every multi-step change, e.g. [{method:'update_nodes', params:{…}}, {method:'lint'}, {method:'render_slides', params:{scale:0.5}}]. method = a tool name without the spread_ prefix (add_nodes, update_nodes, delete_nodes, set_document, arrange, create_board, duplicate_board, update_board, make_variants, lint, render_slides, render_overview, get_feedback, get_state, export_pdf, export_slides…). Rendered images come back as images. Returns each step's result, or where it stopped and why.`,
    inputSchema: {
      steps: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.any()).optional() })).min(1).max(20),
    },
  },
  handle(async ({ steps }) => {
    const r = await rpc('batch', { steps: steps.map((s) => ({ ...s, method: s.method.replace(/^spread_/, '') })) }, 600_000);
    const content = [];
    for (const [i, step] of (r.results ?? []).entries()) {
      const images = Array.isArray(step.result?.images) ? step.result.images : [];
      const rest = images.length ? { ...step.result, images: images.map(({ base64, ...m }) => m) } : step.result;
      content.push({ type: 'text', text: `${i + 1}. ${step.method}: ${JSON.stringify(rest)}` });
      for (const img of images) if (img.base64) content.push({ type: 'image', data: img.base64, mimeType: img.mime ?? 'image/jpeg' });
    }
    if (r.error) return { content: [...content, { type: 'text', text: `Stopped at step ${r.error.step} (${r.error.method}): ${r.error.message}` }], isError: true };
    return { content: content.length ? content : [{ type: 'text', text: 'Done.' }] };
  }),
);

await server.connect(new StdioServerTransport());
