/**
 * dsh-chrome-agent — host half.
 *
 * Exposes the model's browser tools and bridges them to a companion Chrome
 * extension over one WebSocket. The extension owns the browser; this half owns
 * the route, the request correlation, and the tool surface.
 *
 * Why an extension and not a remote-debugging port: Chrome binds cookie
 * encryption keys to the profile path (app-bound encryption), so a second
 * Chrome cannot read another profile's sessions, and two Chrome instances
 * cannot share one window. An extension lives inside the real browser instead,
 * so `chrome.debugger` drives the user's own tabs with their own logins.
 *
 * The bridge route is authenticated by Origin. Every WebSocket handshake a
 * browser makes carries an unforgeable `Origin`, and a companion extension's
 * Origin is `chrome-extension://<id>` where <id> is derived from the public key
 * pinned in its manifest. Pinning the key fixes the id across machines, so the
 * fence can name exactly one extension; a web page (or any other extension)
 * presents a different Origin and is refused.
 *
 * @module dsh-chrome-agent
 */
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WebSocketServer, type WebSocket } from 'ws'

/** Services required before the route and the tools can be claimed. */
export const inject = ['webServer', 'tools']

/** The one route this plugin owns. */
const ROUTE = '/chrome-agent/bridge'

/** Default per-command timeout (the extension answers or the call fails). */
const CALL_TIMEOUT_MS = 30_000

/**
 * The companion extension's public key, copied verbatim into its manifest.
 * Chrome derives the extension id from it, so this constant and the manifest
 * must agree — {@link deriveExtensionId} turns it back into the id at boot and
 * the route refuses any other Origin.
 */
export const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApbeP6/mjVhlNg3yyIUPO2Y6whmWVUzSZid84ehqXkScIGUBfZiGZ3i3nSFEu7COJkpo7TtvuhDmAiEzZIbmBha4csAHg7If8w7JEUK8KE7adw953sfbcgEJEF1P5HwNDLrq7WHgCphEMK3bx1ppTap9qv+ATRGnFAbLdcEhfi0NXGUsETVC2uPfX5qIeCLUXCXajUhkYQyCVksUWlwRXEXFw76MxigriFVC0Dy+Vn9y8+EguUfRr0rHqPkqPXwtjcf8/Vh7L3lowXajJV08lzFY7qLpl0iKkyDnLsRNsjA3xHFNvL5e+c4GalaSjzcYNq8zP6Mr6qNdUYIsfIoGMzwIDAQAB'

/**
 * Derive the Chrome extension id from an SPKI public key, the way Chrome does:
 * the first 16 bytes of SHA-256 over the DER key, each nibble mapped 0-f to a-p.
 * @param publicKeyBase64 - the manifest `key` value (base64 SPKI DER).
 * @returns the 32-character extension id.
 */
export function deriveExtensionId(publicKeyBase64: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32)
  let id = ''
  for (const digit of hex) id += String.fromCharCode(97 + parseInt(digit, 16))
  return id
}

/** This build's extension id, derived from the pinned key. */
export const EXTENSION_ID = deriveExtensionId(EXTENSION_KEY)

/** The single Origin allowed to open the bridge. */
const EXTENSION_ORIGIN = 'chrome-extension://' + EXTENSION_ID

/**
 * Whether one upgrade request comes from the pinned companion extension.
 * `Origin` is set by the browser on every WebSocket handshake and cannot be
 * overridden by page script, which is what makes this an authentication and
 * not a hint. A non-browser client may forge it, but such a client already
 * runs on this machine with this user's rights.
 * @param headers - the upgrade request headers.
 * @returns whether the handshake may proceed.
 */
export function isTrustedBridgeRequest(headers: IncomingMessage['headers']): boolean {
  return headers.origin === EXTENSION_ORIGIN
}

/** One in-flight command awaiting its answer. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The single live extension connection and its request/response correlation.
 * One extension drives one browser, so one socket is the whole state; a second
 * connection replaces the first (a reloaded extension must not be refused).
 */
