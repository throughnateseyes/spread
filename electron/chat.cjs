// The Claude side panel: runs the user's own Claude Code (`claude -p` in stream-json mode, signed in
// with their account) and streams the conversation to the renderer.
//
// - Spread's MCP server is passed in with --mcp-config and its tools are pre-approved, so designing
//   never stops for a permission click. Reading files is pre-approved too.
// - Anything else (editing files, shell commands, the web) comes back as a can_use_tool control
//   request, which the panel shows as an Allow / Deny card.
// - One conversation per project (keyed by the .spread path). The Claude Code session id and the
//   visible transcript are kept in ~/.spread/chats/, so reopening a project picks the chat back up.
const { app, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('./claude.cjs');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const DIR = path.join(HOME, '.spread', 'chats');
const ROOT = path.join(__dirname, '..');

const ALLOWED = ['mcp__spread', 'Read', 'Glob', 'Grep', 'Task', 'Agent', 'Skill', 'TodoWrite'];
// Tools that need an interactive host the panel doesn't have. (AskUserQuestion it does have: the
// questions come back as a can_use_tool request and show as a card with options.)
const DISALLOWED = ['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'];

// Plumbing the user doesn't need to see as a step.
const HIDDEN_TOOLS = new Set(['ToolSearch', 'AskUserQuestion']);

const SYSTEM = `You are Claude in the side panel of Spread, the user's design canvas, working as their senior graphic designer and marketing lead. The canvas is beside this chat and the user watches every change land.
- Mid-run messages: the user can message you while you work. Treat each one as a correction to what you're doing now: fold it in and carry on, don't start over.
- Pinned notes: a <spread-context> block with a "Pinned note" line is a note the user pinned on the canvas. That message is about the row and layer on that line (pass that boardId, address the layer by its key or id), even if the selection or active row says otherwise. Several can arrive at once: act on each one, then say in a line per note what you did.
- Context: every user message starts with a <spread-context> block Spread rebuilds on each send (date, project, brand, design docs, rows with ids and status, the active row, the selection with sizes, the photo tray). "This" means the selection; with nothing selected, the active row. Rows are lettered A, B, C from the top and re-letter when rows are added: list rows again before naming letters in a reply.
- Guides: for new work call spread_guide('director'), and before designing call spread_guide with the medium (carousel, document, eblast). Once per chat each.
- New job: one AskUserQuestion card for the decisions the context, photos and files can't answer: at most four questions, 2-4 options each, your recommendation first and marked "(Recommended)". Offer your named direction concepts as a multi-select on that same card ("All three (Recommended)" first, plus "Go wide: 5 directions"), so one answer sets how many and which. Facts you can't find get one question whose first option is "Leave as {{TODO}} (Recommended)". Brief already complete: skip the card. "Just make it": skip every card, build one direction, put {{TODO}} where facts are missing and say in one line what you assumed. Never invent facts. Never ask about fonts or colors.
- Follow-ups: if the context shows hand edits, or a new pick, reject or reason since your last turn, call spread_get_feedback first; otherwise work from the context.
- The user's work comes first. Pass boardId on every board tool. Without asking, never overwrite a layer they touched, rebuild a row they edited, delete a row, switch brand, or spread_undo a change that isn't yours. Spread autosaves.
- Sources of truth: with a brand set, the kit (spread_get_brand) decides fonts, colors and scale; a DESIGN.md listed in the context decides voice, intent and rules. Read each once per chat. If they conflict, follow the kit and name the conflict in one line.
- Tools: mcp__spread__*, Read, Glob, Grep, Agent and Skill run without asking; chain steps with spread_batch. Editing files, shell commands and the web need the user's Allow tap: ask only when it clearly helps.
- Replies: the canvas shows the work. One or two sentences on what changed and why; after a set of directions use the director guide's Presenting format. End a turn that needs a decision with exactly one AskUserQuestion card. If the user picks a row on a card, mark it with spread_update_board { status: 'picked' }. Shortcuts are Cmd on a Mac, Ctrl elsewhere.`;

/** @type {Map<string, Chat>} */
const chats = new Map();
let send = () => {};
let shellEnv = null;

/** Wires the panel's updates to the window. */
function init(sender) {
  send = sender;
}

const fileOf = (key) => path.join(DIR, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');

function load(key) {
  try {
    const saved = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    // A card that was waiting when Spread closed can't be answered any more.
    const items = (saved.items || []).map((it) => ((it.kind === 'approval' || it.kind === 'question') && it.status === 'pending' ? { ...it, status: 'expired' } : it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'stopped' } : it));
    // Nor can a note that was in flight: its pin offers to send it again.
    const notes = Object.fromEntries(Object.entries(saved.notes || {}).map(([id, s]) => [id, IN_FLIGHT.has(s) ? 'stopped' : s]));
    return { sessionId: saved.sessionId || null, items, lastPayload: saved.lastPayload || null, notes };
  } catch {
    return { sessionId: null, items: [], lastPayload: null, notes: {} };
  }
}

function persist(c) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileOf(c.key), JSON.stringify({ key: c.key, sessionId: c.sessionId, items: c.items.slice(-400), lastPayload: c.lastPayload, notes: Object.fromEntries(Object.entries(c.notes).slice(-400)), updatedAt: Date.now() }));
  } catch (e) {
    console.warn('Could not save chat:', e.message);
  }
}

