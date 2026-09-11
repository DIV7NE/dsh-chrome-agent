/**
 * The extension's browser-free logic: frame keys, the screenshot quality ladder,
 * the tab-confinement predicate and the frame offset sum.
 *
 *   npm test
 *
 * No Chrome, no server, no sockets.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The service worker is a classic worker and loads this with importScripts;
// this is the same file, given the globals a plain script expects.
vm.runInThisContext(readFileSync(new URL('../extension/pure.js', import.meta.url), 'utf8'))
const {
  FRAME_LIMIT,
  flattenFrameTree,
  normaliseFrameKey,
  nextJpegQuality,
  chooseJpegAttempt,
  isTabAllowed,
  sumFrameOffsets,
} = globalThis.DSH_PURE

/** A frame tree node shaped like Page.getFrameTree's. A leaf omits childFrames. */
const frame = (id, childFrames) => (childFrames === undefined
  ? { frame: { id, url: 'https://x/' + id } }
  : { frame: { id, url: 'https://x/' + id }, childFrames })

// root
//   c0
//   c1
//     g0
//     g1
const sample = () => frame('root', [frame('c0'), frame('c1', [frame('g0'), frame('g1')])])

test('a frame tree flattens main-first with parent keys', () => {
  const flat = flattenFrameTree(sample(), FRAME_LIMIT)
  assert.deepEqual(flat.frames.map(f => f.key), ['f0', 'f1', 'f2', 'f3', 'f4'])
  assert.deepEqual(flat.frames.map(f => f.parentKey), [null, 'f0', 'f0', 'f2', 'f2'])
  assert.deepEqual(flat.frames.map(f => f.frameId), ['root', 'c0', 'c1', 'g0', 'g1'])
  assert.equal(flat.total, 5)
})

test('flattening caps the list but still counts every frame', () => {
  const flat = flattenFrameTree(sample(), 2)
  assert.equal(flat.frames.length, 2)
  assert.equal(flat.total, 5)
  // Keys are assigned before the cap, so a returned key always means the same
  // frame — f2 still names c1 even though it is not in the list.
  assert.deepEqual(flat.frames.map(f => f.key), ['f0', 'f1'])
})

test('flattening tolerates no tree and malformed nodes', () => {
  assert.deepEqual(flattenFrameTree(undefined, FRAME_LIMIT), { frames: [], total: 0 })
  assert.deepEqual(flattenFrameTree({ nope: true }, FRAME_LIMIT), { frames: [], total: 0 })
})

test('flattening drops a malformed node and its subtree from the count', () => {
  // A node without a string frame.id is not a frame, so it cannot be given a key
  // and its children cannot be placed under one. Both it and its subtree are
  // ignored, and total counts what was kept rather than every tree-shaped node.
  const flat = flattenFrameTree(
    frame('root', [{ frame: { id: 7 }, childFrames: [frame('ghost')] }]),
    FRAME_LIMIT,
  )
  assert.deepEqual(flat.frames.map(f => f.frameId), ['root'])
  assert.equal(flat.total, 1)
})

test('a non-positive or non-finite limit falls back to the default cap', () => {
  // The cap is a guard, so 0 and NaN mean "use the default", not "return
  // nothing": a caller that forgot to pass one still gets a bounded read.
  const wide = () => frame('root', Array.from({ length: 20 }, (_, i) => frame('c' + i)))
  assert.equal(flattenFrameTree(wide(), 0).frames.length, FRAME_LIMIT)
  assert.equal(flattenFrameTree(wide(), Number.NaN).frames.length, FRAME_LIMIT)
})

test('a frame key normalises with the main frame as the default', () => {
  for (const value of [undefined, null, '', 'f0']) assert.equal(normaliseFrameKey(value), '')
  assert.equal(normaliseFrameKey('f1'), 'f1')
  assert.equal(normaliseFrameKey('f12'), 'f12')
})

test('a malformed frame key is refused rather than ignored', () => {
  // Ignoring it would resolve a ref against the wrong document.
  for (const value of ['1', 'fx', 'f0a', 'f', 7, {}]) {
    assert.throws(() => normaliseFrameKey(value), /frame must look like/)
  }
})

test('the quality ladder walks down and then stops', () => {
  assert.equal(nextJpegQuality(0), 90)
  assert.equal(nextJpegQuality(4), 30)
  assert.equal(nextJpegQuality(5), null)
  assert.equal(nextJpegQuality(undefined), 90)
})

test('the first JPEG attempt that fits wins, even when a later one is smaller', () => {
  const sizes = [300, 150, 100, 50]
  assert.equal(chooseJpegAttempt(sizes, 200), 1)
})

test('when no JPEG attempt fits the smallest one is chosen', () => {
  assert.equal(chooseJpegAttempt([300, 150, 220], 100), 1)
  // Nulls do not win the "smallest" race.
  assert.equal(chooseJpegAttempt([null, 300, 150], 100), 2)
})

test('an attempt exactly equal to the limit fits', () => {
  assert.equal(chooseJpegAttempt([500, 200], 200), 1)
})

test('every JPEG attempt failing yields null', () => {
  assert.equal(chooseJpegAttempt([null, null, undefined], 200), null)
})

test('an empty JPEG ladder yields null', () => {
  assert.equal(chooseJpegAttempt([], 200), null)
  assert.equal(chooseJpegAttempt(undefined, 200), null)
})

test('confinement admits every tab when it is off', () => {
  assert.equal(isTabAllowed(42, 7, false), true)
  assert.equal(isTabAllowed(-1, 7, false), true)
})

test('confinement admits only the agent group when it is on', () => {
  assert.equal(isTabAllowed(7, 7, true), true)
  assert.equal(isTabAllowed(42, 7, true), false)
  // An ungrouped tab, and a session with no group yet, are both refused.
  assert.equal(isTabAllowed(-1, 7, true), false)
  assert.equal(isTabAllowed(7, null, true), false)
})

test('frame offsets sum up the chain', () => {
  const quad = x => [x, x + 1, 0, 0, 0, 0, 0, 0]
  assert.deepEqual(sumFrameOffsets([]), { x: 0, y: 0 })
  assert.deepEqual(sumFrameOffsets([quad(10), quad(100)]), { x: 110, y: 112 })
})

test('an unreadable offset refuses rather than guessing', () => {
  assert.equal(sumFrameOffsets([[1, 2, 3]]), null)
  assert.equal(sumFrameOffsets([null]), null)
})
