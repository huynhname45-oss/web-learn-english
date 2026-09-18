import fs from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCore, hashFile } from './update-core.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await verifyCore(root);
if (!process.argv.includes('--core-only')) {
  const home = resolve(process.env.ATLAS_HOME);
  const map = JSON.parse(await fs.readFile(resolve(root, 'app/media-map.json'), 'utf8'));
  const checked = new Set();
  for (const item of Object.values(map)) {
    if (checked.has(item.file)) continue;
    checked.add(item.file);
    const parent = item.file.startsWith('media/') ? home : root;
    const path = resolve(parent, item.file);
    if (!path.startsWith(parent + sep)) throw new Error('Invalid media path');
    if ((await fs.stat(path)).size !== item.bytes || await hashFile(path) !== item.sha256)
      throw new Error(`Media integrity failure: ${item.file}`);
  }
}
console.log('ATLAS_VERIFIED');
