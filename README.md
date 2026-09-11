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

## Tools

| Tool | What it does |
|---|---|
| `chrome_status` | Is the extension connected, and which build. |
| `chrome_tabs` | Every open tab: id, title, url, which is active, and whether it is the agent's own (`agent: true|false`). |
| `chrome_open` | Navigate a tab, or open a new one. |
| `chrome_snapshot` | The page as a text tree of interactive elements, each with `[ref=N]`. |
| `chrome_click` | Click by `ref`, CSS selector, or coordinates. Brings the tab to the front first. |
| `chrome_type` | Type into an element (or the focused one); optional Enter. |
| `chrome_key` | One key or chord, e.g. `Enter`, `PageDown`, `Control+a`. Brings the tab to the front first. |
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

## It works in the background

Every tab the agent opens lands in a **tab group called "DSH Chrome Agent"**, and
opening one **does not move your view**: the tab is created inactive and loads in
the background. You can collapse the group and forget it, or open it to watch.
Closing the group closes the agent's work; your own tabs are untouched.

Reads stay in the background too. Snapshots, evaluations, text, network and
console all work on a tab without bringing it forward, and screenshots follow the
same rule — the agent sees a background tab without bringing it forward. Only if
a background capture genuinely cannot be produced does it fall back to activating
the tab, which is a last resort rather than the default. A tab Chrome has
discarded to save memory is reloaded first, because a discarded tab has no
renderer to capture.

Sending input is the exception. Chrome routes neither keys nor mouse events to a
tab that is not visible, so `chrome_key`, `chrome_click`, `chrome_hover` and
`chrome_drag` bring the agent's tab to the front for the moment they act, which
moves your view there. `chrome_scroll` does not move your view: scrolling falls
back to a scripted scroll. `chrome_type` does not either, unless you set
`submit` — the Enter it then presses is a key event, and keys need a visible tab.

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

### Why input needs a visible tab

Chrome gives a tab that is not visible no focused frame and drops input before it
reaches the page. Measured: `Control+a` on a background tab produced **zero**
`keydown` events and left the selection empty; a main-frame click and a click on
a frame ref each fired nothing on a background tab, while the same click fired on
a visible one. There is no CDP flag that changes this, so `chrome_key`,
`chrome_click`, `chrome_hover` and `chrome_drag` bring their tab forward first.
Text entry is unaffected, because `Input.insertText` takes a different path and
works on a background tab; scrolling falls back to a scripted `window.scrollBy`,
so it too stays in the background. A `chrome_type` with `submit` set is the
exception: the Enter it presses is a key event, so that call brings the tab
forward first.

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
- **An `alert()` is dismissed automatically.** A dialog owns the renderer's main
  thread, so leaving one open is indistinguishable from a hung tab.
- **Unpacked only.** Chrome will not install an unpublished `.crx`, so this loads
  in Developer mode. `--load-extension` no longer works either: Chrome 153 ignores
  it, which is why the extension is loaded by hand.

## Development

```sh
npm run build          # esbuild: lib/index.js only; the extension needs no build
npm run typecheck      # tsc --noEmit
npm test               # hermetic: id derivation + the Origin fence
node test/live-extension.mjs [port]   # drives a real Chrome (see its header)
```
