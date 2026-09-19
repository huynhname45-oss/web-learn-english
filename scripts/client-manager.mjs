import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateRelease, versionName, downloadAsset, hashFile, expandArchive, verifyCore, atomicJson, run } from './update-core.mjs';
import { latestGit, prepareGit } from './git-update.mjs';

const home = resolve(process.env.ATLAS_HOME || `${process.env.LOCALAPPDATA}/AtlasEnglish`);
const base = 'http://localhost:3000';
const data = resolve(home, 'data'), versions = resolve(home, 'versions');
let current, app, innerPort, proxy, stopping = false, active = 0, draining = false, updateBusy = false, recovering = false;
const token = randomBytes(24).toString('hex');
const state = { enabled: true, home, ready: false, phase: 'idle', current: '', latest: '', message: '', percent: 0, token };
function setState(phase, message, percent = 0) { Object.assign(state, { phase, message, percent }); }
function appRoot(version) { return resolve(versions, versionName(version)); }
function openBrowser() {
  if (process.env.ATLAS_NO_BROWSER === '1') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', base], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function freshPort() {
  const reservation = net.createServer();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  return port;
}
async function boot(version) {
  state.ready = false;
  const root = appRoot(version);
  innerPort = await freshPort();
  const child = spawn(resolve(root, 'runtime/node.exe'), ['scripts/server.mjs'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, ATLAS_DATA_DIR: data, ATLAS_MEDIA_DIR: resolve(home, 'media'), ATLAS_PORT: String(innerPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app = child;
  await new Promise((done, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Ứng dụng mới chưa khởi động được.')), 45000);
    child.stdout.on('data', (chunk) => {
      text = (text + chunk).slice(-6000);
      if (text.includes('ATLAS_READY')) { clearTimeout(timer); done(); }
    });
    child.stderr.on('data', (chunk) => { text = (text + chunk).slice(-3000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(text || `Ứng dụng dừng (${code}).`)); });
  });
  for (const path of ['/', '/api/progress']) {
    const response = await fetch(`http://localhost:${innerPort}${path}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Kiểm tra sau cập nhật thất bại (${response.status}).`);
    await response.arrayBuffer();
  }
  if (child.exitCode !== null) throw new Error('Ứng dụng đã dừng trong khi khởi động.');
  state.ready = true;
  child.once('exit', () => {
    if (app !== child) return;
    state.ready = false;
    if (!stopping && !updateBusy && !recovering) void recoverApp();
  });
}
async function recoverApp() {
  recovering = true;
  for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
    await pause(1000 * (attempt + 1));
    try { await stopApp(); await boot(current.version); recovering = false; return; }
    catch (error) { console.error(`App recovery: ${error.message}`); }
  }
  recovering = false;
  console.error('Không khởi động lại được ứng dụng. Hãy mở lại Atlas.');
  await shutdown();
}
async function stopApp() {
  state.ready = false;
  if (!app || app.exitCode !== null) return;
  const child = app;
  try {
    const saved = JSON.parse(await fs.readFile(resolve(data, 'runtime.json'), 'utf8'));
    await fetch(`http://localhost:${innerPort}/__atlas/stop`, {
      method: 'POST', headers: { 'X-Atlas-Control': saved.controlToken }, signal: AbortSignal.timeout(5000),
    });
  } catch { /* A failed candidate may have exited before opening its port. */ }
  for (let i = 0; child.exitCode === null && i < 100; i++) await pause(100);
  if (child.exitCode === null) {
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
    for (let i = 0; child.exitCode === null && i < 50; i++) await pause(100);
    if (child.exitCode === null) throw new Error('Chưa dừng được ứng dụng; không thể thay dữ liệu khi ứng dụng còn chạy.');
  }
  app = undefined;
}
async function command(version, args) {
  const root = appRoot(version);
  return run(resolve(root, 'runtime/node.exe'), args, {
    cwd: root, env: { ...process.env, ATLAS_DATA_DIR: data, ATLAS_BACKUP_DIR: resolve(home, 'backups') },
  });
}
async function recoverPending() {
  let pending;
  try { pending = JSON.parse(await fs.readFile(resolve(home, 'pending-update.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  versionName(pending.previous);
  await command(pending.previous, ['scripts/data.mjs', 'stop']).catch(() => {});
  if (pending.backup) await command(pending.previous, ['scripts/data.mjs', 'restore', pending.backup]);
  current = { version: pending.previous };
  await atomicJson(resolve(home, 'current.json'), current);
  return true;
}
async function feed() {
  // Only a process-level test configuration can select a local fixture.
  if (process.env.ATLAS_TEST_FEED) return validateRelease(JSON.parse(await fs.readFile(process.env.ATLAS_TEST_FEED, 'utf8')));
  return latestGit(home);
}
let latest;
let checkBusy = false;
async function check() {
  if (checkBusy || updateBusy || recovering || ['success', 'error'].includes(state.phase)) return;
  checkBusy = true;
  try {
    latest = await feed();
    state.latest = latest.version;
    if (latest.version !== current.version) {
      setState('available', 'Lưu bài đang làm trước khi cập nhật. Tiến độ, cài đặt và khóa AI của bạn được giữ lại.');
    }
    state.checkedAt = Date.now();
    state.checkMessage = latest.version === current.version ? 'Bạn đang dùng phiên bản mới nhất.' : 'Có phiên bản mới. Chọn Update ngay để cập nhật.';
  } catch {
    // Opening and learning offline remain available when GitHub cannot be reached.
    state.checkMessage = 'Chưa kiểm tra được GitHub. Bạn vẫn có thể học và thử lại khi có mạng.';
  } finally {
    checkBusy = false;
  }
}
async function cachedDownload(asset, report) {
  const directory = resolve(home, 'downloads');
  await fs.mkdir(directory, { recursive: true });
  const path = resolve(directory, `${asset.sha256}-${asset.name}`);
  try { if ((await fs.stat(path)).size === asset.bytes && await hashFile(path) === asset.sha256) return path; }
  catch { /* No complete cached download. */ }
  await downloadAsset(asset, path, report);
  return path;
}
async function install() {
  if (updateBusy || recovering) return;
  updateBusy = true;
  const previous = current.version;
  let backup, switched = false, appStopped = false, stage;
  const completedDownloads = [];
  try {
    if (!latest || latest.version === previous) throw new Error('Không có phiên bản mới để cài.');
    const target = latest.mode === 'git' ? latest : validateRelease(latest);
    stage = resolve(versions, `${target.version}.staging-${Date.now()}`);
    if (target.mode === 'git') {
      await prepareGit(home, target, stage, setState);
    } else {
    setState('downloading', 'Đang tải phiên bản mới từ GitHub…', 1);
    const archive = await cachedDownload(target.core, (bytes, total) => {
      setState('downloading', 'Đang tải ứng dụng. Bạn không cần tải lại bộ đề nếu dữ liệu không đổi.', Math.round(bytes / total * 65));
    });
    completedDownloads.push(archive);
    let installedMedia;
    try { installedMedia = JSON.parse(await fs.readFile(resolve(home, 'media-version.json'), 'utf8')); } catch {}
    if (installedMedia?.version !== target.media.version) {
      for (const [index, asset] of target.media.parts.entries()) {
        const part = await cachedDownload(asset, (bytes, total) =>
          setState('downloading', `Đang tải phần dữ liệu ${index + 1}/${target.media.parts.length}…`, 65 + Math.round((index + bytes / total) / target.media.parts.length * 15)));
        await expandArchive(part, home); // Content-addressed media is additive; old versions remain valid.
        completedDownloads.push(part);
      }
      await atomicJson(resolve(home, 'media-version.json'), { version: target.media.version });
    }
    setState('verifying', 'Đang kiểm tra tính toàn vẹn của bản cập nhật…', 82);
    await expandArchive(archive, stage);
    await verifyCore(stage);
    }
    // A complete candidate becomes visible only after extraction and verification.
    const destination = appRoot(target.version);
    let exists = false;
    try { await fs.access(destination); exists = true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (exists) {
      await verifyCore(destination);
      if (await hashFile(resolve(stage, 'package-integrity.json')) !== await hashFile(resolve(destination, 'package-integrity.json')))
        throw new Error('Mã phiên bản đã được dùng cho gói khác. Cần phát hành mã phiên bản mới.');
    } else await fs.rename(stage, destination);
    draining = true;
    setState('installing', 'Đang chờ lưu dữ liệu và tạo bản sao khôi phục…', 88);
    for (let i = 0; active > 0 && i < 300; i++) await pause(100);
    if (active > 0) throw new Error('Vẫn có yêu cầu đang xử lý. Hãy thử cập nhật sau khi thao tác hiện tại hoàn tất.');
    await stopApp(); appStopped = true;
    await fs.mkdir(resolve(home, 'backups'), { recursive: true });
    const before = new Set(await fs.readdir(resolve(home, 'backups')));
    await command(previous, ['scripts/data.mjs', 'backup']);
    const added = (await fs.readdir(resolve(home, 'backups'))).filter((p) => !before.has(p));
    if (added.length !== 1) throw new Error('Không xác định được bản sao lưu; chưa thay phiên bản.');
    backup = resolve(home, 'backups', added[0]);
    await atomicJson(resolve(home, 'pending-update.json'), { previous, next: target.version, backup });
    current = { version: target.version };
    await atomicJson(resolve(home, 'current.json'), current); switched = true;
    setState('restarting', 'Đang mở và kiểm tra phiên bản mới…', 95);
    await boot(target.version);
    await fs.unlink(resolve(home, 'pending-update.json'));
    state.current = target.version;
    setState('success', 'Đã cập nhật thành công. Tiến độ và cài đặt của bạn được giữ nguyên.', 100);
    for (const path of completedDownloads) await fs.unlink(path).catch(() => {});
  } catch (error) {
    if (appStopped || switched) {
      setState('rollback', 'Phiên bản mới chưa hoạt động ổn định. Đang quay lại phiên bản trước…', 95);
      try {
        await stopApp();
        if (backup) await command(previous, ['scripts/data.mjs', 'restore', backup]);
        current = { version: previous };
        await atomicJson(resolve(home, 'current.json'), current);
        await boot(previous);
        await fs.unlink(resolve(home, 'pending-update.json')).catch(() => {});
      } catch (rollback) {
        setState('error', `Cần mở lại Atlas để khôi phục. Dữ liệu sao lưu vẫn được giữ. ${rollback.message}`);
        return;
      }
    }
    setState('error', `Chưa cập nhật được; bản trước vẫn được giữ. ${error.message}`);
  } finally { draining = false; updateBusy = false; }
}
async function main() {
  await fs.mkdir(home, { recursive: true });
  proxy = http.createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(503).end('Atlas đang khởi động. Vui lòng thử lại.');
    else res.destroy();
  }); });
  try {
    await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(3000, '127.0.0.1', done); });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let running;
    try {
      const response = await fetch(`${base}/__atlas/update`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Unrecognized service');
      running = await response.json();
    } catch {
      throw new Error('Cổng 3000 đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó trước khi mở Atlas.');
    }
    if (!running.enabled || typeof running.home !== 'string' || resolve(running.home).toLowerCase() !== home.toLowerCase())
      throw new Error('Cổng 3000 đang được ứng dụng hoặc bản cài Atlas khác sử dụng. Hãy đóng bản đó trước.');
    await fetch(`${base}/__atlas/update`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Update': running.token },
      body: JSON.stringify({ action: 'check' }), signal: AbortSignal.timeout(3000) });
    openBrowser(); return;
  }
  current = JSON.parse(await fs.readFile(resolve(home, 'current.json'), 'utf8'));
  versionName(current.version);
  const recovered = await recoverPending();
  await boot(current.version);
  if (recovered) await fs.unlink(resolve(home, 'pending-update.json'));
  state.current = current.version;
  await atomicJson(resolve(home, 'manager.json'), { pid: process.pid, token, home });
  console.log('ATLAS_CLIENT_READY');
  openBrowser();
  void check();
  setInterval(() => { void check(); }, 15 * 60 * 1000).unref();
}
async function handle(req, res) {
  if (!['localhost:3000', '127.0.0.1:3000'].includes(req.headers.host) ||
      (req.headers.origin && ![base, 'http://127.0.0.1:3000'].includes(req.headers.origin))) {
    res.writeHead(403).end(); return;
  }
  const path = new URL(req.url, base).pathname;
  if (path === '/__atlas/update') {
    if (req.method === 'POST') {
      if (req.headers['x-atlas-update'] !== token) { res.writeHead(403).end(); return; }
      let input = '';
      for await (const chunk of req) { input += chunk; if (input.length > 1024) { res.writeHead(413).end(); return; } }
      const action = JSON.parse(input).action;
      if (action === 'start') void install();
      else if (action === 'check') await check();
      else if ((action === 'ack' || action === 'dismiss') && !updateBusy) setState('idle', '');
      else { res.writeHead(400).end(); return; }
    } else if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(state));
    return;
  }
  if (path === '/__atlas/client-stop') {
    if (req.method !== 'POST' || req.headers['x-atlas-update'] !== token || updateBusy) { res.writeHead(403).end(); return; }
    res.end('Đang đóng Atlas.'); setImmediate(() => { void shutdown(); }); return;
  }
  if (!app || draining || app.exitCode !== null) { res.writeHead(503, { 'Retry-After': '2' }).end('Atlas đang cập nhật.'); return; }
  active++;
  let counted = true;
  const finish = () => { if (counted) { active--; counted = false; } };
  res.on('close', finish); res.on('finish', finish);
  const headers = { ...req.headers, host: `localhost:${innerPort}` };
  if (headers.origin) headers.origin = `http://localhost:${innerPort}`;
  const upstream = http.request({ hostname: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers }, (response) => {
    const output = { ...response.headers };
    if (typeof output.location === 'string') output.location = output.location.replace(`http://localhost:${innerPort}`, base);
    res.writeHead(response.statusCode, output); response.pipe(res);
  });
  upstream.on('error', () => { finish(); if (!res.headersSent) res.writeHead(503).end('Atlas đang khởi động lại.'); else res.destroy(); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopApp();
  proxy?.closeAllConnections();
  proxy?.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
main().catch(async (error) => { console.error(error.message); process.exitCode = 1; await shutdown(); });
