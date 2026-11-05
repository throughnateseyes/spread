// Electron main process: one window, native file dialogs over IPC, .spread file association.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { DEV, SPREAD_DIR } = require('./paths.cjs');
const claude = require('./claude.cjs');
const brands = require('./brands.cjs');
const library = require('./library.cjs');
const projects = require('./projects.cjs');
const hosting = require('./hosting.cjs');
const chat = require('./chat.cjs');

let win = null;
let dirty = false;
let closeOk = false;
let quitting = false;
let flushTimer = null;
let rendererReady = false;
const pendingPaths = [];
const readyWaiters = [];

function spreadPathFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().endsWith('.spread') && fs.existsSync(a)) || null;
}

function sendOpenPath(p) {
  if (!p) return;
  if (win && rendererReady) {
    win.webContents.send('open-path', p);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    pendingPaths.push(p);
  }
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // Undo/redo/select-all are deliberately absent: the renderer handles those keys itself.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
      // ⌘W closes the project tab in the renderer, so the window takes ⇧⌘W.
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }] },
    ]),
  );
}

// The app icon. Packaged builds get theirs from electron-builder (.icns / .ico); in dev the Dock and
// window would otherwise show Electron's.
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    ...(process.platform !== 'darwin' && fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {}),
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    // Matches the renderer's --bg until it loads (the in-app theme defaults to the system one).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1d' : '#ffffff',
    title: 'Spread',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.SPREAD_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    // Pinch gestures should zoom the canvas, not the whole app UI.
    win.webContents.setVisualZoomLevelLimits(1, 1);
    rendererReady = true;
    while (pendingPaths.length) win.webContents.send('open-path', pendingPaths.shift());
    while (readyWaiters.length) readyWaiters.shift()();
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) win.webContents.toggleDevTools();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL();
    if (url !== current && /^https?:/i.test(url) && !(devUrl && url.startsWith(devUrl))) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Unsaved work is written to its file before the window goes, so closing never asks.
  win.on('close', (e) => {
    if (closeOk || !dirty || !rendererReady) return;
    e.preventDefault();
    if (flushTimer) return;
    win.webContents.send('flush-close');
    flushTimer = setTimeout(() => finishClose(false), 8000);
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
    closeOk = false;
  });
}

function finishClose(saved) {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!win) return;
  if (!saved) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: "Your latest changes couldn't be saved.",
      detail: 'Closing now loses them.',
    });
    if (choice === 1) {
      quitting = false;
      return;
    }
  }
  closeOk = true;
  win.close();
  if (quitting) app.quit();
}

ipcMain.on('flushed', (_e, ok) => finishClose(!!ok));

// ---------- IPC ----------

const toBuffer = (data) => Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));

// On macOS a save/open panel attached to the window as a sheet sometimes never appears: the panel
// service creates it but never puts it on screen, and the caller waits forever (export stuck on
// "Choose a folder…"). A free-standing panel in front of the app is reliable.
function dialogArgs(opts) {
  if (process.platform !== 'darwin') return [win, opts];
  app.focus({ steal: true });
  return [opts];
}

ipcMain.handle('save-file', async (_e, { defaultPath, filters, data }) => {
  const r = await dialog.showSaveDialog(...dialogArgs({ defaultPath, filters }));
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, toBuffer(data));
  return r.filePath;
});

ipcMain.handle('write-file', async (_e, { path: p, data }) => {
  await projects.writeAtomic(p, toBuffer(data));
  return p;
});

