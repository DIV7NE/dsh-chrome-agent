/**
 * DSH Chrome Agent — extension service worker.
 *
 * One WebSocket to the DSH server, one command router, and the CDP calls that
 * carry them out. Chrome's `chrome.debugger` API gives an extension the same
 * protocol DevTools uses on the user's OWN tabs, which is why this needs no
 * remote-debugging port, no second profile, and no cookie copying.
 *
 * The socket is the keepalive too: since Chrome 116 an extension service
 * worker stays alive while it holds an open WebSocket, so the connection is
 * maintained rather than re-established per command. An alarm is the belt to
 * that brace — it retries when the socket drops or the worker was evicted.
 */
importScripts('pure.js');

/** The browser-free helpers, shared with the node test. */
const PURE = self.DSH_PURE;
const FRAME_LIMIT = PURE.FRAME_LIMIT;
const SCREENSHOT_BASE64_LIMIT = PURE.SCREENSHOT_BASE64_LIMIT;
const flattenFrameTree = PURE.flattenFrameTree;
const normaliseFrameKey = PURE.normaliseFrameKey;
const nextJpegQuality = PURE.nextJpegQuality;
const isTabAllowed = PURE.isTabAllowed;
const sumFrameOffsets = PURE.sumFrameOffsets;

const DEFAULT_PORT = 3080;
const PROTOCOL_VERSION = 1;
const RECONNECT_ALARM = 'dsh-chrome-agent-reconnect';

let socket = null;
let retryTimer = null;
let retryDelayMs = 3000;

/** Every tab this worker currently holds a debugger attachment on. */
const attached = new Set();

/** The tab the agent is working in, and whether storage has been read yet. */
let currentTabId = null;
let currentTabLoaded = false;
/** The in-flight session-storage read, shared by commands that overlap. */
let currentTabLoad = null;
const CURRENT_TAB_KEY = 'currentTabId';

/** The DSH server port, from storage (the options page writes it). */
async function serverPort() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT });
  const port = Number(stored.port);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

/** Send one frame, tolerating a socket that is closing. */
function send(frame) {
  try {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  } catch (error) {
    // The socket died between the check and the write; the close handler reconnects.
  }
}

/**
 * Retry with exponential backoff, capped at 30s. A DSH server that is simply
 * not running must not fill chrome://extensions' error list with a reconnect
 * failure every three seconds, which is what a fixed delay does.
 */
function scheduleRetry() {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 30000);
}

/** Open the bridge if it is not already open. Safe to call repeatedly. */
async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const port = await serverPort();
  let next;
  try {
    next = new WebSocket('ws://127.0.0.1:' + port + '/chrome-agent/bridge');
  } catch (error) {
    scheduleRetry();
    return;
  }
  socket = next;
  next.addEventListener('open', () => {
    retryDelayMs = 3000;
    send({ t: 'hello', protocol: PROTOCOL_VERSION, version: chrome.runtime.getManifest().version });
  });
  next.addEventListener('message', event => {
    handleFrame(event.data);
  });
  next.addEventListener('close', () => {
    if (socket === next) socket = null;
    scheduleRetry();
  });
  next.addEventListener('error', () => {
    try { next.close(); } catch (error) { /* already gone */ }
  });
}

/** Route one frame from the host. */
function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (error) {
    return;
  }
  if (!frame || typeof frame !== 'object' || frame.t !== 'command') return;
  const id = frame.id;
  const method = frame.method;
  const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
  runCommand(method, params).then(
    value => { send({ t: 'result', id: id, ok: true, value: value }); },
    error => { send({ t: 'result', id: id, ok: false, error: describe(error) }); },
  );
}

/** A short, safe message for the host. */
function describe(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

// ---------------------------------------------------------------- tabs ---

/**
 * The tab the agent is working in, read from session storage once per worker.
 *
 * Session storage rather than memory alone because Chrome evicts an idle
 * service worker, and losing the tab on every eviction would make every
 * follow-up call fail for no reason the caller can see.
 */
async function readCurrentTabId() {
  if (!currentTabLoaded) {
    if (currentTabLoad === null) currentTabLoad = loadCurrentTabId();
    // Commands are not serialised, so a second caller shares this one read
    // rather than seeing a half-finished load and returning a null tab.
    await currentTabLoad;
  }
  return currentTabId;
}

/**
 * Run the stored-tab read once. Never throws, and never clobbers a tab that
 * rememberTab recorded while this read was in flight.
 */
async function loadCurrentTabId() {
  try {
    const stored = await chrome.storage.session.get(CURRENT_TAB_KEY);
    if (currentTabLoaded) return;
    const storedId = stored[CURRENT_TAB_KEY];
    if (typeof storedId !== 'number') return;
    try {
      // A tab can close while no worker is alive to hear about it, so a stored
      // id is a claim to check, not a fact.
      await chrome.tabs.get(storedId);
      currentTabId = storedId;
    } catch (error) {
      currentTabId = null;
      chrome.storage.session.remove(CURRENT_TAB_KEY).catch(() => {});
    }
  } catch (error) {
    // Session storage is best effort; memory alone still works this session.
  } finally {
    currentTabLoaded = true;
  }
}

/** Record the tab the agent is working in, in memory and for the next worker. */
function rememberTab(tabId) {
  currentTabId = tabId;
  currentTabLoaded = true;
  try {
    chrome.storage.session.set({ [CURRENT_TAB_KEY]: tabId }).catch(() => {});
  } catch (error) {
    // Session storage is best effort; memory alone still works this session.
  }
}

/**
 * Refuse a tab the agent is not allowed to touch.
 *
 * The setting is read per call rather than cached so that flipping it in the
 * options page takes effect on the next command, not the next worker.
 */
async function assertTabAllowed(tabId) {
  const stored = await chrome.storage.local.get({ confineToAgentTabs: false });
  if (stored.confineToAgentTabs !== true) return;
  let tabGroupId = -1;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabGroupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
  } catch (error) {
    throw new Error('tab ' + tabId + ' is gone');
  }
  // The agent's own group has to be resolved rather than read off agentGroupId:
  // an evicted worker comes back without it.
  const ownGroupId = await agentGroup();
  if (isTabAllowed(tabGroupId, ownGroupId, true)) return;
  throw new Error('Tab ' + tabId + " is not in the agent's tab group for this session. "
    + 'Tools can only target tabs inside the group; call chrome_tabs to list the tabs the agent may use.');
}

