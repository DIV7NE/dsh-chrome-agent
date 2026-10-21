/**
 * Does chrome_type ever need its script fallback? Focus a login field, let a
 * password manager lock the tab, then type into the field and see which path ran.
 *
 *   node test/probe-type-locked.mjs [port]     # port defaults to 19387
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 19387)
let socket = null; let seq = 0; const waiting = new Map()
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })
wss.on('connection', ws => { socket = ws; ws.on('message', raw => { const f = JSON.parse(String(raw))
  if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)) } } }) })
function call(method, params, ms = 30000) { const id = ++seq
  return new Promise((res, rej) => { const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' timed out')) }, ms)
    waiting.set(id, { resolve: v => { clearTimeout(t); res(v) }, reject: e => { clearTimeout(t); rej(e) } })
    socket.send(JSON.stringify({ t: 'command', id, method, params })) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
let tabId = null
try {
  const tab = await call('open', { url: 'https://example.com/?typelocked', newTab: true })
  tabId = tab.tabId
  await call('eval', { tabId, expression: '(function () { document.body.innerHTML = \'<form action="#"><input id="user" name="username" autocomplete="username" style="position:absolute;left:20px;top:20px"><input id="pw" type="password" name="password" autocomplete="current-password" style="position:absolute;left:20px;top:80px"><button style="position:absolute;left:20px;top:140px">Sign in</button></form>\'; return "ok"; })()' })
  for (const [label, selector, text] of [['username', '#user', 'alice@example.com'], ['password', '#pw', 'hunter22']]) {
    const clicked = await call('click', { selector, tabId }).then(() => 'ok', e => 'ERROR ' + e.message)
    await sleep(2000)
    const lockedNow = await call('eval', { tabId, expression: '1' }).then(() => 'tab usable', e => 'tab LOCKED (' + e.message.slice(0, 400) + ')')
    console.log(label.padEnd(10) + 'click ' + clicked.slice(0, 80) + ' | 2s later: ' + lockedNow)
    const started = Date.now()
    const typed = await call('type', { selector, text, tabId }).then(v => JSON.stringify(v), e => 'ERROR ' + e.message)
    console.log(label.padEnd(10) + (Date.now() - started) + 'ms ' + typed)
  }
} finally {
  if (tabId !== null) await call('close', { tabId, dialog: 'accept' }).catch(() => {})
}
process.exit(0)
