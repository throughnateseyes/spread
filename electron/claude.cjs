// Connecting Claude to Spread, for the Connect Claude dialog.
//
// - Claude desktop app: opens Spread.mcpb (the packaged MCP server, see scripts/build-connector.mjs),
//   which Claude Desktop installs as an extension after the user clicks Install there.
// - Claude Code: registers the MCP server at user scope (`claude mcp add-json -s user`), so it works
//   in every folder, not only inside this repo.
// - app.json: tells the MCP server how to start Spread (spread_launch) from wherever it runs.
const { app, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const APP_FILE = path.join(HOME, '.spread', 'app.json');
const ROOT = path.join(__dirname, '..');

let lastClient = null;

/** Called by the bridge on every RPC so the dialog can say which Claude used Spread last. */
function noteClient(name) {
  lastClient = { name: name || 'unknown', at: Date.now() };
}

function writeAppFile() {
  const spec = app.isPackaged
    ? { command: process.execPath, args: [] }
    : fs.existsSync(path.join(ROOT, 'dist', 'index.html'))
      ? { command: process.execPath, args: [ROOT], cwd: ROOT }
      : { command: IS_WIN ? 'npm.cmd' : 'npm', args: ['run', 'app'], cwd: ROOT };
  try {
    fs.mkdirSync(path.dirname(APP_FILE), { recursive: true });
    fs.writeFileSync(APP_FILE, JSON.stringify({ ...spec, version: app.getVersion() }, null, 2));
  } catch (e) {
    console.warn('Could not write app file:', e.message);
  }
}

/** How Claude Code should run the MCP server: the repo copy in development, the bundled one when packaged. */
function serverConfig() {
  if (!app.isPackaged) return { command: 'node', args: [path.join(ROOT, 'mcp', 'server.mjs')] };
  return {
    command: process.execPath,
    args: [path.join(process.resourcesPath, 'connector', 'server', 'index.mjs')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000, windowsHide: true, shell: IS_WIN && /\.cmd$/i.test(file), ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() }),
    );
  });
}

// Apps opened from the Finder or Start menu don't get the terminal's PATH, so look in the usual
// install spots first, then ask the user's shell.
let claudeBin;
async function findClaude() {
  if (claudeBin && fs.existsSync(claudeBin)) return claudeBin;
  const candidates = IS_WIN
    ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')]
    : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  claudeBin = candidates.find((p) => fs.existsSync(p));
  if (!claudeBin) {
    const r = IS_WIN ? await run('where', ['claude']) : await run(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v claude']);
    const found = r.ok && r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    claudeBin = found || null;
  }
  return claudeBin;
}

const claudeDesktopDir = () => (IS_WIN ? path.join(process.env.APPDATA || '', 'Claude') : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Claude') : path.join(HOME, '.config', 'Claude'));

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function status() {
  const desktopDir = claudeDesktopDir();
  let desktopInstalled = false;
  try {
    desktopInstalled = fs.readdirSync(path.join(desktopDir, 'Claude Extensions')).some((n) => /spread/i.test(n));
  } catch {
    // no extensions folder yet
  }
  const codeConfig = readJson(path.join(HOME, '.claude.json'));
  return {
    desktop: { app: fs.existsSync(desktopDir), installed: desktopInstalled },
    code: { cli: !!(await findClaude()), installed: !!codeConfig?.mcpServers?.spread },
    lastClient,
  };
}

/** The .mcpb to hand to Claude Desktop. In development it's rebuilt when the server or guides changed. */
async function extensionFile() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'Spread.mcpb');
  const out = path.join(ROOT, 'release', 'Spread.mcpb');
  const sources = [path.join(ROOT, 'mcp', 'server.mjs'), ...['spread-director', 'spread-document', 'spread-carousel', 'spread-eblast'].map((s) => path.join(ROOT, '.claude', 'skills', s, 'SKILL.md'))];
  const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
  if (sources.some((s) => mtime(s) > mtime(out))) {
    // Electron doubles as Node here, so this works without node on PATH.
    const r = await run(process.execPath, [path.join(ROOT, 'scripts', 'build-connector.mjs')], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000 });
    if (!r.ok) throw new Error(`Building the extension failed: ${r.err.split('\n').slice(-3).join(' ')}`);
  }
  return out;
}

async function connectDesktop() {
  if (!fs.existsSync(claudeDesktopDir())) return { ok: false, error: 'The Claude desktop app isn’t installed on this computer.' };
  const file = await extensionFile();
  const err = await shell.openPath(file);
  return err ? { ok: false, error: err } : { ok: true };
}

async function connectCode() {
  const bin = await findClaude();
  if (!bin) return { ok: false, error: 'Claude Code isn’t installed, or Spread can’t find it.' };
  await run(bin, ['mcp', 'remove', 'spread', '-s', 'user']);
  // Plain args rather than add-json: JSON doesn't survive cmd.exe quoting when claude is a .cmd shim.
  const c = serverConfig();
  const env = Object.entries(c.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = await run(bin, ['mcp', 'add', 'spread', '-s', 'user', ...env, '--', c.command, ...c.args]);
  return r.ok ? { ok: true } : { ok: false, error: r.err || r.out };
}

async function disconnectCode() {
  const bin = await findClaude();
  if (!bin) return { ok: false, error: 'Claude Code isn’t installed, or Spread can’t find it.' };
  const r = await run(bin, ['mcp', 'remove', 'spread', '-s', 'user']);
  return r.ok ? { ok: true } : { ok: false, error: r.err || r.out };
}

module.exports = { findClaude, noteClient, writeAppFile, status, connectDesktop, connectCode, disconnectCode };