/**
 * Resolve the tab a command acts on: the named one, else the tab the agent is
 * already working in.
 *
 * There is deliberately no "the user's active tab" fallback. Guessing there
 * means a command sent without a tabId can act on whatever the user happens to
 * be looking at; failing loudly is the safe answer, and passing a tabId is how a
 * caller reaches a tab the agent did not open.
 */
async function resolveTabId(tabId) {
  if (typeof tabId === 'number') {
    await assertTabAllowed(tabId);
    rememberTab(tabId);
    return tabId;
  }
  const remembered = await readCurrentTabId();
  if (remembered === null) {
    throw new Error('no tab yet — call chrome_open first, or pass an explicit tabId');
  }
  await assertTabAllowed(remembered);
  return remembered;
}

// ----------------------------------------------------------- debugger ---

/**
 * Attach the debugger to one tab, reusing an existing attachment. Detaching
 * after every command would flash Chrome's debugging banner on and off, so
 * attachments are held until the tab closes or the debugger drops them.
 */
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  const target = { tabId: tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (error) {
    const message = describe(error);
    if (/another debugger/i.test(message)) {
      throw new Error('another debugger (DevTools or another extension) already holds tab ' + tabId);
    }
    // Our own attachment survives a service-worker restart while this Set does
    // not, so 'already attached' is success, not failure. The match must be
    // case-insensitive: Chrome says 'Debugger is already attached to the tab'.
    if (!/already attached/i.test(message)) throw error;
  }
  // Page.enable is what makes javascriptDialogOpening fire at all. Without it
  // an alert() or confirm() blocks the renderer and every later command —
  // including the click that opened it — hangs until it times out. Enabling an
  // already-enabled domain is harmless.
  // Page for dialogs and capture, Runtime for console + evaluation, Network for
  // the request log, DOM for setFileInputFiles. Enabling a domain twice is
  // harmless, so this runs on every fresh attachment.
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable']) {
    try {
      await chrome.debugger.sendCommand(target, domain);
    } catch (error) {
      // A target that refuses a domain still serves the others.
    }
  }
  attached.add(tabId);
}

/** Console and exception lines kept per tab, newest last. */
const consoleByTab = new Map();
/** Network requests kept per tab, newest last, keyed by request id for status. */
const networkByTab = new Map();
const CONSOLE_LIMIT = 200;
const NETWORK_LIMIT = 300;

/** Append to a bounded list, dropping the oldest entries first. */
function pushBounded(store, tabId, entry, limit) {
  const list = store.get(tabId) || [];
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
  store.set(tabId, list);
}

/** One console argument, as text. */
function describeConsoleArg(arg) {
  if (arg === null || typeof arg !== 'object') return String(arg);
  if ('value' in arg) return String(arg.value);
  if (typeof arg.description === 'string') return arg.description;
  return String(arg.type || 'value');
}

/**
 * Everything the debugger reports for a tab.
 *
 * A dialog owns the renderer's main thread, so leaving one up is
 * indistinguishable from a hung tab; console and network events are the
 * observation log the read_console / read_network commands serve back.
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') return;
  const tabId = source.tabId;

  if (method === 'Page.javascriptDialogOpening') {
    chrome.debugger.sendCommand({ tabId: tabId }, 'Page.handleJavaScriptDialog', { accept: true })
      .catch(() => { /* the page closed it first */ });
    return;
  }

  if (method === 'Runtime.consoleAPICalled') {
    const args = params && Array.isArray(params.args) ? params.args : [];
    pushBounded(consoleByTab, tabId, {
      level: String((params && params.type) || 'log'),
      text: args.map(describeConsoleArg).join(' ').slice(0, 800),
    }, CONSOLE_LIMIT);
    return;
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = params && params.exceptionDetails;
    const thrown = details && details.exception && (details.exception.description || details.exception.value);
    pushBounded(consoleByTab, tabId, {
      level: 'exception',
      text: String(thrown || (details && details.text) || 'exception').slice(0, 800),
    }, CONSOLE_LIMIT);
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const request = params && params.request;
    pushBounded(networkByTab, tabId, {
      id: String((params && params.requestId) || ''),
      method: String((request && request.method) || 'GET'),
      url: String((request && request.url) || '').slice(0, 400),
      type: String((params && params.type) || ''),
      status: 0,
    }, NETWORK_LIMIT);
    return;
  }

  if (method === 'Network.responseReceived') {
    const response = params && params.response;
    const requestId = String((params && params.requestId) || '');
    const list = networkByTab.get(tabId);
    if (!list) return;
    // Fold the status back onto its request rather than logging a second row.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].id === requestId) {
        list[i].status = Number((response && response.status) || 0);
        return;
      }
    }
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (source && typeof source.tabId === 'number') attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId);
  cursorAt.delete(tabId);
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  if (currentTabId === tabId) {
    currentTabId = null;
    currentTabLoaded = true;
    chrome.storage.session.remove(CURRENT_TAB_KEY).catch(() => {});
  }
});

