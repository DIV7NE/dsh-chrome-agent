/**
 * With Bitwarden on, the live suite's dialog section still hit the foreign-frame
 * lock after its typing checks, and blurring the focused field did not clear it.
 * Which Bitwarden UI is that, and what does it put in the page?
 *
 *   node test/probe-bitwarden-bar.mjs [port]     # port defaults to 19387
 *
 * Needs a throwaway `probe` command (inspect / locked / release) in the worker,
 * using chrome.scripting. Replays the suite's typing fixture, then reports the
 * lock state and the page's injected elements after each step. With "confirm"
 * as the second argument, the button opens a confirm() first.
 *
 * Measured with Bitwarden: a button click after a password was typed injected
 * two randomly named custom elements and locked the tab, held for 20s+ when
 * left alone. With focus on the button, a blur cleared it in 0.13s. After a
 * confirm() focus sat on <body>, and a blur did nothing; a decoy focus change
 * cleared it here, but not in the live suite's page, where removing the two
 * elements did (see releaseForeignFrame).
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

async function report(tabId, label) {
  const locked = await call('probe', { op: 'locked', tabId })
  const page = await call('probe', { op: 'inspect', tabId }).catch(e => ({ error: e.message }))
  console.log(label.padEnd(26) + locked + '\n    ' + JSON.stringify(page))
}

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
let tabId = null
try {
  const tab = await call('open', { url: 'https://example.com/?bwbar', newTab: true })
  tabId = tab.tabId
  const html = '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="t1" style="position:absolute;left:20px;top:520px">'
    + '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="tpw" type="password" style="position:absolute;left:420px;top:520px">'
    // With "confirm", the button opens a confirm() as the suite's dialog check does.
    + (process.argv[4] === 'confirm'
      ? '<button id="b" onclick="window.__c = confirm(&quot;sure?&quot;)" style="position:absolute;left:20px;top:600px">b</button>'
      : '<button id="b" style="position:absolute;left:20px;top:600px">b</button>')
  await call('eval', { tabId, expression: '(function () { document.body.innerHTML = ' + JSON.stringify(html) + '; return "ok"; })()' })
  await report(tabId, 'fresh page')
  await call('type', { selector: '#t1', text: 'replaced', tabId }).then(v => console.log('  type t1: ' + JSON.stringify(v)), e => console.log('  type t1 ERROR ' + e.message))
  await report(tabId, 'after typing text')
  await call('type', { selector: '#tpw', text: 'hunter22', tabId }).then(v => console.log('  type pw: ' + JSON.stringify(v)), e => console.log('  type pw ERROR ' + e.message))
  await report(tabId, 'after typing password')
  await call('click', { selector: '#b', tabId }).then(v => console.log('  click b: ok'), e => console.log('  click b ERROR ' + e.message))
  // How long does the lock last on its own, and does a release end it sooner?
  const clicked = Date.now()
  const timeline = []
  let releasedAt = null
  while (Date.now() - clicked < 20000) {
    const state = await call('probe', { op: 'locked', tabId })
    timeline.push(Math.round((Date.now() - clicked) / 100) / 10 + 's ' + (state === 'debugger ok' ? 'ok' : 'LOCKED'))
    if (process.argv[3] === 'release' && releasedAt === null && state !== 'debugger ok') {
      releasedAt = Date.now() - clicked
      timeline.push('release -> ' + JSON.stringify(await call('probe', { op: 'release', tabId })) + ' after ' + ((Date.now() - clicked - releasedAt) / 1000) + 's')
    }
    await sleep(500)
  }
  console.log('  ' + timeline.join(' | '))
  await report(tabId, 'after 20s')
} finally {
  if (tabId !== null) await call('close', { tabId, dialog: 'accept' }).catch(() => {})
}
process.exit(0)
