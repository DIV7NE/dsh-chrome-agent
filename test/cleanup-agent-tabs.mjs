/**
 * Close the test tabs that aborted live runs and probes left in the agent's group.
 *
 *   node test/cleanup-agent-tabs.mjs [port]     # port defaults to 19387
 *
 * Only tabs the extension marks as the agent's own, and only on the sites the
 * tests use, so none of the user's tabs can be touched.
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 19387)
let socket = null; let seq = 0; const waiting = new Map()
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })
wss.on('connection', ws => { socket = ws; ws.on('message', raw => { const f = JSON.parse(String(raw))
  if (f.t === 'result') { const e = waiting.get(f.id); if (e) { waiting.delete(f.id); f.ok ? e.resolve(f.value) : e.reject(new Error(f.error)) } } }) })
function call(method, params, ms = 10000) { const id = ++seq
  return new Promise((res, rej) => { const t = setTimeout(() => { waiting.delete(id); rej(new Error(method + ' timed out')) }, ms)
    waiting.set(id, { resolve: v => { clearTimeout(t); res(v) }, reject: e => { clearTimeout(t); rej(e) } })
    socket.send(JSON.stringify({ t: 'command', id, method, params })) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
if (socket === null) { console.log('the extension never connected on port ' + PORT); process.exit(1) }
await sleep(500)
const tabs = await call('tabs', {})
const litter = tabs.filter(t => t.agent === true && /^https?:\/\/(www\.)?(example\.com|iana\.org|duckduckgo\.com)/.test(t.url))
let closed = 0
for (const tab of litter) {
  try { await call('close', { tabId: tab.id, dialog: 'accept' }); closed += 1 } catch (error) { console.log('could not close ' + tab.id + ': ' + error.message) }
}
console.log('closed ' + closed + ' of ' + litter.length + ' leftover test tab(s); ' + (tabs.length - closed) + ' tab(s) remain open')
process.exit(0)
