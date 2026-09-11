import { WebSocketServer } from 'ws'

const PORT = 3099;
let socket = null; let nextId = 0; const waiting = new Map();
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', ws => {
  socket = ws;
  ws.on('message', raw => {
    const f = JSON.parse(String(raw));
    if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)); } }
  });
});
function call(method, params, ms) {
  if (!socket) return Promise.reject(new Error('no extension'));
  const id = ++nextId;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' timed out')); }, ms || 25000);
    waiting.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
    socket.send(JSON.stringify({ t: 'command', id, method, params: params || {} }));
  });
}
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
  + ' document.querySelector("#probe-frame").addEventListener("load", function () {'
  + '   window.__armed = true;'
  + '   document.querySelector("#probe-frame").contentWindow.document.getElementById("inner-btn")'
  + '     .addEventListener("click", function () { window.__hit = true; });'
  + ' });'
  + ' return "ok"; })()';
await call('eval', { tabId, expression: FIX });
await wait(1000);

const state = async (tag) => {
  const s = await call('eval', { tabId, expression: '(function () {'
    + ' var f = document.getElementById("probe-frame"); if (!f) return JSON.stringify({gone:true});'
    + ' var r = f.getBoundingClientRect();'
    + ' var c = document.getElementById("dsh-agent-cursor");'
    + ' return JSON.stringify({ scrollY: Math.round(window.scrollY), vh: window.innerHeight, vw: window.innerWidth,'
    + '   frameTop: Math.round(r.top), frameLeft: Math.round(r.left), frameBottom: Math.round(r.bottom),'
    + '   armed: !!window.__armed, hit: window.__hit, cursor: c ? c.style.transform : null }); })()' });
  console.log(tag + ' ' + s.result);
};

await state('BEFORE SCROLL');
await call('scroll', { deltaY: 900, tabId });
await wait(400);
await state('AFTER SCROLL ');

const snap = await call('snapshot', { tabId });
const m = /\[ref=(\d+) frame=(f\d+)\]/.exec(snap.snapshot);
console.log('frame ref: ' + JSON.stringify(m && { ref: m[1], frame: m[2] }));

if (m) {
  const lim = await call('eval', { tabId, expression: '(function () {'
    + ' var f = document.getElementById("probe-frame"); var b = f.contentWindow.document.getElementById("inner-btn");'
    + ' var fr = f.getBoundingClientRect(); var br = b.getBoundingClientRect();'
    + ' return JSON.stringify({ want: { x: Math.round(fr.left + br.left + br.width / 2), y: Math.round(fr.top + br.top + br.height / 2) } }); })()' });
  console.log('expected top-level point: ' + lim.result);
  try {
    const clicked = await call('click', { ref: Number(m[1]), frame: m[2], tabId });
    console.log('click returned: ' + JSON.stringify(clicked));
  } catch (e) {
    console.log('click THREW: ' + String(e.message).slice(0, 220));
  }
  await wait(400);
  await state('AFTER CLICK ');
}
await call('close', { tabId });
console.log('DONE');
process.exit(0);
