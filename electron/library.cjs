// The design library: saved templates (~/.spread/templates/<id>/) and references
// (~/.spread/references/<id>/). Each item is a folder with meta.json plus the files the renderer
// wrote (a template.spread zip and a thumbnail, or a reference's renders and board.json). Plain
// files, so the library can be backed up or shared, and Claude can read a reference's images.
const { shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.spread');
const KINDS = new Set(['templates', 'references']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function dirOf(kind, id) {
  if (!KINDS.has(kind)) throw new Error(`Bad library kind "${kind}"`);
  if (!ID.test(id)) throw new Error(`Bad library id "${id}"`);
  return path.join(ROOT, kind, id);
}

function list(kind) {
  if (!KINDS.has(kind)) throw new Error(`Bad library kind "${kind}"`);
  const root = path.join(ROOT, kind);
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, n, 'meta.json'), 'utf8'));
      if (meta && meta.id === n) out.push({ ...meta, dir: path.join(root, n) });
    } catch {
      // not a library folder
    }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Writes meta.json and the files ({ name, data }) into the item's folder. */
function save({ kind, meta, files = [] }) {
  const dir = dirOf(kind, meta.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f.name)), Buffer.from(f.data));
  const next = { ...meta };
  delete next.dir;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2) + '\n');
  return { ...next, dir };
}

/** Moves the item to the Trash (recoverable), never a hard delete. */
async function remove({ kind, id }) {
  await shell.trashItem(dirOf(kind, id));
}

module.exports = { list, save, remove };
