# Installing dsh-chrome-agent

This is the complete procedure for setting up the plugin in the DeepSeek
Harness desktop app and connecting it to your Chrome. Follow it as written.
Nothing in it needs editing: no port to change, no config file to touch, no
code to modify. If a step seems to need a change, stop and check
[Troubleshooting](#troubleshooting) instead.

## How the pieces fit

There are two halves, and both are in this repository.

- **The plugin** runs inside DeepSeek Harness. It registers the `chrome_*`
  tools and listens for the extension on `ws://127.0.0.1:19387/chrome-agent/bridge`.
- **The extension** runs inside your Chrome. It dials that address and drives
  your tabs through `chrome.debugger`.

The port is fixed at **19387** on both sides. The plugin opens its own
listener instead of using the app's web server, because the app starts that
server with `--port 0` and so gets a different random port on every launch.
That random port is why older setups had to be edited after every restart.
With the fixed listener, nothing changes between launches.

Only the extension with this repository's pinned key can connect. Its id is
always `ffndjnofnffflcljofbpplcpjnknikpe`, and any other origin is refused with
403.

## Requirements

- Windows, macOS or Linux, with the DeepSeek Harness desktop app installed.
- Node.js 20 or newer, to build the plugin.
- Chrome 116 or newer.
- Nothing else listening on 127.0.0.1:19387.

## 1. Build the plugin tarball

```sh
cd D:\projects\dsh-chrome-agent
npm install
npm run pack:plugin
```

This builds `lib/index.js` and writes `dsh-chrome-agent-0.1.0.tgz` in the
repository root. That file is what the app installs.

## 2. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repository's `extension/` folder.
4. Check that the card shows id `ffndjnofnffflcljofbpplcpjnknikpe`.
5. Open the extension's **Options**. **Bridge port** should read `19387`,
   which is the default. Leave it as it is.

Do this once. The extension keeps retrying the connection in the background
(backing off to every 30 seconds), so it connects by itself whenever the
plugin is running.

## 3. Install the plugin in DeepSeek Harness

1. In the app's sidebar, click **Plugins**.
2. Click the arrow next to **Add plugin**, then **Install a third-party plugin**.
3. Enter the full path to the tarball, for example
   `D:\projects\dsh-chrome-agent\dsh-chrome-agent-0.1.0.tgz`, then click **Install**.
4. When it says **Installed**, click **Enable now**.

The plugin starts straight away, and the app does not need a restart. Its
page under **Plugins** shows `dsh-chrome-agent` with one component, **Running**.

The app manages its own profile, so the `dsh plugin` CLI cannot install into
it (`profile "desktop" is managed exclusively by the Electron application`).
Use the app's Plugins page. Don't use `dsh web` either; this setup is for the
desktop app only.

## 4. Check it works

Within about 30 seconds of enabling, the extension connects. To confirm,
start a new session in the app and send:

> Use only the chrome_* tools: 1) chrome_status 2) chrome_open https://example.com
> 3) chrome_snapshot 4) chrome_close that tab. Report each result.

Expected results:

- `chrome_status` reports `Chrome extension connected (version 0.1.0, id ffndjnofnffflcljofbpplcpjnknikpe)`.
- `chrome_open` opens example.com in a background tab in the "DSH Chrome Agent" group. Your current tab stays in front.
- `chrome_snapshot` returns the page tree with one link, `[ref=1] a "Learn more"`.
- `chrome_close` closes that tab.

From a terminal you can also check the socket. On Windows, run
`netstat -ano | findstr :19387`. It should show one LISTENING line owned by
DeepSeek Harness, and one ESTABLISHED pair with `chrome.exe`.

While the agent is attached to a tab, Chrome shows the banner "DSH Chrome Agent
started debugging this browser". That is expected.

## Updating

**After changing the plugin (`src/`):**

1. Run `npm run pack:plugin`.
2. In the app, open **Plugins**, then `dsh-chrome-agent`, then **Uninstall**,
   and confirm.
3. Install it again as in step 3, using the same tarball path, then click
   **Enable now**.

The app only shows an Update button for its own official plugins. For this
one it treats the same version number as unchanged, so uninstalling and
reinstalling is the way to update. Nothing is lost by doing it, because the
plugin keeps no settings of its own.

**After changing the extension (`extension/`):** click **Reload** on its card
in `chrome://extensions`. Alternatively, close DeepSeek Harness (it holds port
19387) and run `node test/reload-extension.mjs 19387`. The running worker then
reloads itself from disk.

## Troubleshooting

**`chrome_status` says NOT connected and gives the expected id.** The
extension isn't loaded, is disabled, or has the wrong port saved.
- Check that its card in `chrome://extensions` is on.
- Check that Options shows `19387`. If not, set it back and click
  **Save & reconnect**.
- Wait 30 seconds, then ask again.

**`chrome_status` says the bridge could not listen on 127.0.0.1:19387.**
Another program holds the port. Usually it's a second DeepSeek Harness, a
leftover `dsh web`, or a live test script. Find it with
`netstat -ano | findstr :19387`, stop it, then disable and re-enable the
plugin on its Plugins page (or restart the app).

**A command fails with "Another debugger is already attached".** DevTools is
open on that tab, or another debugging extension has attached. Close
DevTools on that tab.

**A tab stops answering right after the agent focuses a login field.** A
password manager's autofill menu (Bitwarden, for example) locks the tab
against debugger commands. The extension removes the menu and retries by
itself. If an action reports that it was interrupted, ask the agent to repeat
it.

**The extension card shows a different id.** The `key` in
`extension/manifest.json` was changed. It must stay byte-identical to
`EXTENSION_KEY` in `src/index.ts`, or the plugin refuses the connection.
Restore it from git.

## Removing it

1. In the app, open **Plugins**, then `dsh-chrome-agent`, then **Uninstall**.
2. In `chrome://extensions`, click **Remove** on the DSH Chrome Agent card.

## Running the live test suite

The live suite runs a stand-in bridge on 19387 in place of the plugin, so
**close DeepSeek Harness first**, then run `node test/live-extension.mjs 19387`.
The hermetic tests (`npm test`) need neither Chrome nor the app.
