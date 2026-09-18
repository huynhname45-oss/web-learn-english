import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export const REPOSITORY = 'huynhname45-oss/web-learn-english';
export function versionName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) || value.includes('..'))
    throw new Error('Mã phiên bản không hợp lệ.');
  return value;
}
export function validateRelease(value) {
  if (value?.format !== 'atlas-release-v1' || value.repository !== REPOSITORY) throw new Error('Sai nguồn cập nhật.');
  versionName(value.version);
  if (!/^[a-f0-9]{40}$/.test(value.revision)) throw new Error('Commit không hợp lệ.');
  const assets = [value.core, value.media?.index, ...(value.media?.parts || [])];
  if (assets.length < 3) throw new Error('Thiếu dữ liệu bản phát hành.');
  for (const asset of assets) {
    if (!asset || !/^[a-zA-Z0-9._-]+$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) throw new Error('Thông tin tệp cập nhật không hợp lệ.');
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
        !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)) throw new Error('Địa chỉ tải không thuộc repo Atlas.');
  }
  versionName(value.media.version);
  return value;
}
export async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Atlas-English-Updater' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Chưa kiểm tra được phiên bản (${response.status}).`);
  const info = await response.json();
  const asset = info.assets?.find((a) => a.name === 'atlas-release.json');
  if (!asset || info.draft || info.prerelease) throw new Error('Chưa có bản phát hành ổn định.');
  const url = new URL(asset.browser_download_url);
  if (url.hostname !== 'github.com' || !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`))
    throw new Error('Nguồn phát hành không hợp lệ.');
  const manifest = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!manifest.ok) throw new Error('Không tải được thông tin phiên bản.');
  return validateRelease(await manifest.json());
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function downloadAsset(asset, destination, progress = () => {}) {
  const temporary = destination + '.partial';
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Tải thất bại: ${asset.name} (${response.status}).`);
  let bytes = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, next) {
    bytes += chunk.length;
    if (bytes > asset.bytes) { next(new Error('Tệp tải lớn hơn kích thước đã công bố.')); return; }
    hash.update(chunk); progress(bytes, asset.bytes); next(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary));
  if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Tệp tải chưa toàn vẹn; bản đang dùng được giữ nguyên.');
  await fs.rename(temporary, destination);
}
export async function run(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let text = '';
    child.stdout.on('data', (b) => { text += b; });
    child.stderr.on('data', (b) => { text += b; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? done(text) : reject(new Error(text.slice(-1500) || `Exit ${code}`)));
  });
}
export async function expandArchive(archive, target) {
  await fs.mkdir(target, { recursive: true });
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(target)} -Force`]);
}
export async function verifyCore(root) {
  const manifest = JSON.parse(await fs.readFile(resolve(root, 'package-integrity.json'), 'utf8'));
  if (manifest.format !== 'atlas-package-v1') throw new Error('Sai định dạng ứng dụng.');
  for (const required of ['runtime/node.exe', 'scripts/server.mjs', 'scripts/client-manager.mjs', 'scripts/update-core.mjs', 'scripts/data.mjs'])
    if (!manifest.files?.[required]) throw new Error(`Gói thiếu tệp bắt buộc: ${required}`);
  for (const [name, item] of Object.entries(manifest.files)) {
    if (name.startsWith('media/')) continue;
    const path = resolve(root, name);
    if (!path.startsWith(resolve(root) + sep) || name.startsWith('data/')) throw new Error('Đường dẫn trong gói không hợp lệ.');
    if ((await fs.stat(path)).size !== item.bytes || await hashFile(path) !== item.sha256)
      throw new Error(`Tệp ứng dụng không toàn vẹn: ${name}`);
  }
}
export async function atomicJson(path, value) {
  const temporary = path + '.new';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, path);
}
