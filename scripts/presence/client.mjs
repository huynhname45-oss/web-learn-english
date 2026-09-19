import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { connectPresence } from './connection.mjs';
import { proofText, publicKey, relayAddress } from './protocol.mjs';
import { readSealed, writeSealed } from './sealed-store.mjs';

export async function createIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { id: randomUUID(), publicKey: publicKey(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

export async function clientAuthentication(identity, machine, version, nonce) {
  const details = { id: identity.id, hostname: machine, version };
  const key = await crypto.subtle.importKey('jwk', identity.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const proof = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(proofText(nonce, details)));
  return { type: 'auth', role: 'client', ...details, publicKey: identity.publicKey,
    proof: Buffer.from(proof).toString('base64') };
}

export function startClientPresence({ root, data, version = 'portable', disabled = false }) {
  let stopped = false, connection;
  void (async () => {
    if (disabled) return;
    const config = JSON.parse(await fs.readFile(resolve(root, 'app/presence-public.json'), 'utf8'));
    if (config.enabled !== true) return;
    const url = relayAddress(config.url);
    const path = resolve(data, 'presence/identity.dpapi');
    let identity;
    try { identity = await readSealed(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never reset a damaged/revoked identity silently.
      identity = await createIdentity();
      try { await writeSealed(path, identity); }
      catch (saveError) {
        if (saveError.code !== 'EEXIST') throw saveError;
        identity = await readSealed(path);
      }
    }
    if (stopped) return;
    connection = connectPresence({ url,
      authenticate: nonce => clientAuthentication(identity, hostname(), version, nonce) });
  })().catch(error => {
    // An absent config is supported for old packages; no secrets or machine data in logs.
    if (error.code !== 'ENOENT') console.warn('[Presence] Theo dõi kết nối chưa sẵn sàng; việc học vẫn hoạt động.');
  });
  return { close() { stopped = true; connection?.close(); } };
}
