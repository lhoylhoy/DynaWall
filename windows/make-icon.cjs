'use strict';

/**
 * Regenerate windows/app.ico from the 1024×1024 macOS icon master.
 *
 *   node windows/make-icon.cjs
 *
 * macOS ships `sips`, so the Windows icon is derived from the same Bauhaus
 * Sunrise artwork as AppIcon.icns — no third-party tooling. Each size is a PNG
 * inside the ICO container (Vista+ format). app.ico is checked in, so building the
 * Windows app does not need Node.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOWS_DIR = __dirname;
const ROOT = path.join(WINDOWS_DIR, '..');
const MASTER = path.join(ROOT, 'macos', 'AppIcon.png');
const OUTPUT = path.join(WINDOWS_DIR, 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

if (process.platform !== 'darwin') {
  console.error('make-icon.cjs needs macOS (sips) to resize the master icon.');
  process.exit(1);
}

if (!fs.existsSync(MASTER)) {
  console.error(`missing icon master: ${MASTER}`);
  process.exit(1);
}

const images = SIZES.map((size) => {
  const target = path.join(os.tmpdir(), `dynawall-icon-${size}.png`);
  execFileSync(
    'sips',
    ['-s', 'format', 'png', '-z', String(size), String(size), MASTER, '--out', target],
    { stdio: 'ignore' }
  );
  const data = fs.readFileSync(target);
  fs.rmSync(target, { force: true });
  return { size, data };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;

for (const image of images) {
  const entry = Buffer.alloc(16);
  // 256 px is encoded as 0 in the single-byte dimension fields.
  entry[0] = image.size >= 256 ? 0 : image.size;
  entry[1] = image.size >= 256 ? 0 : image.size;
  entry[2] = 0; // palette entries
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.data.length;
  entries.push(entry);
}

fs.writeFileSync(OUTPUT, Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${SIZES.join(', ')} px)`);
