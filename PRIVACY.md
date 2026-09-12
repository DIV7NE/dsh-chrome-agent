# Privacy Policy — DSH Chrome Agent

**Last updated:** 2026-09-12

DSH Chrome Agent is a browser extension that connects your own Chrome to a
DeepSeek Harness (DSH) server running on your own computer. This policy states
exactly what the extension does with your data.

## Summary

The extension sends data to **one destination: the DSH server on your own
machine** (`127.0.0.1`, configurable port). It has no servers of its own, no
analytics, no telemetry, and no third-party services. Nothing is sold, shared,
or transmitted anywhere else.

## What the extension can access

The extension is granted the `debugger` permission so that DSH can drive the
browser through the Chrome DevTools Protocol. Through it, and only while
connected, DSH can read:

- the **content of open tabs** (page text, DOM structure, console and network
  logs, screenshots),
- **tab metadata** (titles, URLs, ids, and whether a tab belongs to the
  agent's own tab group),
- the **output of JavaScript** the agent evaluates in a page.

This is the same access you get by opening DevTools on a tab yourself.

## Where the data goes

Everything the extension collects is sent over a **loopback WebSocket**
(`ws://127.0.0.1:<port>/chrome-agent/bridge`) to the DSH server on the same
machine. The connection is authenticated: the server accepts a handshake only
from this extension's pinned origin, and the socket is not reachable from any
other host.

The extension itself stores only two settings in `chrome.storage`: the DSH port
number and the "only work in the agent's own tabs" switch. No page content is
persisted by the extension.

## What the extension does NOT do

- It does not send data to the developer or to any third party.
- It does not collect analytics, usage statistics, or crash reports.
- It does not read or transmit browsing history.
- It does not inject ads or modify pages.
- It does not collect personally identifiable information.
- It does not allow humans to read your data. The only consumer is the DSH
  agent you are running locally and instructing directly.

## Limited Use compliance

This extension's single purpose is to let a locally-running DSH agent read and
drive the browser you are already signed in to. Its use of data is limited to
that purpose, consistent with the Chrome Web Store **Limited Use** requirements.
Data is not transferred to third parties, is not used for advertising, and is
not used to determine creditworthiness or for lending purposes.

## Retention

The extension keeps no data. Page content that DSH reads lives in your local DSH
session and is subject to your own DSH configuration. Deleting or uninstalling
the extension removes its stored settings immediately.

## Consent and control

DSH can only reach your browser while the extension is connected, and Chrome
shows a persistent *"DSH Chrome Agent started debugging this browser"* banner
for as long as that connection is held. You can end it at any moment by
disconnecting the extension, closing Chrome, or turning off the "Only work in
the agent's own tabs" switch, which confines every command to the group the
agent itself opened.

## Changes

Material changes to this policy will be published with a new version of the
extension and a new "Last updated" date above.

## Contact

Open an issue at the project repository. Do not include sensitive data in a
public issue.
