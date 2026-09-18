import fs from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { contained } from './files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const manifest = JSON.parse(await fs.readFile(resolve(root, 'package-integrity.json'), 'utf8'));
  if (manifest.format !== 'atlas-package-v1') throw new Error('Sai dinh dang goi.');
  let count = 0;
  for (const [name, item] of Object.entries(manifest.files)) {
    const bytes = await fs.readFile(contained(root, name));
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new Error(`Tep bi thay doi/hong: ${name}`);
    if (++count % 1000 === 0) console.log(`Da kiem tra ${count} tep...`);
  }
  console.log(`DAT: ${count} tep dung checksum. Du ${manifest.media.examCount} de. Du lieu ca nhan khong bi thay doi.`);
} catch (error) { console.error(`KHONG DAT: ${error.message}`); process.exitCode = 1; }
