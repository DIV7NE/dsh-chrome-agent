# Tab targeting, screenshot budget and frame coverage

**Date:** 2026-09-11
**Status:** approved design, not yet implemented
**Scope:** pass 1 of 2. Pass 2 (the seven missing tools and the wider permission
surface) is deliberately excluded and listed at the end.

## Problem

Three defects in the existing 21 tools, found by reading the installed Claude in
Chrome extension (v1.0.91, `fcoeoabgfenejglbffodgkkbkcdhcgfn`) and comparing it
against this one.

1. **Implicit tab targeting is unsafe.** `resolveTabId`
   (`extension/service-worker.js:111`) falls back to
   `chrome.tabs.query({ active: true, lastFocusedWindow: true })`, so any command
   sent without a `tabId` acts on **whatever tab the user is currently looking
   at**. `chrome_click { ref: 7 }` can click in the user's bank tab.
2. **A full-page screenshot can be a multi-megabyte frame.** The capture is
   unconditional PNG and crosses the bridge as base64 with no size guard.
3. **Frames are invisible.** `snapshot`, `find` and every ref resolution run in
   the main frame's execution context only, so any page whose content lives in an
   `iframe` reads as empty.

## Scope

**In:** tab targeting (A), screenshot budget (B), frame coverage (C), and a
documented remote-access path (D).

**Out:** the consent/permission layer (excluded by explicit decision); the seven
missing tools (`form_input`, `gif_creator`, `shortcuts_list`,
`shortcuts_execute`, `update_plan`, `file_upload`, browser switching); the
wider manifest permission surface; a hosted relay.

---

## A — Tab targeting

### Contract

`resolveTabId(tabId)` becomes:

| Input | Behaviour |
|---|---|
| a number | use it; record it as the current tab; the confinement check below still applies |
| absent, and a current tab is recorded | use the recorded tab |
| absent, and none is recorded | throw `no tab yet — call chrome_open first, or pass an explicit tabId` |

The `lastFocusedWindow` active-tab fallback is **deleted**. Guessing is replaced
by either explicit intent or a recorded one.

### State

`currentTabId` is written by:

- `chrome_open` on both paths (the `newTab` path and the existing-tab path);
- every command that receives an explicit numeric `tabId`.

It is persisted in `chrome.storage.session` so a service-worker restart does not
lose it, and it is cleared by the existing `chrome.tabs.onRemoved` listener
(`service-worker.js:247`, which already clears `attached`, `cursorAt`,
`consoleByTab` and `networkByTab`).

### Confinement

A new boolean setting `confineToAgentTabs`, stored in `chrome.storage.local`,
**default `false`**, toggled from the options page.

When it is on, a `tabId` whose `chrome.tabs.get` result has
`groupId !== agentGroupId` is refused with:

> Tab N is not in the agent's tab group for this session. Tools can only target
> tabs inside the group; call chrome_tabs to list the tabs the agent may use.

### Deviation from Claude, stated deliberately

Claude confines unconditionally: every tool refuses a tab outside its own group.
This plugin exists to drive the tabs the user is **already signed in to**, so
unconditional confinement would defeat its purpose. We keep the capability and
remove the accident: the default target is the agent's own tab, and reaching the
user's tabs requires naming one. `confineToAgentTabs` restores Claude's
guarantee for anyone who wants it.

### Tool-facing changes

- The `tabId` description on every tool that has one changes from *"Defaults to
  the active tab"* to *"Defaults to the tab the agent is working in — the last one
  it opened or was given. Pass an explicit id to work on another tab."*
- `chrome_tabs` entries gain `agent: true|false`, true when the tab is in the
  agent's group, so the model can tell its own tabs from the user's.
- `chrome_open`'s description states that it also sets the current tab.

---

## B — Screenshot budget

### Why this is smaller than it first appeared

`chrome_screenshot` returns `{ path, bytes }` to the model, not pixels: the model
receives a **file path** and must call `read_image`, which the harness downscales
before anything reaches the model. Claude's `MAX_BASE64_CHARS = 1398100` JPEG
budget governs a different budget from ours, so matching it would be parity on
paper only. The real cost here is a large base64 frame crossing the loopback
socket.

### Change

One guard, in the extension's `screenshot` command (`service-worker.js:1077`):

1. Capture PNG as today. If `data.length` is at most
   `SCREENSHOT_BASE64_LIMIT = 2_000_000`, return it.
2. Otherwise re-capture as JPEG, stepping CDP's `quality` parameter (0–100)
   through `90, 75, 60, 45, 30`, and return the first result that fits.
3. If none fits, return the smallest produced.
4. The command returns `{ base64, format }` where `format` is `'png'` or
   `'jpeg'`.

The host's `captureScreenshot` (`src/index.ts:313`) uses `format` to pick the
file extension. Today the default path is always `.png`; it becomes `.png` or
`.jpg` to match the bytes actually written. An explicit `savePath` is still
honoured verbatim, because the caller asked for that exact path.

---

## C — Frame coverage

### Enumeration

`Page.getFrameTree` walks the frame tree. Each frame (main frame included) gets an
execution context from `Page.createIsolatedWorld({ frameId, worldName:
'dsh-agent-snapshot' })`, and the existing snapshot expression is evaluated there
with `Runtime.evaluate({ expression, contextId, returnByValue: true })`. An
isolated world is used rather than the page's own context so a page that redefines
globals cannot break the walk, and CDP is not subject to same-origin, so
cross-origin frames work.

At most **12 frames** are read; the rest are reported as
`… N further frames not read`.

### Ref encoding

Frames are keyed `f0` (main), `f1`, `f2`… in tree order. A ref from a child frame
is written `f1:7`.