/** Send one CDP command on a tab. */
async function cdp(tabId, method, params) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
}

/**
 * Evaluate an expression in the page and return its JSON value. `userGesture`
 * is set so pages that gate behaviour behind a real interaction still work.
 */
async function evaluate(tabId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const thrown = details.exception && (details.exception.description || details.exception.value);
    const text = String(thrown || details.text || 'unknown');
    // The expression is evaluated inside parentheses, so a statement list is a
    // parse error rather than a runtime one. Say so instead of echoing back a
    // bare SyntaxError the caller cannot act on.
    const isSyntax = (details.exception && details.exception.className === 'SyntaxError')
      || text.indexOf('SyntaxError') !== -1;
    if (isSyntax) {
      throw new Error('the expression did not parse — chrome_eval takes a single expression; '
        + 'wrap statements in (function () { ... })() (' + text + ')');
    }
    throw new Error('page error: ' + text);
  }
  return result && result.result ? result.result.value : undefined;
}

// ------------------------------------------------------- agent cursor ---

/** The overlay's element id. Deliberately ours, and greppable. */
const CURSOR_ID = 'dsh-agent-cursor';

/**
 * A pointer the human can watch. Purely presentational: `pointer-events: none`,
 * `aria-hidden`, and it never dispatches anything — the click comes from CDP
 * either way. It is injected through the debugger rather than shipped as a
 * content script, so it costs no host permission and cannot outlive the agent.
 */
const CURSOR_ACCENT = '#7AA2F7';
const CURSOR_GLOW = 'rgba(122,162,247,0.85)';
const CURSOR_HALO = 'rgba(122,162,247,0.50)';

/**
 * Evaluate an expression and keep the result as a remote object handle.
 * DOM.setFileInputFiles addresses an element by objectId, not by value, so the
 * file input has to be evaluated with returnByValue off.
 */
async function evaluateHandle(tabId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    returnByValue: false,
    awaitPromise: true,
    userGesture: true,
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const thrown = details.exception && (details.exception.description || details.exception.value);
    throw new Error('page error: ' + String(thrown || details.text || 'unknown'));
  }
  const remote = result && result.result;
  if (!remote || remote.subtype === 'null' || typeof remote.objectId !== 'string') return null;
  return remote.objectId;
}

/** Page-side: create the cursor if absent, then move it and fade it in. */
function cursorExpression(x, y) {
  // The coordinates must be interpolated into the page code. Referencing a bare
  // x there is a ReferenceError, and because the element is appended before the
  // move, that leaves a cursor frozen at its initial off-screen position.
  const transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  return [
    '(function () {',
    '  var id = ' + JSON.stringify(CURSOR_ID) + ';',
    '  var el = document.getElementById(id);',
    '  if (!el) {',
    '    var ns = "http://www.w3.org/2000/svg";',
    '    el = document.createElement("div");',
    '    el.id = id;',
    '    el.setAttribute("aria-hidden", "true");',
    '    el.style.cssText = "position:fixed;top:0;left:0;width:22px;height:28px;pointer-events:none;"',
    '      + "z-index:2147483647;opacity:0;will-change:transform;"',
    '      + "transform:translate3d(-200px,-200px,0);"',
    '      + "transition:transform 180ms cubic-bezier(0.2,0,0,1),opacity 140ms ease;";',
    '    var halo = document.createElement("div");',
    '    halo.style.cssText = "position:absolute;left:-9px;top:-9px;width:30px;height:30px;border-radius:50%;"',
    '      + "background:radial-gradient(circle, " + ' + JSON.stringify(CURSOR_HALO) + ' + " 0%, rgba(0,0,0,0) 70%);"',
    '      + "animation:dsh-agent-pulse 1.6s ease-in-out infinite;";',
    '    var svg = document.createElementNS(ns, "svg");',
    '    svg.setAttribute("width", "22");',
    '    svg.setAttribute("height", "28");',
    '    svg.setAttribute("viewBox", "0 0 20 26");',
    '    svg.style.cssText = "position:absolute;top:0;left:0;overflow:visible;"',
    '      + "filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) drop-shadow(0 0 6px " + ' + JSON.stringify(CURSOR_GLOW) + ' + ");";',
    '    var shape = function (fill, stroke, width) {',
    '      var p = document.createElementNS(ns, "path");',
    '      p.setAttribute("d", "M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z");',
    '      p.setAttribute("fill", fill);',
    '      p.setAttribute("stroke", stroke);',
    '      p.setAttribute("stroke-width", width);',
    '      p.setAttribute("stroke-linejoin", "round");',
    '      return p;',
    '    };',
    '    svg.appendChild(shape(' + JSON.stringify(CURSOR_ACCENT) + ', "#FFFFFF", 3));',
    '    svg.appendChild(shape(' + JSON.stringify(CURSOR_ACCENT) + ', ' + JSON.stringify(CURSOR_ACCENT) + ', 1));',
    '    el.appendChild(halo);',
    '    el.appendChild(svg);',
    '    var style = document.createElement("style");',
    '    style.textContent = "@keyframes dsh-agent-pulse{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:.35;transform:scale(1.25)}}";',
    '    el.appendChild(style);',
    '    (document.body || document.documentElement).appendChild(el);',
    '  }',
    '  el.style.transition = "transform 180ms cubic-bezier(0.2,0,0,1),opacity 140ms ease";',
    '  el.style.transform = ' + JSON.stringify(transform) + ';',
    '  el.style.opacity = "1";',
    '  return "ok";',
    '})()',
  ].join('\n');
}