function chatFor(key) {
  let c = chats.get(key);
  if (!c) {
    const saved = load(key);
    c = { key, proc: null, buf: '', sessionId: saved.sessionId, items: saved.items, notes: saved.notes, queued: [], status: 'idle', cwd: HOME, approvals: new Map(), always: new Set(), blocks: new Map(), streamed: [], lastPayload: saved.lastPayload, timer: null, nextId: 1 };
    chats.set(key, c);
  }
  return c;
}

const snapshot = (c) => ({ key: c.key, items: c.items, notes: c.notes, queued: c.queued.map(({ id, text, noteId }) => ({ id, text, noteId })), status: c.status, hasSession: !!c.sessionId });

// Canvas comments, by note id: waiting (sent, unread) → working (Claude read it) → done (that turn
// ended). A note can't be left waiting or working once nothing will finish it, so everything that
// ends a run early moves what's in flight to stopped, and its pin offers to send it again.
const IN_FLIGHT = new Set(['waiting', 'working']);

function settleNotes(c, status, from = IN_FLIGHT) {
  for (const [id, s] of Object.entries(c.notes)) if (from.has(s)) c.notes[id] = status;
}

// Streaming text arrives token by token; coalesce updates to one per animation-ish frame.
function emit(c, now = false) {
  if (now) {
    clearTimeout(c.timer);
    c.timer = null;
    return send(snapshot(c));
  }
  if (c.timer) return;
  c.timer = setTimeout(() => {
    c.timer = null;
    send(snapshot(c));
  }, 40);
}

function push(c, item) {
  const it = { id: `${Date.now().toString(36)}-${c.nextId++}`, at: Date.now(), ...item };
  c.items.push(it);
  return it;
}

const setStatus = (c, status) => {
  c.status = status;
  emit(c, true);
};

// Apps opened from the Finder don't get the terminal's PATH; Claude Code's hooks and tools need it.
function env() {
  if (!shellEnv) {
    shellEnv = new Promise((resolve) => {
      if (IS_WIN) return resolve(process.env.PATH || '');
      execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 8000 }, (err, out) => resolve(!err && out ? String(out) : process.env.PATH || ''));
    });
  }
  return shellEnv.then((PATH) => {
    const e = { ...process.env, PATH };
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  });
}

