/**
 * Spike: can trusted CDP input reach an agent tab the user is not looking at?
 *
 *   node test/probe-background-input.mjs [port]     # port defaults to 19387
 *
 * Needs the throwaway `probe` command in extension/service-worker.js, the
 * extension reloaded, and nothing else listening on the port. It serves its own
 * fixture over HTTP and, for each case, dispatches a mouse click, a key and a
 * wheel through raw CDP (no ensureVisible), then reads back how many trusted
 * events the page saw, how long each dispatch took, and the page's visibility.
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 19387)
const FIXTURE = 'http://127.0.0.1:' + PORT + '/fixture'
const HTML = '<!doctype html><title>bg-input probe</title>'
  + '<style>html,body{margin:0;height:100%}button{width:100%;height:100%;font-size:40px}</style>'
  + '<button id=b>target</button><script>'
  + 'window.__ev={mousedown:0,click:0,keydown:0,wheel:0};'
  + '["mousedown","click","keydown","wheel"].forEach(function(t){document.addEventListener(t,function(e){if(e.isTrusted)window.__ev[t]++},true)});'
  + '</script>'

let socket = null
let seq = 0
const waiting = new Map()
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(HTML)
})
const wss = new WebSocketServer({ server })
wss.on('connection', ws => {
  socket = ws
  ws.on('message', raw => {
    const f = JSON.parse(String(raw))
    if (f.t !== 'result') return
    const entry = waiting.get(f.id)
    if (!entry) return
    waiting.delete(f.id)
    f.ok ? entry.resolve(f.value) : entry.reject(new Error(f.error))
  })
})
server.listen(PORT, '127.0.0.1')

function call(method, params, ms = 30000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')) }, ms)
    waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    socket.send(JSON.stringify({ t: 'command', id, method, params }))
  })
}
const api = (fn, ...args) => call('probe', { op: 'api', fn, args })
const raw = (tabId, method, params, timeout) => call('probe', { op: 'cdp', tabId, method, params, timeout })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function page(tabId, expression) {
  const r = await raw(tabId, 'Runtime.evaluate', { expression, returnByValue: true })
  return r.ok ? r.value.result.value : 'eval failed: ' + r.error
}

async function waitLoaded(tabId) {
  for (let i = 0; i < 100; i += 1) {
    if (await page(tabId, 'document.readyState === "complete" && !!window.__ev') === true) return
    await sleep(100)
  }
  throw new Error('fixture never loaded in tab ' + tabId)
}

const results = []
async function measure(tabId, label) {
  await page(tabId, 'window.__ev={mousedown:0,click:0,keydown:0,wheel:0}')
  const before = await page(tabId, '({ vis: document.visibilityState, focus: document.hasFocus() })')
  const at = { x: 200, y: 200, modifiers: 0 }
  const timings = {}
  const t = async (name, method, params, timeout) => {
    const r = await raw(tabId, method, params, timeout)
    timings[name] = r.ok ? r.ms : 'FAIL ' + r.ms + 'ms ' + r.error
  }
  await t('move', 'Input.dispatchMouseEvent', { ...at, type: 'mouseMoved', button: 'none', buttons: 0 })
  await t('press', 'Input.dispatchMouseEvent', { ...at, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 })
  await t('release', 'Input.dispatchMouseEvent', { ...at, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 })
  await t('keyDown', 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
  await t('keyUp', 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await t('wheel', 'Input.dispatchMouseEvent', { ...at, type: 'mouseWheel', deltaX: 0, deltaY: 100, button: 'none', buttons: 0 }, 2000)
  await sleep(400)
  const seen = await page(tabId, 'window.__ev')
  const row = { label, ...before, ...seen, timings }
  results.push(row)
  console.log(JSON.stringify(row))
}

async function main() {
  console.log('waiting for the extension on port ' + PORT + ' ...')
  for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
  if (socket === null) throw new Error('extension never connected')
  await sleep(500)

  const userWin = await api('windows.getLastFocused', {})

  // A-C: agent tab in the background of the user's window.
  const tab = await api('tabs.create', { url: FIXTURE, active: false, windowId: userWin.id })
  await waitLoaded(tab.id)
  await measure(tab.id, 'A background tab')
  await raw(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  await measure(tab.id, 'B background + focus emulation')
  await raw(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: false })
  const sc = await raw(tab.id, 'Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 200, maxHeight: 200 })
  console.log('startScreencast: ' + JSON.stringify(sc))
  await sleep(500)
  await measure(tab.id, 'C background + screencast')
  await raw(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  await measure(tab.id, 'C2 background + screencast + focus emulation')
  await raw(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: false })
  await raw(tab.id, 'Page.stopScreencast', {})
  await api('tabs.remove', tab.id)

  // D: a separate agent window.
  const agentWin = await api('windows.create', { url: FIXTURE, focused: false, left: 40, top: 40, width: 600, height: 500 })
  const agentTab = agentWin.tabs[0].id
  await waitLoaded(agentTab)
  await measure(agentTab, 'D1 agent window, unfocused, uncovered')

  const cover = await api('windows.create', { url: 'about:blank', state: 'maximized', focused: true })
  await sleep(1500)
  await measure(agentTab, 'D2 agent window fully covered')
  await raw(agentTab, 'Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 200, maxHeight: 200 })
  await sleep(500)
  await measure(agentTab, 'D2s covered + screencast')
  await raw(agentTab, 'Page.stopScreencast', {})
  await api('windows.remove', cover.id)

  await api('windows.update', agentWin.id, { state: 'minimized' })
  await sleep(1500)
  await measure(agentTab, 'D3 agent window minimised')
  await raw(agentTab, 'Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 200, maxHeight: 200 })
  await sleep(500)
  await measure(agentTab, 'D3s minimised + screencast')
  await raw(agentTab, 'Page.stopScreencast', {})

  await api('windows.remove', agentWin.id)
  await api('windows.update', userWin.id, { focused: true })
}

// Pass 2: focus emulation alone, on fresh tabs, so case B is not an artifact of case A's stall.
async function confirm() {
  console.log('waiting for the extension on port ' + PORT + ' ...')
  for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
  if (socket === null) throw new Error('extension never connected')
  await sleep(500)
  const userWin = await api('windows.getLastFocused', {})

  const tab = await api('tabs.create', { url: FIXTURE, active: false, windowId: userWin.id })
  await waitLoaded(tab.id)
  await raw(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  await measure(tab.id, 'E1 fresh background tab + focus emulation')
  await measure(tab.id, 'E1b again')
  const group = await api('tabs.group', { tabIds: [tab.id] })
  await api('tabGroups.update', group, { collapsed: true })
  await sleep(500)
  await measure(tab.id, 'E2 in a collapsed tab group + focus emulation')
  await api('tabs.remove', tab.id)

  const win = await api('windows.create', { url: FIXTURE, focused: false, left: 40, top: 40, width: 600, height: 500 })
  const winTab = win.tabs[0].id
  await waitLoaded(winTab)
  await raw(winTab, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  await api('windows.update', win.id, { state: 'minimized' })
  await sleep(1500)
  await measure(winTab, 'E3 window minimised + focus emulation')
  await api('windows.remove', win.id)
  await api('windows.update', userWin.id, { focused: true })
}

;(process.argv[3] === 'confirm' ? confirm() : main()).then(
  () => { console.log('\nDONE ' + results.length + ' cases'); process.exit(0) },
  error => { console.log('\nPROBE FAILED: ' + error.message); process.exit(1) },
)
