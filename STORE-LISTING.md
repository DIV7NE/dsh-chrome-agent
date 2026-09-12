# Chrome Web Store submission — DSH Chrome Agent

Everything needed to publish this extension, item by item.

## Item state

| Field | Value |
|---|---|
| Package | `dsh-chrome-agent-webstore.zip` (build with `npm run pack:webstore`) |
| Category | Developer Tools |
| Language | English |
| Visibility | Unlisted or Public (your call; the plugin itself is open source) |
| Pricing | Free |

## Store listing

**Name** (max 75): `DSH Chrome Agent`

**Summary** (max 132 — currently 120): 
`Connects your real, logged-in Chrome to DeepSeek Harness so its agent can read and drive the tabs you already have open.`

**Detailed description:**

```
Give DeepSeek Harness (DSH) your real, logged-in Chrome — not a separate
browser, not a copy of your profile.

DSH Chrome Agent pairs with the open-source dsh-chrome-agent plugin. Once
connected, the DSH agent you are running locally can see and act on the browser
you already have open, with your existing sessions and cookies intact.

WHAT IT DOES
• Reads a page as an annotated text tree of interactive elements.
• Clicks, types, presses keys, scrolls, and runs JavaScript in a tab.
• Takes screenshots of the visible area.
• Reads console and network activity.
• Opens pages into a tab group of its own, in the background, without moving
  your view.

WHY AN EXTENSION
Copying a Chrome profile does not work: Chrome seals cookies with a key bound
to the original profile path, and it takes an exclusive lock on the profile
directory. Running inside your browser with chrome.debugger is the only approach
that preserves your sessions without defeating a security boundary.

PRIVACY
The extension talks to exactly one place: the DSH server on your own machine,
over 127.0.0.1. There is no developer server, no analytics, and no telemetry.
Nothing is collected, sold, or shared. See the privacy policy for details.

REQUIREMENTS
• The dsh-chrome-agent DSH plugin, running locally.
• Chrome 116 or newer.

While the agent is attached, Chrome shows a banner reading "DSH Chrome Agent
started debugging this browser". That banner is the honest signal that the
agent can currently see your tabs — it disappears when the connection ends.
```

## Graphics

| Asset | Requirement | File | Actual |
|---|---|---|---|
| Store icon | 128x128 PNG | `extension/icons/icon-128.png` | 128x128 ✓ |
| Small promo tile | 440x280 PNG/JPEG | `store/tile-440x280.png` | 440x280 ✓ |
| Screenshot 1 | 1280x800 or 640x400 | `store/screenshot-1.png` | 1280x800 ✓ |
| Marquee (optional) | 1400x560 | not supplied | — |

Screenshots must be PNG or JPEG, at least 1280x800 (or exactly 640x400), and
show the real extension UI. `screenshot-1.png` is the real options page.

## Privacy practices tab

This tab must be filled in before submission. Answers for this extension:

**Single purpose description:**
```
Lets a locally-running DeepSeek Harness agent read and drive the browser the
user is already signed in to, by proxying Chrome DevTools Protocol commands over
a loopback WebSocket to that local DSH server.
```

**Justify each permission requested:**

- `debugger` — "Required to attach to a tab and issue Chrome DevTools Protocol
  commands (screenshot, DOM snapshot, input, network) on behalf of the local
  DSH agent. Chrome shows a persistent banner while attached."
- `tabs` — "Required to enumerate the user's tabs, identify the agent's own tab
  group, and navigate or open a tab on the agent's instruction."
- `tabGroups` — "Required to put agent-opened tabs into their own group so the
  user can see and close the agent's work separately from their own tabs."
- `storage` — "Required to persist two settings: the DSH port number and the
  'only work in the agent's own tabs' switch. No page content is stored."
- `alarms` — "Required to periodically retry the loopback WebSocket connection
  when the local DSH server is not running."

**Are you using remote code?** **No.** All JavaScript ships in the package. The
extension evaluates JavaScript in *pages* on the agent's instruction, which is
the product's function, not remote code loading.

**What user data do you collect?** Select **Website content** only. This
extension collects no personally identifiable information, no health, financial,
authentication, personal communications, or location data. Justify:
```
Website content (page text, DOM, screenshots) is read only when the user's own
local DSH agent requests it, is transmitted only to that local server over
127.0.0.1, and is never sent to the developer or any third party.
```

**Certify:** the three Limited Use checkboxes apply — data is used only for the
single purpose, is not sold to third parties, is not used for purposes unrelated
to the single purpose, and is not used to determine creditworthiness.

**Privacy policy URL:** required, because this extension handles website
content. Host `PRIVACY.md` at a public URL (the GitHub repo file URL is fine)
and paste it here.

## Reviewer test instructions

Chrome Web Store review requires the extension to be usable without private
credentials. Because this extension connects to a *local* server by design, the
reviewer needs the server running. Paste this into "Test instructions":

```
This extension is a client half. It dials a WebSocket to a local server (the
open-source DeepSeek Harness, "DSH") on 127.0.0.1:3080. It cannot function
without that local server, and it has no developer-run backend.

To verify it works end to end:

1. Install the companion DSH plugin from the open-source repository
   (npm package "dsh-chrome-agent"):
       npm install dsh-chrome-agent
       node scripts/install-profile.mjs
   Then start the server:  dsh web
   It listens on http://127.0.0.1:3080.
2. Load this extension. Open its Options page and confirm the port is 3080.
   The options page should report "Connected to 127.0.0.1:3080".
3. In the DSH web UI, ask the agent to run the tool named chrome_status.
   It should report the extension connected, with the same extension id shown
   on the Options page.
4. Ask it to run chrome_open with url "https://example.com", then
   chrome_snapshot. It should return a text tree of the page's elements.
5. Chrome will display the banner "DSH Chrome Agent started debugging this
   browser" while the agent holds a tab. This is expected.

Every step uses public, open-source code and no credentials or accounts. If
starting the local server is impractical for review, the extension can still be
verified as far as the connection handshake: the Options page reports its
connection state, and the pinned-origin handshake is enforced server-side.
```

## Before you submit

- [ ] Register a Chrome Web Store developer account (one-time US$5 fee).
- [ ] Enable 2-step verification on the publishing Google account (required).
- [ ] Host `PRIVACY.md` publicly and paste the URL into the privacy tab.
- [ ] Run `npm run pack:webstore` and upload the resulting zip.
- [ ] Verify the zip does **not** contain `node_modules/`, `.store/`, or tests.
- [ ] Confirm the version in `extension/manifest.json` is bumped per release.

## Known review risks

Stated honestly, because these are the things that can stall a review:

1. **It is non-functional without a local companion server.** Reviewers have
   rejected extension-only submissions for this before. The test instructions
   above exist specifically to address it, and the companion is open source.
2. **`debugger` is a broad permission.** The justification is the product
   itself, but expect the reviewer to look closely. The fixed `key` pinning the
   extension id, and the fact that the socket is loopback-only, are the
   strongest supporting facts.
3. **Website content handling** triggers the privacy-policy requirement. The
   policy is written and ready to host.
