# dsh-chrome-agent

A DeepSeek Harness plugin that gives the agent your **real, logged-in Chrome**:
its tabs, its cookies, its sessions. The agent reads pages as annotated text,
clicks, types, presses keys, runs JavaScript, and takes screenshots — all in the
browser you already have open.

```
   Claude extension            this plugin
   ────────────────            ───────────
   chrome.debugger       ←→    chrome.debugger
   native host + cloud          localhost WebSocket to DSH
```

## Why not a second browser, or a debugging port

The obvious design — point a headless browser at a copy of your Chrome profile —
does not work, and the reason is worth stating because it is not a bug:

| Approach | Why it fails |
|---|---|
| Copy the profile | Chrome seals cookies with a key bound to the original profile **path** (app-bound encryption). Byte-identical files still do not decrypt: a copied `Network\Cookies` of exactly 1,638,400 bytes still required sign-in everywhere. |
| Share the live profile | Chrome takes an exclusive lock on `User Data`; a second Chrome cannot start against it. |
| `--remote-debugging-port` | Needs Chrome restarted with the flag, and hands the agent whole-browser control with no consent boundary. |
| **Extension + `chrome.debugger`** | Runs *inside* the trust boundary, so there is nothing to defeat. This is what Claude in Chrome does. |

## Install

### 1. The plugin

```sh
cd <this directory>
npm install
npm run install:profile          # builds, packs, installs into the web profile
```

**Restart the DSH server** (`dsh web`) — the profile's bundle stack is composed
at boot, so a new plugin cannot appear in a running server. Reload the page.

### 2. The companion extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this package's `extension/` folder
4. Open the extension's **Options** and check the DSH web port (default `3080`)

Chrome shows *"DSH Chrome Agent started debugging this browser"* while the agent
holds an attachment. That banner is Chrome's, and it is the honest signal that
the agent can see your tabs.

### 3. Check it

Ask the agent to run `chrome_status`. It should report the extension connected,
with the same extension id the options page shows.

### Sharing the extension with someone else

There is no Chrome Web Store listing, and none is needed: the manifest carries a
fixed `key`, so Chrome derives this extension's id from that key rather than
from the folder it was loaded out of. An unpacked install therefore gets the
**same id** the DSH server expects, and is a first-class install rather than a
degraded one. Move or rename the folder and the id does not change.

Send them the repository (or a release zip), and they run the same four steps
above. What they take on:

| Trade-off | Detail |
|---|---|
| No automatic updates | Chrome never updates an unpacked extension. Re-download and click **Reload** in `chrome://extensions`. |
| Developer mode required | A dismissible "Disable developer mode extensions" prompt appears on startup. |
| No store discovery | There is nothing to search for; the link is how it spreads. |

To cut a shareable zip, `npm run pack:webstore` writes
`dsh-chrome-agent-webstore.zip` — the extension at the zip root, with no
sources, tests, or `node_modules`. Unzip it and point **Load unpacked** at the
resulting folder. See [SHARING-WITHOUT-STORE.md](SHARING-WITHOUT-STORE.md) for
the full picture, and [STORE-LISTING.md](STORE-LISTING.md) if you later decide
to pay the one-time Chrome Web Store fee.

## Tools

| Tool | What it does |
|---|---|
| `chrome_status` | Is the extension connected, and which build. |
| `chrome_tabs` | Every open tab: id, title, url, which is active, and whether it is the agent's own (`agent: true|false`). |
| `chrome_open` | Navigate a tab, or open a new one. |
| `chrome_snapshot` | The page as a text tree of interactive elements, each with `[ref=N]`. |
| `chrome_click` | Click by `ref`, CSS selector, or coordinates, with trusted mouse events. |
| `chrome_type` | Click into a field with a real click, type, and read back what the field now holds (a password reports only its length); optional Enter. |
| `chrome_key` | One key or chord, e.g. `Enter`, `PageDown`, `Control+a`. |
| `chrome_eval` | Evaluate JavaScript in the page. |
| `chrome_screenshot` | The visible area, saved to a path: PNG, or JPEG when the capture is large enough to need re-encoding. The result reports which format it encoded. |

The loop is the same one every browser agent uses: `chrome_snapshot`, then act on
a ref. **A ref is only valid until the next snapshot** — the page re-numbers them.

