# Tab Targeting, Screenshot Budget and Frame Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's browser tools target its own tab instead of guessing, stop a large screenshot crossing the bridge unbounded, and let snapshots and refs reach inside iframes.

**Architecture:** The extension's browser-free logic is extracted into `extension/pure.js`, loaded by the classic service worker with `importScripts` and by the node test with `vm.runInThisContext`, so it can be tested without Chrome. Targeting, the screenshot guard and frame handling are then built on top of those helpers inside the existing command table. No new dependency, no build step, no protocol change.

**Tech Stack:** Chrome MV3 extension (classic service worker), CDP via `chrome.debugger`, TypeScript host plugin compiled by esbuild, `node --test` for hermetic tests, a stand-in WebSocket server for live tests.

**Spec:** `docs/superpowers/specs/2026-09-11-tab-targeting-screenshot-frames-design.md`

## Global Constraints

- Node >= 20; no new runtime or dev dependency may be added.
- `extension/pure.js` may not reference `chrome.*` or the DOM. It is loaded in two environments and only the second has them.
- The service worker stays **classic** (no `"type": "module"` in `manifest.json`); `importScripts` is the loader.
- `ref` stays an integer everywhere. A frame is named by a separate optional `frame` argument.
- Absent `frame`, or `'f0'`, means the main frame.
- `confineToAgentTabs` defaults to **false**.
- `SCREENSHOT_BASE64_LIMIT` is 2000000; the JPEG quality ladder is `[90, 75, 60, 45, 30]`; `FRAME_LIMIT` is 12.
- After editing anything under `extension/`, the extension must be **reloaded from chrome://extensions** before any live test.
- After editing `src/index.ts`, run `npm run install:profile` and **restart the DSH server** before the tools change.
- `npm test` is hermetic and is the automated gate. `node test/live-extension.mjs [port]` is the acceptance gate and requires the extension's options page pointed at that port; it is not part of `npm test`.
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/pure.js` (create) | Frame keys, flattening, JPEG ladder, confinement predicate, offset sum. Browser-free. |
| `extension/service-worker.js` (modify) | Loads `pure.js`; tab targeting; confinement; screenshot capture and guard; frame enumeration and ref resolution; find fan-out. |
| `extension/options.html`, `extension/options.js` (modify) | The `confineToAgentTabs` toggle. |
| `src/index.ts` (modify) | `tabId` descriptions, `frame` parameters, the `agent` flag, screenshot format to file extension. |
| `test/pure.test.mjs` (create) | Hermetic tests for `pure.js`. |
| `test/live-extension.mjs` (modify) | Live acceptance checks. |
| `README.md` (modify) | The new default, the setting, the SSH tunnel recipe. |

---

### Task 1: Extract the browser-free logic

**Files:**
- Create: `extension/pure.js`
- Create: `test/pure.test.mjs`
- Modify: `extension/service-worker.js:14` (the line after the file doc comment)

**Interfaces:**
- Consumes: nothing.
- Produces: `globalThis.DSH_PURE` with `FRAME_LIMIT`, `SCREENSHOT_BASE64_LIMIT`, `JPEG_QUALITIES`, `flattenFrameTree(frameTree, limit) -> { frames: Array<{key, frameId, parentKey, url}>, total: number }`, `normaliseFrameKey(value) -> string`, `nextJpegQuality(attempt) -> number|null`, `isTabAllowed(tabGroupId, agentGroupId, confine) -> boolean`, `sumFrameOffsets(quads) -> {x, y}|null`.

- [ ] **Step 1: Write the failing test**

Create `test/pure.test.mjs`:

```js
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
  isTabAllowed,
  sumFrameOffsets,
} = globalThis.DSH_PURE

/** A frame tree shaped like Page.getFrameTree's. */
function tree(...childLists) {
  const node = (id, children) => ({ frame: { id, url: 'https://x/' + id }, childFrames: children })
  return node('root', childLists.map((kids, i) => node('c' + i, kids)))
}

test('a frame tree flattens main-first with parent keys', () => {
  const flat = flattenFrameTree(tree(['g0', 'g1']), FRAME_LIMIT)
  assert.deepEqual(flat.frames.map(f => f.key), ['f0', 'f1', 'f2', 'f3'])
  assert.deepEqual(flat.frames.map(f => f.parentKey), [null, 'f0', 'f0', 'f1'])
  assert.equal(flat.total, 4)
})

test('flattening caps the list but still counts every frame', () => {
  const flat = flattenFrameTree(tree(['g0', 'g1']), 2)
  assert.equal(flat.frames.length, 2)
  assert.equal(flat.total, 4)
  // Keys are assigned before the cap, so a returned key always means the same frame.
  assert.deepEqual(flat.frames.map(f => f.key), ['f0', 'f1'])
})

