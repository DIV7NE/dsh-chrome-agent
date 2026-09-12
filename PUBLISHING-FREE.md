# Publishing for free

The Chrome Web Store charges a **one-time US$5 developer registration fee**. There
is no way around it *on Chrome*. But the fee is the only cost, and there are two
genuinely free routes that ship this same extension.

## Option A — Microsoft Edge Add-ons (free, recommended)

Microsoft's own documentation states: *"There is no registration fee for
submitting extensions to the Microsoft Edge program."*

Edge is Chromium, so this extension runs unchanged: it uses only standard
`chrome.*` APIs (`debugger`, `tabs`, `tabGroups`, `storage`, `alarms`, `runtime`)
and manifest V3, all of which Edge implements. The manifest already carries
`minimum_edge_version`, so Edge enforces the same floor as Chrome.

**Steps**

1. Go to Partner Center and register as a Microsoft Edge extension developer
   (<https://partner.microsoft.com/dashboard/microsoftedge/>).
   You need a Microsoft account. Choose **Individual** unless publishing for a
   company. There is no fee at any point.
2. Wait for enrollment verification (usually under a day for individual accounts).
3. Create a new extension submission and upload
   `dsh-chrome-agent-webstore.zip` — the same artifact, no changes.
4. Fill in the listing. Reuse the copy in `STORE-LISTING.md`.
5. Submit for certification.

**Trade-offs, honestly:** Edge Add-ons has a much smaller audience than the
Chrome Web Store, and certification takes roughly 1–7 business days. But it is
free, the artifact is identical, and a passing Edge review is real evidence the
extension is sound if you later decide to pay the $5.

## Option B — self-distribution (free, no store)

Chrome allows extensions to be distributed outside the store, via enterprise
policy or a downloadable `.crx`.

- **Enterprise policy** (`ExtensionInstallForcelist` / `ExtensionSettings`): free
  with a Google Workspace or managed device. Not general-purpose.
- **Self-hosted `.crx`**: free, but Chrome blocks off-store `.crx` installs on
  Windows and macOS for normal users unless the extension is policy-installed
  or the user has developer mode on. On Linux it works more readily.
- **Unpacked folder** (what this repo already documents): free, Developer mode,
  works everywhere, but every user must enable Developer mode and reload the
  extension after updates.

For an open-source developer tool aimed at people already running DSH locally,
**Option B via the unpacked folder is often the right answer** — it costs
nothing, updates are `git pull`, and the audience is developers who are
comfortable with it. The README already covers this path.

## What is genuinely free either way

- Icons, promo tile, and screenshot — generated, no cost.
- Privacy policy — written, just host it (`PRIVACY.md`).
- Packaging — `npm run pack:webstore`, no tooling cost.
- The extension itself — the only money in this project is a Google registration
  fee, and only if you choose the Chrome Web Store specifically.

## Recommendation

Publish to **Edge Add-ons** (free) *and* keep the unpacked install documented
for everyone else. Skip the Chrome $5 until you know people want it. The
submission packet in `STORE-LISTING.md` is written for Chrome; every field maps
one-to-one onto Edge's form.