export class Bridge {
  private socket: WebSocket | undefined
  private version = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  /** Adopt a freshly accepted socket, dropping any previous one. */
  attach(socket: WebSocket): void {
    const previous = this.socket
    this.socket = socket
    this.version = ''
    if (previous !== undefined && previous !== socket) {
      try { previous.close() } catch { /* already gone */ }
    }
    const drop = (): void => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.version = ''
    }
    socket.on('message', raw => this.onMessage(raw))
    socket.on('close', drop)
    socket.on('error', drop)
  }

  /** Route one frame from the extension. */
  private onMessage(raw: unknown): void {
    let frame: { t?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown; version?: unknown }
    try {
      frame = JSON.parse(String(raw)) as typeof frame
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    if (frame.t === 'hello') {
      this.version = typeof frame.version === 'string' ? frame.version : ''
      return
    }
    if (frame.t !== 'result' || typeof frame.id !== 'number') return
    const entry = this.pending.get(frame.id)
    if (entry === undefined) return
    this.pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.ok === true) entry.resolve(frame.value)
    else entry.reject(new Error(typeof frame.error === 'string' ? frame.error : 'the extension reported a failure'))
  }

  /** Whether a usable extension connection is present. */
  connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === 1
  }

  /** The extension's self-reported version, empty before it says hello. */
  extensionVersion(): string {
    return this.version
  }

  /**
   * Run one command on the extension.
   * @param method - command name defined by the extension's protocol.
   * @param params - JSON-serializable command parameters.
   * @param timeoutMs - how long to wait before failing the call.
   * @returns the command's value.
   */
  call<T = unknown>(method: string, params: unknown = {}, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.reject(new Error(
        'the companion Chrome extension is not connected — load extension/ unpacked in chrome://extensions (Developer mode) and make sure the DSH server is running',
      ))
    }
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('chrome-agent: ' + method + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      this.pending.set(id, { resolve: value => { resolve(value as T) }, reject, timer })
      try {
        socket.send(JSON.stringify({ t: 'command', id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Fail every in-flight call and drop the socket. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('chrome-agent: plugin unloading'))
    }
    this.pending.clear()
    try { this.socket?.close() } catch { /* already gone */ }
    this.socket = undefined
    this.version = ''
  }
}

/** Structural face of the host webserver service. */
export interface WebServerLike {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: unknown, head: Buffer) => void
  }): () => void
}

/** Structural face of the host tool registry. */
export interface ToolsLike {
  register(tool: unknown): () => void
}

/** Structural face of the host context. */
export interface HostContext {
  webServer: WebServerLike
  tools: ToolsLike
  effect(callback: () => void | (() => void), label?: string): void
}

/**
 * The tools a batch may contain. Context reads (chrome_status, chrome_tabs) are
 * left out because the model needs their answer before choosing steps, and
 * chrome_batch is left out because nesting has no meaning.
 */
export const BATCHABLE_TOOLS: ReadonlySet<string> = new Set([
  'chrome_open',
  'chrome_close',
  'chrome_snapshot',
  'chrome_click',
  'chrome_hover',
  'chrome_drag',
  'chrome_scroll',
  'chrome_type',
  'chrome_key',
  'chrome_wait',
  'chrome_eval',
  'chrome_page_text',
  'chrome_find',
  'chrome_screenshot',
  'chrome_console',
  'chrome_network',
  'chrome_resize',
  'chrome_upload',
])

/** One resolved batch step, or the reason it cannot run. */
export type BatchStep =
  | { ok: true; tool: string; method: string; params: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Turn one action of a batch into a bridge call.
 *
 * Every browser tool maps to the bridge command of the same name with its
 * `chrome_` prefix removed, so the mapping is derived rather than tabulated —
 * a table would be a second place to forget when a tool is added.
 *
 * @param tool - the tool name the action asked for.
 * @param args - that tool's arguments, or undefined for none.
 * @param defaultTabId - the batch's `tabId`, applied where an action omits one.
 * @returns the bridge call, or a message naming what is wrong.
 */
export function resolveBatchStep(tool: unknown, args: unknown, defaultTabId?: number): BatchStep {
  if (typeof tool !== 'string' || tool === '') return { ok: false, error: 'every action needs a tool name' }
  if (!BATCHABLE_TOOLS.has(tool)) {
    return { ok: false, error: tool + ' cannot run inside chrome_batch' }
  }
  const source = args === undefined || args === null ? {} : args
  if (typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, error: tool + ': args must be an object' }
  }
  const params: Record<string, unknown> = { ...(source as Record<string, unknown>) }
  if (params.tabId === undefined && defaultTabId !== undefined) params.tabId = defaultTabId
  // Bridge commands are camelCase, so the tool name is not simply the command
  // with its prefix cut: chrome_page_text is pageText, not page_text.
  const method = tool
    .slice('chrome_'.length)
    .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return { ok: true, tool, method, params }
}

