/**
 * The live suite's frame-ref click misses, while the same click on a fresh copy
 * of the page lands. This replays the suite's exact sequence on its fixture and
 * logs every mousedown, mouseup and click in the frame and the top page.
 *
 *   node test/probe-frame-click.mjs [port]     # port defaults to 19387
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 19387)
let socket = null; let seq = 0; const waiting = new Map()
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })
wss.on('connection', ws => { socket = ws; ws.on('message', raw => { const f = JSON.parse(String(raw))
  if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)) } } }) })
function call(method, params, ms = 20000) { const id = ++seq
  return new Promise((res, rej) => { const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' timed out')) }, ms)
    waiting.set(id, { resolve: v => { clearTimeout(t); res(v) }, reject: e => { clearTimeout(t); rej(e) } })
    socket.send(JSON.stringify({ t: 'command', id, method, params })) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ev = async (tabId, expression) => (await call('eval', { tabId, expression })).result

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)

const tab = await call('open', { url: 'https://example.com', newTab: true })
const t = tab.tabId
const pageHtml = '<div style="height:3000px">tall</div>'
  + '<button id="b" style="width:120px;height:40px">B</button>'
  + '<input id="f" type="file">'
  + '<div id="box" role="button" tabindex="0" style="width:80px;height:80px;background:#ccc">box</div>'
await ev(t, '(function () { document.body.innerHTML = ' + JSON.stringify(pageHtml) + ';'
  + ' var frame = document.createElement("iframe"); frame.id = "probe-frame";'
  + ' frame.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";'
  + ' frame.srcdoc = ' + JSON.stringify('<button id="inner-btn" style="width:200px;height:60px">inner target</button>') + ';'
  + ' document.body.appendChild(frame); return "ok"; })()')
await sleep(600)

console.log('wheel: ' + (await call('scroll', { deltaY: 900, tabId: t })).scrolled)
const capSnap = await call('snapshot', { tabId: t })
const boxRef = /\[ref=(\d+)\] (?:div|button)?\s*"box"/i.exec(capSnap.snapshot)
console.log('scroll to box: ' + (await call('scroll', { ref: Number(boxRef[1]), tabId: t })).scrolled + ', scrollY=' + await ev(t, 'scrollY'))
await sleep(600)
const framed = await call('snapshot', { tabId: t })
console.log('framed snapshot:\n' + framed.snapshot.split('\n').filter(l => /ref=/.test(l)).join('\n'))
const mainRef = /^\[ref=(\d+)\] (?![^\n]*frame=)/m.exec(framed.snapshot)
console.log('scroll to main ref ' + mainRef[1] + ': ' + (await call('scroll', { ref: Number(mainRef[1]), tabId: t })).scrolled + ', scrollY=' + await ev(t, 'scrollY'))

const innerRef = /\[ref=(\d+) frame=(f\d+)\]/.exec(framed.snapshot)
await ev(t, '(function () { window.__log = []; var d = document.querySelector("#probe-frame").contentWindow.document;'
  + ' ["mousedown","mouseup","click"].forEach(function (k) {'
  + '  d.addEventListener(k, function (e) { window.__log.push("FRAME " + k + " " + (e.target.id || e.target.tagName) + " @" + e.clientX + "," + e.clientY); }, true);'
  + '  document.addEventListener(k, function (e) { window.__log.push("TOP " + k + " " + (e.target.id || e.target.tagName) + " @" + e.clientX + "," + e.clientY); }, true); });'
  + ' return "ok"; })()')
const clicked = await call('click', { ref: Number(innerRef[1]), frame: innerRef[2], tabId: t })
await sleep(300)
console.log('click ref ' + innerRef[1] + ' ' + innerRef[2] + ' said: ' + clicked.clicked)
console.log('events: ' + await ev(t, 'JSON.stringify(window.__log)'))
console.log('frame rect: ' + await ev(t, 'JSON.stringify(document.getElementById("probe-frame").getBoundingClientRect())') + ' scrollY=' + await ev(t, 'scrollY'))
await call('close', { tabId: t })
process.exit(0)
