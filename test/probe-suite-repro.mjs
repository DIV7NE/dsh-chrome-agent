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
for (let i = 0; i < 240 && !socket; i += 1) await wait(250);
if (!socket) { console.log('NO EXTENSION'); process.exit(2); }
const cap = await call('open', { url: 'https://example.com', newTab: true });
const tabId = cap.tabId;
const pageHtml = '<div style="height:3000px">tall</div>'
  + '<button id="b" style="width:120px;height:40px">B</button>'
  + '<input id="f" type="file">'
  + '<div id="box" role="button" tabindex="0" style="width:80px;height:80px;background:#ccc">box</div>';
const install = ['(function () {', '  document.body.innerHTML = ' + JSON.stringify(pageHtml) + ';',
  '  window.__ev = []; window.__t0 = performance.now();',
  '  function log(s) { window.__ev.push(Math.round(performance.now() - window.__t0) + " " + s); }',
  '  window.addEventListener("scroll", function () { log("scrollY=" + Math.round(window.scrollY)); }, true);',
  '  ["mousemove","mousedown","mouseup"].forEach(function (k, i) { document.addEventListener(k, function () { log(k); }, true); });',
  'var frame = document.createElement("iframe");', 'frame.id = "probe-frame";',
  'frame.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";',
  'frame.srcdoc = ' + JSON.stringify('<button id="inner-btn" style="width:200px;height:60px">inner target</button>') + ';',
  'document.body.appendChild(frame);', '  return "ok";', '})()'].join('\n');
await call('eval', { tabId, expression: install });
await wait(700);
await call('scroll', { deltaY: 900, tabId }); await wait(300);
const snap1 = await call('snapshot', { tabId });
const boxRef = /\[ref=(\d+)\] (?:div|button)?\s*"box"/i.exec(snap1.snapshot);
await call('scroll', { ref: Number(boxRef[1]), tabId }); await wait(300);
const framed = await call('snapshot', { tabId });
const mainRef = /\[ref=(\d+)\](?! frame=)/.exec(framed.snapshot);
try { await call('scroll', { ref: Number(mainRef[1]), tabId }); } catch (e) { /* ignore */ }
await wait(300);
const innerRef = /\[ref=(\d+) frame=(f\d+)\]/.exec(framed.snapshot);
// Instrument the move, not just the outcome: log every scrollIntoView /
// scrollTo / scrollBy that the click triggers, with the node it targets and the
// page scroll before and after, alongside the scroll and mouse event timeline.
// This is what identified the failure: resolvePoint's in-frame scrollIntoView
// scrolls the top page to 0, the tab's activation then settles it back to 900,
// and the point — correct for scroll 0 — is dispatched at scroll 900.
const instrument = [
  '(function () {',
  '  window.__hit = false; window.__ev = []; window.__t0 = performance.now();',
  // The fixture already logs scroll and mouse events; add only the scroll
  // invocation logs here so each event appears once.
  '  function log(s) { window.__ev.push(Math.round(performance.now() - window.__t0) + " " + s); }',
  '  function d(el) { try { return (el && el.tagName ? el.tagName : String(el)) + (el && el.id ? "#" + el.id : ""); } catch (e) { return "?"; } }',
  '  var si = Element.prototype.scrollIntoView;',
  '  Element.prototype.scrollIntoView = function () {',
  '    log("scrollIntoView " + d(this) + " " + JSON.stringify(arguments[0]) + " yBefore=" + Math.round(window.scrollY));',
  '    var r = si.apply(this, arguments);',
  '    log("scrollIntoView done " + d(this) + " y=" + Math.round(window.scrollY));',
  '    return r;',
  '  };',
  '  var st = window.scrollTo; window.scrollTo = function () { log("scrollTo " + JSON.stringify(Array.prototype.slice.call(arguments))); return st.apply(window, arguments); };',
  '  var sb = window.scrollBy; window.scrollBy = function () { log("scrollBy " + JSON.stringify(Array.prototype.slice.call(arguments))); return sb.apply(window, arguments); };',
  '  document.querySelector("#probe-frame").contentWindow.document.getElementById("inner-btn").addEventListener("click", function () { window.__hit = true; });',
  '  return "ok";',
  '})()',
].join('\n');
await call('eval', { tabId, expression: instrument });
await call('click', { ref: Number(innerRef[1]), frame: innerRef[2], tabId });
await wait(500);
const out = JSON.parse(JSON.parse((await call('eval', { tabId, expression: '(function () { return JSON.stringify({ hit: window.__hit === true, ev: window.__ev }); })()' })).result));
console.log('hit: ' + out.hit);
console.log('event timeline during the click:');
out.ev.slice(0, 24).forEach(e => console.log('   ' + e));
await call('close', { tabId });
// The check: a click that does not land must not report success. Exit non-zero
// so the probe is usable as a gate, not just a printout.
process.exit(out.hit ? 0 : 1);
