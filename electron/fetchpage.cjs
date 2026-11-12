// Reads a public web page for the renderer (listing pages for "Fill cards from listing links").
// The main process isn't held back by CORS. Kept deliberately small: http(s) only, a normal
// browser User-Agent and nothing else that identifies the user (no cookies, no referrer),
// redirects followed, 10 seconds, at most 2 MB of text.
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('That isn’t a web link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https links can be read.');
  return u;
}

/** { url (after redirects), status, type, html }. Throws a plain-English error. */
async function fetchPage(raw) {
  const u = checkUrl(raw);
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('The page took longer than 10 seconds to answer.');
    throw new Error(`Couldn’t reach ${u.hostname}.`);
  }
  checkUrl(res.url || u.href); // a redirect can't leave the web
  if (!res.ok) throw new Error(res.status === 404 ? 'That page doesn’t exist (404). The listing may have been taken down.' : `The site answered ${res.status}.`);
  const type = res.headers.get('content-type') || '';
  if (type && !/text\/|html|xml|json/i.test(type)) throw new Error('That link isn’t a web page.');
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('That page is too large to read.');

  // Read at most MAX_BYTES, even when the server doesn't say how much is coming.
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('That page is too large to read.');
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  return { url: res.url || u.href, status: res.status, type, html };
}

module.exports = { fetchPage };
