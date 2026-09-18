import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const types = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export function contained(root, relative) {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (!target.startsWith(base + sep)) throw new Error('Invalid file path');
  return target;
}

export async function sendFile(req, res, file, digest) {
  let info;
  try { info = await stat(file); } catch { return false; }
  if (!info.isFile()) return false;
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return true; }
  const etag = `"${digest || `${info.size}-${Math.trunc(info.mtimeMs)}`}"`;
  const headers = {
    'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ETag: etag,
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return true; }
  let start = 0, end = info.size - 1, status = 200;
  const range = req.headers.range;
  if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end(); return true;
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end(); return true;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !info.size) res.end();
  else {
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
  return true;
}
