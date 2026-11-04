#!/usr/bin/env node
// Manual check of the Spread bridge: `node mcp/smoke.mjs` while the app is running.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = join(process.env.SPREAD_HOME || join(homedir(), '.spread'), 'bridge.json');
let info;
try {
  info = JSON.parse(await readFile(file, 'utf8'));
} catch {
  console.log(`No bridge file at ${file} — is Spread running?`);
  process.exit(1);
}
console.log('bridge:', { port: info.port, pid: info.pid });

const base = `http://127.0.0.1:${info.port}`;
try {
  const h = await fetch(`${base}/health`);
  console.log('health:', h.status, await h.text());
  const r = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ method: 'get_state', params: {} }),
  });
  const body = await r.json();
  if (body.error) console.log('get_state error:', body.error);
  else {
    const s = body.result;
    console.log('get_state:', {
      name: s.name,
      size: `${s.slideWidth}x${s.slideHeight}`,
      slides: s.slideCount,
      nodes: s.nodes?.length,
      photos: s.photos?.length,
      selection: s.selection,
    });
  }
} catch (e) {
  console.log('Bridge not reachable:', e.message);
  process.exit(1);
}