/** Spread's MCP server, run by Electron as Node so it works without node on PATH. */
function mcpConfig(key) {
  const server = app.isPackaged ? path.join(process.resourcesPath, 'connector', 'server', 'index.mjs') : path.join(ROOT, 'mcp', 'server.mjs');
  // SPREAD_PROJECT ties this Claude's edits to its own project, whichever tab is in front.
  return JSON.stringify({ mcpServers: { spread: { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1', SPREAD_PROJECT: key } } } });
}

async function start(c) {
  const bin = await findClaude();
  if (!bin) {
    push(c, { kind: 'notice', tone: 'error', action: 'install', text: 'Claude Code isn’t installed on this computer, or Spread can’t find it.' });
    return setStatus(c, 'idle'), null;
  }
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--mcp-config', mcpConfig(c.key),
    '--allowedTools', ALLOWED.join(','),
    '--disallowedTools', DISALLOWED.join(','),
    '--append-system-prompt', SYSTEM,
  ];
  if (c.sessionId) args.push('--resume', c.sessionId);
  const proc = spawn(bin, args, { cwd: fs.existsSync(c.cwd) ? c.cwd : HOME, env: await env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  c.proc = proc;
  c.buf = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    c.buf += d;
    let i;
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, i).trim();
      c.buf = c.buf.slice(i + 1);
      if (!line) continue;
      try {
        onMessage(c, JSON.parse(line));
      } catch (e) {
        console.warn('Chat: bad line', e.message);
      }
    }
  });
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  proc.on('error', (e) => {
    push(c, { kind: 'notice', tone: 'error', text: `Couldn’t start Claude Code: ${e.message}` });
  });
  proc.on('exit', (code) => {
    if (c.proc !== proc) return;
    c.proc = null;
    for (const [, a] of c.approvals) a.item.status = 'expired';
    c.approvals.clear();
    const stopped = c.stopping;
    c.stopping = false;
    if (c.status !== 'idle' && code && !stopped && !c.items.some((it) => it.kind === 'notice' && it.at > (c.lastPayload?.at ?? 0))) {
      push(c, { kind: 'notice', tone: 'error', text: lastLine(stderr) || `Claude Code stopped (exit ${code}).` });
    }
    for (const it of c.items) if (it.kind === 'tool' && it.status === 'running') it.status = 'stopped';
    settleNotes(c, 'stopped');
    // Anything Claude never read stays visible, so a crash can't quietly swallow a message.
    if (c.queued.length) {
      for (const q of c.queued.splice(0)) push(c, { kind: 'user', text: q.text, label: q.label || null });
      push(c, { kind: 'notice', tone: 'error', text: 'Claude stopped before reading your last message. Send it again.' });
    }
    c.status = 'idle';
    persist(c);
    emit(c, true);
  });
  return proc;
}

const lastLine = (s) => s.trim().split('\n').filter(Boolean).slice(-1)[0] || '';

function write(c, msg) {
  if (c.proc && c.proc.stdin.writable) c.proc.stdin.write(JSON.stringify(msg) + '\n');
}

// ---------- reading Claude Code's stream ----------

function onMessage(c, m) {
  if (m.session_id && m.session_id !== c.sessionId && m.type === 'system' && m.subtype === 'init') {
    c.sessionId = m.session_id;
    const spread = (m.mcp_servers || []).find((s) => s.name === 'spread');
    if (spread && spread.status !== 'connected') push(c, { kind: 'notice', tone: 'error', text: `Spread’s tools didn’t load (${spread.status}). Claude can chat but not design.` });
  }
  if (m.type === 'stream_event') return onStream(c, m);
  if (m.type === 'assistant') return onAssistant(c, m);
  if (m.type === 'user') return m.isReplay ? onReplay(c, m) : onToolResults(c, m);
  if (m.type === 'control_request') return onControl(c, m);
  if (m.type === 'control_cancel_request') {
    const a = c.approvals.get(m.request_id);
    if (a) {
      a.item.status = 'expired';
      c.approvals.delete(m.request_id);
      emit(c);
    }
    return;
  }
  if (m.type === 'result') return onResult(c, m);
}

/** Live text and tool starts from the main conversation (subagents are summarised by their Task row). */
function onStream(c, m) {
  if (m.parent_tool_use_id) return;
  const e = m.event || {};
  if (e.type === 'message_start') {
    c.msgId = e.message && e.message.id;
  } else if (e.type === 'content_block_start') {
    const b = e.content_block || {};
    const k = `${c.msgId}:${e.index}`;
    if (b.type === 'text') {
      const it = push(c, { kind: 'text', text: b.text || '' });
      c.blocks.set(k, it);
      c.streamed.push(it);
    } else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
      c.blocks.set(k, push(c, { kind: 'tool', toolId: b.id, name: b.name, ...describe(b.name, {}), status: 'running' }));
    }
    emit(c);
  } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
    const it = c.blocks.get(`${c.msgId}:${e.index}`);
    if (it) {
      it.text += e.delta.text;
      emit(c);
    }
  }
}

/** The finished message: fills in what streaming left out (full text, the tool's input). */
function onAssistant(c, m) {
  const msg = m.message || {};
  // Subagents are summarised by their Task row; synthetic messages are errors the result reports.
  if (m.parent_tool_use_id || msg.model === '<synthetic>') return;
  // Finished messages don't share ids or block indexes with the stream: match tools by their id
  // and text blocks in the order they streamed.
  for (const b of msg.content || []) {
    if (b.type === 'text') {
      const it = c.streamed.shift();
      if (it) it.text = b.text || '';
      else if (b.text && b.text.trim()) push(c, { kind: 'text', text: b.text });
    } else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
      let it = c.items.find((x) => x.kind === 'tool' && x.toolId === b.id);
      if (!it) it = push(c, { kind: 'tool', toolId: b.id, name: b.name, status: 'running' });
      Object.assign(it, describe(b.name, b.input || {}));
    }
  }
  emit(c);
}