/**
 * Page-side: hide the cursor without removing it, so it can return.
 *
 * The transition is switched off for the hide. Fading out would leave the
 * overlay partially painted for the next 140ms, which is precisely the window a
 * screenshot is taken in; the transition is restored when the cursor returns.
 */
function hideCursorExpression() {
  return '(function () { var el = document.getElementById(' + JSON.stringify(CURSOR_ID)
    + '); if (el) { el.style.transition = "none"; el.style.opacity = "0"; void el.offsetWidth; }'
    + ' return "ok"; })()';
}

// ---------------------------------------------------------- page code ---

/** The elements a snapshot reports, in document order. */
const INTERESTING = 'a[href],button,input,select,textarea,summary,[contenteditable=true],'
  + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],'
  + '[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=treeitem]';

/**
 * Page-side snapshot builder. Refs are positions in a fresh array on the page,
 * so a ref is only valid until the next snapshot — the same contract every
 * browser agent uses, and the reason chrome_click is told to snapshot first.
 */
const SNAPSHOT_EXPRESSION = [
  '(function () {',
  '  var refs = [];',
  '  window.__dshChromeRefs = refs;',
  '  var lines = [];',
  '  var nodes = document.querySelectorAll(' + JSON.stringify(INTERESTING) + ');',
  '  function visible(el) {',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width < 1 || r.height < 1) return false;',
  '    var style = window.getComputedStyle(el);',
  '    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";',
  '  }',
  '  function label(el) {',
  '    var text = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title")' + '\n' + '      || el.getAttribute("alt") || el.getAttribute("name") || el.value || el.innerText || "";',
  '    return String(text).replace(/\\s+/g, " ").trim().slice(0, 120);',
  '  }',
  '  for (var i = 0; i < nodes.length && refs.length < 400; i++) {',
  '    var el = nodes[i];',
  '    if (!visible(el)) continue;',
  '    refs.push(el);',
  '    var ref = refs.length;',
  '    var kind = el.getAttribute("role") || el.tagName.toLowerCase();',
  '    var type = el.getAttribute("type");',
  '    if (type) kind += "[" + type + "]";',
  '    var extra = el.tagName === "A" && el.href ? " -> " + el.href : "";',
  '    var disabled = el.disabled ? " (disabled)" : "";',
  '    lines.push("[ref=" + ref + "] " + kind + " \\"" + label(el) + "\\"" + extra + disabled);',
  '  }',
  '  var body = document.body ? document.body.innerText : "";',
  '  var head = String(body).replace(/\\s+/g, " ").trim().slice(0, 1500);',
  '  return JSON.stringify({',
  '    url: location.href,',
  '    title: document.title,',
  '    text: head,',
  '    tree: lines.join("\\n")',
  '  });',
  '})()',
].join('\n');

/**
 * Page-side resolver: an element ref, a CSS selector, or explicit coordinates.
 *
 * `prefix` names the argument group, so a drag can resolve a `from` and a `to`
 * with the same code (`fromRef`/`fromSelector`/`fromX`/`fromY`, and so on). An
 * empty prefix is the plain `ref`/`selector`/`x`/`y` form.
 *
 * @param params - the command's arguments.
 * @param prefix - '', 'from' or 'to' (capitalised internally).
 * @returns the page expression, whose value is a point, or null.
 */
function pointExpressionFor(params, prefix) {
  const cap = prefix === '' ? '' : prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const selector = typeof params[prefix === '' ? 'selector' : prefix + 'Selector'] === 'string'
    ? params[prefix === '' ? 'selector' : prefix + 'Selector']
    : null;
  const ref = typeof params[prefix === '' ? 'ref' : prefix + 'Ref'] === 'number'
    ? params[prefix === '' ? 'ref' : prefix + 'Ref']
    : null;
  const fixedX = typeof params[prefix === '' ? 'x' : prefix + 'X'] === 'number'
    ? params[prefix === '' ? 'x' : prefix + 'X']
    : null;
  const fixedY = typeof params[prefix === '' ? 'y' : prefix + 'Y'] === 'number'
    ? params[prefix === '' ? 'y' : prefix + 'Y']
    : null;
  if (fixedX !== null && fixedY !== null) {
    return '(function () { return { x: ' + Math.round(fixedX) + ', y: ' + Math.round(fixedY)
      + ', label: "coordinates ' + Math.round(fixedX) + ',' + Math.round(fixedY) + '" }; })()';
  }
  void cap;
  return [
    '(function () {',
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '  el = null;',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (!el) return null;',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  var r = el.getBoundingClientRect();',
    '  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),',
    '           label: (el.getAttribute("aria-label") || el.innerText || el.tagName).slice(0, 80) };',
    '})()',
  ].join('\n');
}

/** The plain single-target resolver used by click, hover and type. */
function pointExpression(params) {
  return pointExpressionFor(params, '');
}

/** Page-side focus resolver for chrome_type. */
function focusExpression(params) {
  const selector = typeof params.selector === 'string' ? params.selector : null;
  const ref = typeof params.ref === 'number' ? params.ref : null;
  return [
    '(function () {',
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '  el = null;',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (el) { el.focus(); if (el.select && el.value !== undefined) el.select(); return true; }',
    '  return document.activeElement !== document.body;',
    '})()',
  ].join('\n');
}

