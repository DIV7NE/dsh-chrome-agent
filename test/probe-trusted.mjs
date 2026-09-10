/** One-off probe: is CDP-dispatched input trusted by the page? */
import { WebSocketServer } from 'ws'
const PORT = 3099;
let socket = null; let seq = 0; const waiting = new Map();
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', ws => {
  socket = ws;
  ws.on('message', raw => {
    const f = JSON.parse(String(raw));
    if (f.t === 'hello') { console.log('hello from extension ' + f.version); return; }
    if (f.t === 'result') {
      const e = waiting.get(f.id);
      if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)); }
    }
  });
});
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, 25000);
    waiting.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    socket.send(JSON.stringify({ t: 'command', id, method, params: params || {} }));
  });
}
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 90000;
  const tick = () => socket ? resolve() : (Date.now() > deadline ? reject(new Error('no extension')) : setTimeout(tick, 250));
  tick();
});

const tab = await call('open', { url: 'https://example.com', newTab: true });
await call('eval', { tabId: tab.tabId, expression: '(function () { window.__probe = []; document.addEventListener("click", function (e) { window.__probe.push({ trusted: e.isTrusted, x: e.clientX, y: e.clientY, pointer: e.pointerType || null }); }, true); window.__webdriver = navigator.webdriver; return "armed"; })()' });

await call('click', { x: 300, y: 300, tabId: tab.tabId });
await new Promise(r => setTimeout(r, 600));
const seen = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify(window.__probe)' });
const wd = await call('eval', { tabId: tab.tabId, expression: 'String(navigator.webdriver)' });
console.log('events the page observed : ' + seen.result);
console.log('navigator.webdriver       : ' + wd.result);

// Does the page see any agent overlay element in its own DOM?
const overlays = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify([...document.querySelectorAll("[id*=cursor],[id*=phantom],[id*=agent]")].map(e => e.id))' });
console.log('overlay elements in DOM   : ' + overlays.result);

await call('close', { tabId: tab.tabId });
wss.close();
process.exit(0);
