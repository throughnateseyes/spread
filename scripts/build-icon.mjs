// Rasterizes the app icon sources in assets/icon/ into every format the app and installers need.
//   assets/icon/icon.svg        -> assets/icon/icon.png (1024), assets/icon/icon.icns (macOS)
//   assets/icon/icon-square.svg -> assets/icon/icon.ico (Windows), connector/icon.png (512, Claude extension)
// and copies icon.png / .icns / .ico into build/ (electron-builder's default resources folder).
// The outputs are committed, so this only needs re-running when the SVGs change.
// Needs macOS (iconutil) and rsvg-convert (`brew install librsvg`). Run: npm run icon
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON = join(ROOT, 'assets', 'icon');
const tmp = mkdtempSync(join(tmpdir(), 'spread-icon-'));

const raster = (svg, size, out) => execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out]);

try {
  // macOS: 1024 master + .iconset -> .icns
  const mac = join(ICON, 'icon.svg');
  raster(mac, 1024, join(ICON, 'icon.png'));
  const set = join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    raster(mac, s, join(set, `icon_${s}x${s}.png`));
    raster(mac, s * 2, join(set, `icon_${s}x${s}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(ICON, 'icon.icns')]);

  // Windows: .ico holding PNG-compressed images (supported since Vista).
  const sq = join(ICON, 'icon-square.svg');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => {
    const p = join(tmp, `ico-${s}.png`);
    raster(sq, s, p);
    return readFileSync(p);
  });
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2); // palette
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bpp
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  writeFileSync(join(ICON, 'icon.ico'), Buffer.concat([head, ...pngs]));

  // Claude desktop extension icon.
  raster(sq, 512, join(ROOT, 'connector', 'icon.png'));

  // electron-builder also looks in build/ by default (gitignored, so copy rather than author there).
  mkdirSync(join(ROOT, 'build'), { recursive: true });
  for (const f of ['icon.png', 'icon.icns', 'icon.ico']) copyFileSync(join(ICON, f), join(ROOT, 'build', f));
  console.log('icons written to assets/icon/, connector/icon.png and build/');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
