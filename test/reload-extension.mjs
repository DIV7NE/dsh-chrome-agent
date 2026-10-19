/**
 * Reload the unpacked extension from disk through the bridge, then wait for the
 * fresh worker to say hello.
 *
 *   node test/reload-extension.mjs [port]     # port defaults to 19387
 *
 * Needs a running worker that already has the reloadExtension command, and
 * nothing else on the port (stop the DSH server first).
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 19387)
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })
let hellos = 0
let asked = false

const done = setTimeout(() => {
  console.log(asked ? 'the extension did not come back within 60s' : 'no extension connected within 60s')
  process.exit(1)
}, 60000)

wss.on('connection', ws => {
  ws.on('message', raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t === 'hello') {
      hellos += 1
      if (asked) {
        console.log('reloaded: the new worker said hello (version ' + frame.version + ')')
        clearTimeout(done)
        process.exit(0)
      }
      asked = true
      ws.send(JSON.stringify({ t: 'command', id: 1, method: 'reloadExtension', params: {} }))
    }
    if (frame.t === 'result' && frame.id === 1 && !frame.ok) {
      console.log('this worker cannot reload itself (' + frame.error + ') — reload it once in chrome://extensions')
      process.exit(1)
    }
  })
})
