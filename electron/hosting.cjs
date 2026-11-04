// Picture hosting for email exports: uploads rendered pictures to a WordPress media library over
// the REST API, with an Application Password (Users → Profile → Application Passwords). The
// password is encrypted with the system keychain (safeStorage) before it touches disk. Uploads
// are keyed by a hash of the picture, so exporting the same email again reuses the URLs and only
// pictures that changed go up; old URLs are never overwritten, so sent emails keep working.
const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const { SPREAD_DIR } = require('./paths.cjs');
const FILE = path.join(SPREAD_DIR, 'hosting.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function store(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

const cleanSite = (site) => {
  let s = String(site || '').trim();
  if (!s) throw new Error('Enter the WordPress site address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) throw new Error('Use the https:// address of the site.');
  return u.origin + u.pathname.replace(/\/+$/, '');
};

async function secret(cfg) {
  const wp = cfg.wordpress;
  if (!wp) throw new Error('WordPress isn’t connected. Connect it in Export → Upload to WordPress.');
  const password = (await safeStorage.decryptStringAsync(Buffer.from(wp.password, 'base64'))).result;
  return { site: wp.site, auth: 'Basic ' + Buffer.from(`${wp.user}:${password}`).toString('base64') };
}

async function wpError(res) {
  let msg = '';
  try {
    msg = (await res.json()).message || '';
  } catch {
    // not JSON
  }
  msg = msg.replace(/<[^>]+>/g, '').trim();
  if (res.status === 401 || res.status === 403) return `WordPress turned down the login (${res.status}). Check the username and the application password${msg ? `: ${msg}` : '.'}`;
  if (res.status === 404) return 'That address has no WordPress REST API (/wp-json). Check the site address.';
  if (res.status === 413) return 'The server refused a picture as too large.';
  return `WordPress answered ${res.status}${msg ? `: ${msg}` : ''}`;
}

function status() {
  const wp = load().wordpress;
  return { wordpress: wp ? { site: wp.site, user: wp.user, name: wp.name || wp.user } : null };
}

/** Checks the login against /users/me, then saves it (password encrypted). */
async function connect({ site, user, password }) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('This computer can’t store the password securely.');
  const s = cleanSite(site);
  const u = String(user || '').trim();
  const pw = String(password || '').replace(/\s+/g, ' ').trim();
  if (!u || !pw) throw new Error('Enter the username and an application password.');
  const auth = 'Basic ' + Buffer.from(`${u}:${pw}`).toString('base64');
  let res;
  try {
    res = await fetch(`${s}/wp-json/wp/v2/users/me?context=edit`, { headers: { Authorization: auth } });
  } catch (e) {
    throw new Error(`Couldn’t reach ${s}: ${e.message}`);
  }
  if (!res.ok) throw new Error(await wpError(res));
  const me = await res.json();
  const caps = me.capabilities || {};
  if (caps.upload_files === false) throw new Error(`${me.name || u} can’t upload files on this site.`);
  const cfg = load();
  if (cfg.wordpress && cfg.wordpress.site !== s) cfg.uploaded = {};
  cfg.wordpress = { site: s, user: u, name: me.name || u, password: (await safeStorage.encryptStringAsync(pw)).toString('base64') };
  store(cfg);
  return status();
}

function disconnect() {
  const cfg = load();
  delete cfg.wordpress;
  store(cfg);
  return status();
}

/**
 * Uploads pictures ({ name, type, hash, data }) that aren't on the site yet.
 * Returns { urls: { hash: url }, uploaded, reused }.
 */
async function upload({ files }) {
  const cfg = load();
  const { site, auth } = await secret(cfg);
  cfg.uploaded = cfg.uploaded || {};
  const urls = {};
  let uploaded = 0;
  let reused = 0;
  for (const f of files) {
    const known = cfg.uploaded[f.hash];
    if (known && known.site === site) {
      urls[f.hash] = known.url;
      reused++;
      continue;
    }
    const res = await fetch(`${site}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': f.type,
        'Content-Disposition': `attachment; filename="${path.basename(f.name).replace(/"/g, '')}"`,
      },
      body: Buffer.from(f.data),
    });
    if (!res.ok) throw new Error(`${f.name}: ${await wpError(res)}`);
    const media = await res.json();
    const url = media.source_url || (media.guid && media.guid.rendered);
    if (!url) throw new Error(`${f.name}: WordPress didn’t return a URL.`);
    urls[f.hash] = url;
    cfg.uploaded[f.hash] = { site, url, at: Date.now() };
    store(cfg);
    uploaded++;
  }
  return { urls, uploaded, reused };
}

module.exports = { status, connect, disconnect, upload };
