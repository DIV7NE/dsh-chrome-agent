/**
 * A leave-page (beforeunload) warning on a background agent tab: chrome.tabs.update
 * navigation made Chrome activate the tab to show it (moving the user's view) and
 * hang chrome_open for its 20s load timeout once the warning was dismissed.
 *
 *   node test/probe-beforeunload.mjs [port]     # port defaults to 19387
 *
 * Measured here, with the throwaway raw-CDP `probe` command in the worker:
 * can the handler be detected beforehand, and does CDP's Page.navigate skip the
 * warning (no dialog, no activation)?
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
const raw = (tabId, method, params) => call('probe', { tabId, method, params })
const activeIds = async () => (await call('tabs', {})).filter(t => t.active).map(t => t.id).sort()

async function listenersOnWindow(tabId) {
  const win = await raw(tabId, 'Runtime.evaluate', { expression: 'window' })
  if (!win.ok) return 'evaluate failed: ' + win.error
  const listed = await raw(tabId, 'DOMDebugger.getEventListeners', { objectId: win.value.result.objectId })
  if (!listed.ok) return 'getEventListeners failed: ' + listed.error
  return listed.value.listeners.map(l => l.type).filter(t => /unload/.test(t)).join(',') || '(none)'
}

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
const opened = []
try {
  for (const style of ['addEventListener', 'onbeforeunload property', 'no handler']) {
    const tab = await call('open', { url: 'https://example.com/?leave', newTab: true })
    const tabId = tab.tabId
    opened.push(tabId)
    const install = style === 'addEventListener'
      ? 'window.addEventListener("beforeunload", function (e) { e.preventDefault(); e.returnValue = ""; })'
      : style === 'onbeforeunload property' ? 'window.onbeforeunload = function () { return "unsaved"; }' : '0'
    await call('eval', { tabId, expression: '(function () { ' + install + '; return "ok"; })()' })
    await call('click', { x: 10, y: 10, tabId })
    const listeners = await listenersOnWindow(tabId)
    const prop = (await raw(tabId, 'Runtime.evaluate', { expression: 'typeof window.onbeforeunload === "function"', returnByValue: true })).value.result.value
    await call('probe', { op: 'dialogs' })
    const before = await activeIds()
    const started = Date.now()
    const nav = await raw(tabId, 'Page.navigate', { url: 'https://example.com/?left' })
    await sleep(1500)
    const dialogs = (await call('probe', { op: 'dialogs' })).value
    const after = await activeIds()
    const where = (await call('eval', { tabId, expression: 'location.search' })).result
    console.log(style.padEnd(26) + 'listeners: ' + listeners + ' | onbeforeunload fn: ' + prop
      + ' | Page.navigate ' + (nav.ok ? 'ok' : 'FAIL ' + nav.error) + ' in ' + (Date.now() - started - 1500) + 'ms'
      + ' | dialogs: ' + JSON.stringify(dialogs.map(d => d.type + (d.accepted ? ' accepted' : ' dismissed')))
      + ' | now at ' + where + ' | activated: ' + (after.includes(tabId) && !before.includes(tabId)))
  }
} finally {
  for (const tabId of opened) await call('close', { tabId, dialog: 'accept' }).catch(() => {})
}
process.exit(0)
