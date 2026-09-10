/** Probe: does a Control+a keydown even reach a background tab? */
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
const info = await call('tabs');
const me = info.find(t => t.id === tab.tabId);
console.log('tab active?      : ' + me.active + '   (false = background, the case we care about)');

const setup = '(function () {'
  + ' window.__keys = [];'
  + ' document.addEventListener("keydown", function (e) { window.__keys.push(e.key + "|" + e.ctrlKey); }, true);'
  + ' document.body.innerHTML = \'<input id="z" type="text" value="hello world">\';'
  + ' var el = document.getElementById("z"); el.focus(); el.setSelectionRange(4, 4);'
  + ' return "ok"; })()';
await call('eval', { tabId: tab.tabId, expression: setup });

const before = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify({ start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd, focused: document.hasFocus() })' });
console.log('before Control+a  : ' + before.result);

await call('key', { key: 'Control+a', tabId: tab.tabId });
await new Promise(r => setTimeout(r, 400));

const keys = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify(window.__keys)' });
console.log('keydowns observed : ' + keys.result);
const after = await call('eval', { tabId: tab.tabId, expression: 'JSON.stringify({ start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })' });
console.log('after Control+a   : ' + after.result);

await call('close', { tabId: tab.tabId });
wss.close();
process.exit(0);