### Frames

Snapshots read `iframe`s as well as the top page. A ref from inside a frame is
written `[ref=7 frame=f1]`, and it has to be passed back with `frame: "f1"` — a
ref with no frame means the main page, so every existing call is unchanged at the
price of one optional argument. `chrome_find` searches every frame and labels a
hit from inside a frame, but `chrome_page_text` stays main-page only, because
frame text is usually widget and banner noise. At most **12 frames** are read; a
snapshot or a find reports how many further frames it did not read, and which
frames it could not read at all.

### Clicks check their target first

`chrome_click`, `chrome_hover` and `chrome_drag` hit-test the target before any
mouse event goes out. The element must still be on the page and have a size, and
`elementFromPoint` (looking through open shadow roots, and again in the top page
for a frame ref) must land on the element or inside it. The first point tried is
the centre of the element's first line box, so a wrapped link is not clicked in
the gap between its lines; if that point is covered, a grid of other points on the
element is tried. When nothing on the element is reachable, the command is refused
and the error names what covers it. Before this, a covered button clicked the
cover, and a ref whose element had re-rendered or been hidden clicked the page's
top-left corner — all reported as success.

## It works in the background

Every tab the agent opens lands in a **tab group called "DSH Chrome Agent"**, and
opening one **does not move your view**: the tab is created inactive and loads in
the background. You can collapse the group and forget it, or open it to watch.
Closing the group closes the agent's work; your own tabs are untouched.

Everything else stays in the background too, input included. Clicks, keys,
hover, drag, typing, wheel scrolling, snapshots, evaluations and screenshots all
act on the agent's tab **without ever bringing it forward**, so you can keep
watching a video in another tab while the agent works. No command activates a
tab or focuses a window. A tab Chrome has discarded to save memory is reloaded
first, because a discarded tab has no renderer to act on.

### Which tab a command acts on

A command sent without a `tabId` acts on the tab the agent is working in — the
last one it opened or was given. There is no "whichever tab you are looking at"
default: that fallback is gone. With no tab yet, such a command fails with
`no tab yet — call chrome_open first, or pass an explicit tabId`, rather than
touching the tab on your screen.

To have the agent work on a tab **you** opened, name it: the model passes that
tab's id, or you point it at one with `chrome_tabs`. Each entry there is marked
`agent: true|false`, so the agent can tell its own tabs from yours.

The options page's **Only work in the agent's own tabs** switch confines every
command to the group the agent opened. It is **off by default**, because the whole
point of this plugin is driving the tabs you are already signed in to; with it on,
a command naming one of your tabs is refused instead.

### How input reaches a background tab

Left alone, Chrome drops input to a tab it is not showing: a background-tab click
fired nothing, `Control+a` produced zero `keydown` events, and the first mouse
event stalled about five seconds. The extension turns on CDP's
`Emulation.setFocusEmulationEnabled` when it attaches to a tab, which makes Chrome
render that tab wherever it is — the page reports `visibilityState: visible` — and
trusted input then lands. Measured (`test/probe-background-input.mjs`): click, key
and wheel landed in 0–3ms in a background tab, in a collapsed tab group, and in a
minimised window. A screencast alone still stalled 1.6s; a separate window alone
stalled 5s in every state. A tab that still reports hidden is refused with an
error rather than brought forward.

Two side effects of that rendering are handled in the extension:

- **The first wheel after attaching is held** until Chrome next produces a frame,
  and then lands on top of whatever the page did meanwhile — a later
  `scrollIntoView` was overridden and the click that followed missed. So
  `chrome_scroll` sends one wheel, follows it with a mouse move that applies it,
  and reports the pixels that actually moved, or that nothing did. It never
  re-sends: a held wheel plus a re-send scrolled 1800px for a 900px request.
  (`test/probe-scroll-commit.mjs`)
- **`Page.captureScreenshot` alternated** between succeeding and hanging for its
  whole timeout on a background tab, so screenshots take the first frame of a
  screencast instead: six of six arrived in 1.2–1.4s.
  (`test/probe-capture-variants.mjs`)

The cost is that the agent's tabs keep rendering in the background like a visible
tab would: animations run and media plays.

## Security

The bridge hands over a browser, so it is fenced:

