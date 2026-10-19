/**
 * Does a background capture keep working once focus emulation is on?
 *
 *   node test/probe-bg-capture.mjs [port]     # port defaults to 19387
 *
 * Opens one background tab and captures it repeatedly, a few seconds apart,
 * reporting each capture's time or error next to the page's visibility.
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

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
const tab = await call('open', { url: 'https://example.com', newTab: true })
for (let round = 0; round < 6; round += 1) {
  const vis = await call('eval', { tabId: tab.tabId, expression: 'document.visibilityState + "/" + document.hasFocus()' })
  const started = Date.now()
  let outcome
  try {
    const shot = await call('screenshot', { tabId: tab.tabId })
    outcome = 'ok ' + shot.base64.length + ' b64 chars'
  } catch (error) {
    outcome = 'FAIL ' + error.message
  }
  console.log('round ' + round + ' vis=' + vis.result + ' ' + (Date.now() - started) + 'ms ' + outcome)
  if (round === 2) {
    await call('click', { x: 10, y: 10, tabId: tab.tabId })
    console.log('  (clicked the tab, as the suite does between captures)')
  }
  await sleep(3000)
}
await call('close', { tabId: tab.tabId })
process.exit(0)