/** Claude Code echoes each message as it reads it, which is when a queued one joins the transcript. */
function onReplay(c, m) {
  const content = m.message && m.message.content;
  const text = Array.isArray(content) ? content.map((b) => b.text || '').join('') : content;
  // Read mid-turn, each message echoes alone. Waiting for the next turn, they're joined into one
  // message and echo as one, so look for every queued message inside the echo.
  const read = typeof text === 'string' ? c.queued.filter((q) => text.includes(q.content)) : [];
  if (!read.length) return;
  c.queued = c.queued.filter((q) => !read.includes(q));
  for (const q of read) {
    if (q.noteId) c.notes[q.noteId] = 'working';
    push(c, { kind: 'user', text: q.text, label: q.label || null });
  }
  persist(c);
  emit(c, true);
}

function onToolResults(c, m) {
  const content = (m.message && m.message.content) || [];
  if (!Array.isArray(content)) return;
  for (const r of content) {
    if (r.type !== 'tool_result') continue;
    const it = c.items.find((x) => x.kind === 'tool' && x.toolId === r.tool_use_id);
    if (!it) continue;
    it.status = r.is_error ? (c.stopping ? 'stopped' : 'error') : 'done';
    if (r.is_error) it.error = textOf(r.content).slice(0, 300);
  }
  emit(c);
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => x.text || '').join(' ') : '');

function onResult(c, m) {
  for (const it of c.items) if (it.kind === 'tool' && it.status === 'running') it.status = 'done';
  if (m.is_error) {
    const text = String(m.result || (m.errors || []).join(' ') || 'Something went wrong.');
    const login = /authenticat|log ?in|oauth|api key|credential/i.test(text);
    push(c, login ? { kind: 'notice', tone: 'error', action: 'login', text: 'Sign in to Claude Code to use the panel. It uses your own Claude account.' } : { kind: 'notice', tone: 'error', text });
    // A fresh process after signing in picks up the new login.
    if (login && c.proc) c.proc.kill();
  }
  // This turn answered what it read. A note still waiting missed it (the replay shows when it's read,
  // and that comes after this result), so it stays waiting for the next turn.
  settleNotes(c, m.is_error ? 'stopped' : 'done', new Set(['working']));
  // A message that arrived too late for this turn starts the next one.
  c.status = c.queued.length ? 'working' : 'idle';
  c.blocks.clear();
  c.streamed = [];
  persist(c);
  emit(c, true);
}

// ---------- permissions ----------

function onControl(c, m) {
  const req = m.request || {};
  if (req.subtype !== 'can_use_tool') {
    return write(c, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Spread doesn't handle ${req.subtype}` } });
  }
  const input = req.input || {};
  if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const item = push(c, { kind: 'question', requestId: m.request_id, questions: input.questions, answers: null, status: 'pending' });
    c.approvals.set(m.request_id, { item, req });
    return emit(c, true);
  }
  if (c.always.has(req.tool_name)) return answer(c, m.request_id, req, 'allow');
  const item = push(c, { kind: 'approval', requestId: m.request_id, name: req.tool_name, ...describe(req.tool_name, input), preview: preview(req.tool_name, input), reason: req.decision_reason || null, status: 'pending' });
  c.approvals.set(m.request_id, { item, req });
  emit(c, true);
}

function answer(c, requestId, req, decision) {
  const response =
    decision === 'deny'
      ? { behavior: 'deny', message: 'The user declined this in Spread. Carry on without it or suggest another way.', toolUseID: req.tool_use_id }
      : { behavior: 'allow', updatedInput: req.input || {}, toolUseID: req.tool_use_id };
  write(c, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

/** The panel's Allow / Always / Deny on an approval card. */
function approve({ key, requestId, decision }) {
  const c = chats.get(key);
  const a = c && c.approvals.get(requestId);
  if (!a) return;
  c.approvals.delete(requestId);
  if (decision === 'always') c.always.add(a.req.tool_name);
  a.item.status = decision === 'deny' ? 'denied' : 'allowed';
  answer(c, requestId, a.req, decision);
  emit(c, true);
}

/** The panel's answers to a question card (question text → chosen label(s), comma-separated), or a skip. */
function answerQuestions({ key, requestId, answers }) {
  const c = chats.get(key);
  const a = c && c.approvals.get(requestId);
  if (!a) return;
  c.approvals.delete(requestId);
  const req = a.req;
  if (answers) {
    a.item.status = 'answered';
    a.item.answers = answers;
    write(c, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: { ...(req.input || {}), answers }, toolUseID: req.tool_use_id } } });
  } else {
    a.item.status = 'skipped';
    write(c, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'The user skipped these questions. Use your judgement, say in one line what you assumed, and carry on.', toolUseID: req.tool_use_id } } });
  }
  emit(c, true);
}

