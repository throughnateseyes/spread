// The send checklist's live check: loads one address from the email (a picture or a link) the way
// an inbox or a reader's browser would, from the main process because the renderer is held back by
// CORS. Runs only when asked, one address per call; the renderer decides which addresses and how
// many at a time. Sends nothing but a plain browser User-Agent: no cookies, no Spread header.

const TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ACCEPT = {
  image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  page: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ---------- picture sizes from the first bytes of the file ----------

/** EXIF orientation 5–8 turns the picture a quarter, so its shown width and height swap. */
function exifTurned(b, start, end) {
  // "Exif\0\0" then a TIFF header.
  if (b.toString('latin1', start, start + 6) !== 'Exif\0\0') return false;
  const t = start + 6;
  if (t + 8 > end) return false;
  const le = b.toString('latin1', t, t + 2) === 'II';
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return false;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return false;
    if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
  }
  return false;
}

/** { width, height } as shown, from a PNG, GIF, JPEG or WebP header; null if not found (yet). */
function imageSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let turned = false;
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = b.readUInt16BE(o + 2);
      if (m === 0xe1 && o + 4 + len - 2 <= b.length) turned = exifTurned(b, o + 4, o + 2 + len) || turned;
      // Start of frame (not DHT C4, JPG C8 or DAC CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (o + 9 > b.length) return null;
        const h = b.readUInt16BE(o + 5);
        const w = b.readUInt16BE(o + 7);
        return turned ? { width: h, height: w } : { width: w, height: h };
      }
      if (m === 0xda) return null;
      o += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------- loading ----------

const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function friendly(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `No answer after ${TIMEOUT_MS / 1000} seconds`;
  const code = e && e.cause && e.cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That web address doesn’t exist (no such site)';
  if (code === 'ECONNREFUSED') return 'The site refused the connection';
  if (code === 'ECONNRESET') return 'The site dropped the connection';
  if (code && /CERT|SSL|TLS/.test(code)) return 'The site’s security certificate isn’t valid';
  return String((e && e.message) || e);
}

/**
 * Loads one address. kind 'image': reads just far enough to know the picture's size.
 * kind 'page': returns the page's HTML (up to 1.5 MB) for the renderer to read.
 * Returns { status, type, finalUrl, redirected, width?, height?, html?, title? }; throws with a
 * plain-English reason when there is no answer at all.
 */
async function check({ url, kind }) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error('Not a web address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web addresses can be checked');
  const k = kind === 'image' ? 'image' : 'page';
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: ACCEPT[k] },
    });
  } catch (e) {
    throw new Error(friendly(e));
  }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const out = { status: res.status, type, finalUrl: res.url || u.href, redirected: !!res.redirected };
  const wantImage = k === 'image' && type.startsWith('image/');
  const wantText = /html|xml|text\//.test(type) || !type;
  if (!res.body || (!wantImage && !wantText)) {
    res.body?.cancel().catch(() => {});
    return out;
  }
  // Read only what's needed: a picture's header, or a page up to the cap.
  const cap = wantImage ? MAX_IMAGE_BYTES : k === 'page' ? MAX_PAGE_BYTES : 64 * 1024;
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (wantImage) {
        const dims = imageSize(Buffer.concat(chunks));
        if (dims) {
          Object.assign(out, dims);
          break;
        }
      }
      if (size >= cap) break;
    }
  } catch (e) {
    if (!size) throw new Error(friendly(e));
  } finally {
    reader.cancel().catch(() => {});
  }
  out.bytes = size;
  if (!wantImage) {
    const text = Buffer.concat(chunks).toString('utf8');
    if (k === 'page') out.html = text;
    const t = TITLE.exec(text);
    if (t) out.title = t[1].replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return out;
}

module.exports = { check, imageSize, TIMEOUT_MS };
