/**
 * Which capture method works reliably on a background tab with focus emulation on?
 *
 *   node test/probe-capture-variants.mjs [port]     # port defaults to 19387
 *
 * Needs the throwaway `probe` command in extension/service-worker.js. Each
 * variant captures one background tab six times, 1.5s apart.
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
const raw = (tabId, method, params, timeout) => call('probe', { tabId, method, params, timeout })

const variants = {
  plain: tabId => raw(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }),
  beyondViewport: tabId => raw(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }),
  screencast: tabId => call('probe', { op: 'screencastFrame', tabId }),
  retry: async tabId => {
    const first = await raw(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, 1500)
    if (first.ok) return first
    const second = await raw(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, 6000)
    return { ...second, ms: first.ms + second.ms, retried: true }
  },
}

// Wait for a worker that has the probe command; a stale one answers 'unknown command'.
for (let i = 0; ; i += 1) {
  if (i > 120) throw new Error('no extension with the probe command connected')
  if (socket !== null) {
    try { await call('probe', { op: 'none' }, 3000); break } catch (error) { /* stale worker or reconnecting */ }
  }
  await sleep(1000)
}
const tab = await call('open', { url: 'https://example.com', newTab: true })
await sleep(1500)
for (const [name, run] of Object.entries(variants)) {
  const rows = []
  for (let round = 0; round < 6; round += 1) {
    const r = await run(tab.tabId)
    rows.push(r.ok ? r.ms + 'ms' + (r.retried ? '(retry)' : '') : 'FAIL ' + r.ms + 'ms')
    await sleep(1500)
  }
  console.log(name.padEnd(15) + rows.join('  '))
}
await call('close', { tabId: tab.tabId })
process.exit(0)
