#!/usr/bin/env node
// Builds the Claude Desktop extension: release/Spread.mcpb.
//
//   npm run connector
//
// Bundles mcp/server.mjs (with the MCP SDK and zod) into one file, copies the design guides
// (.claude/skills/*/SKILL.md) and pdf.js next to it, writes manifest.json with the live tool list,
// then validates and packs it with Anthropic's mcpb library. Double-clicking the .mcpb installs it in
// Claude Desktop, which runs the server with its own Node, so the user needs nothing else.

import { build } from 'rolldown';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packExtension, validateManifest } from '@anthropic-ai/mcpb/cli';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, 'build', 'connector');
const OUT = join(ROOT, 'release', 'Spread.mcpb');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'server', 'guides'), { recursive: true });

// 1. Server, bundled. pdf.js stays external: it loads its worker from a sibling file at runtime.
await build({
  input: join(ROOT, 'mcp', 'server.mjs'),
  platform: 'node',
  external: [/^node:/, /^pdfjs-dist/],
  output: { file: join(STAGE, 'server', 'index.mjs'), format: 'esm' },
  logLevel: 'warn',
});
const pdfjs = join(ROOT, 'node_modules', 'pdfjs-dist');
const pdfjsOut = join(STAGE, 'server', 'node_modules', 'pdfjs-dist');
mkdirSync(join(pdfjsOut, 'legacy', 'build'), { recursive: true });
cpSync(join(pdfjs, 'package.json'), join(pdfjsOut, 'package.json'));
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) cpSync(join(pdfjs, 'legacy', 'build', f), join(pdfjsOut, 'legacy', 'build', f));

// 2. Design guides, the same text as the Claude Code skills.
for (const skill of ['spread-director', 'spread-document', 'spread-carousel', 'spread-eblast']) {
  cpSync(join(ROOT, '.claude', 'skills', skill, 'SKILL.md'), join(STAGE, 'server', 'guides', `${skill}.md`));
}
cpSync(join(ROOT, 'connector', 'icon.png'), join(STAGE, 'icon.png'));

// 3. Ask the bundled server for its tools, which also proves the bundle starts.
const client = new Client({ name: 'spread-build', version: pkg.version });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(STAGE, 'server', 'index.mjs')] }));
const { tools } = await client.listTools();
await client.close();
const firstSentence = (s = '') => (s.match(/^[^]*?[.!?](?=\s|$)/)?.[0] ?? s).replace(/\s+/g, ' ').slice(0, 200);

// 4. Manifest.
const manifest = {
  manifest_version: '0.3',
  name: 'spread',
  display_name: 'Spread',
  version: pkg.version,
  description: 'Design carousels, resumes, posters, slides and emails with Claude on your own canvas, then refine by hand.',
  long_description:
    "Connects Claude to the Spread desktop app, a local design canvas. Claude builds directions live on your canvas, checks spacing and alignment, and exports PDFs with real text or PNGs. You pick, edit by hand, and make the final call. Spread needs to be installed on this computer; Claude can open it for you once you've opened it once.",
  author: { name: 'Spread', url: 'https://github.com/throughnateseyes/spread' },
  repository: { type: 'git', url: 'https://github.com/throughnateseyes/spread' },
  homepage: 'https://github.com/throughnateseyes/spread',
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs'] },
  },
  tools: tools.map((t) => ({ name: t.name, description: firstSentence(t.description) })),
  prompts_generated: true,
  keywords: ['design', 'carousel', 'resume', 'pdf', 'canvas', 'marketing'],
  compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=18.0.0' } },
};
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 5. Validate and pack. (The library, not the mcpb CLI: the app runs this script with Electron as
// Node, where the CLI's argument parser misreads its arguments.)
mkdirSync(dirname(OUT), { recursive: true });
if (!validateManifest(join(STAGE, 'manifest.json'))) throw new Error('manifest.json failed validation');
if (!(await packExtension({ extensionPath: STAGE, outputPath: OUT, silent: true }))) throw new Error('Packing the extension failed');
console.log(`\n${tools.length} tools → ${OUT}`);
