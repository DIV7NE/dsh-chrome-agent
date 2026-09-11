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
const FIX = '(function () {'
  + ' document.body.style.minHeight = "3000px";'
  + ' var f = document.createElement("iframe"); f.id = "probe-frame";'
  + ' f.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";'
  + ' f.srcdoc = ' + JSON.stringify('<button id="inner-btn" style="width:200px;height:60px">inner target</button>') + ';'
  + ' document.body.appendChild(f); window.__hit = false;'
  + ' f.addEventListener("load", function () {'
  + '   f.contentWindow.document.getElementById("inner-btn")'
  + '     .addEventListener("click", function () { window.__hit = true; }); });'
  + ' return "ok"; })()';
await call('eval', { tabId, expression: FIX });
await wait(1000);
const snap = await call('snapshot', { tabId });
const m = /\[ref=(\d+) frame=(f\d+)\]/.exec(snap.snapshot);
// the eval command already JSON-serializes, so the payload is a JSON string of a JSON string
const read = async () => {
  const raw = (await call('eval', { tabId, expression: '(function () {'
    + ' var f = document.getElementById("probe-frame"); var r = f.getBoundingClientRect();'
    + ' var el = document.elementFromPoint(148, 238);'
    + ' return JSON.stringify({ s: Math.round(window.scrollY), ft: Math.round(r.top),'
    + '   hit: window.__hit, at: el ? (el.tagName + "#" + el.id) : "none" }); })()' })).result;
  return JSON.parse(JSON.parse(raw));
};
for (const s of [0, 300, 900]) {
  await call('eval', { tabId, expression: '(function () { window.scrollTo(0, ' + s + '); window.__hit = false; return 1; })()' });
  await wait(250);
  const b = await read();
  let err = '';
  try { await call('click', { ref: Number(m[1]), frame: m[2], tabId }); } catch (e) { err = ' THREW:' + String(e.message).slice(0, 70); }
  await wait(200);
  const a = await read();
  console.log('set ' + String(s).padEnd(4)
    + ' before{scrollY:' + b.s + ', frameTop:' + b.ft + '}'
    + '  after{scrollY:' + a.s + ', frameTop:' + a.ft + ', hit:' + a.hit + ', elementAt238:' + a.at + '}' + err);
}
await call('close', { tabId });
process.exit(0);