/** Page-side: scroll an element (by ref or selector) into view. */
function scrollToExpression(params) {
  const selector = typeof params.selector === 'string' ? params.selector : null;
  const ref = typeof params.ref === 'number' ? params.ref : null;
  return [
    '(function () {',
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '  el = null;',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (!el) return false;',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  return true;',
    '})()',
  ].join('\n');
}

/** Page-side: scroll the window by a pixel delta. */
function scrollByExpression(deltaX, deltaY) {
  return 'window.scrollBy(' + Math.round(deltaX) + ', ' + Math.round(deltaY) + ')';
}

/**
 * Page-side: the readable text of the page.
 *
 * Prefers the article body over the whole document, because a page's own nav,
 * cookie banner and footer are most of its length and none of its content.
 */
const PAGE_TEXT_EXPRESSION = [
  '(function () {',
  '  var pick = document.querySelector("article") || document.querySelector("main")'
  + ' || document.querySelector("[role=main]") || document.body;',
  '  if (!pick) return JSON.stringify({ url: location.href, title: document.title, text: "", truncated: false });',
  '  var clone = pick.cloneNode(true);',
  '  var drop = clone.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,svg,iframe");',
  '  for (var i = 0; i < drop.length; i++) drop[i].remove();',
  '  var text = String(clone.innerText || clone.textContent || "");',
  '  text = text.replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();',
  '  return JSON.stringify({',
  '    url: location.href, title: document.title,',
  '    text: text.slice(0, 24000), truncated: text.length > 24000',
  '  });',
  '})()',
].join('\n');

/** Page-side: count and quote a string in the rendered text, scrolling to it. */
function findExpression(needle) {
  return [
    '(function () {',
    '  var needle = ' + JSON.stringify(needle) + ';',
    '  var text = document.body ? document.body.innerText : "";',
    '  var lower = text.toLowerCase();',
    '  var target = needle.toLowerCase();',
    '  var count = 0, at = 0, firstAt = -1, matches = [];',
    '  while (true) {',
    '    var hit = lower.indexOf(target, at);',
    '    if (hit === -1) break;',
    '    if (firstAt === -1) firstAt = hit;',
    '    count++;',
    '    if (matches.length < 20) {',
    '      matches.push(text.slice(Math.max(0, hit - 60), hit + needle.length + 60).replace(/\\s+/g, " ").trim());',
    '    }',
    '    at = hit + target.length;',
    '  }',
    '  if (firstAt !== -1) {',
    '    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);',
    '    var seen = 0, node = walker.nextNode();',
    '    while (node) {',
    '      var length = node.nodeValue ? node.nodeValue.length : 0;',
    '      if (seen + length > firstAt) {',
    '        try {',
    '          var range = document.createRange();',
    '          var startAt = Math.max(0, firstAt - seen);',
    '          range.setStart(node, startAt);',
    '          range.setEnd(node, Math.min(length, startAt + needle.length));',
    '          window.scrollBy(0, range.getBoundingClientRect().top - window.innerHeight / 2);',
    '        } catch (error) { /* the node moved under us */ }',
    '        break;',
    '      }',
    '      seen += length;',
    '      node = walker.nextNode();',
    '    }',
    '  }',
    '  return JSON.stringify({ count: count, matches: matches });',
    '})()',
  ].join('\n');
}

/** Page-side: resolve the file input to upload into. */
function uploadTargetExpression(params) {
  const selector = typeof params.selector === 'string' ? params.selector : null;
  const ref = typeof params.ref === 'number' ? params.ref : null;
  return [
    '(function () {',
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '  el = null;',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (!el) el = document.querySelector("input[type=file]");',
    '  if (!el || el.tagName !== "INPUT" || el.type !== "file") return null;',
    '  return el;',
    '})()',
  ].join('\n');
}

// --------------------------------------------------------- key names ---

/** Named keys the tools may press, as CDP key descriptors. */
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};

/**
 * Editing commands for the chords a background tab does not honour as plain
 * keystrokes. A background document has no browser-level focus, so Ctrl+A
 * reaches the page but never reaches the editing layer; `commands` runs the
 * edit directly. (Measured: a selection of 0 without this, 11 with it.)
 */
const EDIT_COMMANDS = { a: 'SelectAll', c: 'Copy', v: 'Paste', x: 'Cut', z: 'Undo', y: 'Redo' };

/** Ctrl/Alt/Meta/Shift modifier masks (CDP uses the DOM bitfield). */
const MODIFIERS = { alt: 1, control: 2, meta: 4, shift: 8 };

/**
 * Translate one chord such as "Control+a" or "PageDown" into CDP key
 * parameters. A single printable character is typed as itself.
 */
function keyDescriptor(chord) {
  const parts = String(chord).split('+').map(p => p.trim()).filter(p => p !== '');
  let mask = 0;
  while (parts.length > 1) {
    const modifier = MODIFIERS[parts[0].toLowerCase()];
    if (modifier === undefined) break;
    mask |= modifier;
    parts.shift();
  }
  const name = parts.join('+');
  const named = NAMED_KEYS[name] || NAMED_KEYS[name.charAt(0).toUpperCase() + name.slice(1)];
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      modifiers: mask,
      // A chord must not also carry the key's text, or the character would be
      // typed as well as the shortcut being triggered.
      text: mask === 0 ? (named.text || '') : '',
      commands: [],
    };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const editing = (mask & (MODIFIERS.control | MODIFIERS.meta)) !== 0
      ? EDIT_COMMANDS[name.toLowerCase()]
      : undefined;
    return {
      key: name,
      code: 'Key' + upper,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers: mask,
      text: mask === 0 ? name : '',
      commands: editing === undefined ? [] : [editing],
    };
  }
  throw new Error('unsupported key: ' + chord);
}