/** A model-facing text projection. */
function textRender<T>(fn: (value: T) => string) {
  return (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: fn(value as T) },
  ]
}

/** Close a message over a string, avoiding backticks in generated text. */
function bullet(items: string[]): string {
  return items.length === 0 ? '(none)' : items.join('\n')
}

/**
 * A compact, JSON-safe summary of one action's value. Batch results are strings
 * because the schema requires JSON values and the model reads them as text; a
 * snapshot is by far the largest thing that can land here, so it is capped.
 */
export function summarizeBatchValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const limit = 4000
  return text.length > limit ? text.slice(0, limit) + '… (truncated)' : text
}

/**
 * Sleep for a bounded number of milliseconds.
 *
 * Bounded because a wait is only ever meant to let a page settle; an unbounded
 * one would park the tool call until the harness timeout instead.
 *
 * @param ms - requested wait in milliseconds.
 * @returns how long was actually waited.
 */
async function waitFor(ms: number): Promise<number> {
  const bounded = Math.max(0, Math.min(30000, Math.round(Number.isFinite(ms) ? ms : 0)))
  await new Promise(resolve => setTimeout(resolve, bounded))
  return bounded
}

/** Capture a screenshot and write it to disk, returning where it landed. */
async function captureScreenshot(
  bridge: Bridge,
  args: { tabId?: number; savePath?: string },
): Promise<{ path: string; bytes: number }> {
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
}

/**
 * Register the browser tools against the host tool registry.
 * @param ctx - host context carrying the tools service.
 * @param bridge - the live extension connection.
 */