- **The extension id is pinned.** The manifest carries a fixed public `key`, so
  Chrome derives the same 32-character id on every machine that loads this
  folder. The server computes that id from the same key and accepts a handshake
  only from `chrome-extension://<that id>`.
- **`Origin` is set by the browser and cannot be forged by page script**, which
  is what makes the check an authentication rather than a hint. A web page —
  including one served from localhost — presents an `http(s)` origin and is
  refused. Another extension presents its own id and is refused.
- This is a browser-driving capability, not a shell: it can do what you could do
  with DevTools open on any tab, and nothing more.

### Reaching a browser on another machine

The bridge listens on the loopback interface only, and the pinned-origin check is
the authentication precisely because the socket is not reachable from anywhere
else. To drive a Chrome on another machine, forward the port over SSH:

```bash
ssh -N -L 3080:127.0.0.1:3080 user@the-other-machine
```

DSH, the extension and its options port all then live on the same machine as
before: the extension still dials `127.0.0.1:3080`, and neither it nor the options
page knows the tunnel exists.

## Configuration

```yaml
- id: chrome-agent
  name: 'dsh-chrome-agent'
```

The extension's port lives in its own options page, not in this file — the
extension is what dials out, so that is where the address belongs.

## Known limitations

- **One debugger client per tab.** If DevTools is open on a tab, or another
  extension has attached, commands on that tab fail with a clear message.
- **Refs are snapshot-scoped.** Re-snapshot after anything that changes the DOM.
- **Text entry uses `Input.insertText`.** Fine for forms and search boxes; a page
  that needs per-keystroke events (some typeaheads) may need a follow-up.
- **The screenshot is the visible viewport**, not a full-page capture.
- **Dialogs are answered at once, and reported.** A dialog owns the renderer's
  main thread, so leaving one open is indistinguishable from a hung tab. An alert
  is accepted; a confirm or prompt is dismissed unless the action passed
  `dialog: "accept"` (and `promptText`). Every dialog comes back in the result of
  the click, key, type, eval, open or close that raised it.
- **A page that asks before it is left is never left unasked.** Chrome brings a
  background tab forward to show its leave-page warning, so `chrome_open` and
  `chrome_close` check for a `beforeunload` handler first and refuse unless given
  `dialog: "accept"`, in which case the handler is removed and the page is left
  without the warning appearing. If a click raises the warning anyway, it is
  dismissed and your previous tab is put back in front.
- **A password manager's autofill menu locks the agent out of that tab.** When the
  agent focuses a login-style field, a password manager such as Bitwarden injects
  its own frame into the page, and Chrome then refuses every debugger command to
  the whole tab — input, capture and reads alike. Left alone, Bitwarden's menu
  held a tab for 20s and more. The extension gets the tab back through
  `chrome.scripting`, which is not locked: first a focus change, which lets the
  password manager close the menu itself; if the menu stays, its injected
  elements (direct children of `<body>`/`<html>` with a custom tag the page never
  defined) are removed. Then the refused command is sent again — except real
  input and the model's own `chrome_eval` code when they were interrupted rather
  than refused, which are reported instead. `chrome_type` fills a field whose
  focus keeps locking the tab by script, and says so in its result. Verified with
  Bitwarden switched on. To avoid the lock altogether, set the password manager's
  site access to "On click" in `chrome://extensions`, or turn off its inline
  autofill menu.
- **Background tabs answer at about a frame per second.** Anything that waits for
  a fresh frame — a wheel scroll, a screenshot, a click that opens a dialog —
  takes around one to two seconds on a background tab, against milliseconds on a
  visible one. That is the price of never taking your view.
- **Unpacked only.** Chrome will not install an unpublished `.crx`, so this loads
  in Developer mode. `--load-extension` no longer works either: Chrome 153 ignores
  it, which is why the extension is loaded by hand.

## Development

```sh
npm run build          # esbuild: lib/index.js only; the extension needs no build
npm run typecheck      # tsc --noEmit
npm test               # hermetic: id derivation + the Origin fence
node test/live-extension.mjs [port]   # drives a real Chrome (see its header)
node test/reload-extension.mjs [port] # reload the unpacked extension after editing it
node test/cleanup-agent-tabs.mjs [port] # close test tabs an aborted run left behind
```
