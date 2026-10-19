/**
 * The first wheel on a freshly attached background tab is acked but scrolls
 * nothing, and a frame-ref click missed in the live suite. This narrows both.
 *
 *   node test/probe-scroll-frame.mjs [port]     # port defaults to 19387
 *
 * Wheel: on fresh tabs, does a zero-delta wheel or a click beforehand let the
 * next wheel scroll? Frame: does a frame-ref click land when the page starts
 * scrolled far past the frame, as it is in the suite?
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
const FIXTURE = '(function () { document.body.innerHTML = \'<div style="height:3000px">tall</div><button id="b">B</button>\';'
  + ' var f = document.createElement("iframe"); f.id = "pf"; f.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";'
  + ' f.srcdoc = \'<button id="inner" style="width:200px;height:60px">inner target</button>\'; document.body.appendChild(f); return "ok"; })()'

async function freshTab() {
  const tab = await call('open', { url: 'https://example.com', newTab: true })
  await ev(tab.tabId, FIXTURE)
  await sleep(600)
  return tab.tabId
}

async function wheelCase(label, prime) {
  const t = await freshTab()
  await prime(t)
  await call('scroll', { deltaY: 300, tabId: t })
  console.log(label.padEnd(28) + 'scrollY after a 300 wheel = ' + await ev(t, 'Math.round(scrollY)'))
  await call('close', { tabId: t })
}

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)

await wheelCase('no primer', async () => {})
await wheelCase('zero-delta wheel first', async t => { await call('scroll', { deltaY: 0, tabId: t }) })
await wheelCase('click first', async t => { await call('click', { x: 600, y: 50, tabId: t }) })
await wheelCase('eval only (attach) first', async t => { await ev(t, '1') })

const t = await freshTab()
await call('scroll', { deltaY: 0, tabId: t })
for (const start of [0, 1500, 2800]) {
  await ev(t, 'scrollTo(0, ' + start + ')')
  await sleep(300)
  const snap = await call('snapshot', { tabId: t })
  const inner = /\[ref=(\d+) frame=(f\d+)\]/.exec(snap.snapshot)
  if (!inner) { console.log('start ' + start + ': no frame ref in snapshot'); continue }
  await ev(t, '(function () { window.__down = null; var d = document.getElementById("pf").contentWindow.document;'
    + ' d.addEventListener("mousedown", function (e) { window.__down = "FRAME:" + e.target.id + "@" + e.clientX + "," + e.clientY; }, true);'
    + ' document.addEventListener("mousedown", function (e) { window.__down = "TOP:" + (e.target.id || e.target.tagName) + "@" + e.clientX + "," + e.clientY; }, true); return "ok"; })()')
  let outcome
  try { outcome = (await call('click', { ref: Number(inner[1]), frame: inner[2], tabId: t })).clicked } catch (error) { outcome = 'ERROR ' + error.message }
  await sleep(200)
  console.log('frame click from scrollY ' + String(start).padEnd(5) + outcome + ' | mousedown ' + await ev(t, 'window.__down')
    + ' | frame top now ' + await ev(t, 'Math.round(document.getElementById("pf").getBoundingClientRect().top)'))
}
await call('close', { tabId: t })
process.exit(0)
