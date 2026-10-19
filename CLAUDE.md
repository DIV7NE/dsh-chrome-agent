# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A DeepSeek Harness (DSH) plugin that lets the DSH agent drive the user's real, logged-in Chrome. It has two halves that talk over one WebSocket:

- **Host half** (`src/index.ts`, bundled to `lib/index.js`): a DSH plugin that claims the `/chrome-agent/bridge` upgrade route on DSH's web server, registers the `chrome_*` model tools via `defineTool` from `@deepseek-ai/dsh-tools`, and forwards each call to the extension.
- **Extension half** (`extension/`): a plain-JS MV3 extension. `service-worker.js` dials `ws://127.0.0.1:<port>/chrome-agent/bridge` (port from the options page, default 3080) and executes commands through `chrome.debugger` (CDP). It has **no build step**; Chrome loads `extension/` as it sits on disk.

README.md explains the design rationale (why not a second profile or a debugging port) and the user-facing behaviour in detail. Its tool table lists only some of the tools; the `name: 'chrome_…'` entries in `src/index.ts` are the full list.

## Commands

```sh
npm run build        # esbuild src/index.ts -> lib/index.js (ws and dsh-tools stay external)
npm run typecheck    # tsc --noEmit over src/ and scripts/
npm test             # builds first (pretest), then node --test test/*.test.mjs + test/probe-eval-contract.mjs
node --test test/pure.test.mjs                          # one test file
node --test --test-name-pattern "<regex>" test/pure.test.mjs   # one test
npm run install:profile [profile]   # build, npm pack, `dsh plugin --profile <web> add` the tarball
npm run pack:webstore               # zip extension/ into dsh-chrome-agent-webstore.zip
```

`test/bridge.test.mjs` imports `../lib/index.js`, so run `npm run build` before running it directly. The `*.tgz` and `*.zip` files in the root are build outputs (gitignored).

After host changes, `npm run install:profile` and then **restart the DSH server** (the bundle stack is composed at boot). After extension changes, click **Reload** on the extension in `chrome://extensions`. `--load-extension` no longer works, so nothing can launch a Chrome with the extension for you.

### Hermetic vs live tests

- Hermetic (no Chrome): `test/*.test.mjs` and `test/probe-eval-contract.mjs`. These are what `npm test` runs.
- Live: `test/live-extension.mjs [port]` and most `test/probe-*.mjs` start a stand-in bridge server on port 3099 and need a real Chrome with the extension loaded unpacked and its options-page port set to 3099 (set it back afterwards). The probes are kept as debugging evidence for specific past bugs; they are not a suite. `probe-background-input.mjs` and `probe-capture-variants.mjs` also need a throwaway raw-CDP `probe` command added to `COMMANDS` (described in their headers), which must not be committed.
- `test/probe-worker.mjs <repoRoot>` validates the manifest key and loads the service worker against a stubbed `chrome` global.
- On the maintainer's machine the DSH web server runs on port **19387**, and the extension's options-page port stays at 19387; don't ask for it to be changed. Run live tests on 19387 while the DSH server is stopped (`node test/live-extension.mjs 19387`). The other probes hardcode 3099 and need their `PORT` edited to match.

## Architecture and cross-file invariants

**Wire protocol.** Host sends `{t:'command', id, method, params}`; extension replies `{t:'result', id, ok, value | error}` and opens with `{t:'hello', protocol, version}`. One socket is the whole state: a new connection replaces the old one (`Bridge.attach`). Calls time out after 30s on the host side.

**Tool name to command name.** Each `chrome_foo_bar` tool calls the extension command `fooBar` in the `COMMANDS` object in `service-worker.js`. `resolveBatchStep` derives this mapping rather than tabulating it, so a new tool must follow the convention. Adding a tool means: a `defineTool` in `registerTools`, a `COMMANDS` entry, and an entry in `BATCHABLE_TOOLS` if it may run inside `chrome_batch`.

**Origin fence (security-critical).** The upgrade handler accepts only `Origin: chrome-extension://<id>`, where the id is derived (`deriveExtensionId`) from `EXTENSION_KEY` in `src/index.ts`. That constant must stay byte-identical to `"key"` in `extension/manifest.json`; changing either alone locks the extension out. The socket listens on loopback only, and that plus the Origin check is the whole authentication.

**`extension/pure.js`.** Browser-free logic (frame tree flattening and keys, screenshot JPEG quality ladder, tab-confinement predicate, viewport/frame-offset math) lives here so node can test it. The worker loads it with `importScripts`, the test with `vm.runInThisContext`, and it exports through `globalThis.DSH_PURE`. It must not touch `chrome.*` or the DOM. Put new testable logic here rather than in the worker.

**Eval wrapper copy.** `test/probe-eval-contract.mjs` contains a byte-for-byte copy of the `eval` command's wrapper from `service-worker.js`. If that wrapper changes, update the copy or the probe stops proving anything.

**Tab targeting.** A command without `tabId` acts on the agent's current tab (last opened or given), persisted in `chrome.storage.session` so it survives service-worker eviction. There is deliberately no fallback to the user's active tab; with no current tab the command fails. Agent-opened tabs are created inactive in a "DSH Chrome Agent" tab group. The options-page `confineToAgentTabs` switch (off by default) restricts commands to that group.

**Input reaches background tabs; nothing may move the user's view.** Chrome drops input to a tab it isn't rendering. `ensureAttached` turns on `Emulation.setFocusEmulationEnabled`, which makes Chrome render the tab wherever it is, and every input command calls `ensureInputReady` first. That function refuses a tab still reporting hidden; it never activates the tab or focuses its window. No command may call `chrome.tabs.update({active})` or `chrome.windows.update({focused})`. Two side effects: the first wheel after attaching is held until the next frame, which is why `scroll` follows the wheel with a mouse move and never re-sends. And `Page.captureScreenshot` hangs intermittently on background tabs, which is why `captureOnce` uses the first screencast frame. README "How input reaches a background tab" has the measurements; `test/probe-*.mjs` are the probes behind them.

**Refs and frames.** `chrome_snapshot` numbers interactive elements `[ref=N]`, valid only until the next snapshot. Refs inside iframes carry a frame key (`f1`, …; main frame is `f0`) that must be passed back as `frame`. At most `FRAME_LIMIT` (12) frames are read. Frame-ref clicks convert from frame document space to top-viewport coordinates via `sumFrameOffsets`/`framePointToViewport` and are refused when out of viewport.

**Keepalive.** The open WebSocket keeps the MV3 worker alive (Chrome 116+); a 30s `chrome.alarms` alarm reconnects after eviction, with exponential backoff capped at 30s.

## Conventions

- Comments are JSDoc-style and explain *why* (Chrome behaviour, measured numbers, constraints), not what. Tool `description` strings are model-facing and state behaviour the model must know (e.g. "works on a background tab without moving the user's view").
- Host TypeScript: no semicolons, single quotes. Extension JS: semicolons, no build-time syntax beyond what Chrome runs natively.
- Larger features go through a spec and plan in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