// ---------- describing tool calls ----------

const SPREAD_LABELS = {
  get_state: 'Read the canvas',
  get_feedback: 'Read your picks',
  guide: 'Read the design guide',
  add_nodes: 'Added layers',
  update_nodes: 'Edited layers',
  delete_nodes: 'Deleted layers',
  select: 'Selected layers',
  arrange: 'Arranged photos',
  import_photos: 'Imported photos',
  render_slides: 'Looked at the design',
  render_overview: 'Looked at every row',
  lint: 'Checked the layout',
  batch: 'Ran a batch of steps',
  create_board: 'Made a new row',
  duplicate_board: 'Duplicated a row',
  delete_board: 'Deleted a row',
  update_board: 'Updated a row',
  activate_board: 'Switched rows',
  list_boards: 'Listed rows',
  make_variants: 'Made directions',
  set_document: 'Set up the page',
  export_pdf: 'Exported a PDF',
  export_slides: 'Exported images',
  pdf_text: 'Checked the PDF text',
  list_fonts: 'Listed fonts',
  list_brands: 'Listed brands',
  get_brand: 'Read the brand',
  save_brand: 'Saved the brand',
  use_brand: 'Switched brand',
  create_email: 'Started an email',
  add_email_section: 'Added an email section',
  email_html: 'Checked the email HTML',
  export_email: 'Exported the email',
  list_email_templates: 'Listed email templates',
  save_project: 'Saved the project',
  open_project: 'Opened a project',
  new_project: 'Started a project',
  undo: 'Undid a step',
  redo: 'Redid a step',
  launch: 'Opened Spread',
};

const base = (p) => (p ? path.basename(String(p)) : '');