test('flattening tolerates no tree and malformed nodes', () => {
  assert.deepEqual(flattenFrameTree(undefined, FRAME_LIMIT), { frames: [], total: 0 })
  assert.deepEqual(flattenFrameTree({ nope: true }, FRAME_LIMIT), { frames: [], total: 0 })
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pure.test.mjs`
Expected: FAIL — `Cannot find module .../extension/pure.js`

- [ ] **Step 3: Write the implementation**

Create `extension/pure.js`:

```js
/**
 * The parts of this extension that need no browser: frame keys, the screenshot
 * quality ladder, the tab-confinement predicate, and the frame offset sum.
 *
 * They live here rather than in the service worker so `npm test` can exercise
 * them without Chrome. The worker loads this file with importScripts (a classic
 * MV3 service worker, so that is allowed); the node test loads it with
 * vm.runInThisContext. One implementation, two loaders.
 *
 * Nothing here may touch `chrome.*` or the DOM.
 */
(function (root) {
  'use strict';

  /** How many frames a snapshot reads, main frame included. */
  var FRAME_LIMIT = 12;

  /** The base64 length above which a screenshot is re-captured as JPEG. */
  var SCREENSHOT_BASE64_LIMIT = 2000000;

  /** CDP's JPEG quality values (0-100), tried in order until the image fits. */
  var JPEG_QUALITIES = [90, 75, 60, 45, 30];

  /**
   * Flatten a CDP frame tree into the order a snapshot reads it.
   *
   * Keys are assigned before the cap is applied, so a key that was handed out
   * always means the same frame even when later frames go unread.
   *
   * @param frameTree - the `frameTree` member of Page.getFrameTree.
   * @param limit - the most frames to return.
   * @returns `{ frames, total }`; frames are `{ key, frameId, parentKey, url }`
   *   breadth-first with the main frame as `f0`, and total counts every frame.
   */
  function flattenFrameTree(frameTree, limit) {
    var max = typeof limit === 'number' && limit > 0 ? limit : FRAME_LIMIT;
    var frames = [];
    var total = 0;
    var queue = frameTree ? [{ node: frameTree, parentKey: null }] : [];
    while (queue.length > 0) {
      var entry = queue.shift();
      var node = entry.node;
      if (!node || !node.frame || typeof node.frame.id !== 'string') continue;
      var key = 'f' + total;
      total += 1;
      if (frames.length < max) {
        frames.push({
          key: key,
          frameId: node.frame.id,
          parentKey: entry.parentKey,
          url: typeof node.frame.url === 'string' ? node.frame.url : '',
        });
      }
      var children = Array.isArray(node.childFrames) ? node.childFrames : [];
      for (var i = 0; i < children.length; i += 1) {
        queue.push({ node: children[i], parentKey: key });
      }
    }
    return { frames: frames, total: total };
  }

  /**
   * Normalise a caller's frame argument.
   *
   * @returns '' for the main frame, otherwise the key.
   * @throws on anything malformed, because a silently ignored key would resolve
   *   a ref against the wrong document.
   */
  function normaliseFrameKey(value) {
    if (value === undefined || value === null || value === '' || value === 'f0') return '';
    if (typeof value !== 'string' || !/^f[1-9][0-9]*$/.test(value)) {
      throw new Error('frame must look like "f1" (as chrome_snapshot writes it), not '
        + JSON.stringify(value));
    }
    return value;
  }

  /**
   * The next JPEG quality to try.
   *
   * @param attempt - how many JPEG captures have already been made.
   * @returns the quality, or null when the ladder is exhausted.
   */
  function nextJpegQuality(attempt) {
    var index = typeof attempt === 'number' && isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    return index < JPEG_QUALITIES.length ? JPEG_QUALITIES[index] : null;
  }

  /**
   * Whether a tab may be acted on.
   *
   * @param tabGroupId - the tab's group, or -1 when it has none.
   * @param agentGroupId - the agent's group, or null when it has not made one.
   * @param confine - true when the user asked for confinement.
   */
  function isTabAllowed(tabGroupId, agentGroupId, confine) {
    if (confine !== true) return true;
    if (typeof agentGroupId !== 'number') return false;
    return tabGroupId === agentGroupId;
  }

  /**
   * Sum a frame chain's offsets.
   *
   * Each entry is a CDP box model's border quad — eight numbers, top-left first —
   * expressed in that frame's parent. Summing the chain moves a point from a
   * frame's own coordinates to the top-level ones a CDP mouse event needs.
   *
   * @returns the offset, or null when any quad is missing, so a caller refuses
   *   rather than clicks at a guessed position.
   */
  function sumFrameOffsets(quads) {
    if (!Array.isArray(quads)) return null;
    var x = 0;
    var y = 0;
    for (var i = 0; i < quads.length; i += 1) {
      var quad = quads[i];
      if (!Array.isArray(quad) || quad.length < 8) return null;
      if (typeof quad[0] !== 'number' || typeof quad[1] !== 'number') return null;
      x += quad[0];
      y += quad[1];
    }
    return { x: x, y: y };
  }

  root.DSH_PURE = {
    FRAME_LIMIT: FRAME_LIMIT,
    SCREENSHOT_BASE64_LIMIT: SCREENSHOT_BASE64_LIMIT,
    JPEG_QUALITIES: JPEG_QUALITIES,
    flattenFrameTree: flattenFrameTree,
    normaliseFrameKey: normaliseFrameKey,
    nextJpegQuality: nextJpegQuality,
    isTabAllowed: isTabAllowed,
    sumFrameOffsets: sumFrameOffsets,
  };
})(typeof self !== 'undefined' ? self : globalThis);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pure.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Load it from the service worker**

In `extension/service-worker.js`, immediately after the closing `*/` of the file doc comment on line 13, add:

```js
importScripts('pure.js');

/** The browser-free helpers, shared with the node test. */
const PURE = self.DSH_PURE;
const FRAME_LIMIT = PURE.FRAME_LIMIT;
const SCREENSHOT_BASE64_LIMIT = PURE.SCREENSHOT_BASE64_LIMIT;
const flattenFrameTree = PURE.flattenFrameTree;
const normaliseFrameKey = PURE.normaliseFrameKey;
const nextJpegQuality = PURE.nextJpegQuality;
const isTabAllowed = PURE.isTabAllowed;
const sumFrameOffsets = PURE.sumFrameOffsets;
```

- [ ] **Step 6: Verify the worker still parses and the whole suite is green**

Run: `node --check extension/service-worker.js && npm test`
Expected: no output from `--check`, and the node test summary reports 0 failures.

- [ ] **Step 7: Commit**

```bash
git add extension/pure.js extension/service-worker.js test/pure.test.mjs
git commit -m "refactor: extract the browser-free extension logic so it can be tested"
```

---

### Task 2: Target the agent's own tab instead of guessing

**Files:**
- Modify: `extension/service-worker.js` — `resolveTabId` (line 111), the `chrome.tabs.onRemoved` listener (line 247), `open` (line 803), and near line 19 for the new state
- Modify: `src/index.ts` — 16 identical `tabId` descriptions
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `readCurrentTabId() -> Promise<number|null>`, `rememberTab(tabId)`, `resolveTabId(tabId) -> Promise<number>`. Task 3 wraps the last of these.

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, after the existing tab checks that end around line 210, add:

```js
// Targeting: a command with no tabId must use the agent's own tab. The old
// fallback was "the active tab of the last focused window", which means a bare
// call could click whatever the user happened to be looking at.
console.log('tab targeting');
const userTab = await call('open', { url: 'https://example.com/?user=1', newTab: true });
const agentTab = await call('open', { url: 'https://example.com/?agent=1', newTab: true });
const implicit = await call('eval', { expression: 'location.search' });
check('a command without a tabId uses the agent tab it opened last',
  String(implicit.result).indexOf('agent=1') !== -1, implicit);

await call('close', { tabId: agentTab.tabId });
let noTabError = '';
try { await call('eval', { expression: 'location.search' }); } catch (error) { noTabError = String(error.message); }
check('with no agent tab left a bare command fails instead of using the user tab',
  /no tab yet/.test(noTabError), noTabError);

await call('close', { tabId: userTab.tabId });
```

- [ ] **Step 2: Run it to verify it fails**

Reload the extension from chrome://extensions, point its options port at the test port, then:
Run: `node test/live-extension.mjs 3099`
Expected: FAIL — the second check reports an empty error, because the old code silently read the user's active tab.

- [ ] **Step 3: Add the remembered-tab state**

In `extension/service-worker.js`, after the `attached` set (line 24), add:

```js
/** The tab the agent is working in, and whether storage has been read yet. */
let currentTabId = null;
let currentTabLoaded = false;
const CURRENT_TAB_KEY = 'currentTabId';
```

- [ ] **Step 4: Replace `resolveTabId` and add its helpers**

Replace lines 110-117 (the comment and `resolveTabId`) with:

```js
/**
 * The tab the agent is working in, read from session storage once per worker.
 *
 * Session storage rather than memory alone because Chrome evicts an idle
 * service worker, and losing the tab on every eviction would make every
 * follow-up call fail for no reason the caller can see.
 */
async function readCurrentTabId() {
  if (!currentTabLoaded) {
    currentTabLoaded = true;
    try {
      const stored = await chrome.storage.session.get(CURRENT_TAB_KEY);
      if (typeof stored[CURRENT_TAB_KEY] === 'number') currentTabId = stored[CURRENT_TAB_KEY];
    } catch (error) {
      // Session storage is best effort; memory alone still works this session.
    }
  }
  return currentTabId;
}

/** Record the tab the agent is working in, in memory and for the next worker. */
function rememberTab(tabId) {
  currentTabId = tabId;
  currentTabLoaded = true;
  chrome.storage.session.set({ [CURRENT_TAB_KEY]: tabId }).catch(() => {});
}

/**
 * Resolve the tab a command acts on: the named one, else the tab the agent is
 * already working in.
 *
 * There is deliberately no "the user's active tab" fallback. Guessing there
 * means a command sent without a tabId can act on whatever the user happens to
 * be looking at; failing loudly is the safe answer, and passing a tabId is how a
 * caller reaches a tab the agent did not open.
 */
async function resolveTabId(tabId) {
  if (typeof tabId === 'number') {
    rememberTab(tabId);
    return tabId;
  }
  const remembered = await readCurrentTabId();
  if (remembered === null) {
    throw new Error('no tab yet — call chrome_open first, or pass an explicit tabId');
  }
  return remembered;
}
```

- [ ] **Step 5: Record the tab on open, and forget it on close**

In the `open` command, replace:

```js
    if (typeof tabId !== 'number') throw new Error('could not determine the target tab');
    await waitForLoad(tabId, 20000);
```

with:

```js
    if (typeof tabId !== 'number') throw new Error('could not determine the target tab');
    rememberTab(tabId);
    await waitForLoad(tabId, 20000);
```

In the `chrome.tabs.onRemoved` listener (line 247), add inside the callback:

```js
  if (currentTabId === tabId) {
    currentTabId = null;
    currentTabLoaded = true;
    chrome.storage.session.remove(CURRENT_TAB_KEY).catch(() => {});
  }
```

- [ ] **Step 6: Correct the tool descriptions**

In `src/index.ts`, replace all 16 occurrences (find them with `grep -c 'Defaults to the active tab' src/index.ts`) of:

```
Target tab id from chrome_tabs. Defaults to the active tab.
```

with:

```
Target tab id from chrome_tabs. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.
```

and all occurrences of:

```
Target tab id. Defaults to the active tab.
```

with:

```
Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.
```

In `chrome_open`'s description, append: `Opening a tab also makes it the tab later calls act on by default.`

- [ ] **Step 7: Run the gates**

Run: `npx tsc --noEmit && npm test`
Expected: exit 0, 0 test failures.

- [ ] **Step 8: Run the live check to verify it passes**

Reload the extension from chrome://extensions, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — both `tab targeting` checks report PASS.

- [ ] **Step 9: Commit**

```bash
git add extension/service-worker.js src/index.ts test/live-extension.mjs
git commit -m "fix: target the agent's own tab instead of the user's active tab"
```

---

### Task 3: Confinement, and telling the agent's tabs from the user's

**Files:**
- Modify: `extension/service-worker.js` — a new `assertTabAllowed`, `resolveTabId`, `withGroup` (line 752)
- Modify: `extension/options.html`, `extension/options.js`
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: `resolveTabId`, `rememberTab` from Task 2; `isTabAllowed` from Task 1.
- Produces: `assertTabAllowed(tabId) -> Promise<void>`; `chrome_tabs` entries gain `agent: boolean`.

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, after the targeting block from Task 2:

```js
// The listing has to say which tabs are the agent's own; every targeting
// decision the model makes reads this flag.
const ownTab = await call('open', { url: 'https://example.com/?own=1', newTab: true });
const listing = await call('tabs');
const own = listing.filter(t => t.id === ownTab.tabId)[0];
const others = listing.filter(t => t.id !== ownTab.tabId);
check('a tab the agent opened is reported as its own', own && own.agent === true, own);
check('a tab the agent did not open is not', others.length > 0 && others.every(t => t.agent === false), others.slice(0, 3));
await call('close', { tabId: ownTab.tabId });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/live-extension.mjs 3099`
Expected: FAIL — `agent` is undefined on every entry.

- [ ] **Step 3: Add the confinement check**

In `extension/service-worker.js`, directly above `resolveTabId`, add:

```js
/**
 * Refuse a tab the agent is not allowed to touch.
 *
 * The setting is read per call rather than cached so that flipping it in the
 * options page takes effect on the next command, not the next worker.
 */
async function assertTabAllowed(tabId) {
  const stored = await chrome.storage.local.get({ confineToAgentTabs: false });
  if (stored.confineToAgentTabs !== true) return;
  let groupId = -1;
  try {
    const tab = await chrome.tabs.get(tabId);
    groupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
  } catch (error) {
    throw new Error('tab ' + tabId + ' is gone');
  }
  if (isTabAllowed(groupId, agentGroupId, true)) return;
  throw new Error('Tab ' + tabId + " is not in the agent's tab group for this session. "
    + 'Tools can only target tabs inside the group; call chrome_tabs to list the tabs the agent may use.');
}
```

Then in `resolveTabId`, add the check on both paths:

```js
async function resolveTabId(tabId) {
  if (typeof tabId === 'number') {
    await assertTabAllowed(tabId);
    rememberTab(tabId);
    return tabId;
  }
  const remembered = await readCurrentTabId();
  if (remembered === null) {
    throw new Error('no tab yet — call chrome_open first, or pass an explicit tabId');
  }
  await assertTabAllowed(remembered);
  return remembered;
}
```

- [ ] **Step 4: Mark the agent's tabs in the listing**

Replace `withGroup` (line 752) with:

```js
/** Add the agent group to a tab listing, and whether the agent may act on it. */
function withGroup(tab) {
  const groupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: tab.active === true,
    groupId: groupId,
    agent: agentGroupId !== null && groupId === agentGroupId,
  };
}
```

- [ ] **Step 5: Add the options toggle**

In `extension/options.html`, after the `<button id="save">` line (line 24), add:

```html
  <label for="confine" style="margin-top:16px"><input id="confine" type="checkbox" style="width:auto" /> Only work in the agent's own tabs</label>
  <p style="margin:0 0 16px">When this is on, a command may not touch a tab outside the group the agent opened. Your own tabs stay reachable while it is off.</p>
```

In `extension/options.js`, add below `const stateBox = ...`:

```js
const confineBox = document.getElementById('confine');
```

replace the storage read in `refresh`:

```js
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, confineToAgentTabs: false });
  portInput.value = String(stored.port || DEFAULT_PORT);
  confineBox.checked = stored.confineToAgentTabs === true;
```

and append at the end of the file:

```js
confineBox.addEventListener('change', async () => {
  await chrome.storage.local.set({ confineToAgentTabs: confineBox.checked });
  stateBox.textContent = confineBox.checked
    ? 'Confined: the agent may only use tabs in its own group.'
    : 'Not confined: the agent may use any tab you name.';
  stateBox.className = '';
});
```

- [ ] **Step 6: Verify parsing and the suite**

Run: `node --check extension/service-worker.js && node --check extension/options.js && npm test`
Expected: no output from the checks, 0 test failures.

- [ ] **Step 7: Run the live check to verify it passes**

Reload the extension, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — both `tabs` flag checks pass.

Then, by hand: open the options page, tick **Only work in the agent's own tabs**, and confirm `chrome_tabs` reports the agent's tab as `agent: true` while a bare command naming one of your tabs is refused with the group message. Untick it and confirm the refusal goes away.

- [ ] **Step 8: Commit**

```bash
git add extension/service-worker.js extension/options.html extension/options.js test/live-extension.mjs
git commit -m "feat: optional confinement to the agent's tab group"
```

---

### Task 4: Bound the screenshot payload

**Files:**
- Modify: `extension/service-worker.js:1077` (`screenshot`)
- Modify: `src/index.ts:313` (`captureScreenshot`)
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: `nextJpegQuality`, `SCREENSHOT_BASE64_LIMIT` from Task 1.
- Produces: the `screenshot` bridge command answers `{ base64, format }` where format is `'png'` or `'jpeg'`; `captureScreenshot` keeps its `{ path, bytes }` signature.

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, after the existing `screenshot` check:

```js
const shotInfo = await call('screenshot', { tabId: cap.tabId });
check('a screenshot reports the format it was encoded in',
  shotInfo.format === 'png' || shotInfo.format === 'jpeg', shotInfo.format);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/live-extension.mjs 3099`
Expected: FAIL — `format` is undefined.

- [ ] **Step 3: Replace the capture path**

In `extension/service-worker.js`, replace the body of `screenshot` (lines 1077-1105) with:

```js
  async screenshot(params) {
    const tabId = await resolveTabId(params.tabId);
    await ensureLive(tabId);
    // The model gets the page, not our pointer: hide the overlay, capture, then
    // put it back where the human last saw it.
    await hideCursor(tabId);
    // The style is committed, but the compositor still holds the previous frame
    // for a beat; capture would otherwise catch the overlay mid-flight.
    await new Promise(resolve => setTimeout(resolve, 60));
    const shot = await captureBounded(tabId);
    const last = cursorAt.get(tabId);
    if (last) await paintCursor(tabId, last.x, last.y);
    return shot;
  },
};```
```
// (the trailing `};` closes the COMMANDS table — keep whatever closes it today)
```

Then add these two helpers above `const COMMANDS`:

```js
/** One screenshot capture, taking the view only if a background one is refused. */
async function captureOnce(tabId, options) {
  const params = Object.assign({ fromSurface: true }, options);
  try {
    // A background tab is the normal case: the agent must not move the user's
    // view to see a page. Bounded, so a frozen renderer cannot hang the call.
    return await withTimeout(cdp(tabId, 'Page.captureScreenshot', params), 8000);
  } catch (error) {
    // Only when the background capture genuinely cannot be produced.
    await chrome.tabs.update(tabId, { active: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    return await cdp(tabId, 'Page.captureScreenshot', params);
  }
}

/**
 * Capture a page, re-encoding only when the first result is too big to send.
 *
 * PNG stays the default because it is lossless and most pages fit well inside
 * the limit. The ladder is a guard against the pathological full-page capture,
 * not a routine re-encode.
 */
async function captureBounded(tabId) {
  const png = await captureOnce(tabId, { format: 'png' });
  if (!png || typeof png.data !== 'string') throw new Error('the page returned no image data');
  if (png.data.length <= SCREENSHOT_BASE64_LIMIT) return { base64: png.data, format: 'png' };
  let smallest = null;
  for (let attempt = 0; ; attempt += 1) {
    const quality = nextJpegQuality(attempt);
    if (quality === null) break;
    const jpeg = await captureOnce(tabId, { format: 'jpeg', quality: quality });
    if (!jpeg || typeof jpeg.data !== 'string') continue;
    if (smallest === null || jpeg.data.length < smallest.length) smallest = jpeg.data;
    if (jpeg.data.length <= SCREENSHOT_BASE64_LIMIT) return { base64: jpeg.data, format: 'jpeg' };
  }
  if (smallest === null) throw new Error('the page returned no image data');
  return { base64: smallest, format: 'jpeg' };
}
```

Make sure `captureBounded` and `captureOnce` are defined **before** the `COMMANDS` object literal, and that the pre-existing duplicate comment block inside the old `screenshot` (the "Out of the way first" lines appear twice in `click`, not here) is not carried over.

- [ ] **Step 4: Follow the format into the filename**

In `src/index.ts`, replace the body of `captureScreenshot` (lines 317-325) with:

```ts
  const captured = await bridge.call<{ base64?: unknown; format?: unknown }>('screenshot', { tabId: args.tabId })
  const base64 = typeof captured?.base64 === 'string' ? captured.base64 : ''
  if (base64 === '') throw new Error('chrome-agent: the extension returned no image data')
  const bytes = Buffer.from(base64, 'base64')
  // The extension re-encodes an oversized capture as JPEG; writing JPEG bytes
  // into a .png would hand the reader a file that lies about itself.
  const extension = captured?.format === 'jpeg' ? '.jpg' : '.png'
  const path = typeof args.savePath === 'string' && args.savePath !== ''
    ? args.savePath
    : join(tmpdir(), 'dsh-chrome-' + randomUUID() + extension)
  await writeFile(path, bytes)
  return { path, bytes: bytes.byteLength }
```

Update the `chrome_screenshot` tool description to say the file is a PNG, or a JPEG when the capture is very large.

- [ ] **Step 5: Run the gates**

Run: `npx tsc --noEmit && node --check extension/service-worker.js && npm test`
Expected: exit 0, 0 failures.

- [ ] **Step 6: Run the live check to verify it passes**

Reload the extension, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — the format check reports `png` on the small fixture page.

- [ ] **Step 7: Commit**

```bash
git add extension/service-worker.js src/index.ts test/live-extension.mjs
git commit -m "feat: bound the screenshot payload and report its encoding"
```

---

### Task 5: Read every frame in a snapshot

**Files:**
- Modify: `extension/service-worker.js` — new `framesFor`, `frameContext`, `evaluateIn`; rewrite the `snapshot` command (line 818)
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: `flattenFrameTree`, `FRAME_LIMIT` from Task 1.
- Produces: `framesFor(tabId) -> Promise<{ frames: Array<{key, frameId, parentKey, url}>, total: number }>`, `frameContext(tabId, frameId) -> Promise<number>`, `evaluateIn(tabId, contextId, expression) -> Promise<unknown>`. Task 6 resolves refs through these.

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, in the fixture-install block (around line 276, where `install` is evaluated), extend the fixture by appending before the `install` string's closing:

```js
  'var frame = document.createElement("iframe");',
  'frame.id = "probe-frame";',
  'frame.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";',
  'frame.srcdoc = "<button id=\"inner-btn\" style=\"width:200px;height:60px\">inner target</button>";',
  'document.body.appendChild(frame);',
```

then after the existing snapshot checks:

```js
// Content inside a frame is invisible to a main-frame-only snapshot.
await new Promise(r => setTimeout(r, 600));
const framed = await call('snapshot', { tabId: cap.tabId });
check('a snapshot reports a ref from inside an iframe',
  /frame=f\d+\]/.test(framed.snapshot), framed.snapshot.slice(0, 400));
check('a snapshot still reports main-frame refs unchanged',
  /\[ref=\d+\] (?!.*frame=)/.test(framed.snapshot), framed.snapshot.slice(0, 200));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/live-extension.mjs 3099`
Expected: FAIL — no `frame=` appears; the iframe is not read.

- [ ] **Step 3: Add the frame helpers**

In `extension/service-worker.js`, above `const COMMANDS`:

```js
/** Every frame a snapshot should read, main frame first. */
async function framesFor(tabId) {
  const tree = await cdp(tabId, 'Page.getFrameTree', {});
  const flat = flattenFrameTree(tree && tree.frameTree, FRAME_LIMIT);
  if (flat.frames.length === 0) throw new Error('the page reported no frames');
  return flat;
}

/**
 * An execution context inside one frame.
 *
 * An isolated world rather than the page's own context: the page cannot see or
 * redefine anything in it, so a page that shadows a global cannot break the
 * walk. CDP is not subject to the same-origin policy, so this works in
 * cross-origin frames too.
 */
async function frameContext(tabId, frameId) {
  const created = await cdp(tabId, 'Page.createIsolatedWorld', {
    frameId: frameId,
    worldName: 'dsh-agent-snapshot',
  });
  if (!created || typeof created.executionContextId !== 'number') {
    throw new Error('could not open an execution context in frame ' + frameId);
  }
  return created.executionContextId;
}

/** Evaluate an expression in one frame's isolated world. */
async function evaluateIn(tabId, contextId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    contextId: contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const thrown = details.exception && (details.exception.description || details.exception.value);
    throw new Error('page error: ' + String(thrown || details.text || 'unknown'));
  }
  return result && result.result ? result.result.value : undefined;
}
```

- [ ] **Step 4: Rewrite the snapshot command**

Replace the `snapshot` command (lines 818-828) with:

```js
  async snapshot(params) {
    const tabId = await resolveTabId(params.tabId);
    const flat = await framesFor(tabId);
    const lines = [];
    const frameText = [];
    let url = '';
    let title = '';
    let text = '';
    for (let index = 0; index < flat.frames.length; index += 1) {
      const frame = flat.frames[index];
      const contextId = await frameContext(tabId, frame.frameId);
      const raw = await evaluateIn(tabId, contextId, SNAPSHOT_EXPRESSION);
      if (typeof raw !== 'string') continue;
      const parsed = JSON.parse(raw);
      const isMain = frame.key === 'f0';
      if (isMain) {
        url = parsed.url;
        title = parsed.title;
        text = parsed.text;
      } else if (parsed.text !== '') {
        frameText.push('[' + frame.key + '] ' + String(parsed.text).slice(0, 400));
      }
      const tree = String(parsed.tree);
      if (tree === '') continue;
      const rows = tree.split('\n');
      for (let row = 0; row < rows.length; row += 1) {
        if (rows[row] === '') continue;
        // A ref is an index into one document's array, so the document travels
        // with it. The main frame stays unmarked, which keeps every existing
        // ref in every existing prompt valid.
        lines.push(isMain
          ? rows[row]
          : rows[row].replace(/^\[ref=(\d+)\]/, '[ref=$1 frame=' + frame.key + ']'));
      }
    }
    const skipped = flat.total - flat.frames.length;
    const tree = lines.length === 0 ? '(no interactive elements found)' : lines.join('\n');
    const suffix = skipped > 0 ? '\n\n… ' + skipped + ' further frame(s) not read' : '';
    const allText = frameText.length === 0 ? text : text + '\n' + frameText.join('\n');
    return {
      url: url,
      title: title,
      snapshot: tree + suffix + '\n\n--- visible text ---\n' + allText,
    };
  },
```

- [ ] **Step 5: Verify parsing and the suite**

Run: `node --check extension/service-worker.js && npm test`
Expected: no output from `--check`, 0 failures.

- [ ] **Step 6: Run the live check to verify it passes**

Reload the extension, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — the snapshot reports a `frame=fN` ref and still reports unmarked main-frame refs.

- [ ] **Step 7: Commit**

```bash
git add extension/service-worker.js test/live-extension.mjs
git commit -m "feat: read iframe content in snapshots"
```

---

### Task 6: Resolve refs inside a frame

**Files:**
- Modify: `extension/service-worker.js` — new `resolvePoint`, `frameOffsetFor`; `pointExpressionFor` (line 456); the `click`, `hover`, `type`, `scroll`, `upload` and `drag` commands
- Modify: `src/index.ts` — the `frame` parameters
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: `framesFor`, `frameContext`, `evaluateIn` from Task 5; `normaliseFrameKey`, `sumFrameOffsets` from Task 1.
- Produces: `frameFor(tabId, frameKey) -> Promise<{frame, frames}>`, `evaluateInFrame(tabId, frameKey, expression) -> Promise<unknown>`, `frameOffsetFor(tabId, frames, frameKey) -> Promise<{x, y}>`, `resolvePoint(tabId, params, prefix) -> Promise<{x, y, label}|null>`, and `evaluateHandle(tabId, contextId, expression)` (its signature gains the context).

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, after the frame snapshot checks:

```js
// A ref inside a frame resolves in that frame's coordinates, which are not the
// page's. Clicking must apply the frame's offset.
const innerRef = /\[ref=(\d+) frame=(f\d+)\]/.exec(framed.snapshot);
if (innerRef) {
  await call('eval', { tabId: cap.tabId, expression: 'window.__hit = false; document.querySelector("#probe-frame").contentWindow.document.getElementById("inner-btn").addEventListener("click", function () { window.__hit = true; })' });
  await call('click', { ref: Number(innerRef[1]), frame: innerRef[2], tabId: cap.tabId });
  const hit = await call('eval', { tabId: cap.tabId, expression: 'String(document.querySelector("#probe-frame").contentWindow.__hit === true || window.__hit === true)' });
  check('a ref from a frame clicks the element inside it', String(hit.result) === 'true', hit);
} else {
  check('a ref from a frame clicks the element inside it', false, framed.snapshot.slice(0, 300));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/live-extension.mjs 3099`
Expected: FAIL — the click either finds no element or lands on the wrong point.

- [ ] **Step 3: Add the point resolver and the offset walk**

In `extension/service-worker.js`, below `pointExpression`, add:

```js
/**
 * Sum the offsets of a frame and every frame between it and the top.
 *
 * DOM.getFrameOwner names the element a frame is loaded in, and DOM.getBoxModel
 * gives that element's box in its own parent, so walking up the chain turns a
 * frame's local point into the top-level one a CDP mouse event needs.
 *
 * @returns the offset, or throws: a wrong click is worse than a refused one.
 */
async function frameOffsetFor(tabId, frames, frameKey) {
  const byKey = {};
  for (let i = 0; i < frames.length; i += 1) byKey[frames[i].key] = frames[i];
  const quads = [];
  let current = byKey[frameKey];
  while (current && current.parentKey) {
    let owner = null;
    try {
      owner = await cdp(tabId, 'DOM.getFrameOwner', { frameId: current.frameId });
    } catch (error) {
      owner = null;
    }
    let box = null;
    if (owner && typeof owner.backendNodeId === 'number') {
      try {
        box = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
      } catch (error) {
        box = null;
      }
    }
    const border = box && box.model ? box.model.border : null;
    if (!Array.isArray(border)) {
      throw new Error('cannot place frame ' + current.key + ' on the page (its container has no box), '
        + 'so a click would land in the wrong place — pass x and y explicitly instead');
    }
    quads.push(border);
    current = byKey[current.parentKey];
  }
  const sum = sumFrameOffsets(quads);
  if (sum === null) {
    throw new Error('cannot place frame ' + frameKey + ' on the page, so a click would land in the '
      + 'wrong place — pass x and y explicitly instead');
  }
  return sum;
}

/** One frame, by its key; the empty key means the main frame. */
async function frameFor(tabId, frameKey) {
  const flat = await framesFor(tabId);
  const wanted = frameKey === '' ? 'f0' : frameKey;
  for (let i = 0; i < flat.frames.length; i += 1) {
    if (flat.frames[i].key === wanted) return { frame: flat.frames[i], frames: flat.frames };
  }
  throw new Error('no frame ' + wanted + ' on this page — take a fresh chrome_snapshot');
}

/** Evaluate an expression inside the named frame; the empty key is the main frame. */
async function evaluateInFrame(tabId, frameKey, expression) {
  const found = await frameFor(tabId, frameKey);
  const contextId = await frameContext(tabId, found.frame.frameId);
  return evaluateIn(tabId, contextId, expression);
}

/**
 * Resolve a click, hover, type, scroll or upload target to top-level viewport
 * coordinates.
 *
 * @param params - the command's arguments.
 * @param prefix - '', 'from' or 'to', naming the argument group.
 * @returns the point, or null when the target does not exist.
 */
async function resolvePoint(tabId, params, prefix) {
  const frameKey = normaliseFrameKey(params[prefix === '' ? 'frame' : prefix + 'Frame']);
  const found = await frameFor(tabId, frameKey);
  const contextId = await frameContext(tabId, found.frame.frameId);
  const point = await evaluateIn(tabId, contextId, pointExpressionFor(params, prefix));
  if (!point) return null;
  if (frameKey === '') return point;
  const offset = await frameOffsetFor(tabId, found.frames, frameKey);
  return { x: point.x + offset.x, y: point.y + offset.y, label: point.label };
}
```

- [ ] **Step 4: Route the commands through it**

In `click`, replace:

```js
      const point = await evaluate(tabId, pointExpression(params));
```

with:

```js
      const point = await resolvePoint(tabId, params, '');
```

In `hover`, replace:

```js
    const point = await evaluate(tabId, pointExpression(params));
```

with:

```js
    const point = await resolvePoint(tabId, params, '');
```

In `drag`, replace:

```js
    const start = await evaluate(tabId, pointExpressionFor(params, 'from'));
    const end = await evaluate(tabId, pointExpressionFor(params, 'to'));
```

with:

```js
    const start = await resolvePoint(tabId, params, 'from');
    const end = await resolvePoint(tabId, params, 'to');
```

In `type`, replace:

```js
      const focused = await evaluate(tabId, focusExpression(params));
```

with:

```js
      const focused = await evaluateInFrame(tabId, normaliseFrameKey(params.frame), focusExpression(params));
```

In `scroll`'s target branch, replace:

```js
      const moved = await evaluate(tabId, scrollToExpression(params));
```

with:

```js
      const moved = await evaluateInFrame(tabId, normaliseFrameKey(params.frame), scrollToExpression(params));
```

In `upload`, `DOM.setFileInputFiles` addresses an element by object handle, so this
one needs the context rather than a value. Replace:

```js
    const objectId = await evaluateHandle(tabId, uploadTargetExpression(params));
```

with:

```js
    const uploadFrame = await frameFor(tabId, normaliseFrameKey(params.frame));
    const uploadContext = await frameContext(tabId, uploadFrame.frame.frameId);
    const objectId = await evaluateHandle(tabId, uploadContext, uploadTargetExpression(params));
```

and give `evaluateHandle` the context it now needs — it currently takes
`(tabId, expression)` at line 309:

```js
async function evaluateHandle(tabId, contextId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    contextId: contextId,
    returnByValue: false,
    awaitPromise: true,
    userGesture: true,
  });
```

leaving the rest of that function as it is.

- [ ] **Step 5: Declare the parameter on the host tools**

In `src/index.ts`, add to the `parameters` of `chrome_click`, `chrome_hover`, `chrome_type`, `chrome_scroll` and `chrome_upload`:

```ts
    frame: {
      type: 'string',
      description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
    },
```

and to `chrome_drag`:

```ts
    fromFrame: {
      type: 'string',
      description: 'Frame the fromRef belongs to, as chrome_snapshot writes it. Omit for the main page.',
    },
    toFrame: {
      type: 'string',
      description: 'Frame the toRef belongs to, as chrome_snapshot writes it. Omit for the main page.',
    },
```

- [ ] **Step 6: Run the gates**

Run: `npx tsc --noEmit && node --check extension/service-worker.js && npm test`
Expected: exit 0, 0 failures.

- [ ] **Step 7: Run the live check to verify it passes**

Reload the extension, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — the in-frame click is reported as hitting the element.

- [ ] **Step 8: Commit**

```bash
git add extension/service-worker.js src/index.ts test/live-extension.mjs
git commit -m "feat: resolve refs inside frames, with the frame offset applied"
```

---

### Task 7: Search every frame

**Files:**
- Modify: `extension/service-worker.js` — the `find` command (line 927)
- Modify: `test/live-extension.mjs`

**Interfaces:**
- Consumes: `framesFor`, `frameContext`, `evaluateIn` from Task 5.
- Produces: `chrome_find` counts and quotes matches from every frame, labelling child-frame quotes with `[fN]`.

- [ ] **Step 1: Write the failing live check**

In `test/live-extension.mjs`, after the frame click check:

```js
// page_text is deliberately main-frame only: its job is reading the article,
// and frame text is usually widget noise. Assert the decision, not just intend it.
const mainOnly = await call('pageText', { tabId: cap.tabId });
check('page_text stays on the main page by decision',
  String(mainOnly.text).indexOf('inner target') === -1, String(mainOnly.text).slice(0, 200));

const framedFind = await call('find', { text: 'inner target', tabId: cap.tabId });
check('find reaches text that only exists inside a frame',
  framedFind.count > 0, framedFind);
check('a match from a frame says which frame it came from',
  framedFind.matches.some(m => /^\[f\d+\]/.test(m)), framedFind.matches);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/live-extension.mjs 3099`
Expected: FAIL — count is 0.

- [ ] **Step 3: Fan the command out**

Replace the `find` command with:

```js
  async find(params) {
    const tabId = await resolveTabId(params.tabId);
    const needle = typeof params.text === 'string' ? params.text : '';
    if (needle === '') throw new Error('find needs some text to look for');
    const flat = await framesFor(tabId);
    const matches = [];
    let count = 0;
    for (let index = 0; index < flat.frames.length; index += 1) {
      const frame = flat.frames[index];
      const contextId = await frameContext(tabId, frame.frameId);
      const raw = await evaluateIn(tabId, contextId, findExpression(needle));
      if (typeof raw !== 'string') continue;
      const parsed = JSON.parse(raw);
      count += Number(parsed.count) || 0;
      const isMain = frame.key === 'f0';
      const found = Array.isArray(parsed.matches) ? parsed.matches : [];
      for (let m = 0; m < found.length && matches.length < 20; m += 1) {
        matches.push(isMain ? found[m] : '[' + frame.key + '] ' + found[m]);
      }
    }
    return { count: count, matches: matches };
  },
```

- [ ] **Step 4: Run the gates**

Run: `node --check extension/service-worker.js && npm test`
Expected: no output from `--check`, 0 failures.

- [ ] **Step 5: Run the live check to verify it passes**

Reload the extension, then:
Run: `node test/live-extension.mjs 3099`
Expected: PASS — the frame find count is above zero and a match is labelled with its frame.

- [ ] **Step 6: Commit**

```bash
git add extension/service-worker.js test/live-extension.mjs
git commit -m "feat: search iframe content in chrome_find"
```

---

### Task 8: Document the new default and the remote path

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Read the current README**

Run: `cat README.md`
Note its existing structure so the additions match it.

- [ ] **Step 2: Document targeting**

Add a section stating, in the README's own voice:

- Commands act on the tab the agent is working in — the last one it opened or was given. There is no "whichever tab you are looking at" default.
- To let the agent work on a tab **you** opened, name it: the model passes that tab's id, or you point it at one with `chrome_tabs`.
- The options page's **Only work in the agent's own tabs** switch confines every command to the group the agent opened, and is off by default. When it is on, a command naming one of your tabs is refused.

- [ ] **Step 3: Document frames**

Add a short paragraph: snapshots read iframes as well as the page; a ref from inside a frame is written `[ref=7 frame=f1]` and must be passed back with `frame: "f1"`; `chrome_page_text` stays main-page only; at most 12 frames are read.

- [ ] **Step 4: Document the screenshot format**

Note that `chrome_screenshot` writes a PNG, or a JPEG when the capture is large enough to need re-encoding, and that the extension reports which.

- [ ] **Step 5: Document remote access**

Add a section explaining that the bridge listens on the loopback interface only, and that the pinned-origin check is the authentication precisely because the socket is not reachable from elsewhere. Give the SSH tunnel recipe for reaching a browser on another machine:

```bash
ssh -N -L 3080:127.0.0.1:3080 user@the-other-machine
```

and note that DSH, the extension and its options port all then live on the same machine as before.

- [ ] **Step 6: Verify the README renders and the suite is still green**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: tab targeting, frames, screenshot format and the tunnel recipe"
```

---

## Final verification

Run every gate once, in order, on the finished branch:

```bash
npx tsc --noEmit                       # exit 0
node --check extension/service-worker.js
node --check extension/options.js
node --check extension/pure.js
npm test                               # 0 failures, including the new pure tests
npm run install:profile                # repack and install into the web profile
```

Then reload the extension, restart the DSH server, point the extension's options port at the test port, and run:

```bash
node test/live-extension.mjs 3099
```

Expected: every check PASS, including the new targeting, agent-flag, format, frame-ref, in-frame-click and in-frame-find checks. Point the options port back at 3080 afterwards.

Finally, by hand: confirm the confinement toggle refuses one of your own tabs when on and admits it when off.