function registerTools(ctx: HostContext, bridge: Bridge): void {
  // The registry hands back a disposer per tool; without collecting them a
  // plugin unload (HMR, disable) leaves the tools registered against a dead
  // bridge, so every later call fails with 'not connected'.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const register = (tool: unknown): void => { disposers.push(ctx.tools.register(tool)) }

  register(defineTool({
    name: 'chrome_status',
    description:
      'Report whether the companion Chrome extension is connected to this DSH server. '
      + 'Call this first when a browser tool fails, or when unsure whether the user has the browser available.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          version: { type: 'string', required: true, description: 'Extension version, empty when not connected.' },
          extensionId: { type: 'string', required: true },
        },
      },
      render: textRender<{ connected: boolean; version: string; extensionId: string }>(value =>
        value.connected
          ? 'Chrome extension connected (version ' + (value.version === '' ? 'unknown' : value.version) + ', id ' + value.extensionId + ').'
          : 'Chrome extension NOT connected (expected id ' + value.extensionId + '). Ask the user to load extension/ unpacked in chrome://extensions with Developer mode on, then retry.',
      ),
    },
    execute: async () => ({
      connected: bridge.connected(),
      version: bridge.extensionVersion(),
      extensionId: EXTENSION_ID,
    }),
  }))

  register(defineTool({
    name: 'chrome_tabs',
    description:
      'List the tabs open in the user\'s Chrome: id, title, url, and which is active. '
      + 'Use a returned id as `tabId` for the other chrome_* tools; omit `tabId` to act on the tab the agent is working in.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            active: { type: 'boolean', required: true },
            groupId: { type: 'integer', required: true, description: 'Tab group id, or -1 when the tab is ungrouped. Agent-opened tabs share one group.' },
            agent: { type: 'boolean', required: true, description: 'True when the agent opened this tab — it is in the agent\'s own group.' },
          },
        },
      },
      render: textRender<Array<{ id: number; title: string; url: string; active: boolean; groupId: number; agent: boolean }>>(tabs =>
        bullet(tabs.map(t => (t.active ? '* ' : '  ') + t.id + '  ' + t.title + '  ' + t.url + (t.groupId === -1 ? '' : '  [group ' + t.groupId + ']') + (t.agent ? '  [agent]' : ''))),
      ),
    },
    execute: async () => bridge.call<Array<{ id: number; title: string; url: string; active: boolean; groupId: number; agent: boolean }>>('tabs'),
  }))

  register(defineTool({
    name: 'chrome_open',
    description:
      'Navigate a Chrome tab to a URL. Set `newTab` to open a fresh tab in the agent\'s own group — '
      + 'prefer that, or pass a `tabId` for a tab you already opened, so you never navigate a tab the '
      + 'user is reading. Without either, this navigates the tab the agent is working in. '
      + 'Opening a tab also makes it the tab later calls act on by default. '
      + 'This is the user\'s real browser, already signed in.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      tabId: { type: 'integer', description: 'Target tab id from chrome_tabs. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
      newTab: { type: 'boolean', description: 'Open a new tab instead of reusing one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: textRender<{ tabId: number; url: string; title: string }>(v =>
        'Opened tab ' + v.tabId + ': ' + v.title + ' (' + v.url + ')',
      ),
    },
    execute: async (args: { url: string; tabId?: number; newTab?: boolean }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call('open', args)
    },
  }))

  register(defineTool({
    name: 'chrome_snapshot',
    description:
      'Read the page as a compact text tree of interactive elements, each annotated with a ref like [ref=7]. '
      + 'This is the primary way to see a page — read the snapshot, then pass a ref to chrome_click or chrome_type. '
      + 'Cheaper and more reliable than a screenshot for anything but layout and images. '
      + 'A ref from inside a frame is written [ref=7 frame=f1] and must be passed back with frame: "f1"; '
      + 'chrome_page_text stays main-page only.',
    parameters: {
      tabId: { type: 'integer', description: 'Target tab id from chrome_tabs. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          snapshot: { type: 'string', required: true, description: 'The annotated page tree.' },
        },
      },
      render: textRender<{ url: string; title: string; snapshot: string }>(v =>
        v.title + ' — ' + v.url + '\n\n' + v.snapshot,
      ),
    },
    execute: async (args: { tabId?: number }) => bridge.call<{ url: string; title: string; snapshot: string }>('snapshot', args),
  }))

  register(defineTool({
    name: 'chrome_click',
    description:
      'Click an element. Prefer `ref` from the latest chrome_snapshot. Use `selector` for a CSS selector, '
      + 'or `x`/`y` for raw viewport coordinates. Dispatches trusted input events at the element\'s centre. '
      + 'Chrome routes no mouse input to a hidden tab, so this brings the agent\'s tab to the front '
      + 'for the moment it acts, moving the user\'s view there.',
    parameters: {
      ref: { type: 'integer', description: 'Element ref from chrome_snapshot (e.g. 7).' },
      selector: { type: 'string', description: 'CSS selector, when no ref is known.' },
      x: { type: 'integer', description: 'Viewport x, with y, for a coordinate click.' },
      y: { type: 'integer', description: 'Viewport y, with x, for a coordinate click.' },
      button: { type: 'string', description: 'Which button: left (default), right, or middle.' },
      clicks: { type: 'integer', description: '1 (default), 2 for a double click, or 3 for a triple click.' },
      frame: {
        type: 'string',
        description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'string', required: true, description: 'What was clicked, as the extension described it.' },
        },
      },
      render: textRender<{ clicked: string }>(v => 'Clicked ' + v.clicked + '. Take a fresh chrome_snapshot to see the result.'),
    },
    execute: async (args: {
      ref?: number
      selector?: string
      x?: number
      y?: number
      button?: string
      clicks?: number
      frame?: string
      tabId?: number
    }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ clicked: string }>('click', args)
    },
  }))

  register(defineTool({
    name: 'chrome_type',
    description:
      'Type text into an element, or into whatever is focused when neither `ref` nor `selector` is given. '
      + 'Set `submit` to press Enter afterwards (search boxes, forms).',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to type.' },
      ref: { type: 'integer', description: 'Element ref from chrome_snapshot; focused when omitted.' },
      selector: { type: 'string', description: 'CSS selector, when no ref is known.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      frame: {
        type: 'string',
        description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { typed: { type: 'boolean', required: true }, submitted: { type: 'boolean', required: true } },
      },
      render: textRender<{ typed: boolean; submitted: boolean }>(v =>
        v.submitted ? 'Typed the text and pressed Enter.' : 'Typed the text.',
      ),
    },
    execute: async (args: { text: string; ref?: number; selector?: string; submit?: boolean; frame?: string; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call('type', args)
    },
  }))

  register(defineTool({
    name: 'chrome_key',
    description:
      'Press a single key or chord on the page, e.g. "Enter", "Escape", "PageDown", "Control+a". '
      + 'Use chrome_type for text and this for navigation and shortcuts. '
      + 'Chrome drops key events on tabs that are not visible, so this brings the agent\'s tab '
      + 'to the front for the moment it acts, moving the user\'s view there.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or chord, e.g. "Tab", "Control+Enter".' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { pressed: { type: 'string', required: true } },
      },
      render: textRender<{ pressed: string }>(v => 'Pressed ' + v.pressed + '.'),
    },
    execute: async (args: { key: string; tabId?: number }) => bridge.call<{ pressed: string }>('key', args),
  }))

  register(defineTool({
    name: 'chrome_eval',
    description:
      'Evaluate a JavaScript expression in the page and return its value. Returns a serialized value '
      + '(JSON, or a description for host objects). Use it to read data the snapshot does not surface.',
    parameters: {
      expression: { type: 'string', required: true, description: 'A JavaScript expression. Wrap multi-statement work in an IIFE.' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { result: { type: 'string', required: true } },
      },
      render: textRender<{ result: string }>(v => v.result),
    },
    execute: async (args: { expression: string; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call('eval', args)
    },
  }))

  register(defineTool({
    name: 'chrome_close',
    description:
      'Close a tab. Use it to tidy up tabs you opened; do not close a tab the user was already using unless they asked.',
    parameters: {
      tabId: { type: 'integer', required: true, description: 'Tab id from chrome_tabs or chrome_open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { closed: { type: 'integer', required: true } },
      },
      render: textRender<{ closed: number }>(v => 'Closed tab ' + v.closed + '.'),
    },
    execute: async (args: { tabId: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ closed: number }>('close', args)
    },
  }))

  register(defineTool({
    name: 'chrome_screenshot',
    description:
      'Capture the visible area of a tab and save it to disk, returning the file path. '
      + 'The file is a PNG, or a JPEG when the capture is very large. '
      + 'Use it for layout, images, canvas, or when the text snapshot is not enough; read the returned path with the image reader.',
    parameters: {
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
      savePath: { type: 'string', description: 'Absolute path to write the screenshot to. Defaults to a temp file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: textRender<{ path: string; bytes: number }>(v =>
        'Saved a ' + v.bytes + '-byte screenshot to ' + v.path + '.',
      ),
    },
    execute: async (args: { tabId?: number; savePath?: string }, exec) => {
      exec.signal.throwIfAborted()
      return captureScreenshot(bridge, args)
    },
  }))

  register(defineTool({
    name: 'chrome_hover',
    description:
      'Move the pointer over an element without clicking. Use it to open hover menus and tooltips, or to make a page reveal controls before you click them. '
      + 'Chrome routes no mouse input to a hidden tab, so this brings the agent\'s tab to the front '
      + 'for the moment it acts, moving the user\'s view there.',
    parameters: {
      ref: { type: 'integer', description: 'Element ref from chrome_snapshot.' },
      selector: { type: 'string', description: 'CSS selector, when no ref is known.' },
      x: { type: 'integer', description: 'Viewport x, with y.' },
      y: { type: 'integer', description: 'Viewport y, with x.' },
      frame: {
        type: 'string',
        description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hovered: { type: 'string', required: true } },
      },
      render: textRender<{ hovered: string }>(v => 'Hovering ' + v.hovered + '.'),
    },
    execute: async (args: { ref?: number; selector?: string; x?: number; y?: number; frame?: string; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ hovered: string }>('hover', args)
    },
  }))

  register(defineTool({
    name: 'chrome_drag',
    description:
      'Drag from one point to another, e.g. a slider, a sortable row, or a canvas handle. Give each end as a snapshot ref, a CSS selector, or x+y coordinates. This drives mouse events, so it does not move native HTML5 drag-and-drop payloads (file drops, native reordering). '
      + 'Chrome routes no mouse input to a hidden tab, so this brings the agent\'s tab to the front '
      + 'for the moment it acts, moving the user\'s view there.',
    parameters: {
      fromRef: { type: 'integer', description: 'Start element ref from chrome_snapshot.' },
      fromSelector: { type: 'string', description: 'Start CSS selector.' },
      fromX: { type: 'integer', description: 'Start viewport x.' },
      fromY: { type: 'integer', description: 'Start viewport y.' },
      toRef: { type: 'integer', description: 'End element ref from chrome_snapshot.' },
      toSelector: { type: 'string', description: 'End CSS selector.' },
      toX: { type: 'integer', description: 'End viewport x.' },
      toY: { type: 'integer', description: 'End viewport y.' },
      fromFrame: {
        type: 'string',
        description: 'Frame the fromRef belongs to, as chrome_snapshot writes it. Omit for the main page.',
      },
      toFrame: {
        type: 'string',
        description: 'Frame the toRef belongs to, as chrome_snapshot writes it. Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { dragged: { type: 'string', required: true } },
      },
      render: textRender<{ dragged: string }>(v => 'Dragged ' + v.dragged + '.'),
    },
    execute: async (args: Record<string, unknown>, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ dragged: string }>('drag', args)
    },
  }))

  register(defineTool({
    name: 'chrome_scroll',
    description:
      'Scroll the page. Pass a ref or selector to bring that element into view, or no target to scroll by deltaY (default 600, positive scrolls down). Most pages need scrolling before their content is in the snapshot or reachable by a click.',
    parameters: {
      ref: { type: 'integer', description: 'Element to scroll into view.' },
      selector: { type: 'string', description: 'CSS selector to scroll into view.' },
      deltaY: { type: 'integer', description: 'Pixels to scroll vertically when there is no target.' },
      deltaX: { type: 'integer', description: 'Pixels to scroll horizontally when there is no target.' },
      frame: {
        type: 'string',
        description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { scrolled: { type: 'string', required: true } },
      },
      render: textRender<{ scrolled: string }>(v => 'Scrolled ' + v.scrolled + '.'),
    },
    execute: async (args: { ref?: number; selector?: string; deltaY?: number; deltaX?: number; frame?: string; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ scrolled: string }>('scroll', args)
    },
  }))

  register(defineTool({
    name: 'chrome_wait',
    description:
      'Pause for a number of milliseconds. Use it inside chrome_batch where a page needs a moment after a click or a navigation, instead of spreading the wait across turns.',
    parameters: {
      ms: { type: 'integer', required: true, description: 'Milliseconds to wait (max 30000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { waited: { type: 'integer', required: true } },
      },
      render: textRender<{ waited: number }>(v => 'Waited ' + v.waited + 'ms.'),
    },
    execute: async (args: { ms: number }, exec) => {
      exec.signal.throwIfAborted()
      return { waited: await waitFor(args.ms) }
    },
  }))

  register(defineTool({
    name: 'chrome_page_text',
    description:
      'Read the page as prose, preferring the article body over the whole document. Cheaper than a snapshot when you want to read or summarise rather than interact — navigation, banners and footers are dropped.',
    parameters: {
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: textRender<{ url: string; title: string; text: string; truncated: boolean }>(v =>
        v.title + ' — ' + v.url + '\n\n' + v.text + (v.truncated ? '\n\n[truncated]' : '')),
    },
    execute: async (args: { tabId?: number }) => bridge.call<{ url: string; title: string; text: string; truncated: boolean }>('pageText', args),
  }))

  register(defineTool({
    name: 'chrome_find',
    description:
      'Look for a string in the text the page is showing, and scroll the first hit into view. Returns how many times it appears and a short quote around each of the first few. Use it to locate something on a long page instead of reading the whole snapshot.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to look for (case-insensitive).' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          matches: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'integer', required: true, description: 'Frames the 12-frame cap left unread.' },
          unread: { type: 'array', required: true, items: { type: 'string' }, description: 'Frame keys that were in range but could not be read.' },
        },
      },
      render: textRender<{ count: number; matches: string[]; skipped: number; unread: string[] }>(v => {
        const head = v.count === 0
          ? 'No matches.'
          : v.count + ' match(es):\n' + v.matches.map(m => '  …' + m + '…').join('\n')
        const notes: string[] = []
        if (v.skipped > 0) notes.push(v.skipped + ' further frame(s) not read')
        if (v.unread.length > 0) notes.push(v.unread.length + ' frame(s) could not be read (' + v.unread.join(', ') + ')')
        return notes.length === 0 ? head : head + '\n\n… ' + notes.join('; ')
      }),
    },
    execute: async (args: { text: string; tabId?: number }) => bridge.call<{ count: number; matches: string[]; skipped: number; unread: string[] }>('find', args),
  }))

  register(defineTool({
    name: 'chrome_console',
    description:
      'Read the console messages and uncaught exceptions a tab has produced since you last read them (pass keep to read without clearing). Use it when a page misbehaves after an action.',
    parameters: {
      keep: { type: 'boolean', description: 'Read without clearing the buffer.' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: textRender<{ entries: Array<{ level: string; text: string }> }>(v => v.entries.length === 0
        ? 'No console output.'
        : v.entries.map(e => '[' + e.level + '] ' + e.text).join('\n')),
    },
    execute: async (args: { keep?: boolean; tabId?: number }) => bridge.call<{ entries: Array<{ level: string; text: string }> }>('console', args),
  }))

  register(defineTool({
    name: 'chrome_network',
    description:
      'Read the HTTP requests a tab made since you last read them (pass keep to read without clearing), with the response status where one was seen. Use it to find the API behind a page, or to see what a click actually triggered.',
    parameters: {
      keep: { type: 'boolean', description: 'Read without clearing the buffer.' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                method: { type: 'string', required: true },
                url: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: textRender<{ entries: Array<{ method: string; url: string; status: number }> }>(v => v.entries.length === 0
        ? 'No requests recorded.'
        : v.entries.map(e => (e.status === 0 ? '···' : String(e.status)) + ' ' + e.method + ' ' + e.url).join('\n')),
    },
    execute: async (args: { keep?: boolean; tabId?: number }) => bridge.call<{ entries: Array<{ method: string; url: string; type: string; status: number }> }>('network', args),
  }))

  register(defineTool({
    name: 'chrome_resize',
    description:
      'Emulate a viewport size for responsive testing. This changes what the page lays out against without moving the window the user is working in; pass width 0 (or height 0) to clear it.',
    parameters: {
      width: { type: 'integer', required: true, description: 'Viewport width in CSS pixels, or 0 to clear.' },
      height: { type: 'integer', required: true, description: 'Viewport height in CSS pixels, or 0 to clear.' },
      scale: { type: 'number', description: 'Device scale factor; 0 leaves it alone.' },
      mobile: { type: 'boolean', description: 'Emulate a mobile device.' },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { resized: { type: 'string', required: true } },
      },
      render: textRender<{ resized: string }>(v => 'Viewport ' + v.resized + '.'),
    },
    execute: async (args: { width: number; height: number; scale?: number; mobile?: boolean; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ resized: string }>('resize', args)
    },
  }))

  register(defineTool({
    name: 'chrome_upload',
    description:
      'Attach local files to a file input on the page. Pass a ref or selector, or let it use the only file input. Paths are read by the browser machine, so they must exist there — a path returned by chrome_screenshot works.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: 'Absolute paths to attach.',
        items: { type: 'string' },
      },
      ref: { type: 'integer', description: 'The input[type=file] ref from chrome_snapshot.' },
      selector: { type: 'string', description: 'CSS selector for the input.' },
      frame: {
        type: 'string',
        description: 'Frame the ref belongs to, as chrome_snapshot writes it (e.g. "f1"). Omit for the main page.',
      },
      tabId: { type: 'integer', description: 'Target tab id. Defaults to the tab the agent is working in — the last one it opened or was given. Pass an explicit id to work on another tab.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { uploaded: { type: 'integer', required: true } },
      },
      render: textRender<{ uploaded: number }>(v => 'Attached ' + v.uploaded + ' file(s).'),
    },
    execute: async (args: { files: string[]; ref?: number; selector?: string; frame?: string; tabId?: number }, exec) => {
      exec.signal.throwIfAborted()
      return bridge.call<{ uploaded: number }>('upload', args)
    },
  }))

  register(defineTool({
    name: 'chrome_batch',
    description:
      'Run several browser actions in one call. Each action names another chrome_* tool and its arguments. '
      + 'Prefer this whenever you can predict two or more steps ahead — a click then a type then a key, a form fill, '
      + 'a multi-step navigation. One batch is one round trip instead of one per action, which is where the time goes. '
      + 'Actions run in order and stop at the first failure; the result reports which action failed and how many never ran. '
      + 'chrome_status, chrome_tabs and chrome_batch itself are not allowed inside a batch.',
    parameters: {
      actions: {
        type: 'array',
        required: true,
        description: 'The actions to run, in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: { type: 'string', required: true, description: 'A browser tool name, e.g. chrome_click.' },
            args: {
              type: 'object',
              additionalProperties: true,
              description: 'That tool\'s arguments, exactly as you would pass them on their own.',
            },
          },
        },
      },
      tabId: { type: 'integer', description: 'Default tab for every action that omits one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ran: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tool: { type: 'string', required: true },
                output: { type: 'string', required: true, description: 'That action\'s result, as text.' },
              },
            },
          },
          failedTool: { type: 'string', required: true, description: 'Empty when every action ran.' },
          error: { type: 'string', required: true, description: 'Empty when every action ran.' },
          notRun: { type: 'integer', required: true },
        },
      },
      render: textRender<{
        ran: number
        total: number
        failedTool: string
        error: string
        notRun: number
      }>(v => v.failedTool === ''
        ? 'Ran all ' + v.total + ' action(s).'
        : 'Stopped at action ' + (v.ran + 1) + ' (' + v.failedTool + '): ' + v.error
          + ' — ' + v.ran + ' ran, ' + v.notRun + ' not run.'),
    },
    execute: async (args: { actions: Array<{ tool: string; args?: Record<string, unknown> }>; tabId?: number }, exec) => {
      const actions = Array.isArray(args.actions) ? args.actions : []
      if (actions.length === 0) throw new Error('chrome_batch needs at least one action')
      const results: Array<{ tool: string; output: string }> = []
      const stop = (failedTool: string, error: string, attempted: boolean) => ({
        ran: results.length,
        total: actions.length,
        results,
        failedTool,
        error,
        notRun: actions.length - results.length - (attempted ? 1 : 0),
      })
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]
        const step = resolveBatchStep(action?.tool, action?.args, args.tabId)
        if (!step.ok) {
          const named = typeof action?.tool === 'string' ? action.tool : ''
          return stop(named, 'action ' + (index + 1) + ': ' + step.error, false)
        }
        exec.signal.throwIfAborted()
        try {
          const value = step.method === 'screenshot'
            ? await captureScreenshot(bridge, step.params as { tabId?: number; savePath?: string })
            : step.method === 'wait'
              // Waiting is the host's own job; there is no page to tell.
              ? { waited: await waitFor(Number(step.params.ms)) }
              : await bridge.call(step.method, step.params)
          results.push({ tool: step.tool, output: summarizeBatchValue(value) })
        } catch (error) {
          return stop(step.tool, error instanceof Error ? error.message : String(error), true)
        }
      }
      return { ran: results.length, total: actions.length, results, failedTool: '', error: '', notRun: 0 }
    },
  }))

    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-chrome-agent: browser tools')
}

/**
 * Host plugin body: claim the bridge route and register the browser tools.
 * @param ctx - the host context (webserver, tools).
 */
export function apply(ctx: HostContext): void {
  const bridge = new Bridge()

  ctx.effect(() => {
    const wss = new WebSocketServer({ noServer: true })

    wss.on('connection', (ws: WebSocket) => { bridge.attach(ws) })

    const disposeRoute = ctx.webServer.registerUpgrade({
      path: ROUTE,
      handler: (req, socket, head) => {
        if (!isTrustedBridgeRequest(req.headers)) {
          const raw = socket as { write?: (text: string) => void; destroy?: () => void }
          raw.write?.('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          raw.destroy?.()
          return
        }
        wss.handleUpgrade(req, socket as never, head, ws => { wss.emit('connection', ws, req) })
      },
    })

    return () => {
      disposeRoute()
      bridge.dispose()
      wss.close()
    }
  }, 'dsh-chrome-agent: bridge route')

  registerTools(ctx, bridge)
}