/** Where the cursor sits per tab, so a capture can put it back afterwards. */
const cursorAt = new Map();

/** Paint the cursor at a point. A page that cannot take it is not an error. */
async function paintCursor(tabId, x, y) {
  cursorAt.set(tabId, { x: x, y: y });
  try { await evaluate(tabId, cursorExpression(x, y)); } catch (error) { /* navigated or blocked */ }
}

/** Fade the cursor out for the duration of an action or a capture. */
async function hideCursor(tabId) {
  try { await evaluate(tabId, hideCursorExpression()); } catch (error) { /* ignore */ }
}

// ------------------------------------------------------- agent group ---

/**
 * The agent's own tab group. Every tab the agent opens joins it, so its work is
 * visually separated from the pages the user is reading, and can be collapsed or
 * closed as one thing.
 */
const GROUP_TITLE = 'DSH Chrome Agent';
const GROUP_COLOR = 'blue';
let agentGroupId = null;

/** Whether the title lookup has already run in this worker's life. */
let agentGroupLookupDone = false;

/**
 * The agent's tab group, found again after a worker restart.
 *
 * agentGroupId is in memory only, so an evicted worker comes back without it. The
 * group itself outlives the worker and is the one wearing GROUP_TITLE, so it can be
 * found rather than duplicated.
 */
async function agentGroup() {
  if (agentGroupId !== null) return agentGroupId;
  if (agentGroupLookupDone) return null;
  agentGroupLookupDone = true;
  try {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (groups.length > 0 && typeof groups[0].id === 'number') agentGroupId = groups[0].id;
  } catch (error) {
    // A browser without tab groups still works, ungrouped.
  }
  return agentGroupId;
}

/** Put a freshly opened tab into the agent group, creating it on first use. */
async function groupTab(tabId) {
  try {
    const existing = await agentGroup();
    if (existing !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
        return;
      } catch (error) {
        // The group vanished with its last tab; fall through and make a new one.
        agentGroupId = null;
      }
    }
    agentGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(agentGroupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
  } catch (error) {
    // Grouping is presentation; a browser without it must still work.
  }
}

/** Reject if a CDP call does not answer in time. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms)),
  ]);
}

/**
 * Make sure a tab has a live renderer. Chrome discards background tabs to save
 * memory, and a discarded tab has nothing to screenshot or evaluate against, so
 * the call would hang until it timed out.
 */
async function ensureLive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.discarded) return;
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId, 20000);
}

/** Add the agent group to a tab listing, and whether the agent may act on it. */
function withGroup(tab, agentGroupId) {
  const groupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    active: tab.active === true,
    groupId: groupId,
    agent: agentGroupId !== null && groupId === agentGroupId,
  };
}

// -------------------------------------------------------- commands ---

/** Wait until a tab reports complete, or give up. */
function waitForLoad(tabId, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (changedId, info) => {
      if (changedId === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // The load can finish between the navigation call and this listener, and
    // a tab that is already complete never fires another update — without
    // this read the call would sit here for the whole timeout.
    chrome.tabs.get(tabId).then(
      tab => { if (tab && tab.status === 'complete') finish(); },
      () => { /* the tab went away; the timeout settles it */ },
    );
  });
}

async function describeTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId: tabId, url: tab.url || '', title: tab.title || '' };
}