- **A bare integer ref still means the main frame.** Existing snapshots, prompts
  and tests keep working.
- Ref resolution takes the frame key into account, so a ref drawn from a frame is
  resolved in that frame's context.

### Clicking a ref that lives inside a frame

This is the part that must not be got wrong, and it is not free.

`getBoundingClientRect` inside a frame is relative to **that frame's** viewport,
not the top-level page, and CDP mouse events take top-level viewport coordinates.
A ref from a frame therefore needs its offset accumulated up the tree: for each
ancestor frame, `DOM.getFrameOwner({ frameId })` gives the frame's element, and
`DOM.getBoxModel` gives that element's box in its own parent. Summing the chain
yields the offset the click needs. `DOM.enable` is already on
(`ensureAttached`, `service-worker.js:126`).

If any offset in the chain cannot be determined (the frame's owner element is
`display: none`, or an ancestor has no box model), the command **fails with a
named error rather than clicking at a guessed position**. Clicking the wrong place
is worse than not clicking.

### find fan-out

`chrome_find` runs in every frame context and merges the results; matches from a
child frame are labelled with their frame key. Nobody hunts for text and wants it
only if it happens to be in the main document.

`chrome_page_text` **stays main-frame only** by decision: its job is reading the
article, and frame text is usually widget and banner noise.

### Caps

Frame count is capped at 12. The snapshot's existing text budget is unchanged.
Nested frames are read in tree order, so the cap degrades predictably.

---

## D — Remote access (documentation only)

No relay is built. The bridge stays bound to `127.0.0.1` and the pinned
`Origin` check remains the only authentication, which is only sound because the
socket is unreachable from anywhere else. Reaching a browser on another machine is
an SSH tunnel, documented in `README.md` as a short recipe.

---

## The interface pass 2 is written against

Pass 2 adds seven tools. Each of them calls `resolveTabId`, so this pass
establishes, once:

1. a command with no `tabId` targets the recorded tab or fails loudly — never a
   guess;
2. a command with a `tabId` respects `confineToAgentTabs`;
3. a command that reads the page reads every frame it should.

## Testing

**Hermetic** (`npm test`, no browser). The pure helpers move to
`extension/pure.js`, loaded by the classic service worker with `importScripts`
(permitted in MV3 service workers that are not modules) and by the node test
directly, so there is one implementation and no `chrome.*` dependency:

- `encodeRef` / `parseRef`: bare `7` is the main frame; `f1:7` round-trips; a
  malformed key is rejected.
- the quality ladder: given an oversize PNG it picks the first JPEG that fits, and
  the smallest when none fits.
- the confinement predicate: an agent-group tab passes, a foreign tab is refused,
  and `confineToAgentTabs: false` admits both.

**Live** (`node test/live-extension.mjs`, real Chrome). Appended checks:

- with no recorded tab, a command without `tabId` fails with the named error
  rather than touching the user's active tab — the regression this pass exists for;
- after `chrome_open`, a command without `tabId` acts on the agent's tab while a
  **different** tab is the user's active one;
- `chrome_tabs` marks the agent's tab `agent: true` and the user's `false`;
- against a fixture page with an offset `srcdoc` iframe, the snapshot contains a
  ref from the frame, and clicking it lands on the frame's element with the offset
  applied;
- `chrome_find` finds text that exists only inside the iframe;
- a screenshot reports a `format`, and the written file's extension matches it.

**Manual:** the `confineToAgentTabs` toggle exercised from the options page
against a user tab. A storage-driven setting cannot be flipped from the live
suite without a test-only command, which is not worth adding.

## Files touched

| File | Change |
|---|---|
| `extension/pure.js` | new: ref encoding, quality ladder, confinement predicate |
| `extension/service-worker.js` | `importScripts`; `resolveTabId` rewrite; `currentTabId` state; confinement check; screenshot format and guard; frame enumeration, ref parsing, offset accumulation; `find` fan-out |
| `extension/options.html`, `extension/options.js` | the `confineToAgentTabs` toggle |
| `src/index.ts` | `tabId` descriptions; `chrome_tabs` `agent` flag; screenshot format to file extension |
| `test/bridge.test.mjs` | hermetic tests for the pure helpers |
| `test/live-extension.mjs` | the live checks above |
| `README.md` | the new default, the setting, the SSH tunnel recipe |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Claude-exact unconditional confinement | defeats the plugin's purpose; kept as an opt-in setting instead |
| Requiring `tabId` on every call | safe, but every call and every batch step becomes verbose for no extra safety over a recorded tab |
| Full Claude-parity JPEG ladder with a 1398100-char cap | governs a context budget we do not share; the model gets a path, not pixels |
| Doing nothing about screenshot size | leaves a pathological multi-page PNG as a multi-megabyte bridge frame |
| Fanning `page_text` out across frames | mixes banner and widget text into the article the model is reading |
| Guessing a frame's offset when its owner has no box model | a wrong click is worse than a refused one |
| A hosted WSS relay | new public attack surface to serve a case that an SSH tunnel already covers |

## Risks and limits

- Clicking a ref inside a frame depends on `DOM.getFrameOwner` and
  `DOM.getBoxModel` succeeding for every ancestor; when they do not, the click is
  refused rather than approximated.
- The 12-frame cap means the very deepest content on a frame-heavy page is not
  read. Tree order makes what is skipped predictable.
- `importScripts` keeps the service worker classic. Converting it to an ES module
  would also work but changes how it loads, which this pass does not need.
- A ref taken before the page navigates or the frame tree changes remains stale,
  exactly as a main-frame ref does today. The existing advice — take a fresh
  snapshot — still applies.
