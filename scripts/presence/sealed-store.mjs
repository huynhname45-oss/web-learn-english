import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

// Windows CurrentUser DPAPI: neither portable credentials nor command-line secrets.
function dpapi(value, decrypt) {
  if (process.platform !== 'win32') throw new Error('Presence credentials require Windows DPAPI');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, [Text.Encoding]::UTF8.GetBytes('AtlasPresence.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((done, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows credential protection timed out')); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Windows credential protection unavailable')); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || !output.trim()) reject(new Error('Credential belongs to another Windows account/machine or is damaged'));
      else done(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}

export async function readSealed(path) {
  return JSON.parse((await dpapi(await fs.readFile(path), true)).toString('utf8'));
}

export async function writeSealed(path, value) {
  const bytes = await dpapi(Buffer.from(JSON.stringify(value)), false);
  await fs.mkdir(dirname(path), { recursive: true });
  // Atomic publication with no overwrite: concurrent startups cannot change an identity.
  const temporary = `${path}.${process.pid}.new`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.link(temporary, path);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
