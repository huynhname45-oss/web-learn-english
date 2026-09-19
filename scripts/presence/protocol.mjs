export const HEARTBEAT_MS = 15000;
export const UNSTABLE_MS = 30000;
export const OFFLINE_MS = 45000;
export const MAX_MESSAGE_BYTES = 4096;
export const hasControlCharacters = value => [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);

export function relayAddress(value, allowLocal = false) {
  const url = new URL(value);
  const local = allowLocal && url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!local && url.protocol !== 'wss:') || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/connect') throw new Error('Invalid presence relay address');
  return url.href;
}

export function clientState(device, session, now = Date.now()) {
  if (device.access !== 'approved') return device.access;
  if (!session || now - session.seen >= OFFLINE_MS) return 'offline';
  return now - session.seen >= UNSTABLE_MS ? 'unstable' : 'online';
}

export function proofText(nonce, identity) {
  return JSON.stringify([nonce, identity.id, identity.hostname, identity.version]);
}

export function validIdentity(value) {
  return value && /^[a-f0-9-]{36}$/.test(value.id) &&
    typeof value.hostname === 'string' && value.hostname.length > 0 && value.hostname.length <= 128 &&
    !hasControlCharacters(value.hostname) &&
    typeof value.version === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value.version);
}

export function publicKey(value) {
  if (!value || value.kty !== 'EC' || value.crv !== 'P-256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y) || value.d) {
    throw new Error('Invalid public key');
  }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y, ext: true };
}

export const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async value => toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