/** The command table. Every method answers one JSON value. */
const COMMANDS = {

  async tabs() {
    const tabs = await chrome.tabs.query({});
    const groupId = await agentGroup();
    return tabs.filter(tab => typeof tab.id === 'number').map(tab => withGroup(tab, groupId));
  },

  async open(params) {
    const url = typeof params.url === 'string' ? params.url : '';
    if (!/^https?:\/\//i.test(url)) throw new Error('chrome_open needs an absolute http(s) url');
    let tabId;
    if (params.newTab === true) {
      // Deliberately not activated. The agent works in the background so the
      // user's view never moves; the tab still loads and is still drivable,
      // and the user can watch it by opening the agent's tab group.
      const created = await chrome.tabs.create({ url: url, active: false });
      tabId = created.id;
      if (typeof tabId === 'number') await groupTab(tabId);
    } else {
      tabId = await resolveTabId(params.tabId);
      await chrome.tabs.update(tabId, { url: url });
    }
    if (typeof tabId !== 'number') throw new Error('could not determine the target tab');
    rememberTab(tabId);
    await waitForLoad(tabId, 20000);
    return describeTab(tabId);
  },

  async snapshot(params) {
    const tabId = await resolveTabId(params.tabId);
    const raw = await evaluate(tabId, SNAPSHOT_EXPRESSION);
    const parsed = JSON.parse(String(raw));
    const tree = parsed.tree === '' ? '(no interactive elements found)' : parsed.tree;
    return {
      url: parsed.url,
      title: parsed.title,
      snapshot: tree + '\n\n--- visible text ---\n' + parsed.text,
    };
  },

  async click(params) {
    const tabId = await resolveTabId(params.tabId);
    let x = typeof params.x === 'number' ? params.x : null;
    let y = typeof params.y === 'number' ? params.y : null;
    let label = 'coordinates ' + x + ',' + y;
    if (x === null || y === null) {
      const point = await evaluate(tabId, pointExpression(params));
      if (!point) throw new Error('click target not found — take a fresh chrome_snapshot and use its ref');
      x = point.x;
      y = point.y;
      label = point.label;
    }
    // Out of the way first. The click itself is CDP input and never touches the
    // overlay; hiding it just keeps the overlay out of whatever frame is
    // captured next, and shows the human the page rather than the pointer.
    // Out of the way first. The click itself is CDP input and never touches the
    // overlay; hiding it just keeps the overlay out of whatever frame is
    // captured next, and shows the human the page rather than the pointer.
    await hideCursor(tabId);
    await new Promise(resolve => setTimeout(resolve, 50));
    const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left';
    // The pressed-buttons mask is a bitfield: 1 left, 2 right, 4 middle.
    const held = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    const clicks = params.clicks === 3 ? 3 : params.clicks === 2 ? 2 : 1;
    const at = { x: x, y: y, modifiers: 0, button: button };
    await cdp(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', buttons: 0, force: 0 }, at, { button: 'none' }));
    for (let count = 1; count <= clicks; count += 1) {
      await cdp(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', buttons: held, clickCount: count, force: 0.5 }, at));
      await cdp(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', buttons: 0, clickCount: count, force: 0 }, at));
    }
    await paintCursor(tabId, x, y);
    return { clicked: label + (button === 'left' && clicks === 1 ? '' : ' [' + button + ' x' + clicks + ']') };
  },

  async hover(params) {
    const tabId = await resolveTabId(params.tabId);
    const point = await evaluate(tabId, pointExpression(params));
    if (!point) throw new Error('hover target not found — take a fresh chrome_snapshot and use its ref');
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, force: 0, modifiers: 0,
    });
    await paintCursor(tabId, point.x, point.y);
    return { hovered: point.label };
  },

  async drag(params) {
    const tabId = await resolveTabId(params.tabId);
    const start = await evaluate(tabId, pointExpressionFor(params, 'from'));
    const end = await evaluate(tabId, pointExpressionFor(params, 'to'));
    if (!start || !end) {
      throw new Error('drag needs a from and a to target (fromRef/fromSelector or fromX+fromY, and the same for to)');
    }
    await hideCursor(tabId);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, modifiers: 0 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, force: 0.5, modifiers: 0 });
    // Interpolate: a drag handler that only sees press then release at the far
    // end usually ignores it, because no intermediate move ever fired.
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(start.x + (end.x - start.x) * i / steps),
        y: Math.round(start.y + (end.y - start.y) * i / steps),
        button: 'left', buttons: 1, modifiers: 0,
      });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, force: 0, modifiers: 0 });
    await paintCursor(tabId, end.x, end.y);
    return { dragged: start.label + ' -> ' + end.label };
  },

  async scroll(params) {
    const tabId = await resolveTabId(params.tabId);
    const hasTarget = typeof params.ref === 'number' || typeof params.selector === 'string';
    if (hasTarget) {
      const moved = await evaluate(tabId, scrollToExpression(params));
      if (moved !== true) throw new Error('scroll target not found — take a fresh chrome_snapshot');
      return { scrolled: 'element into view' };
    }
    const deltaY = typeof params.deltaY === 'number' ? Math.round(params.deltaY) : 600;
    const deltaX = typeof params.deltaX === 'number' ? Math.round(params.deltaX) : 0;
    // A wheel event needs a position to be dispatched at; the viewport centre is
    // the one point guaranteed to be over the document.
    const centre = await evaluate(tabId, 'JSON.stringify({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })');
    const point = JSON.parse(String(centre));
    try {
      // Chrome only answers wheel input when the compositor is actually
      // rendering the tab; on a background tab the call never acks and would
      // cost the caller its whole timeout. Bounded, so falling back is cheap.
      await withTimeout(cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX: deltaX, deltaY: deltaY,
        button: 'none', buttons: 0, modifiers: 0,
      }), 1500);
      return { scrolled: 'wheel ' + deltaX + ',' + deltaY };
    } catch (error) {
      // A hidden tab gets no wheel, so scroll it directly instead of moving the
      // user's view to the tab.
      await evaluate(tabId, scrollByExpression(deltaX, deltaY));
      return { scrolled: 'scripted ' + deltaX + ',' + deltaY };
    }
  },

  async pageText(params) {
    const tabId = await resolveTabId(params.tabId);
    return JSON.parse(String(await evaluate(tabId, PAGE_TEXT_EXPRESSION)));
  },

  async find(params) {
    const tabId = await resolveTabId(params.tabId);
    const needle = typeof params.text === 'string' ? params.text : '';
    if (needle === '') throw new Error('find needs some text to look for');
    return JSON.parse(String(await evaluate(tabId, findExpression(needle))));
  },

  async console(params) {
    const tabId = await resolveTabId(params.tabId);
    const entries = consoleByTab.get(tabId) || [];
    // One-shot by default: the caller reads what has happened since it last
    // looked, which is what makes this usable in a loop.
    if (params.keep !== true) consoleByTab.set(tabId, []);
    return { entries: entries.map(entry => ({ level: entry.level, text: entry.text })) };
  },

  async network(params) {
    const tabId = await resolveTabId(params.tabId);
    const entries = networkByTab.get(tabId) || [];
    if (params.keep !== true) networkByTab.set(tabId, []);
    return {
      entries: entries.map(entry => ({
        method: entry.method, url: entry.url, type: entry.type, status: entry.status,
      })),
    };
  },

  async resize(params) {
    const tabId = await resolveTabId(params.tabId);
    const width = Number(params.width);
    const height = Number(params.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new Error('resize needs a non-negative width and height');
    }
    if (width === 0 || height === 0) {
      await cdp(tabId, 'Emulation.clearDeviceMetricsOverride', {});
      return { resized: 'cleared' };
    }
    // Emulation rather than chrome.windows.update: it changes the layout the page
    // sees without moving the window the user is working in.
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: typeof params.scale === 'number' ? params.scale : 0,
      mobile: params.mobile === true,
    });
    return { resized: Math.round(width) + 'x' + Math.round(height) };
  },

  async upload(params) {
    const tabId = await resolveTabId(params.tabId);
    const files = Array.isArray(params.files)
      ? params.files.filter(file => typeof file === 'string' && file !== '')
      : [];
    if (files.length === 0) throw new Error('upload needs at least one absolute path in `files`');
    const objectId = await evaluateHandle(tabId, uploadTargetExpression(params));
    if (objectId === null) throw new Error('no file input found — pass a ref or selector for the input[type=file]');
    await cdp(tabId, 'DOM.setFileInputFiles', { files: files, objectId: objectId });
    return { uploaded: files.length };
  },

  async type(params) {
    const tabId = await resolveTabId(params.tabId);
    const text = typeof params.text === 'string' ? params.text : '';
    if (text !== '') {
      const focused = await evaluate(tabId, focusExpression(params));
      if (focused !== true) throw new Error('no element to type into — pass a ref or selector');
      await cdp(tabId, 'Input.insertText', { text: text });
    }
    const submit = params.submit === true;
    if (submit) await COMMANDS.key({ key: 'Enter', tabId: tabId });
    return { typed: text !== '', submitted: submit };
  },

  async key(params) {
    const tabId = await resolveTabId(params.tabId);
    // Chrome delivers no key events to a tab that is not visible: the renderer
    // has no focused frame and drops them silently (measured: zero keydowns
    // reached the page on a background tab, and the selection never changed).
    // Text entry is unaffected, because Input.insertText takes a different
    // path — so a key press is the ONE action that brings its tab forward.
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const descriptor = keyDescriptor(params.key);
    const shared = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers: descriptor.modifiers,
      location: 0,
      isKeypad: false,
    };
    // rawKeyDown for a key that produces no text; keyDown otherwise. Chrome
    // treats the two differently and a raw event is what a shortcut is.
    const down = Object.assign({}, shared, { type: descriptor.text === '' ? 'rawKeyDown' : 'keyDown' });
    // text and commands are mutually exclusive in the protocol.
    if (descriptor.text !== '') {
      down.text = descriptor.text;
      down.unmodifiedText = descriptor.text;
    } else if (descriptor.commands.length > 0) {
      down.commands = descriptor.commands;
    }
    await cdp(tabId, 'Input.dispatchKeyEvent', down);
    await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({}, shared, { type: 'keyUp' }));
    return { pressed: String(params.key) };
  },

  async eval(params) {
    const tabId = await resolveTabId(params.tabId);
    const expression = typeof params.expression === 'string' ? params.expression : '';
    if (expression === '') throw new Error('chrome_eval needs an expression');
    const wrapped = [
      '(function () {',
      '  try {',
      '    var value = (' + expression + ');',
      '    if (value === undefined) return "undefined";',
      '    return JSON.stringify(value);',
      '  } catch (error) { return "Error: " + (error && error.message); }',
      '})()',
    ].join('\n');
    const result = await evaluate(tabId, wrapped);
    return { result: String(result) };
  },

  async close(params) {
    const tabId = typeof params.tabId === 'number' ? params.tabId : null;
    if (tabId === null) throw new Error('close needs a tabId');
    await assertTabAllowed(tabId);
    attached.delete(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async screenshot(params) {
    const tabId = await resolveTabId(params.tabId);
    await ensureLive(tabId);
    // The model gets the page, not our pointer: hide the overlay, capture, then
    // put it back where the human last saw it.
    await hideCursor(tabId);
    // The style is committed, but the compositor still holds the previous frame
    // for a beat; capture would otherwise catch the overlay mid-flight.
    await new Promise(resolve => setTimeout(resolve, 60));
    let shot = null;
    try {
      // A background tab is the normal case: the agent must not move the user's
      // view to see a page. Bounded, so a frozen renderer cannot hang the call.
      shot = await withTimeout(
        cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }),
        8000,
      );
    } catch (error) {
      // Only when the background capture genuinely cannot be produced do we
      // take the view — a last resort, not the default.
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(resolve => setTimeout(resolve, 400));
      shot = await cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
    }
    const last = cursorAt.get(tabId);
    if (last) await paintCursor(tabId, last.x, last.y);
    if (!shot || typeof shot.data !== 'string') throw new Error('the page returned no image data');
    return { base64: shot.data };
  },
};

/** Dispatch one command by name. */
async function runCommand(method, params) {
  const handler = COMMANDS[method];
  if (typeof handler !== 'function') throw new Error('unknown command: ' + String(method));
  return handler(params);
}

// -------------------------------------------------------- lifecycle ---

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message && message.type === 'reconnect') {
    if (socket) { try { socket.close(); } catch (error) { /* ignore */ } }
    socket = null;
    connect();
    respond({ ok: true });
  }
  return true;
});

connect();
