/**
 * In the live suite, an eval on the accuracy tab died 8ms in with "Detached
 * while handling command" (no onDetach), at varying points after the typing
 * checks. Does typing into a password field make the page's renderer go away
 * a few seconds later? A text field is the control.
 *
 *   node test/probe-password-detach.mjs [port]     # port defaults to 19387
 *
 * Result: both stayed stable for 10s. A lone password field did not bring
 * Bitwarden in; a login form's username field did (probe-foreign-frame.mjs).
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
const opened = []
try {
  for (const kind of ['text', 'password']) {
    const tab = await call('open', { url: 'https://example.com/?field=' + kind, newTab: true })
    opened.push(tab.tabId)
    await call('eval', { tabId: tab.tabId, expression: '(function () { document.body.innerHTML = \'<input id="f" type="' + kind + '">\'; return "ok"; })()' })
    const origin = (await call('eval', { tabId: tab.tabId, expression: 'performance.timeOrigin' })).result
    await call('type', { selector: '#f', text: 'hunter22', tabId: tab.tabId })
    const events = []
    for (let n = 0; n < 50; n += 1) {
      try {
        const now = (await call('eval', { tabId: tab.tabId, expression: 'performance.timeOrigin + " " + location.href' })).result
        if (!now.startsWith(origin.replace(/"/g, ''), 1)) events.push((n * 200) + 'ms: page changed -> ' + now)
      } catch (error) {
        events.push((n * 200) + 'ms: ERROR ' + error.message)
      }
      await sleep(200)
    }
    console.log(kind.padEnd(9) + (events.length === 0 ? 'stable for 10s' : events.slice(0, 5).join(' | ')))
  }
} finally {
  for (const tabId of opened) await call('close', { tabId, dialog: 'accept' }).catch(() => {})
}
process.exit(0)
