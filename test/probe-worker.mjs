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

// The worker is a classic MV3 service worker, so it loads pure.js with
// importScripts. self has to be the global, because that is where pure.js
// publishes DSH_PURE; and the shim has to really evaluate the script, because a
// no-op would leave self.DSH_PURE undefined and the worker would die on the
// missing constants instead of exercising what this probe is for. A worker's
// importScripts resolves against its own directory, hence extension/ under ROOT.
globalThis.self = globalThis
globalThis.importScripts = (name) => {
  new Function(readFileSync(ROOT + '/extension/' + name, 'utf8'))()
}
// new Function's top level is a function body, not the global scope. pure.js is
// an IIFE and takes its globals as arguments, so it works here — but a future
// top-level `var` in pure.js would land on the global object in Chrome and be
// invisible inside this function. Revisit the shim if pure.js's shape changes.

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
