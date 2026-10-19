/**
 * On a background tab, is the first wheel after attaching dropped or held?
 *
 *   node test/probe-scroll-commit.mjs [port]     # port defaults to 19387
 *
 * A: no wheel at all — does a JS scroll survive the next input event?
 * B: one chrome_scroll, then a capture to force a frame — does the page sit at
 *    exactly the requested delta, and does a JS scroll then survive input?
 *
 * Before the fix the scroll command re-sent an unmoved wheel, and B read 1800
 * after a 900 request: the first wheel had been held until the next frame, not
 * dropped. A JS scroll followed by a click also snapped to JS position + 900.
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

for (const [name, wheel] of [['A no wheel', false], ['B wheel, flushed', true]]) {
  const tab = await call('open', { url: 'https://example.com', newTab: true })
  const t = tab.tabId
  await ev(t, '(function () { document.body.innerHTML = \'<div style="height:5000px">tall</div>\'; return 1; })()')
  await sleep(400)
  let note = ''
  if (wheel) {
    const r = await call('scroll', { deltaY: 900, tabId: t })
    await call('screenshot', { tabId: t })
    note = '[' + r.scrolled + '; after a forced frame scrollY ' + await ev(t, 'scrollY') + '] '
  }
  await ev(t, 'scrollTo(0, 500)')
  const beforeInput = await ev(t, 'scrollY')
  await call('click', { x: 5, y: 5, tabId: t })
  await sleep(200)
  console.log(name.padEnd(18) + note + 'JS scroll to 500: before input ' + beforeInput + ', after input ' + await ev(t, 'scrollY'))
  await call('close', { tabId: t })
}
process.exit(0)
