// The brand library: one folder per brand kit under ~/.spread/brands/<id>/ with brand.json and
// fonts/. Plain files, so a kit can be backed up, shared or checked into a repo.
const { shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.spread', 'brands');
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const dirOf = (id) => {
  if (!ID.test(id)) throw new Error(`Bad brand id "${id}"`);
  return path.join(ROOT, id);
};

function list() {
  let names = [];
  try {
    names = fs.readdirSync(ROOT);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const brand = JSON.parse(fs.readFileSync(path.join(ROOT, n, 'brand.json'), 'utf8'));
      if (brand && brand.id === n) out.push({ ...brand, dir: path.join(ROOT, n) });
    } catch {
      // not a brand folder
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes brand.json. fontFiles ({ path, family }) are copied into fonts/ and listed on that family. */
function save({ brand, fontFiles = [] }) {
  const dir = dirOf(brand.id);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  const next = { ...brand, fonts: (brand.fonts || []).map((f) => ({ ...f })) };
  delete next.dir;
  for (const f of fontFiles) {
    const file = path.basename(f.path);
    fs.copyFileSync(f.path, path.join(dir, 'fonts', file));
    let entry = next.fonts.find((x) => x.family === f.family);
    if (!entry) next.fonts.push((entry = { family: f.family }));
    entry.files = [...new Set([...(entry.files || []), file])];
  }
  next.updatedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(next, null, 2) + '\n');
  return { ...next, dir };
}

/** Writes font bytes carried inside a .spread file, so a project's brand can be installed on a new machine. */
function writeFont({ id, file, data }) {
  const dir = dirOf(id);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fonts', path.basename(file)), Buffer.from(data));
}

/** Moves the brand folder to the Trash (recoverable), never a hard delete. */
async function remove(id) {
  await shell.trashItem(dirOf(id));
}

module.exports = { list, save, writeFont, remove };
