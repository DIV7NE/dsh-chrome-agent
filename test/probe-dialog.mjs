/** Probe: (1) mousemove event fields, (2) does an open JS dialog hang us? */
import { WebSocketServer } from 'ws'
let socket = null; let seq = 0; const waiting = new Map();
const wss = new WebSocketServer({ port: 3099 });
wss.on('connection', ws => { socket = ws; ws.on('message', raw => {
  const f = JSON.parse(String(raw));
  if (f.t === 'hello') return;
  if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)); } }
}); });
function call(method, params, ms) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' TIMED OUT')); }, ms || 25000);
    waiting.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    socket.send(JSON.stringify({ t: 'command', id, method, params: params || {} }));
  });
}
await new Promise((resolve, reject) => { const d = Date.now() + 90000;
  const tick = () => socket ? resolve() : (Date.now() > d ? reject(new Error('no extension')) : setTimeout(tick, 250)); tick(); });

const tab = await call('open', { url: 'https://example.com', newTab: true });
const html = '<button id="b" onclick="alert(1)" style="width:200px;height:60px">Press</button>';
const watch = '(function () { window.__m = [];'
  + ' document.addEventListener("mousemove", function (e) { window.__m.push({ button: e.button, buttons: e.buttons }); }, true);'
  + ' document.body.innerHTML = ' + JSON.stringify(html) + '; return "ok"; })()';
await call('eval', { tabId: tab.tabId, expression: watch });

await call('click', { x: 100, y: 40, tabId: tab.tabId });
const moves = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify(window.__m)' });
console.log('mousemove fields seen : ' + moves.result);

console.log('--- clicking a button that opens alert() ---');
try { await call('click', { selector: '#b', tabId: tab.tabId }, 8000); console.log('click returned'); }
catch (error) { console.log('click: ' + String(error.message)); }
try {
  const after = await call('eval', { tabId: tab.tabId, expression: '1 + 1' }, 8000);
  console.log('command after dialog  : ' + after.result);
} catch (error) {
  console.log('command after dialog  : ' + String(error.message) + '   <-- BLOCKED BY DIALOG');
}
try { await call('close', { tabId: tab.tabId }); } catch (error) { /* gone */ }
wss.close();
process.exit(0);
