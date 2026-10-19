/**
 * Once another extension (a password manager, say) injects its own iframe into
 * a page, chrome.debugger commands to that tab fail with "Cannot access a
 * chrome-extension:// URL of different extension". Which extension, which
 * commands, and does closing its frame give the tab back?
 *
 *   node test/probe-foreign-frame.mjs [port]     # port defaults to 19387
 *
 * Needs a throwaway `probe` command in extension/service-worker.js: raw CDP, plus
 * `inspect`/`remove` ops that run chrome.scripting.executeScript (which also
 * needs the "scripting" permission and "<all_urls>" host permission).
 *
 * Measured with Bitwarden: focusing the username field locked every debugger
 * command out of the tab (input and capture too); Escape and a click away were
 * refused as well. The injected elements had random tag names and no reachable
 * iframe. Blurring the field through chrome.scripting made them go away, and a
 * fresh attach then worked again.
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
const raw = (tabId, method, params) => call('probe', { tabId, method, params })

function frameUrls(tree, out = []) {
  if (!tree) return out
  out.push(tree.frame.url)
  for (const child of tree.childFrames || []) frameUrls(child, out)
  return out
}

async function status(tabId, label) {
  const tree = await raw(tabId, 'Page.getFrameTree', {})
  const foreign = tree.ok ? frameUrls(tree.value.frameTree).filter(u => u.startsWith('chrome-extension://')) : ['getFrameTree failed: ' + tree.error]
  const ev = await raw(tabId, 'Runtime.evaluate', { expression: '1+1', returnByValue: true })
  const shot = await raw(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 10 })
  const dom = await raw(tabId, 'DOM.getDocument', { depth: 1 })
  const fmt = r => r.ok ? 'ok' : 'FAIL(' + r.error.slice(0, 60) + ')'
  console.log(label.padEnd(30) + 'extension frames: ' + JSON.stringify(foreign) + ' | evaluate ' + fmt(ev) + ' | capture ' + fmt(shot) + ' | DOM ' + fmt(dom))
}

for (let i = 0; i < 90 && socket === null; i += 1) await sleep(1000)
await sleep(500)
let tabId = null
try {
  const tab = await call('open', { url: 'https://example.com/?login', newTab: true })
  tabId = tab.tabId
  await call('eval', { tabId, expression: '(function () { document.body.innerHTML = \'<form action="#"><input id="user" name="username" autocomplete="username" style="position:absolute;left:20px;top:20px"><input id="pw" type="password" name="password" autocomplete="current-password" style="position:absolute;left:20px;top:80px"><button style="position:absolute;left:20px;top:140px">Sign in</button></form><p style="position:absolute;left:20px;top:400px">elsewhere</p>\'; return "ok"; })()' })
  await sleep(500)
  await status(tabId, 'before any focus')
  await call('click', { selector: '#user', tabId })
  await sleep(1500)
  await status(tabId, 'after clicking username')
  // The normal command path re-attaches when Chrome has detached the debugger.
  for (let n = 0; n < 3; n += 1) {
    try {
      const ev = await call('eval', { tabId, expression: 'document.activeElement.id' })
      console.log('   normal eval (re-attaches) #' + n + ': ok ' + ev.result)
    } catch (error) {
      console.log('   normal eval (re-attaches) #' + n + ': FAIL ' + error.message)
    }
    await sleep(500)
  }
  // chrome.scripting does not go through the debugger, so it may still reach the page.
  const seen = await call('probe', { op: 'inspect', tabId })
  console.log('   injected, via chrome.scripting: ' + JSON.stringify(seen.value))
  const removed = await call('probe', { op: 'remove', tabId })
  console.log('   removed and blurred: ' + JSON.stringify(removed.value && removed.value.found))
  await sleep(500)
  for (let n = 0; n < 3; n += 1) {
    try {
      const ev = await call('eval', { tabId, expression: 'document.activeElement.tagName' })
      console.log('   after blur, normal eval #' + n + ': ok ' + ev.result)
    } catch (error) {
      console.log('   after blur, normal eval #' + n + ': FAIL ' + error.message)
    }
    await sleep(700)
  }
  const after = await call('probe', { op: 'inspect', tabId })
  console.log('   still injected after blur: ' + JSON.stringify(after.value && after.value.tail))
  await status(tabId, 'after removing the frames')
  await sleep(2000)
  await status(tabId, '2s later')
} finally {
  if (tabId !== null) await call('close', { tabId, dialog: 'accept' }).catch(() => {})
}
process.exit(0)
