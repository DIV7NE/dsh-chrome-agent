/**
 * Does chrome_open return before the new tab has navigated? A command sent the
 * moment it returns then lands on about:blank, or dies with "Detached while
 * handling command" when the tab swaps to the real page's renderer.
 *
 *   node test/probe-open-race.mjs [port]     # port defaults to 19387
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
let bad = 0
for (let n = 1; n <= 10; n += 1) {
  const started = Date.now()
  const opened = await call('open', { url: 'https://example.com/?race=' + n, newTab: true })
  const openMs = Date.now() - started
  let outcome
  try {
    outcome = (await call('eval', { tabId: opened.tabId, expression: 'location.href + " " + document.readyState' })).result
    if (!/race=/.test(outcome)) bad += 1
  } catch (error) {
    outcome = 'ERROR ' + error.message
    bad += 1
  }
  console.log('open ' + n + ' returned in ' + openMs + 'ms (reported url ' + opened.url + ') -> ' + outcome)
  await call('close', { tabId: opened.tabId }).catch(() => {})
}
console.log(bad + ' of 10 commands did not land on the opened page')
process.exit(0)
