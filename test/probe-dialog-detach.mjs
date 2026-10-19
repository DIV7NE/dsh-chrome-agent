/**
 * A click that opens a confirm() on a background tab failed with "Detached
 * while handling command". This repeats that click several ways and prints
 * each outcome in full, including the detach reason the extension now reports.
 *
 *   node test/probe-dialog-detach.mjs [port]     # port defaults to 19387
 *
 * It never reproduced the failure: the cause was not the dialog but Bitwarden
 * injecting its frame into the suite's page — see probe-foreign-frame.mjs.
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
async function attempt(label, method, params) {
  const started = Date.now()
  try {
    const value = await call(method, params)
    console.log(label.padEnd(34) + (Date.now() - started) + 'ms ok ' + JSON.stringify(value))
  } catch (error) {
    console.log(label.padEnd(34) + (Date.now() - started) + 'ms ERROR ' + error.message)
  }
}

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
const tab = await call('open', { url: 'https://example.com', newTab: true })
const t = tab.tabId
await call('eval', { tabId: t, expression: '(function () { document.body.innerHTML = \'<button id="c" onclick="window.__c = confirm(&quot;Delete forever?&quot;)">confirm</button><button id="a" onclick="alert(&quot;Saved&quot;)">alert</button>\'; return "ok"; })()' })
if (process.argv[3] === 'iframe') {
  // The live suite's page also holds a srcdoc iframe, which the probe page lacked.
  await call('eval', { tabId: t, expression: '(function () { var f = document.createElement("iframe"); f.srcdoc = "<button>framed</button>"; document.body.appendChild(f); return "ok"; })()' })
  await sleep(500)
  await call('snapshot', { tabId: t })
}
if (process.argv[3] === 'window') {
  // How long after a dialog-opening click do commands to the tab fail?
  for (const [label, selector, dialog] of [['alert', '#a', undefined], ['confirm dismissed', '#c', undefined], ['confirm accepted', '#c', 'accept']]) {
    await call('click', { selector, dialog, tabId: t })
    const clicked = Date.now()
    const failures = []
    let firstOk = null
    while (Date.now() - clicked < 2000) {
      try {
        await call('eval', { tabId: t, expression: '1' })
        if (firstOk === null && failures.length > 0) firstOk = Date.now() - clicked
      } catch (error) {
        failures.push((Date.now() - clicked) + 'ms')
      }
      await sleep(25)
    }
    console.log(label.padEnd(18) + (failures.length === 0 ? 'no failed command' : failures.length + ' failed (' + failures.slice(0, 4).join(', ') + (failures.length > 4 ? ' …' : '') + '), first success after them at ' + firstOk + 'ms'))
  }
  await call('close', { tabId: t }).catch(() => {})
  process.exit(0)
}
await attempt('eval confirm(), default', 'eval', { tabId: t, expression: 'confirm("via eval")' })
await attempt('eval confirm(), accept', 'eval', { tabId: t, expression: 'confirm("via eval")', dialog: 'accept' })
await attempt('click alert button', 'click', { selector: '#a', tabId: t, debug: true })
await attempt('click confirm button, default', 'click', { selector: '#c', tabId: t, debug: true })
await attempt('click confirm button, accept', 'click', { selector: '#c', dialog: 'accept', tabId: t, debug: true })
await attempt('read answer', 'eval', { tabId: t, expression: 'window.__c' })
await call('close', { tabId: t }).catch(() => {})
process.exit(0)
