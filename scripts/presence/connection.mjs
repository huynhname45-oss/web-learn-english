import { HEARTBEAT_MS, MAX_MESSAGE_BYTES, relayAddress } from './protocol.mjs';

// Shared transport contains no owner credential or dashboard. Every timer is bounded
// and detached from application startup, HTTP serving, speech and update handling.
export function connectPresence({ url, authenticate, onMessage = () => {}, onState = () => {},
  allowLocal = false, WebSocketImpl = WebSocket, random = Math.random }) {
  url = relayAddress(url, allowLocal);
  let socket, retry, pulse, deadline, stopped = false, failures = 0, generation = 0;
  let lastReply = 0, accepted = false, sequence = 0, pendingSequence = 0;
  const notify = state => { try { onState(state); } catch {} };
  const clearSession = () => { clearInterval(pulse); clearTimeout(deadline); accepted = false; };
  function reconnect() {
    if (stopped) return;
    const wait = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6)) * (0.75 + random() * 0.5);
    retry = setTimeout(open, wait); retry.unref?.();
  }
  function open() {
    if (stopped) return;
    const mine = ++generation;
    notify('connecting');
    try { socket = new WebSocketImpl(url); }
    catch { notify('disconnected'); reconnect(); return; }
    const ws = socket;
    deadline = setTimeout(() => ws.close(4000, 'Authentication timeout'), 10000); deadline.unref?.();
    ws.addEventListener('error', () => {}); // close controls the one reconnect loop.
    ws.addEventListener('message', event => { void (async () => {
      if (stopped || mine !== generation || typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES * 512) return;
      const message = JSON.parse(event.data);
      if (message.type === 'challenge' && !accepted) {
        if (typeof message.nonce !== 'string' || message.nonce.length > 128) throw new Error('Invalid challenge');
        const auth = await authenticate(message.nonce);
        if (!stopped && mine === generation && ws.readyState === 1) ws.send(JSON.stringify(auth));
      } else if (message.type === 'accepted') {
        if (accepted) return;
        accepted = true; failures = 0; lastReply = Date.now(); clearTimeout(deadline);
        notify('connected');
        pulse = setInterval(() => {
          if (Date.now() - lastReply >= HEARTBEAT_MS * 2) {
            notify('disconnected'); ws.close(4000, 'Heartbeat timeout'); return;
          }
          pendingSequence = ++sequence;
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', sequence: pendingSequence }));
        }, HEARTBEAT_MS);
        pulse.unref?.();
      } else if (message.type === 'pong' && message.sequence === pendingSequence) {
        lastReply = Date.now();
      } else if (accepted) {
        onMessage(message);
      }
    })().catch(() => ws.close(4002, 'Invalid response')); });
    ws.addEventListener('close', event => {
      if (mine !== generation) return;
      clearSession();
      if ([4001, 4003, 4009].includes(event.code)) {
        stopped = true; notify(event.code === 4003 ? 'blocked' : event.code === 4009 ? 'superseded' : 'unauthorized');
      } else { notify('disconnected'); reconnect(); }
    });
  }
  open();
  return {
    send(message) {
      if (!accepted || stopped || socket?.readyState !== 1) throw new Error('Relay is disconnected');
      socket.send(JSON.stringify(message));
    },
    close() {
      stopped = true; ++generation; clearTimeout(retry); clearSession();
      socket?.close(1000, 'Atlas stopped'); notify('stopped');
    },
  };
}