async function readFile(p) {
  const buf = await fs.promises.readFile(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

ipcMain.handle('open-file', async (_e, { filters } = {}) => {
  const r = await dialog.showOpenDialog(...dialogArgs({ properties: ['openFile'], filters }));
  if (r.canceled || !r.filePaths.length) return null;
  return readFile(r.filePaths[0]);
});

ipcMain.handle('read-file', async (_e, p) => readFile(p));

// A photo from the web, for table cells that hold a link. The main process isn't held back by CORS.
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
ipcMain.handle('fetch-image', async (_e, url) => {
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Only web links can be downloaded.');
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('That link is not an image.');
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error('That image is too large.');
  return { data, type };
});

ipcMain.handle('pick-directory', async (_e, { defaultPath } = {}) => {
  const opts = { properties: ['openDirectory', 'createDirectory'] };
  if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
  const r = await dialog.showOpenDialog(...dialogArgs(opts));
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Spread's own folder browser (src/components/FolderPicker.tsx). The macOS folder panel can fail to
// appear for this app, so choosing an export folder doesn't depend on it.
ipcMain.handle('list-dir', async (_e, dir) => {
  const home = os.homedir();
  const target = dir && fs.existsSync(dir) ? path.resolve(dir) : home;
  let entries = [];
  let error = null;
  try {
    entries = (await fs.promises.readdir(target, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !(process.platform === 'darwin' && target === home && d.name === 'Library'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  } catch (e) {
    error = e.code === 'EPERM' || e.code === 'EACCES' ? 'Spread isn’t allowed to read this folder.' : e.message;
  }
  const places = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
    ['Pictures', app.getPath('pictures')],
    ['Spread exports', path.join(app.getPath('pictures'), 'Spread')],
  ].filter(([, p]) => fs.existsSync(p)).map(([label, p]) => ({ label, path: p }));
  const parent = path.dirname(target);
  return { dir: target, parent: parent !== target ? parent : null, entries, places, error };
});

ipcMain.handle('make-dir', async (_e, { dir, name }) => {
  const clean = String(name || '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  if (!clean) throw new Error('Give the folder a name');
  const target = path.join(dir, clean);
  await fs.promises.mkdir(target, { recursive: true });
  return target;
});

ipcMain.handle('write-files', async (_e, { dir, files }) => {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const f of files) {
    const target = path.join(dir, path.basename(f.name));
    await fs.promises.writeFile(target, toBuffer(f.data));
  }
  return dir;
});

// Prints a self-contained HTML page set (built by src/pdf.ts, fonts and images inlined) to a
// vector PDF with real, selectable text. widthIn/heightIn = page size in inches.
ipcMain.handle('print-pdf', async (_e, { html, widthIn, heightIn }) => {
  const tmp = path.join(os.tmpdir(), `spread-print-${process.pid}-${Date.now()}.html`);
  await fs.promises.writeFile(tmp, html, 'utf8');
  const pw = new BrowserWindow({ show: false, webPreferences: { javascript: true, sandbox: true } });
  try {
    await pw.loadFile(tmp);
    await pw.webContents.executeJavaScript(
      'document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => true)',
    );
    const pdf = await pw.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: { width: widthIn, height: heightIn },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  } finally {
    pw.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
});

// Photographs HTML at a real viewport width: an email preview for Claude, or a past email to compare
// against. Scripts stay off, since a past email can come from anywhere. height 0 fits the whole page,
// and relative pictures resolve against dir.
ipcMain.handle('render-html', async (_e, { html, width, height = 0, maxHeight = 6000, dir, format = 'jpeg' }) => {
  const head = `${dir ? `<base href="${pathToFileURL(dir + path.sep).href}">` : ''}<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
  const page = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
  const tmp = path.join(os.tmpdir(), `spread-render-${process.pid}-${Date.now()}.html`);
  await fs.promises.writeFile(tmp, page, 'utf8');
  const pw = new BrowserWindow({ show: false, width, height: Math.max(1, Math.min(height || 100, maxHeight)), useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true } });
  const painted = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
  try {
    await pw.loadFile(tmp);
    // A slow or dead picture host shouldn't hold this up.
    await pw.webContents.executeJavaScript(
      `Promise.race([new Promise((r) => setTimeout(r, 15000)), document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null))))]).then(() => ${painted})`,
    );
    let h = Math.min(height, maxHeight);
    if (!h) {
      h = Math.max(1, Math.min(await pw.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)'), maxHeight));
      pw.setContentSize(width, h);
      await pw.webContents.executeJavaScript(painted);
    }
    const shot = await pw.webContents.capturePage({ x: 0, y: 0, width, height: h });
    return new Uint8Array(format === 'png' ? shot.toPNG() : shot.toJPEG(85));
  } finally {
    pw.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
});

ipcMain.handle('reveal', async (_e, p) => {
  try {
    const st = await fs.promises.stat(p);
    if (st.isDirectory()) await shell.openPath(p);
    else shell.showItemInFolder(p);
  } catch {
    // path vanished; nothing to show
  }
});

ipcMain.handle('set-dirty', (_e, v) => {
  dirty = !!v;
});

ipcMain.on('get-paths', (e) => {
  e.returnValue = { home: os.homedir(), pictures: app.getPath('pictures') };
});

const DEFAULT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'heic', 'ttf', 'otf', 'woff', 'woff2'];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function expandPaths(paths, exts) {
  const allow = new Set((exts && exts.length ? exts : DEFAULT_EXTS).map((x) => x.replace(/^\./, '').toLowerCase()));
  const out = [];
  const visit = async (p) => {
    if (path.basename(p).startsWith('.')) return;
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      const names = await fs.promises.readdir(p);
      for (const n of names) await visit(path.join(p, n));
    } else if (st.isFile() && allow.has(path.extname(p).slice(1).toLowerCase())) {
      out.push(path.resolve(p));
    }
  };
  for (const p of paths || []) await visit(p);
  return [...new Set(out)].sort((a, b) => collator.compare(a, b));
}

ipcMain.handle('list-files', async (_e, { paths, exts } = {}) => expandPaths(paths, exts));

// ---------- Connect Claude ----------

const guard = (fn) => async () => {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};
ipcMain.handle('claude-status', () => claude.status());
ipcMain.handle('claude-connect-desktop', guard(claude.connectDesktop));
ipcMain.handle('claude-connect-code', guard(claude.connectCode));
ipcMain.handle('claude-disconnect-code', guard(claude.disconnectCode));

// ---------- brand library ----------

ipcMain.handle('brands-list', () => brands.list());
ipcMain.handle('brand-save', (_e, opts) => brands.save(opts));
ipcMain.handle('brand-write-font', (_e, opts) => brands.writeFont(opts));
ipcMain.handle('brand-delete', (_e, id) => brands.remove(id));

// ---------- design library and picture hosting ----------

ipcMain.handle('projects-read', () => projects.read());
ipcMain.handle('projects-write', (_e, index) => projects.write(index));
ipcMain.handle('project-free-path', (_e, { dir, name }) => projects.freePath(dir || projects.defaultDir(), name));
ipcMain.handle('project-rename', (_e, opts) => projects.rename(opts));
ipcMain.handle('project-duplicate', (_e, file) => projects.duplicate(file));
ipcMain.handle('project-trash', (_e, file) => projects.trash(file));
ipcMain.handle('project-thumb', (_e, opts) => projects.writeThumb(opts));
ipcMain.handle('project-backup', (_e, file) => projects.backup(file));
ipcMain.handle('library-list', (_e, kind) => library.list(kind));
ipcMain.handle('library-save', (_e, opts) => library.save(opts));
ipcMain.handle('library-delete', (_e, opts) => library.remove(opts));

/** Hosting calls answer { ok: true, ... } or { ok: false, error } so the renderer can show the reason. */
const answer = (fn) => async (_e, opts) => {
  try {
    return { ok: true, ...(await fn(opts)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};
ipcMain.handle('hosting-status', answer(hosting.status));
ipcMain.handle('hosting-connect', answer(hosting.connect));
ipcMain.handle('hosting-disconnect', answer(hosting.disconnect));
ipcMain.handle('hosting-upload', answer(hosting.upload));

// ---------- Claude side panel ----------

chat.init((update) => {
  if (win && !win.isDestroyed()) win.webContents.send('chat-update', update);
});
ipcMain.handle('chat-open', (_e, key) => chat.open(key));
ipcMain.handle('chat-send', (_e, opts) => chat.sendMessage(opts));
ipcMain.handle('chat-retry', (_e, key) => chat.retry(key));
ipcMain.handle('chat-stop', (_e, key) => chat.stop(key));
ipcMain.handle('chat-reset', (_e, key) => chat.reset(key));
ipcMain.handle('chat-rename', (_e, opts) => chat.rename(opts));
ipcMain.handle('chat-approve', (_e, opts) => chat.approve(opts));
ipcMain.handle('chat-answer', (_e, opts) => chat.answerQuestions(opts));
ipcMain.handle('chat-login', guard(chat.login));
ipcMain.handle('chat-design-docs', (_e, dir) => chat.designDocs(dir));

// ---------- automation bridge (local HTTP → renderer) ----------
// Lets local tools (e.g. an MCP server for Claude Code) drive the app. Bound to 127.0.0.1,
// guarded by a random bearer token written to bridge.json in the Spread folder, and refuses browser origins.

const BRIDGE_FILE = path.join(SPREAD_DIR, 'bridge.json');
const BODY_LIMIT = 50 * 1024 * 1024;
const RPC_TIMEOUT = 120_000;
const bridgeToken = crypto.randomBytes(24).toString('hex');
const pendingRpc = new Map();
let bridgeServer = null;

ipcMain.on('automation-response', (_e, resp) => {
  const p = resp && pendingRpc.get(resp.id);
  if (!p) return;
  pendingRpc.delete(resp.id);
  clearTimeout(p.timer);
  p.resolve(resp);
});

function waitForRenderer(ms) {
  if (win && rendererReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    readyWaiters.push(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function handleBridge(req, res) {
  if (req.headers.origin) return sendJson(res, 403, { error: 'Browser origins are not allowed' });
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/health') return sendJson(res, 200, { ok: true, app: 'spread', version: app.getVersion() });
  if (req.method !== 'POST' || url !== '/rpc') return sendJson(res, 404, { error: 'Not found' });
  if (req.headers.authorization !== `Bearer ${bridgeToken}`) return sendJson(res, 401, { error: 'Unauthorized' });

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) return sendJson(res, 413, { error: 'Body too large' });
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  if (!body || typeof body.method !== 'string') return sendJson(res, 400, { error: 'Missing method' });
  claude.noteClient(req.headers['x-spread-client']);

  if (!(await waitForRenderer(15_000)) || !win) return sendJson(res, 504, { error: 'Spread window is not ready' });
  const id = crypto.randomUUID();
  const resp = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      resolve({ id, error: 'Timed out waiting for Spread', timeout: true });
    }, RPC_TIMEOUT);
    pendingRpc.set(id, { resolve, timer });
    win.webContents.send('automation-request', { id, method: body.method, params: body.params || {}, project: decodeURIComponent(req.headers['x-spread-project'] || '') || null });
  });
  if (resp.timeout) return sendJson(res, 504, { error: resp.error });
  if (resp.error !== undefined) return sendJson(res, 400, { error: String(resp.error) });
  return sendJson(res, 200, { result: resp.result === undefined ? null : resp.result });
}

function startBridge(port = 7331) {
  const server = http.createServer((req, res) => {
    handleBridge(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
    });
  });
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 7340) startBridge(port + 1);
    else console.warn('Automation bridge disabled:', err.message);
  });
  server.listen(port, '127.0.0.1', () => {
    bridgeServer = server;
    try {
      fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
      fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ port, token: bridgeToken, pid: process.pid }, null, 2));
    } catch (e) {
      console.warn('Could not write bridge file:', e.message);
    }
  });
}

function stopBridge() {
  try {
    const cur = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(BRIDGE_FILE);
  } catch {
    // already gone
  }
  if (bridgeServer) bridgeServer.close();
}

// ---------- lifecycle ----------

// A dev copy is its own app: otherwise the installed Spread holds the single-instance lock and the
// dev window quits on launch. It starts with a copy of the brands and library so there's real work
// to test against; nothing is ever written back, and hosting logins are left behind.
if (DEV) {
  app.setName('Spread Dev');
  app.setPath('userData', path.join(app.getPath('appData'), 'Spread Dev'));
  for (const dir of ['brands', 'templates', 'references']) {
    const from = path.join(os.homedir(), '.spread', dir);
    const to = path.join(SPREAD_DIR, dir);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = spreadPathFromArgv(argv.slice(1));
    if (p) sendOpenPath(p);
    else if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-file', (e, p) => {
    e.preventDefault();
    sendOpenPath(p);
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged && app.dock && fs.existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    buildMenu();
    createWindow();
    startBridge();
    claude.writeAppFile();
    const p = spreadPathFromArgv(process.argv.slice(1));
    if (p) sendOpenPath(p);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    stopBridge();
    chat.quitAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
