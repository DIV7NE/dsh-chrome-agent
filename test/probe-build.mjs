import { WebSocketServer } from 'ws'
const PORT = 3099; let socket = null; let nextId = 0; const waiting = new Map();
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', ws => { socket = ws; ws.on('message', raw => { const f = JSON.parse(String(raw));
  if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)); } } }); });
function call(method, params, ms) { if (!socket) return Promise.reject(new Error('no extension')); const id = ++nextId;
  return new Promise((res, rej) => { const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' timed out')); }, ms || 20000);
    waiting.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
    socket.send(JSON.stringify({ t: 'command', id, method, params: params || {} })); }); }
const wait = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 240 && !socket; i++) await wait(250);
if (!socket) { console.log('NO EXTENSION'); process.exit(2); }

const open = await call('open', { url: 'https://example.com', newTab: true });
const tabId = open.tabId;

// DISCRIMINATOR: the new build refuses a point outside the viewport with a named error.
// The old build dispatches it and reports success.
try {
  const r = await call('click', { x: -5, y: -5, tabId });
  console.log('DISCRIMINATOR: click(-5,-5) returned ' + JSON.stringify(r) + '  => OLD build (no viewport guard)');
} catch (e) {
  console.log('DISCRIMINATOR: click(-5,-5) THREW: ' + String(e.message).slice(0, 160) + '  => NEW build (guard present)');
}
await call('close', { tabId });
process.exit(0);
