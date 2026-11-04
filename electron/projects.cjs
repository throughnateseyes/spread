// The Home screen's records: which .spread files Spread knows about, the folders they sit in, and
// the tabs that were open. It's an index in ~/.spread/projects.json, so projects stay ordinary files
// wherever they were saved, and a Home folder never moves anything on disk. Thumbnails sit in
// ~/.spread/thumbs and safety copies in ~/.spread/backups, both named by a hash of the file's path.
const crypto = require('crypto');
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { SPREAD_DIR } = require('./paths.cjs');
const ROOT = SPREAD_DIR;
const INDEX = path.join(ROOT, 'projects.json');
const THUMBS = path.join(ROOT, 'thumbs');
const BACKUPS = path.join(ROOT, 'backups');
/** Safety copies kept per project. */
const KEEP_BACKUPS = 3;

const hash = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
const defaultDir = () => path.join(app.getPath('pictures'), 'Spread');

const EMPTY = { version: 1, folders: [], projects: [], hidden: [], tabs: [], activeTab: null, home: true };

/** Writes beside the target and renames over it, so a crash can't leave half a file. */
async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

async function readIndex() {
  try {
    return { ...EMPTY, ...JSON.parse(await fs.promises.readFile(INDEX, 'utf8')) };
  } catch {
    return { ...EMPTY };
  }
}

async function spreadFilesIn(dir) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.toLowerCase().endsWith('.spread') && !n.startsWith('.')).map((n) => path.join(dir, n));
}

/** The index, with files from the default folder added and each file's date and presence refreshed. */
async function read() {
  const index = await readIndex();
  const known = new Set(index.projects.map((p) => p.path));
  const hidden = new Set(index.hidden);
  for (const file of await spreadFilesIn(defaultDir())) {
    if (!known.has(file) && !hidden.has(file)) index.projects.push({ path: file, folderId: null, openedAt: 0 });
  }
  for (const p of index.projects) {
    try {
      const st = await fs.promises.stat(p.path);
      p.updatedAt = st.mtimeMs;
      p.missing = false;
    } catch {
      p.missing = true;
    }
    const thumb = path.join(THUMBS, `${hash(p.path)}.jpg`);
    p.thumbPath = fs.existsSync(thumb) ? thumb : undefined;
  }
  return { ...index, dir: defaultDir() };
}

async function write(index) {
  const { dir: _dir, ...rest } = index;
  const projects = rest.projects.map(({ missing: _m, thumbPath: _t, ...p }) => p);
  await writeAtomic(INDEX, JSON.stringify({ ...rest, projects }, null, 2) + '\n');
}

/** A free file name in `dir`: "Name.spread", then "Name 2.spread". */
function freePath(dir, name) {
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${name}${i > 1 ? ` ${i}` : ''}.spread`);
    if (!fs.existsSync(file)) return file;
  }
}

async function moveThumb(from, to) {
  await fs.promises.rename(path.join(THUMBS, `${hash(from)}.jpg`), path.join(THUMBS, `${hash(to)}.jpg`)).catch(() => {});
}

/** Renames the file in place. Refuses to overwrite another project. */
async function rename({ from, name }) {
  const to = path.join(path.dirname(from), `${name}.spread`);
  if (to === from) return from;
  if (fs.existsSync(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`There's already a project called "${name}" in that folder`);
  await fs.promises.rename(from, to);
  await moveThumb(from, to);
  return to;
}

async function duplicate(from) {
  const to = freePath(path.dirname(from), `${path.basename(from, path.extname(from))} copy`);
  await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  await fs.promises.copyFile(path.join(THUMBS, `${hash(from)}.jpg`), path.join(THUMBS, `${hash(to)}.jpg`)).catch(() => {});
  return to;
}

/** Moves the file to the Trash (recoverable), never a hard delete. */
async function trash(file) {
  await shell.trashItem(file);
  await fs.promises.rm(path.join(THUMBS, `${hash(file)}.jpg`), { force: true });
}

async function writeThumb({ path: file, data }) {
  await writeAtomic(path.join(THUMBS, `${hash(file)}.jpg`), Buffer.from(data));
}

/** Keeps a copy of the file as it stands, before autosave first replaces it this session. */
async function backup(file) {
  if (!fs.existsSync(file)) return;
  const dir = path.join(BACKUPS, hash(file));
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.promises.copyFile(file, path.join(dir, `${stamp} ${path.basename(file)}`));
  const old = (await fs.promises.readdir(dir)).sort().slice(0, -KEEP_BACKUPS);
  await Promise.all(old.map((n) => fs.promises.rm(path.join(dir, n), { force: true })));
}

module.exports = { read, write, rename, duplicate, trash, writeThumb, backup, freePath, defaultDir, writeAtomic };
