// Reproduce the service worker's registration-time execution with Chrome API stubs.
import { readFileSync } from 'node:fs'
import { createPublicKey } from 'node:crypto'

const ROOT = process.argv[2]

// --- validate the manifest key first ---
const manifest = JSON.parse(readFileSync(ROOT + '/extension/manifest.json', 'utf8'))
try {
  const key = createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' })
  console.log('manifest key: VALID spki (' + key.asymmetricKeyType + ' ' + (key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength) + ')' )
} catch (error) {
  console.log('manifest key: INVALID -> ' + error.message)
}

// --- stub the chrome surface the worker touches ---
const calls = []
const noop = (name) => (...args) => { calls.push(name); return undefined }
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: manifest.version }),
    onStartup: { addListener: noop('runtime.onStartup') },
    onInstalled: { addListener: noop('runtime.onInstalled') },
    onMessage: { addListener: noop('runtime.onMessage') },
  },
  storage: { local: { get: async (d) => d, set: async () => {} } },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 1, url: '', title: '' }),
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    onRemoved: { addListener: noop('tabs.onRemoved') },
    onUpdated: { addListener: noop('tabs.onUpdated'), removeListener: noop('tabs.onUpdated.remove') },
  },
  debugger: {
    attach: async () => {}, sendCommand: async () => ({}), detach: async () => {},
    onDetach: { addListener: noop('debugger.onDetach') },
    onEvent: { addListener: noop('debugger.onEvent') },
  },
  alarms: { create: noop('alarms.create'), onAlarm: { addListener: noop('alarms.onAlarm') } },
}
globalThis.WebSocket = class {
  constructor(url) { calls.push('WebSocket(' + url + ')'); this.readyState = 0 }
  addEventListener() {} send() {} close() {}
}
globalThis.WebSocket.OPEN = 1

// --- execute the worker ---
try {
  const source = readFileSync(ROOT + '/extension/service-worker.js', 'utf8')
  new Function(source)()
  console.log('service worker top level: OK')
  console.log('side effects: ' + JSON.stringify(calls))
} catch (error) {
  console.log('service worker top level: THREW -> ' + error.message)
  console.log(error.stack)
}
