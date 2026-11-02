import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(root, 'dist');
const destination = path.join(dist, 'tools/life_diary');
// Only this generated directory may be removed. Source files remain authoritative.
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('Invalid build output path');
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });

const files = new Set(['index.html', 'app.js', 'google-drive.js', 'styles.css', 'manifest.json', 'favicon.png', 'sw.js', 'update.html']);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons) files.add(icon.src);
for (const relative of files) {
  const source = path.resolve(root, relative);
  const target = path.resolve(destination, relative);
  if (!source.startsWith(root + path.sep) || !target.startsWith(destination + path.sep)) throw new Error('Asset path escapes build directory');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
console.log(`Built ${files.size} app files for /tools/life_diary/`);
