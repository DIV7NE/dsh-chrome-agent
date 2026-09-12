/**
 * The host half's testable surface: the extension-id derivation the fence
 * depends on, and the fence itself. Everything else needs a live browser.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BATCHABLE_TOOLS,
  deriveExtensionId,
  EXTENSION_ID,
  EXTENSION_KEY,
  isTrustedBridgeRequest,
  resolveBatchStep,
  summarizeBatchValue,
} from '../lib/index.js'

test('derives a real Chrome extension id from its manifest key', () => {
  // Fixture: Anthropic's published Claude in Chrome extension. Its manifest
  // `key` and its Web Store id are both public, so the derivation is checked
  // against ground truth rather than against itself.
  const claudeKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjU1XnLPoasGVmZU42K3h6S+sQhkogfcoLPbIcrWH5Oo8QoInBIugkew/7cWaEFySyQrkaEBe1fjeS/rlAqd3r778dKcTvDZcXmj0VVX0Fi1i8tnkarurceGKGdVxfkL7e30nwfgwoPxj3H8OQbsbxFcBWGVtcFekmdpiyaxwz6o4yXIWColfAxh9K2yToOZkoAS5GvgGvTexiCh1gYy++eFdk6C61mcFsyDdoGQtduhGEaX0zZ9uAW1jX4JTPmHV3kEFrZu/WVBl7Obw+Jk/osoHMdmghVNy6SCB8/6mcgmxkP9buPrNUZgYP6n0x5dqEJ2Ecww/lb1Zd4nQf4XGOwIDAQAB'
  assert.equal(deriveExtensionId(claudeKey), 'fcoeoabgfenejglbffodgkkbkcdhcgfn')
})

test('the pinned key yields this build\'s extension id', () => {
  assert.equal(EXTENSION_ID, deriveExtensionId(EXTENSION_KEY))
  assert.match(EXTENSION_ID, /^[a-p]{32}$/)
})

test('the bridge fence accepts only the pinned extension origin', () => {
  const good = 'chrome-extension://' + EXTENSION_ID
  assert.equal(isTrustedBridgeRequest({ origin: good }), true)
  // A web page (any origin) must not reach the browser tools.
  assert.equal(isTrustedBridgeRequest({ origin: 'http://127.0.0.1:3080' }), false)
  assert.equal(isTrustedBridgeRequest({ origin: 'https://evil.example' }), false)
  // A different extension is a different origin.
  assert.equal(isTrustedBridgeRequest({ origin: 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn' }), false)
  // Absent or malformed headers are refused, never defaulted open.
  assert.equal(isTrustedBridgeRequest({}), false)
  assert.equal(isTrustedBridgeRequest({ origin: '' }), false)
  assert.equal(isTrustedBridgeRequest({ origin: good.toUpperCase() }), false)
})

test('a batch step maps a tool onto its bridge command', () => {
  const step = resolveBatchStep('chrome_click', { ref: 3 }, 77)
  assert.deepEqual(step, { ok: true, tool: 'chrome_click', method: 'click', params: { ref: 3, tabId: 77 } })
})

test('a batch step keeps an explicit tab and tolerates no args', () => {
  const explicit = resolveBatchStep('chrome_eval', { expression: '1', tabId: 5 }, 77)
  assert.equal(explicit.ok && explicit.params.tabId, 5)
  const bare = resolveBatchStep('chrome_snapshot', undefined, 77)
  assert.deepEqual(bare.ok && bare.params, { tabId: 77 })
})

test('a batch step carries a multi-word tool name into camelCase', () => {
  // The bridge speaks camelCase, so cutting the prefix off is not enough:
  // chrome_page_text is pageText. Derived once, so a new tool cannot drift.
  assert.equal(resolveBatchStep('chrome_page_text', {}, undefined).method, 'pageText')
  assert.equal(resolveBatchStep('chrome_screenshot', {}, undefined).method, 'screenshot')
  // chrome_wait_for is the multi-word tool with a trailing word, so it is the
  // case that catches a prefix cut standing in for a real derivation.
  assert.equal(resolveBatchStep('chrome_wait_for', { timeout: 10 }, undefined).method, 'waitFor')
})

test('every batchable tool maps onto a camelCase command', () => {
  for (const tool of BATCHABLE_TOOLS) {
    const step = resolveBatchStep(tool, {}, undefined)
    assert.equal(step.ok, true, tool + ' should be batchable')
    assert.doesNotMatch(step.method, /_/, tool + ' must not map onto a snake_case command')
  }
})

test('a batch step refuses reads and nesting', () => {
  // chrome_status and chrome_tabs must answer before steps are chosen, and a
  // batch inside a batch has no meaning.
  for (const tool of ['chrome_status', 'chrome_tabs', 'chrome_batch']) {
    const step = resolveBatchStep(tool, {}, undefined)
    assert.equal(step.ok, false, tool + ' should be refused')
    assert.match(step.ok === false ? step.error : '', /cannot run inside chrome_batch/)
  }
})

test('a batch step refuses malformed actions', () => {
  assert.equal(resolveBatchStep(undefined, {}, undefined).ok, false)
  assert.equal(resolveBatchStep('', {}, undefined).ok, false)
  assert.equal(resolveBatchStep('chrome_click', 'not an object', undefined).ok, false)
  assert.equal(resolveBatchStep('chrome_click', [1, 2], undefined).ok, false)
  assert.equal(resolveBatchStep('delete_everything', {}, undefined).ok, false)
})

test('a batch result is a bounded string', () => {
  assert.equal(summarizeBatchValue({ clicked: 'Save' }), JSON.stringify({ clicked: 'Save' }))
  assert.equal(summarizeBatchValue('plain'), 'plain')
  assert.equal(summarizeBatchValue(undefined), 'null')
  const long = summarizeBatchValue('x'.repeat(9000))
  assert.ok(long.length < 4100, 'long output must be capped, got ' + long.length)
  assert.match(long, /truncated/)
})
