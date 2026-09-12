# Sharing this extension without the Chrome Web Store

You do not need the store, and you do not need the US$5 fee. This extension is
already designed for a manual install, and the design detail that makes it work
is worth understanding.

## Why a manual install works here

Most extensions break when loaded unpacked, because Chrome assigns an unpacked
extension an id derived from its **folder path**. Move the folder and the id
changes, which invalidates anything that pinned it.

This extension avoids that: `extension/manifest.json` carries a fixed
`key`, so Chrome derives the same 32-character id from the **key**, not the
path. Verified by the test suite:

    test('the pinned key yields this build\'s extension id', ...)

That is the same id the DSH server computes and enforces at the handshake. So an
unpacked install is a first-class install here, not a degraded one.

## What your user does

1. Download or clone the repository (or just the `extension/` folder).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder.
5. Open the extension's **Options** and confirm the DSH port (default `3080`).

That is the whole install. The extension appears in the toolbar with the
DeepSeek whale icon, and reports "Connected" once the local DSH server is
running.

## What they give up

Stated honestly, because a manual install is a real trade, not a free lunch:

- **No automatic updates.** Chrome does not update unpacked extensions. They
  re-download and click **Reload** in `chrome://extensions`. This is the main
  cost, and it is not fixable without a store listing.
- **A Developer mode warning.** Chrome shows a dismissible "Disable developer
  mode extensions" prompt on startup. It can be dismissed permanently.
- **No store discovery.** Nobody finds it by searching. You hand out the link.
- **Chrome's "unpacked" badge** appears on the extension card.

None of these affect how the extension *functions*.

## Publishing the zip as a download

`npm run pack:webstore` produces `dsh-chrome-agent-webstore.zip`. That zip is
built for store upload — its root is the extension. To hand it to a user for a
manual install, they unzip it and point **Load unpacked** at the resulting
folder. Either ship the zip or ship the `extension/` folder directly; both work.

Attach the zip to a GitHub Release so the download has a stable URL:

    gh release create v0.1.0 dsh-chrome-agent-webstore.zip \
      --title "DSH Chrome Agent v0.1.0" \
      --notes "Load unpacked: unzip and select the folder in chrome://extensions"

## The one real limitation

**Users must opt in.** Developer mode is a deliberate user action, and some
people will not do it — it is a small but non-zero barrier, and for a
browser-driving extension it is a reasonable one. If you need frictionless
one-click install for non-technical users, the Chrome Web Store is the only
route, and it costs the $5.

For this extension's actual audience — people already running DSH locally, who
run `npm install` to set up the server half — Developer mode is a smaller ask
than the npm install they just did.

## Recommendation

Ship the manual install. Add the `gh release create` line above to your release
process so there is a stable download link. Revisit the $5 only if you find
yourself wanting discovery or auto-updates for users who are not already
developers.