/** A short human label (and optional detail) for a tool call. */
function describe(name, input) {
  const spread = /^mcp__spread__spread_(.+)$/.exec(name || '');
  if (spread) {
    const label = SPREAD_LABELS[spread[1]] || spread[1].replace(/_/g, ' ');
    const steps = Array.isArray(input.steps) ? input.steps.length : 0;
    return { label, detail: steps ? `${steps} steps` : input.path ? base(input.path) : '' };
  }
  switch (name) {
    case 'Read':
      return { label: 'Read', detail: base(input.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Edit', detail: base(input.file_path) };
    case 'Write':
      return { label: 'Write', detail: base(input.file_path) };
    case 'Glob':
    case 'Grep':
      return { label: 'Searched files', detail: input.pattern ? String(input.pattern).slice(0, 60) : '' };
    case 'Bash':
      return { label: 'Run a command', detail: String(input.description || input.command || '').slice(0, 80) };
    case 'WebFetch':
      return { label: 'Open a web page', detail: hostOf(input.url) };
    case 'WebSearch':
      return { label: 'Search the web', detail: String(input.query || '').slice(0, 60) };
    case 'Task':
    case 'Agent':
      return { label: 'Asked a helper', detail: String(input.description || '').slice(0, 60) };
    case 'Skill':
      return { label: 'Loaded a skill', detail: String(input.skill || input.name || '') };
    case 'TodoWrite':
      return { label: 'Updated the plan', detail: '' };
    default:
      return { label: String(name || 'Tool').replace(/^mcp__([^_]+)__/, '$1: ').replace(/_/g, ' '), detail: '' };
  }
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** What an approval card shows: the command, the path, or the change. */
function preview(name, input) {
  if (name === 'Bash') return String(input.command || '').slice(0, 600);
  if (name === 'Write') return `${input.file_path}\n\n${String(input.content || '').slice(0, 400)}`;
  if (name === 'Edit') return `${input.file_path}\n\n− ${String(input.old_string || '').slice(0, 200)}\n+ ${String(input.new_string || '').slice(0, 200)}`;
  if (name === 'WebFetch') return String(input.url || '');
  if (input.file_path) return String(input.file_path);
  const s = JSON.stringify(input);
  return s.length > 2 ? s.slice(0, 400) : '';
}

// ---------- the panel's API ----------

function open(key) {
  return snapshot(chatFor(key));
}

async function sendMessage({ key, cwd, text, content, label, noteId }) {
  const c = chatFor(key);
  if (cwd) {
    // Claude Code's working folder (and its CLAUDE.md) follows the project; restart if it moved.
    if (c.proc && c.cwd !== cwd) stop(key, true);
    c.cwd = cwd;
  }
  // Claude Code reads a message sent mid-turn at its next step, so the user can steer without waiting.
  if (c.status === 'working') {
    c.queued.push({ id: `q${c.nextId++}`, text, content, label, noteId });
    if (noteId) c.notes[noteId] = 'waiting';
    emit(c, true);
  } else {
    c.lastPayload = { text, content, label, noteId, at: Date.now() };
    if (noteId) c.notes[noteId] = 'working';
    push(c, { kind: 'user', text, label: label || null });
    setStatus(c, 'working');
  }
  if (!c.proc) {
    c.starting = c.starting || start(c).finally(() => (c.starting = null));
    if (!(await c.starting)) {
      c.queued = [];
      settleNotes(c, 'stopped');
      return emit(c, true);
    }
  }
  write(c, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: c.sessionId || '' });
}

/** Sends the last message again (after signing in, say), without repeating it in the transcript. */
async function retry(key) {
  const c = chatFor(key);
  const p = c.lastPayload;
  if (!p) return;
  c.items = c.items.filter((it) => !(it.kind === 'notice' && it.at >= p.at));
  if (p.noteId) c.notes[p.noteId] = 'working';
  setStatus(c, 'working');
  if (!c.proc && !(await start(c))) return settleNotes(c, 'stopped');
  write(c, { type: 'user', message: { role: 'user', content: p.content }, parent_tool_use_id: null, session_id: c.sessionId || '' });
}

function stop(key, kill = false) {
  const c = chats.get(key);
  if (!c || !c.proc) return;
  // Claude Code would carry on with queued messages after an interrupt, and Stop means stop.
  const held = c.queued.length > 0;
  c.queued = [];
  settleNotes(c, 'stopped');
  emit(c, true);
  if (kill || held) {
    c.stopping = true;
    c.proc.kill();
    emit(c, true);
    return;
  }
  write(c, { type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
  // If Claude Code doesn't wind down promptly, end the process; the next message resumes the session.
  const proc = c.proc;
  setTimeout(() => {
    if (c.proc === proc && c.status !== 'idle') {
      c.stopping = true;
      proc.kill();
    }
  }, 4000);
}

/** Starts a fresh conversation for this project. */
function reset(key) {
  const c = chatFor(key);
  if (c.proc) c.proc.kill();
  c.proc = null;
  c.sessionId = null;
  c.items = [];
  c.queued = [];
  settleNotes(c, 'stopped');
  c.always.clear();
  c.approvals.clear();
  c.status = 'idle';
  persist(c);
  emit(c, true);
}

/** An unsaved project got a path: carry its conversation over. */
function rename({ from, to }) {
  const c = chats.get(from);
  if (!c || from === to || chats.has(to)) return;
  chats.delete(from);
  c.key = to;
  chats.set(to, c);
  try {
    fs.unlinkSync(fileOf(from));
  } catch {
    // never saved
  }
  persist(c);
}

/** Opens a terminal running `claude auth login`; the user signs in there, in their browser. */
async function login() {
  const bin = await findClaude();
  if (!bin) return { ok: false, error: 'Claude Code isn’t installed.' };
  if (IS_WIN) {
    spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', bin, 'auth', 'login'], { detached: true, windowsHide: false });
    return { ok: true };
  }
  const script = path.join(os.tmpdir(), 'spread-claude-login.command');
  fs.writeFileSync(script, `#!/bin/sh\nclear\necho "Sign in to Claude Code for Spread's panel. When it says you're signed in, close this window."\n"${bin}" auth login\n`, { mode: 0o755 });
  const err = await shell.openPath(script);
  return err ? { ok: false, error: err } : { ok: true };
}

/** DESIGN.md (any case) in a folder, so a project's own design doc travels with it. */
function designDocs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^design\.md$/i.test(n))
      .slice(0, 1)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function quitAll() {
  for (const c of chats.values()) if (c.proc) c.proc.kill();
}

module.exports = { init, open, sendMessage, retry, stop, reset, rename, approve, answerQuestions, login, designDocs, quitAll };
