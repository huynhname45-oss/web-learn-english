import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { contained, sendFile } from './files.mjs';
import { createSpeechMiddleware } from './speech.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.ATLAS_DATA_DIR || resolve(root, 'data'));
const port = Number(process.env.ATLAS_PORT || 3000);
const base = `http://localhost:${port}`;
const lockFile = resolve(data, 'running.lock');
const stateFile = resolve(data, 'runtime.json');
let mf, server, lock, closing = false;
function openBrowser() {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', base], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => console.log(`Hay mo ${base}`));
  child.unref();
}
async function shutdown() {
  if (closing) return;
  closing = true;
  if (server) {
    server.close();
    server.closeAllConnections();
  }
  await mf?.dispose();
  await lock?.close();
  if (lock) {
    await fs.unlink(lockFile).catch(() => {});
    await fs.unlink(stateFile).catch(() => {});
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

async function main() {
  await fs.mkdir(data, { recursive: true });
  // Reserve the public port before touching the database or starting another runtime.
  server = http.createServer();
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const current = await (await fetch(`${base}/__atlas/status`, { signal: AbortSignal.timeout(2000) })).json();
      if (current.product === 'Atlas English Portable' && current.data === data) {
        console.log(`Atlas da chay: ${base}`);
        if (process.argv.includes('--open')) openBrowser();
        return;
      }
    } catch { /* Occupied by another application. */ }
    throw new Error(`Cong ${port} dang duoc su dung. Hay dong phien web cu truoc; khong tu dung chuong trinh khac.`);
  }
  server.on('request', (_req, res) => {
    if (!mf) res.writeHead(503, { 'Retry-After': '2' }).end('Atlas dang khoi dong...');
  });
  try { lock = await fs.open(lockFile, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await fs.readFile(lockFile, 'utf8'));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); throw new Error('Thu muc du lieu dang duoc mot phien khac su dung.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    } else throw new Error('Khoa du lieu khong hop le. Hay sao luu va kiem tra truoc khi mo lai.');
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, 'wx');
  }
  await lock.writeFile(String(process.pid));
  const workerRoot = resolve(root, 'app/server');
  const entries = await fs.readdir(workerRoot, { recursive: true, withFileTypes: true });
  const modules = entries.filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => resolve(d.parentPath, d.name));
  const entry = resolve(workerRoot, 'index.js');
  modules.sort((a, b) => a === entry ? -1 : b === entry ? 1 : a.localeCompare(b));
  const bindings = {};
  try {
    const settings = JSON.parse(await fs.readFile(resolve(data, 'settings.json'), 'utf8'));
    for (const name of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_API_KEY', 'GEMINI_API_KEYS'])
      if (typeof settings[name] === 'string') bindings[name] = settings[name];
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  mf = new Miniflare({
    host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR),
    modules: modules.map((path) => ({ type: 'ESModule', path })), modulesRoot: workerRoot,
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: '00000000-0000-4000-8000-000000000000' },
    d1Persist: resolve(data, 'state/v3/d1'), cachePersist: resolve(data, 'state/v3/cache'),
    bindings,
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  const expected = ['activity', 'attempts', 'completions', 'notes', 'profiles', 'reviews', 'sessions', 'tests'];
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((r) => r.name);
  const count = expected.filter((t) => tables.includes(t)).length;
  if (!count) {
    const migration = await fs.readFile(resolve(root, 'app/schema.sql'), 'utf8');
    await db.batch(migration.split('--> statement-breakpoint').filter((s) => s.trim()).map((s) => db.prepare(s)));
  } else if (count !== expected.length) throw new Error('Du lieu thieu bang. Da dung de tranh lam hong du lieu.');
  const integrity = await db.prepare('PRAGMA quick_check').all();
  if (integrity.results.some((row) => Object.values(row)[0] !== 'ok')) throw new Error('Kiem tra du lieu khong dat.');
  // Preserve the profile ID used by older offline builds when restoring data.
  // No database rows or content IDs are renamed during migration.
  const profileRows = await db.batch(expected.map((table) => db.prepare(`SELECT DISTINCT user_id FROM ${table}`)));
  const profileIds = [...new Set(profileRows.flatMap((result) => result.results.map((row) => row.user_id)))];
  const userId = profileIds.includes('local-offline-user') ? 'local-offline-user'
    : profileIds.includes('local-user') ? 'local-user'
      : profileIds.length === 1 ? profileIds[0] : 'local-offline-user';
  const media = JSON.parse(await fs.readFile(resolve(root, 'app/media-map.json'), 'utf8'));
  const speech = createSpeechMiddleware(root, resolve(root, 'runtime/python/python.exe'));
  const controlToken = randomBytes(24).toString('hex');
  await fs.writeFile(stateFile, JSON.stringify({ pid: process.pid, base, data, controlToken }));
  server.removeAllListeners('request');
  server.on('request', (req, res) => { void handle(req, res).catch((error) => {
    console.error(error.message);
    if (!res.headersSent) res.writeHead(500).end('Khong xu ly duoc yeu cau.');
    else res.destroy();
  }); });
  async function handle(req, res) {
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) {
      res.writeHead(403).end(); return;
    }
    if (req.headers.origin && ![base, `http://127.0.0.1:${port}`].includes(req.headers.origin)) {
      res.writeHead(403).end(); return;
    }
    let path;
    try { path = decodeURIComponent(new URL(req.url, base).pathname); } catch { res.writeHead(400).end(); return; }
    if (path === '/__atlas/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ product: 'Atlas English Portable', data, port }));
      return;
    }
    if (path === '/__atlas/stop') {
      if (req.method !== 'POST' || req.headers['x-atlas-control'] !== controlToken) { res.writeHead(403).end(); return; }
      res.writeHead(200).end('Da dong Atlas.');
      setImmediate(() => { void shutdown(); });
      return;
    }
    if (path === '/__atlas/speech') { await speech(req, res); return; }
    if (path === '/__atlas/transfer') {
      await sendFile(req, res, resolve(root, 'app/transfer.html')); return;
    }
    if (path.startsWith('/Bo_De/')) {
      const item = media[path];
      if (!item) { res.writeHead(404).end(); return; }
      const file = process.env.ATLAS_MEDIA_DIR && item.file.startsWith('media/')
        ? contained(process.env.ATLAS_MEDIA_DIR, item.file.slice(6))
        : contained(root, item.file);
      await sendFile(req, res, file, item.sha256);
      return;
    }
    if (path !== '/' && !path.split('/').some((p) => p.startsWith('.')) && !path.includes('\\')) {
      if (await sendFile(req, res, contained(resolve(root, 'app/client'), path.slice(1)))) return;
    }
    if (path.startsWith('/__atlas/') || path.startsWith('/@') || path.split('/').some((p) => p.startsWith('.'))) {
      res.writeHead(404).end(); return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('oai-') || name.startsWith('x-forwarded-') ||
          ['host', 'connection', 'transfer-encoding', 'content-length'].includes(name)) continue;
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    headers.set('oai-authenticated-user-id', userId);
    headers.set('oai-authenticated-user-email', 'local@atlas.offline');
    headers.set('oai-authenticated-user-full-name', 'Ng%C6%B0%E1%BB%9Di%20h%E1%BB%8Dc%20Atlas');
    headers.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
    const origin = `http://${req.headers.host}`;
    const options = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      options.body = Buffer.concat(chunks);
    }
    const response = await mf.dispatchFetch(new URL(req.url, origin), options);
    const outgoing = Object.fromEntries(response.headers);
    delete outgoing['transfer-encoding'];
    res.writeHead(response.status, outgoing);
    if (!response.body || req.method === 'HEAD') { res.end(); return; }
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  console.log(`ATLAS_READY ${base}`);
  console.log('Du lieu cua ban: data. Giu cua so nay; Ctrl+C de dong Atlas.');
  if (process.argv.includes('--open')) openBrowser();
}
main().catch(async (error) => { console.error(error.message); process.exitCode = 1; await shutdown(); });
