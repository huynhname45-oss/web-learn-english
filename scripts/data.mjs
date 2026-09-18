import fs from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { contained } from './files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.ATLAS_DATA_DIR || resolve(root, 'data'));
const stamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
async function isRunning() {
  try {
    const pid = Number(await fs.readFile(resolve(data, 'running.lock'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock');
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function takeSnapshot(destination) {
  await fs.mkdir(destination, { recursive: true });
  const files = await fs.readdir(data, { recursive: true, withFileTypes: true }).catch((e) => {
    if (e.code === 'ENOENT') return []; throw e;
  });
  const manifest = { format: 'atlas-data-v1', createdAt: new Date().toISOString(), files: {} };
  for (const item of files.filter((d) => d.isFile())) {
    const source = resolve(item.parentPath, item.name);
    const relative = source.slice(data.length + 1).replaceAll('\\', '/');
    if (['running.lock', 'runtime.json'].includes(relative) || /(?:-wal|-shm)$/.test(relative) ||
        relative.startsWith('state/v3/cache/')) continue;
    const target = contained(destination, relative);
    await fs.mkdir(dirname(target), { recursive: true });
    if (relative.endsWith('.sqlite')) {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        const rows = db.prepare('PRAGMA integrity_check').all();
        if (rows.some((r) => Object.values(r)[0] !== 'ok')) throw new Error('Database integrity check failed');
        await backup(db, target);
      } finally { db.close(); }
    } else await fs.copyFile(source, target);
    const bytes = await fs.readFile(target);
    manifest.files[relative] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await fs.writeFile(resolve(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
async function main() {
  const command = process.argv[2];
  if (command === 'stop') {
    const state = JSON.parse(await fs.readFile(resolve(data, 'runtime.json'), 'utf8'));
    if (!/^http:\/\/localhost:\d+$/.test(state.base)) throw new Error('Invalid server address');
    const response = await fetch(`${state.base}/__atlas/stop`, {
      method: 'POST', headers: { 'X-Atlas-Control': state.controlToken }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Khong dong duoc phien Atlas.');
    console.log('Da gui lenh dong Atlas.');
    return;
  }
  if (command === 'backup') {
    if (await isRunning()) throw new Error('Hay dong Atlas bang Dong-Atlas.cmd truoc khi sao luu.');
    const destination = resolve(process.env.ATLAS_BACKUP_DIR || resolve(root, 'backups'), `Atlas-${stamp()}`);
    await takeSnapshot(destination);
    console.log(`Da sao luu: ${destination}\nBan sao luu co the chua khoa AI. Chi chuyen cho may cua ban.`);
    return;
  }
  if (command === 'restore') {
    const source = resolve(process.argv[3] || 'restore');
    if (await isRunning()) throw new Error('Hay dong Atlas truoc khi khoi phuc.');
    const manifest = JSON.parse(await fs.readFile(resolve(source, 'backup-manifest.json'), 'utf8'));
    if (manifest.format !== 'atlas-data-v1' || !Object.keys(manifest.files || {}).length) throw new Error('Ban sao luu khong hop le.');
    const staging = resolve(dirname(data), `${basename(data)}-restore-${stamp()}`);
    await fs.mkdir(staging);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const bytes = await fs.readFile(contained(source, name));
      if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error(`Ban sao luu bi thay doi/hong: ${name}. Du lieu hien tai chua bi thay.`);
      const target = contained(staging, name);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      if (name.endsWith('.sqlite')) {
        const db = new DatabaseSync(target, { readOnly: true });
        try { if (db.prepare('PRAGMA integrity_check').all().some((r) => Object.values(r)[0] !== 'ok'))
          throw new Error('Du lieu SQLite khong toan ven.'); } finally { db.close(); }
      }
    }
    // Keep the original directory intact so recovery is possible after interruption.
    const previous = resolve(dirname(data), `${basename(data)}-before-restore-${stamp()}`);
    let moved = false;
    try { await fs.rename(data, previous); moved = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.rename(staging, data); } catch (e) { if (moved) await fs.rename(previous, data); throw e; }
    console.log(`Da khoi phuc. Du lieu cu duoc giu tai: ${previous}`);
    return;
  }
  throw new Error('Dung backup, restore <thu-muc-ban-sao-luu>, hoac stop.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
