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
const chooseJpegAttempt = PURE.chooseJpegAttempt;
const isTabAllowed = PURE.isTabAllowed;
const pointInViewport = PURE.pointInViewport;
const sumFrameOffsets = PURE.sumFrameOffsets;
const framePointToViewport = PURE.framePointToViewport;

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
  const message = error && typeof error.message === 'string' && error.message !== '' ? error.message : String(error);
  if (/detached/i.test(message) && lastDetach && Date.now() - lastDetach.at < 5000) {
    // 'canceled_by_user' is the user pressing Cancel on Chrome's debugging
    // banner; 'target_closed' is the tab or its renderer going away.
    return message + ' (Chrome detached the debugger from tab ' + lastDetach.tabId + ': ' + lastDetach.reason + ')';
  }
  return message;
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
      // A rememberTab can land during the await above; re-check so its tab is
      // not overwritten by the stored one now that the read has finished.
      if (currentTabLoaded) return;
      currentTabId = storedId;
    } catch (error) {
      // This catch is part of the same read: a rememberTab can land during the
      // chrome.tabs.get await above, and its newer claim must not be cleared
      // just because the stored tab turned out to be gone.
      if (currentTabLoaded) return;
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
  // Fail closed like isTabAllowed: any truthy stored value confines, so a
  // non-boolean '1' or 'true' cannot slip past this gate before the predicate.
  if (!stored.confineToAgentTabs) return;
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
/** Attaches in flight, so callers that race for one tab share a single attach. */
const attaching = new Map();

/**
 * Attach to a tab once, however many callers ask at the same moment. Two
 * overlapping chrome.debugger.attach calls for one tab can fail the second as
 * "another debugger", which recovery from a locked tab made likely: its loop,
 * a retried command and the next command can all re-attach together.
 */
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const attempt = attachTab(tabId);
  attaching.set(tabId, attempt);
  try {
    await attempt;
  } finally {
    attaching.delete(tabId);
  }
}

async function attachTab(tabId) {
  const target = { tabId: tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (error) {
    const message = describe(error);
    if (/another debugger/i.test(message)) {
      // Chrome also says "Another debugger is already attached" when the
      // attachment it means is this extension's own — seen intermittently while
      // recovering a locked tab. If a command goes through, it is ours.
      let ours = false;
      try {
        await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: '1' });
        ours = true;
      } catch (probeError) {
        // Locked by another extension's frame: let cdp() recover it.
        if (/URL of different extension/.test(describe(probeError))) throw probeError;
        ours = false;
      }
      if (!ours) throw new Error('another debugger (DevTools or another extension) already holds tab ' + tabId);
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
  // Focus emulation makes Chrome render a background tab as if it were shown,
  // and a rendered tab is one trusted input reaches. Measured in
  // test/probe-background-input.mjs: without it a background tab dropped the
  // click and the first mouse event stalled ~5s; with it click, key and wheel
  // landed in milliseconds, in a background tab, in a collapsed group and in a
  // minimised window — without the user's view ever moving.
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (error) {
    // ensureInputReady reports a tab that is still not rendering.
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
 * Dialogs answered since they were last reported, and how the running command
 * asked for them to be answered. The commands that can open one report these
 * in their result; see DIALOG_COMMANDS.
 */
const dialogLog = [];
let dialogChoice = null;

/**
 * Answer a JavaScript dialog the way the running command asked, or by default
 * the way that loses nothing: an alert has only OK; a confirm, a prompt and a
 * leave-page warning are dismissed, so a "Delete forever?" or an unsaved-changes
 * warning is never agreed to unasked. The model learns of every dialog either way.
 */
function answerDialog(tabId, params) {
  const type = String((params && params.type) || 'alert');
  const asked = dialogChoice ? dialogChoice.dialog : undefined;
  const accept = asked === 'accept' ? true : asked === 'dismiss' ? false : type === 'alert';
  const reply = { accept: accept };
  if (accept && type === 'prompt') {
    reply.promptText = dialogChoice && typeof dialogChoice.promptText === 'string'
      ? dialogChoice.promptText
      : String((params && params.defaultPrompt) || '');
  }
  dialogLog.push({ tabId: tabId, type: type, message: String((params && params.message) || '').slice(0, 300), accepted: accept });
  if (dialogLog.length > 50) dialogLog.splice(0, dialogLog.length - 50);
  chrome.debugger.sendCommand({ tabId: tabId }, 'Page.handleJavaScriptDialog', reply)
    .catch(() => { /* the page closed it first */ });
}

/**
 * Everything the debugger reports for a tab.
 *
 * A dialog owns the renderer's main thread, so leaving one up is
 * indistinguishable from a hung tab, and it is answered at once; console and
 * network events are the observation log the read_console / read_network
 * commands serve back.
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') return;
  const tabId = source.tabId;

  if (method === 'Page.javascriptDialogOpening') {
    answerDialog(tabId, params);
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

/** Why Chrome last dropped an attachment, for an error that otherwise says only "Detached". */
let lastDetach = null;

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && typeof source.tabId === 'number') attached.delete(source.tabId);
  lastDetach = { tabId: source && source.tabId, reason: String(reason), at: Date.now() };
});
chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId);
  cursorAt.delete(tabId);
  resizedTabs.delete(tabId);
  consoleByTab.delete(tabId);
  networkByTab.delete(tabId);
  if (currentTabId === tabId) {
    currentTabId = null;
    currentTabLoaded = true;
    chrome.storage.session.remove(CURRENT_TAB_KEY).catch(() => {});
  }
});

/** Send one CDP command on a tab. */
async function cdpOnce(tabId, method, params, reattached) {
  const started = Date.now();
  try {
    await ensureAttached(tabId);
    return await chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
  } catch (error) {
    // Chrome dropped the attachment before onDetach told us: the command never
    // ran, so attach again and send it once more.
    if (!reattached && /Debugger is not attached/i.test(describe(error))) {
      attached.delete(tabId);
      return cdpOnce(tabId, method, params, true);
    }
    // Chrome's own text ("Detached while handling command.") says neither which
    // call failed nor after how long; one click makes eight calls.
    const which = method + (params && typeof params.type === 'string' ? '(' + params.type + ')' : '');
    const failure = new Error(which + ' failed after ' + (Date.now() - started) + 'ms: ' + describe(error));
    failure.refusedForForeignFrame = /URL of different extension/.test(describe(error));
    failure.interrupted = /Detached while handling command/.test(describe(error));
    throw failure;
  }
}

/**
 * One CDP call, recovering a tab another extension's frame has locked.
 *
 * Chrome refuses a command to such a tab before running it, so after the frame
 * is released the same command is sent once more. "Detached while handling
 * command" is how the lock often begins, and by then the command may already
 * have run: it is sent again only when running it twice is harmless — not real
 * input, and not the model's own chrome_eval code (`userCode`), which is
 * reported so the model can decide.
 */
async function cdp(tabId, method, params, options) {
  try {
    return await cdpOnce(tabId, method, params);
  } catch (error) {
    if (!error.refusedForForeignFrame && !error.interrupted) throw error;
    const released = await releaseForeignFrame(tabId);
    if (!released.ok) throw new Error(error.message + FOREIGN_FRAME_NOTE + ', and it could not be cleared: ' + released.why);
    const unsafeTwice = method.startsWith('Input.') || (options && options.userCode === true);
    if (error.interrupted && unsafeTwice) {
      throw new Error(error.message + FOREIGN_FRAME_NOTE + '; it has been cleared, so repeat the action');
    }
    return cdpOnce(tabId, method, params);
  }
}

/** When each tab was last released from another extension's frame. */
const releasedAt = new Map();

/**
 * Get a tab back from another extension's frame, then wait until the debugger
 * can use it again. chrome.scripting is not locked, so both stages go through it.
 *
 * Measured with Bitwarden (test/probe-foreign-frame.mjs, probe-bitwarden-bar.mjs):
 * its autofill menu is injected as two randomly named custom elements under
 * <body>, each hiding its frame in a closed shadow root, and it locks every
 * debugger command out of the tab — Escape and clicks included. Its own code
 * force-closes the menu only on a window focusout while document.hasFocus() is
 * false, or on the page turning hidden, and focus emulation suppresses both.
 *
 * First, gently: a focus change, which let Bitwarden close the menu itself when
 * a field had just been focused (cleared in 0.13s). When the menu stays — it did
 * after a confirm() on a page that had a password typed into it, even with the
 * page hidden for over a second — the injected elements are removed: direct
 * children of <html> or <body> whose custom tag the page never defined, since an
 * extension defines its elements in its own isolated world. That gave the
 * debugger the tab back within 100ms and left the page's own content alone.
 */
async function releaseForeignFrame(tabId) {
  // What takes the password manager's frame down is a focus change. With focus
  // on <body> (measured after a confirm() closed) there is nothing to blur, so
  // a throwaway button off-screen takes focus and gives it up — a button, not an
  // input, because focusing an input is what brings an autofill menu in. Only
  // the top page gets the decoy: one inside an iframe would pull the page's
  // focus into that frame instead of producing the change.
  const blur = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.tagName !== 'IFRAME' && typeof active.blur === 'function') {
      active.blur();
      return;
    }
    if (window !== window.top) return;
    const decoy = document.createElement('button');
    decoy.tabIndex = -1;
    decoy.setAttribute('aria-hidden', 'true');
    decoy.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
    document.documentElement.appendChild(decoy);
    decoy.focus({ preventScroll: true });
    decoy.blur();
    decoy.remove();
  };
  const blurAll = async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, func: blur });
    } catch (error) {
      // A frame the extension cannot script must not stop the blur where it can.
      await chrome.scripting.executeScript({ target: { tabId: tabId }, func: blur });
    }
  };
  const removeInjected = () => {
    for (const parent of [document.documentElement, document.body]) {
      if (!parent) continue;
      for (const el of Array.from(parent.children)) {
        const tag = el.tagName.toLowerCase();
        if (tag.includes('-') && !customElements.get(tag)) el.remove();
      }
    }
  };
  let last = '';
  let blurredAt = 0;
  let removedAt = 0;
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try {
      if (blurredAt === 0) {
        await blurAll();
        blurredAt = Date.now();
      } else if (Date.now() - started >= 1000 && Date.now() - removedAt >= 1000) {
        // Main world: customElements there is the page's registry, not ours.
        await chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'MAIN', func: removeInjected });
        removedAt = Date.now();
      }
    } catch (error) {
      return { ok: false, why: 'the page could not be scripted (' + describe(error) + ')' };
    }
    try {
      await ensureAttached(tabId);
      await chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', { expression: '1' });
      releasedAt.set(tabId, Date.now());
      return { ok: true, why: '' };
    } catch (error) {
      last = describe(error);
      attached.delete(tabId);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return { ok: false, why: 'the tab was still locked 4s later, after taking focus off the field and removing the injected elements (' + last + ')' };
}

/**
 * Chrome refuses every debugger command to a tab that contains a frame from a
 * different extension, input and capture included. Measured with a login form:
 * focusing its username field made the user's password manager inject its
 * autofill menu, and the tab stayed locked until focus left the field. The
 * frame sits in a closed shadow root and webNavigation does not list another
 * extension's frames, so it cannot be named, only explained.
 */
const FOREIGN_FRAME_NOTE = ' — another extension (often a password manager\'s autofill menu) has put its own frame '
  + 'into this page, and Chrome blocks the debugger from the whole tab while it is there';

/**
 * Evaluate an expression in the page and return its JSON value. `userGesture`
 * is set so pages that gate behaviour behind a real interaction still work.
 * `options.userCode` marks the model's own code, which cdp() never runs twice.
 */
async function evaluate(tabId, expression, options) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, options);
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
async function evaluateHandle(tabId, contextId, expression) {
  const params = {
    expression: expression,
    returnByValue: false,
    awaitPromise: true,
    userGesture: true,
  };
  // The main frame has no contextId, so the key is omitted rather than set to
  // undefined, which the protocol would read as a malformed context reference.
  if (contextId !== undefined) params.contextId = contextId;
  const result = await cdp(tabId, 'Runtime.evaluate', params);
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
  void cap;
  if (fixedX !== null && fixedY !== null) {
    const x = Math.round(fixedX);
    const y = Math.round(fixedY);
    return [
      '(function () {',
      HIT_TEST_HELPERS,
      '  var at = topAt(' + x + ', ' + y + ');',
      '  return { x: ' + x + ', y: ' + y + ', label: "coordinates ' + x + ',' + y + '" + (at ? " on " + describe(at) : "") };',
      '})()',
    ].join('\n');
  }
  return [
    '(function () {',
    HIT_TEST_HELPERS,
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '  el = null;',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (!el) return null;',
    '  var label = (el.getAttribute("aria-label") || el.innerText || el.value || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 80);',
    '  if (!el.isConnected) return { error: "gone", label: label };',
    '  el.scrollIntoView({ block: "center", inline: "center" });',
    '  var rects = el.getClientRects();',
    '  var boxes = [];',
    '  for (var i = 0; i < rects.length; i++) if (rects[i].width >= 1 && rects[i].height >= 1) boxes.push(rects[i]);',
    '  if (boxes.length === 0) return { error: "hidden", label: label };',
    // The first line box's centre first: a wrapped link's bounding-box centre can
    // fall in the gap between its lines. Then a grid over every box, for when the
    // centre is covered.
    '  var points = [];',
    '  for (var b = 0; b < boxes.length; b++) {',
    '    var r = boxes[b];',
    '    points.push([r.left + r.width / 2, r.top + r.height / 2]);',
    '    var fx = [0.25, 0.5, 0.75], fy = [0.25, 0.5, 0.75];',
    '    for (var p = 0; p < 3; p++) for (var q = 0; q < 3; q++) points.push([r.left + r.width * fx[p], r.top + r.height * fy[q]]);',
    '  }',
    '  var blocker = null, inView = false;',
    '  for (var k = 0; k < points.length; k++) {',
    '    var x = Math.round(points[k][0]), y = Math.round(points[k][1]);',
    '    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;',
    '    inView = true;',
    '    var hit = topAt(x, y);',
    '    if (hit && within(hit, el)) return { x: x, y: y, label: label };',
    '    if (!blocker && hit) blocker = hit;',
    '  }',
    '  if (!inView) return { error: "offscreen", label: label };',
    '  return { error: "covered", label: label, blocker: blocker ? describe(blocker) : "something" };',
    '})()',
  ].join('\n');
}

/**
 * Page-side helpers for the pre-click hit test, inlined into each resolver.
 * `topAt` is what a click at (x, y) would land on, looking through open shadow
 * roots; `within` asks whether that is the target or inside it.
 */
const HIT_TEST_HELPERS = [
  '  function topAt(x, y) {',
  '    var hit = document.elementFromPoint(x, y);',
  '    while (hit && hit.shadowRoot) {',
  '      var inner = hit.shadowRoot.elementFromPoint(x, y);',
  '      if (!inner || inner === hit) break;',
  '      hit = inner;',
  '    }',
  '    return hit;',
  '  }',
  '  function within(hit, el) {',
  '    for (var n = hit; n; n = n.parentNode || n.host) if (n === el) return true;',
  '    return false;',
  '  }',
  '  function describe(node) {',
  '    var name = node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")',
  '      + (typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\\s+/)[0] : "");',
  '    var text = String(node.innerText || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 40);',
  '    return name + (text ? " \\"" + text + "\\"" : "");',
  '  }',
].join('\n');

/** Turn a resolver's refusal into the error the model sees. */
function pointRefusal(point) {
  const what = point.label ? JSON.stringify(point.label) : 'the target';
  if (point.error === 'gone') {
    return what + ' is no longer on the page (it re-rendered) — take a fresh chrome_snapshot and use its new ref';
  }
  if (point.error === 'hidden') {
    return what + ' has no visible size, so there is nothing to act on — it may be collapsed or hidden; take a fresh chrome_snapshot';
  }
  if (point.error === 'offscreen') {
    return what + ' could not be brought into the viewport, so input there would be dropped — scroll to it first';
  }
  return what + ' is covered by ' + point.blocker + ' at every visible point, so input would land on that instead — '
    + 'dismiss or scroll past it first';
}

/**
 * Scroll a frame's owner element into view, in the document that holds it.
 *
 * `DOM.scrollIntoViewIfNeeded` looked like the right call, but for a frame
 * owner it did nothing here and its errors were swallowed, so the frame stayed
 * off-screen and the click was dispatched anyway. Resolve the owner to a JS
 * object and scroll it with `scrollIntoView` — the same call the page-side
 * resolver uses — and let any failure throw, so an unreachable frame refuses
 * instead of silently clicking the wrong place.
 */
async function bringFrameIntoView(tabId, backendNodeId, frameKey) {
  let objectId = null;
  try {
    const resolved = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: backendNodeId });
    objectId = resolved && resolved.object ? resolved.object.objectId : null;
  } catch (error) {
    throw new Error('cannot bring frame ' + frameKey + ' into view: '
      + (error && error.message ? error.message : error));
  }
  if (typeof objectId !== 'string' || objectId === '') {
    throw new Error('cannot bring frame ' + frameKey + ' into view (its container is not a scriptable '
      + 'element), so a click would land in the wrong place — pass x and y explicitly instead');
  }
  try {
    await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: objectId,
      functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "center", '
        + 'behavior: "instant" }); }',
    });
  } catch (error) {
    throw new Error('cannot bring frame ' + frameKey + ' into view: '
      + (error && error.message ? error.message : error));
  }
}

/**
 * Sum the offsets of a frame and every frame between it and the top.
 *
 * DOM.getFrameOwner names the element a frame is loaded in, and DOM.getBoxModel
 * gives that element's box in its own parent. The quads are scroll-unadjusted,
 * so the sum is the frame's position in the top frame's DOCUMENT space — not
 * viewport space; `resolvePoint` applies the top frame's scroll before the
 * point is dispatched.
 *
 * The frame element can itself be scrolled out of the top page's viewport.
 * el.scrollIntoView inside pointExpressionFor scrolls the frame's own content,
 * never the frame element, so each ancestor frame is brought into view first —
 * outermost first, so an inner frame is only scrolled once the frame that holds
 * it is visible. Because the box quads are scroll-unadjusted, which frame is in
 * view does not change them; the scroll is what makes the final point land on
 * screen.
 *
 * @returns the document-space offset, or throws: a wrong click is worse than a
 *   refused one.
 */
async function frameOffsetFor(tabId, frames, frameKey) {
  const byKey = {};
  for (let i = 0; i < frames.length; i += 1) byKey[frames[i].key] = frames[i];
  const chain = [];
  for (let current = byKey[frameKey]; current && current.parentKey; current = byKey[current.parentKey]) {
    chain.push(current);
  }
  const quads = [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const frame = chain[i];
    let owner = null;
    try {
      owner = await cdp(tabId, 'DOM.getFrameOwner', { frameId: frame.frameId });
    } catch (error) {
      owner = null;
    }
    if (!owner || typeof owner.backendNodeId !== 'number') {
      // A frame whose owner cannot be named cannot be measured or scrolled.
      // Swallowing this was the bug: the frame stayed off-screen and the click
      // was dispatched anyway.
      throw new Error('cannot locate the element that holds frame ' + frame.key
        + ' on the page, so a click would land in the wrong place — pass x and y explicitly instead');
    }
    await bringFrameIntoView(tabId, owner.backendNodeId, frame.key);
    let box = null;
    try {
      box = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
    } catch (error) {
      box = null;
    }
    const border = box && box.model ? box.model.border : null;
    if (!Array.isArray(border)) {
      throw new Error('cannot place frame ' + frame.key + ' on the page (its container has no box), '
        + 'so a click would land in the wrong place — pass x and y explicitly instead');
    }
    quads.push(border);
  }
  const sum = sumFrameOffsets(quads);
  if (sum === null) {
    throw new Error('cannot place frame ' + frameKey + ' on the page, so a click would land in the '
      + 'wrong place — pass x and y explicitly instead');
  }
  return sum;
}

/** One frame, by its key; the empty key means the main frame. */
async function frameFor(tabId, frameKey) {
  const flat = await framesFor(tabId);
  const wanted = frameKey === '' ? 'f0' : frameKey;
  for (let i = 0; i < flat.frames.length; i += 1) {
    if (flat.frames[i].key === wanted) return { frame: flat.frames[i], frames: flat.frames };
  }
  throw new Error('no frame ' + wanted + ' on this page — take a fresh chrome_snapshot');
}

/** Evaluate an expression inside the named frame; the empty key is the main frame. */
async function evaluateInFrame(tabId, frameKey, expression) {
  // The main frame is evaluated in the page's own world, which is where the
  // snapshot wrote its refs and where every existing ref consumer looks. Only a
  // child frame uses an isolated world. This is the single place the choice is
  // made, so click, hover, type, scroll, upload and drag all inherit it.
  if (frameKey === '') return evaluate(tabId, expression);
  const found = await frameFor(tabId, frameKey);
  const contextId = await frameContext(tabId, found.frame.frameId);
  return evaluateIn(tabId, contextId, expression);
}


/**
 * Refuse to dispatch input at a point outside the tab's viewport.
 *
 * CDP accepts any coordinate, but a mouse event outside the viewport reaches
 * nothing, so a command that returned success would be lying: the agent would
 * believe it acted. Called with every point about to be dispatched, however it
 * was obtained (resolved ref, frame offset or explicit coordinates), before the
 * view is moved. A point exactly on the edge is inside.
 */
async function assertInViewport(tabId, points) {
  const size = await evaluate(tabId, '({ width: window.innerWidth, height: window.innerHeight })');
  const width = size ? size.width : null;
  const height = size ? size.height : null;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (pointInViewport(point.x, point.y, width, height)) continue;
    throw new Error('target ' + (point.label ? JSON.stringify(point.label) + ' ' : '')
      + 'at ' + Math.round(point.x) + ',' + Math.round(point.y) + ' is outside the viewport '
      + '(' + Math.round(width) + 'x' + Math.round(height) + '), so input there would be dropped — '
      + 'scroll it into view first, or pass coordinates inside the viewport');
  }
}

/**
 * Resolve a click, hover, type, scroll or upload target to top-level viewport
 * coordinates.
 *
 * @param params - the command's arguments.
 * @param prefix - '', 'from' or 'to', naming the argument group.
 * @returns the point, or null when the target does not exist.
 */
async function resolvePoint(tabId, params, prefix) {
  const frameKey = normaliseFrameKey(params[prefix === '' ? 'frame' : prefix + 'Frame']);
  // The main frame needs no frame tree: its point is already in the page's own
  // coordinates, so only a child frame has a parent-tree offset to walk.
  const point = await evaluateInFrame(tabId, frameKey, pointExpressionFor(params, prefix));
  if (!point) return null;
  if (point.error) throw new Error(pointRefusal(point));
  if (frameKey === '') return point;
  const found = await frameFor(tabId, frameKey);
  const offset = await frameOffsetFor(tabId, found.frames, frameKey);
  // The offset is document space; CDP input is viewport space. Subtract the top
  // frame's scroll — read once, after the frame has been scrolled into view —
  // or a scrolled page silently clicks the wrong place.
  const scroll = await evaluate(tabId, '({ x: window.scrollX, y: window.scrollY })');
  const placed = framePointToViewport(point, offset, scroll);
  if (placed === null) {
    throw new Error('cannot read the page scroll, so frame ' + frameKey + ' cannot be placed — '
      + 'pass x and y explicitly instead');
  }
  // The frame's own hit test cannot see the page above it, such as an overlay
  // drawn over the iframe, so the point is checked again in the top document.
  const top = await evaluate(tabId, [
    '(function () {',
    HIT_TEST_HELPERS,
    '  var hit = topAt(' + Math.round(placed.x) + ', ' + Math.round(placed.y) + ');',
    '  if (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) return "frame";',
    '  return hit ? describe(hit) : "nothing";',
    '})()',
  ].join('\n'));
  if (top !== 'frame') throw new Error(pointRefusal({ error: 'covered', label: point.label, blocker: top }));
  return { x: placed.x, y: placed.y, label: point.label };
}

/**
 * Resolve a target and refuse it unless it lies inside the viewport.
 *
 * Call it only after ensureInputReady. A tab Chrome is not rendering does not
 * commit a `scrollIntoView`: measured on the frame fixture, a point resolved on
 * an unrendered tab was 900px off by the time input went out, and the click
 * reported success without landing.
 */
async function resolveVisiblePoint(tabId, params, prefix) {
  const point = await resolvePoint(tabId, params, prefix);
  if (point) await assertInViewport(tabId, [{ x: point.x, y: point.y, label: point.label }]);
  return point;
}

/**
 * Page-side: the field chrome_type works on — the ref or selector target, else
 * whatever has focus — whether focus is in it, and what it holds now.
 *
 * With `prepare` it also sets where the text goes: an input's text is selected
 * so typing replaces it, and a contenteditable's caret moves to the end so
 * typing appends instead of wiping it. A password's value is never returned,
 * only its length.
 */
function typeFieldExpression(params, prepare) {
  const selector = typeof params.selector === 'string' ? params.selector : null;
  const ref = typeof params.ref === 'number' ? params.ref : null;
  return [
    '(function () {',
    HIT_TEST_HELPERS,
    '  var active = document.activeElement;',
    '  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;',
    '  var el = null;',
    ref !== null ? '  el = (window.__dshChromeRefs || [])[' + String(ref - 1) + '];' : '',
    selector !== null ? '  if (!el) el = document.querySelector(' + JSON.stringify(selector) + ');' : '',
    '  if (!el) el = active && active !== document.body ? active : null;',
    '  if (!el) return { focused: false, active: "nothing" };',
    '  var focused = !!active && (within(active, el) || within(el, active));',
    prepare ? [
      '  if (focused && typeof el.select === "function" && typeof el.value === "string") el.select();',
      '  else if (focused && active.isContentEditable) {',
      '    var range = document.createRange(); range.selectNodeContents(active); range.collapse(false);',
      '    var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);',
      '  }',
    ].join('\n') : '',
    '  var field = typeof el.value === "string" ? el : active;',
    '  var value = field && typeof field.value === "string" ? field.value : field && field.isContentEditable ? field.innerText : null;',
    '  var secret = !!field && field.type === "password";',
    '  return { focused: focused, active: active ? describe(active) : "nothing",',
    '    value: secret || value === null ? null : value.slice(0, 500), length: value === null ? 0 : value.length, secret: secret };',
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

/**
 * Page-side: find what a wheel at (x, y) would scroll — the nearest ancestor
 * that scrolls and has room in the wheel's direction, else the document — and
 * stash it so the same element can be read and scrolled afterwards.
 */
function wheelTargetExpression(x, y, deltaX, deltaY) {
  return [
    '(function () {',
    '  function room(el) {',
    '    var down = el.scrollHeight - el.clientHeight - el.scrollTop;',
    '    var right = el.scrollWidth - el.clientWidth - el.scrollLeft;',
    '    return (' + deltaY + ' > 0 && down > 0) || (' + deltaY + ' < 0 && el.scrollTop > 0)',
    '      || (' + deltaX + ' > 0 && right > 0) || (' + deltaX + ' < 0 && el.scrollLeft > 0);',
    '  }',
    '  var root = document.scrollingElement || document.documentElement;',
    '  var el = document.elementFromPoint(' + Math.round(x) + ', ' + Math.round(y) + ');',
    '  while (el && el !== root) {',
    '    var style = getComputedStyle(el);',
    '    if (/(auto|scroll|overlay)/.test(style.overflowY + " " + style.overflowX) && room(el)) break;',
    '    el = el.parentElement;',
    '  }',
    '  if (!el) el = root;',
    '  window.__dshWheelTarget = el;',
    '  return { left: el.scrollLeft, top: el.scrollTop, room: room(el) };',
    '})()',
  ].join('\n');
}

/** Page-side: where the stashed wheel target is scrolled to now. */
const WHEEL_TARGET_POSITION = '(function () { var el = window.__dshWheelTarget;'
  + ' return el ? { left: el.scrollLeft, top: el.scrollTop } : null; })()';

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

/** The width each tab was resized to, so clearing knows what to wait for. */
const resizedTabs = new Map();

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
/** The in-flight title lookup, shared by commands that overlap. */
let agentGroupLookup = null;

/**
 * The agent's tab group, found again after a worker restart.
 *
 * agentGroupId is in memory only, so an evicted worker comes back without it. The
 * group itself outlives the worker and is the one wearing GROUP_TITLE, so it can be
 * found rather than duplicated.
 */
async function agentGroup() {
  if (agentGroupId !== null) return agentGroupId;
  if (!agentGroupLookupDone) {
    if (agentGroupLookup === null) agentGroupLookup = findAgentGroup();
    // Commands are not serialised, so a second confined command shares this one
    // lookup rather than seeing a not-yet-resolved null group and being wrongly
    // refused.
    await agentGroupLookup;
  }
  return agentGroupId;
}

/** Run the title lookup once, marking it done only after it has answered. */
async function findAgentGroup() {
  try {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (groups.length > 0 && typeof groups[0].id === 'number') agentGroupId = groups[0].id;
  } catch (error) {
    // A browser without tab groups still works, ungrouped.
  } finally {
    agentGroupLookupDone = true;
  }
}

/** Put a freshly opened tab into the agent group, creating it on first use. */
/**
 * Run a tab-strip edit, waiting out Chrome's drag lock. While the user drags a
 * tab every edit throws "Tabs cannot be edited right now (user may be dragging
 * a tab)" — seen live, failing chrome_open while the user tidied their tabs —
 * and the lock lifts when the drag ends.
 */
async function editTabs(edit) {
  for (let waited = 0; ; waited += 100) {
    try {
      return await edit();
    } catch (error) {
      if (!/cannot be edited right now/i.test(describe(error)) || waited >= 5000) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function groupTab(tabId) {
  try {
    const existing = await agentGroup();
    if (existing !== null) {
      try {
        await editTabs(() => chrome.tabs.group({ tabIds: [tabId], groupId: existing }));
        return;
      } catch (error) {
        // The group vanished with its last tab; fall through and make a new one.
        agentGroupId = null;
      }
    }
    agentGroupId = await editTabs(() => chrome.tabs.group({ tabIds: [tabId] }));
    await editTabs(() => chrome.tabGroups.update(agentGroupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false }));
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

/**
 * Make sure trusted input will reach a tab, without ever moving the user's view.
 *
 * Chrome drops input to a tab it is not rendering, and stalls every mouse event
 * on it for about five seconds. Focus emulation (set in ensureAttached) makes
 * Chrome render the tab wherever it is, so the page reports itself visible.
 * The switch can take a frame to show, hence the short poll. A tab that still
 * reports hidden is refused rather than brought forward: the user's view is
 * not the agent's to take, and input sent anyway would be lost.
 */
async function ensureInputReady(tabId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await evaluate(tabId, 'document.visibilityState === "visible"')) return;
    if (attempt === 4) await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('tab ' + tabId + ' is not being rendered, so input sent to it would be dropped — '
    + 'reload the tab, or check that DevTools or another debugger is not attached to it');
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

/**
 * One screenshot capture. It never activates the tab.
 *
 * `backgroundOnly` turns a failure into null instead of an error. The JPEG
 * ladder sets it: the PNG has already succeeded, so a failed re-encode is a
 * skipped attempt, which the ladder records as a null size.
 */
async function captureOnce(tabId, options) {
  const backgroundOnly = options.backgroundOnly === true;
  try {
    return await withTimeout(screencastFrame(tabId, options), 8000);
  } catch (error) {
    if (backgroundOnly) return null;
    // Never activate the tab to retry: the user's view is not the agent's to take.
    throw new Error('screenshot failed: ' + describe(error));
  }
}

/**
 * One frame of the page, taken from a screencast rather than Page.captureScreenshot.
 *
 * On a background tab under focus emulation, captureScreenshot alternated
 * between succeeding and hanging until its timeout — measured in
 * test/probe-capture-variants.mjs, six captures went ok, 8s timeout, ok,
 * timeout, ok, timeout. The first screencast frame arrived every time, in
 * 1.2-1.4s.
 */
async function screencastFrame(tabId, options) {
  let listener = null;
  const frame = new Promise(resolve => {
    listener = (source, method, event) => {
      if (!source || source.tabId !== tabId || method !== 'Page.screencastFrame') return;
      chrome.debugger.sendCommand({ tabId: tabId }, 'Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(() => { /* the screencast is stopping anyway */ });
      resolve({ data: event.data });
    };
    chrome.debugger.onEvent.addListener(listener);
  });
  const params = { format: options.format === 'jpeg' ? 'jpeg' : 'png', everyNthFrame: 1 };
  if (typeof options.quality === 'number') params.quality = options.quality;
  try {
    await cdp(tabId, 'Page.startScreencast', params);
    return await frame;
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    await cdp(tabId, 'Page.stopScreencast', {}).catch(() => { /* the tab may be gone */ });
  }
}

/**
 * Capture a page, re-encoding only when the first result is too big to send.
 *
 * PNG stays the default because it is lossless and most pages fit well inside
 * the limit. The ladder is a guard against the pathological full-page capture,
 * not a routine re-encode.
 */
async function captureBounded(tabId) {
  const png = await captureOnce(tabId, { format: 'png' });
  if (!png || typeof png.data !== 'string') throw new Error('the page returned no image data');
  if (png.data.length <= SCREENSHOT_BASE64_LIMIT) return { base64: png.data, format: 'png' };
  // The retries are background-only: the PNG already succeeded, so nothing here
  // may activate the tab. A refused attempt is recorded as a null size.
  const images = [];
  const sizes = [];
  for (let attempt = 0; ; attempt += 1) {
    const quality = nextJpegQuality(attempt);
    if (quality === null) break;
    const jpeg = await captureOnce(tabId, { format: 'jpeg', quality: quality, backgroundOnly: true });
    const data = jpeg && typeof jpeg.data === 'string' ? jpeg.data : null;
    images.push(data);
    sizes.push(data === null ? null : data.length);
    if (data !== null && data.length <= SCREENSHOT_BASE64_LIMIT) break;
  }
  const chosen = chooseJpegAttempt(sizes, SCREENSHOT_BASE64_LIMIT);
  if (chosen === null) {
    // Every JPEG attempt produced nothing. An oversized PNG is still a usable
    // image, and returning it beats turning a size problem into a failure.
    return { base64: png.data, format: 'png' };
  }
  return { base64: images[chosen], format: 'jpeg' };
}

/**
 * Every frame a snapshot should read, main frame first.
 */
async function framesFor(tabId) {
  const tree = await cdp(tabId, 'Page.getFrameTree', {});
  const flat = flattenFrameTree(tree && tree.frameTree, FRAME_LIMIT);
  if (flat.frames.length === 0) throw new Error('the page reported no frames');
  return flat;
}

/**
 * An execution context inside one frame.
 *
 * An isolated world rather than the page's own context: the page cannot see or
 * redefine anything in it, so a page that shadows a global cannot break the
 * walk. CDP is not subject to the same-origin policy, so this works in
 * cross-origin frames too.
 */
async function frameContext(tabId, frameId) {
  const created = await cdp(tabId, 'Page.createIsolatedWorld', {
    frameId: frameId,
    worldName: 'dsh-agent-snapshot',
  });
  if (!created || typeof created.executionContextId !== 'number') {
    throw new Error('could not open an execution context in frame ' + frameId);
  }
  return created.executionContextId;
}

/** Evaluate an expression in one frame's isolated world. */
async function evaluateIn(tabId, contextId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: expression,
    contextId: contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails;
    const thrown = details.exception && (details.exception.description || details.exception.value);
    throw new Error('page error: ' + String(thrown || details.text || 'unknown'));
  }
  return result && result.result ? result.result.value : undefined;
}

/** The command table. Every method answers one JSON value. */
/**
 * chrome_type for a field whose focus locks the debugger out of the tab.
 *
 * Runs in the page's own world, where the snapshot refs live: the value goes in
 * through the element's native setter (so a framework-controlled input sees the
 * change) with beforeinput, input and change events, an Enter is a form submit,
 * and the field is blurred again so the debugger gets the tab back. These are
 * untrusted events, which is why this is only the fallback, and the result says
 * so.
 */
async function typeByScript(tabId, params, text) {
  const ref = typeof params.ref === 'number' ? params.ref : null;
  const selector = typeof params.selector === 'string' ? params.selector : null;
  const submit = params.submit === true;
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    args: [ref, selector, text, submit],
    func: (ref, selector, text, submit) => {
      let el = ref !== null ? (window.__dshChromeRefs || [])[ref - 1] : null;
      if (!el && selector !== null) el = document.querySelector(selector);
      if (!el || !el.isConnected) return { error: 'the field is no longer on the page — take a fresh chrome_snapshot' };
      el.focus();
      if (typeof el.value === 'string') {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        setter.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, text);
      } else {
        return { error: 'the target is not a text field' };
      }
      let submitted = false;
      if (submit && el.form) {
        if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit();
        submitted = true;
      }
      const value = typeof el.value === 'string' ? el.value : el.innerText;
      const secret = el.type === 'password';
      el.blur();
      return { value: secret ? null : String(value).slice(0, 500), length: String(value).length, secret: secret, submitted: submitted };
    },
  });
  const result = injection ? injection.result : null;
  if (!result || result.error) throw new Error(result && result.error ? result.error : 'typing by script failed');
  await releaseForeignFrame(tabId);
  const value = result.secret ? '(hidden: ' + result.length + ' characters)' : result.value;
  return {
    typed: text !== '',
    submitted: result.submitted,
    value: value,
    matches: result.secret ? result.length >= text.length : result.value.indexOf(text) !== -1,
    note: 'typed by script, not keystrokes: another extension (often a password manager\'s autofill menu) locks the '
      + 'debugger out of this tab while the field has focus'
      + (submit && !result.submitted ? '; Enter could not be pressed, and the field has no form to submit' : ''),
  };
}

/**
 * chrome_type's normal path: a real click into the field, inserted text, and
 * the field read back.
 */
async function typeWithInput(params) {
  const tabId = await resolveTabId(params.tabId);
  const text = typeof params.text === 'string' ? params.text : '';
  const frameKey = normaliseFrameKey(params.frame);
  const named = typeof params.ref === 'number' || typeof params.selector === 'string';
  // A real click puts focus where a user's would, runs the page's own focus
  // handlers, and goes through the click's hit test, so a covered or stale
  // field is refused instead of typed past.
  if (named) await COMMANDS.click({ ref: params.ref, selector: params.selector, frame: params.frame, tabId: tabId });
  const field = await evaluateInFrame(tabId, frameKey, typeFieldExpression(params, true));
  if (!field || field.focused !== true) {
    throw new Error(named
      ? 'clicked the field but focus went to ' + (field ? field.active : 'nothing')
        + ' — it may be disabled, read-only, or a custom widget; take a fresh chrome_snapshot'
      : 'nothing is focused to type into — pass a ref or selector');
  }
  if (text !== '') await cdp(tabId, 'Input.insertText', { text: text });
  // Read the field back: a page can reformat, truncate or reject what was
  // typed, and the model must see what the field really holds.
  const after = await evaluateInFrame(tabId, frameKey, typeFieldExpression(params, false));
  const submit = params.submit === true;
  if (submit) await COMMANDS.key({ key: 'Enter', tabId: tabId });
  let value;
  let matches;
  if (after && typeof after.value === 'string') {
    value = after.value;
    matches = after.value.indexOf(text) !== -1;
  } else {
    value = after && after.secret ? '(hidden: ' + after.length + ' characters)' : '(not a text field)';
    matches = !!after && after.length >= text.length;
  }
  return { typed: text !== '', submitted: submit, value: value, matches: matches };
}

const COMMANDS = {

  /**
   * Reload this extension from disk, so an edit to extension/ takes effect
   * without a trip to chrome://extensions (test/reload-extension.mjs). Not a
   * model tool. The reply goes out before the worker restarts.
   */
  async reloadExtension() {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: chrome.runtime.getManifest().version };
  },

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
      // Deliberately not activated. The tab still loads, and every command,
      // input included, works on it without moving the user's view. The user
      // can watch it by opening the agent's tab group.
      const created = await editTabs(() => chrome.tabs.create({ url: url, active: false }));
      tabId = created.id;
      if (typeof tabId === 'number') await groupTab(tabId);
    } else {
      tabId = await resolveTabId(params.tabId);
      await guardLeaving(tabId, params, 'navigated');
      await editTabs(() => chrome.tabs.update(tabId, { url: url }));
    }
    if (typeof tabId !== 'number') throw new Error('could not determine the target tab');
    rememberTab(tabId);
    await waitForLoad(tabId, 20000);
    return describeTab(tabId);
  },

  async snapshot(params) {
    const tabId = await resolveTabId(params.tabId);
    const flat = await framesFor(tabId);
    const lines = [];
    const frameText = [];
    // Frames that could not be read. The frame tree and the execution contexts
    // are read in separate calls, so a frame can navigate away in between. One
    // frame going away must not cost the caller the whole snapshot, but it must
    // not vanish silently either: the keys are reported in the trailer.
    const unread = [];
    let url = '';
    let title = '';
    let text = '';
    for (let index = 0; index < flat.frames.length; index += 1) {
      const frame = flat.frames[index];
      const isMain = frame.key === 'f0';
      let parsed;
      try {
        // The main frame is read in the page's own world, exactly as it was
        // before frames existed: SNAPSHOT_EXPRESSION parks its refs in
        // window.__dshChromeRefs, and click/type/scroll/hover/drag still resolve
        // them through evaluate() in that same world. Reading the main frame in
        // an isolated world would leave every main-frame ref unreachable.
        //
        // A child frame has no main-world consumers yet, so it is read in its own
        // isolated world: the page cannot see or redefine anything in it, and CDP
        // reaches cross-origin frames regardless.
        const raw = isMain
          ? await evaluate(tabId, SNAPSHOT_EXPRESSION)
          : await evaluateIn(tabId, await frameContext(tabId, frame.frameId), SNAPSHOT_EXPRESSION);
        if (typeof raw !== 'string') {
          unread.push(frame.key + ': the snapshot returned no value');
          continue;
        }
        parsed = JSON.parse(raw);
      } catch (error) {
        // The message travels with the key so a systemic CDP failure or a detach
        // is distinguishable from one frame that navigated away.
        unread.push(frame.key + ': ' + describe(error));
        continue;
      }
      if (isMain) {
        url = parsed.url;
        title = parsed.title;
        text = parsed.text;
      } else if (parsed.text !== '') {
        frameText.push('[' + frame.key + '] ' + String(parsed.text).slice(0, 400));
      }
      const tree = String(parsed.tree);
      if (tree === '') continue;
      const rows = tree.split('\n');
      for (let row = 0; row < rows.length; row += 1) {
        if (rows[row] === '') continue;
        // A ref is an index into one document's array, so the document travels
        // with it. The main frame stays unmarked, which keeps every existing
        // ref in every existing prompt valid.
        lines.push(isMain
          ? rows[row]
          : rows[row].replace(/^\[ref=(\d+)\]/, '[ref=$1 frame=' + frame.key + ']'));
      }
    }
    const notes = [];
    const skipped = flat.total - flat.frames.length;
    if (skipped > 0) notes.push(skipped + ' further frame(s) not read');
    if (unread.length > 0) {
      notes.push(unread.length + ' frame(s) could not be read (' + unread.join(', ') + ')');
    }
    const suffix = notes.length === 0 ? '' : '\n\n… ' + notes.join('; ');
    const tree = lines.length === 0 ? '(no interactive elements found)' : lines.join('\n');
    const allText = frameText.length === 0 ? text : text + '\n' + frameText.join('\n');
    return {
      url: url,
      title: title,
      snapshot: tree + suffix + '\n\n--- visible text ---\n' + allText,
    };
  },

  async click(params) {
    const tabId = await resolveTabId(params.tabId);
    await ensureInputReady(tabId);
    const placed = await resolveVisiblePoint(tabId, params, '');
    if (!placed) throw new Error('click target not found — take a fresh chrome_snapshot and use its ref');
    const x = placed.x;
    const y = placed.y;
    const label = placed.label;
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
    await ensureInputReady(tabId);
    const placed = await resolveVisiblePoint(tabId, params, '');
    if (!placed) throw new Error('hover target not found — take a fresh chrome_snapshot and use its ref');
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: placed.x, y: placed.y, button: 'none', buttons: 0, force: 0, modifiers: 0,
    });
    await paintCursor(tabId, placed.x, placed.y);
    return { hovered: placed.label };
  },

  async drag(params) {
    const tabId = await resolveTabId(params.tabId);
    await ensureInputReady(tabId);
    // Only the ends need the viewport check: an interpolated path between two
    // in-view points is itself in view.
    const start = await resolveVisiblePoint(tabId, params, 'from');
    const end = await resolveVisiblePoint(tabId, params, 'to');
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
      const moved = await evaluateInFrame(tabId, normaliseFrameKey(params.frame), scrollToExpression(params));
      if (moved !== true) throw new Error('scroll target not found — take a fresh chrome_snapshot');
      return { scrolled: 'element into view' };
    }
    const deltaY = typeof params.deltaY === 'number' ? Math.round(params.deltaY) : 600;
    const deltaX = typeof params.deltaX === 'number' ? Math.round(params.deltaX) : 0;
    // A wheel event needs a position to be dispatched at; the viewport centre is
    // the one point guaranteed to be over the document.
    const centre = await evaluate(tabId, 'JSON.stringify({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })');
    const point = JSON.parse(String(centre));
    // Chrome only acks a wheel on a tab it is rendering; ensureInputReady makes
    // sure it is.
    await ensureInputReady(tabId);
    const before = await evaluate(tabId, wheelTargetExpression(point.x, point.y, deltaX, deltaY));
    if (!before || before.room !== true) {
      return { scrolled: 'nothing: already at the end in that direction' };
    }
    try {
      // The ack can take 200-1000ms on the first wheel after attaching.
      await withTimeout(cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: point.x, y: point.y, deltaX: deltaX, deltaY: deltaY,
        button: 'none', buttons: 0, modifiers: 0,
      }), 1500);
    } catch (error) {
      /* unacked — the read below says whether it scrolled */
    }
    // An acked wheel is not yet a scrolled page. Measured in
    // test/probe-scroll-commit.mjs: on a background tab the first wheel after
    // attaching is held until Chrome next produces a frame. It then lands on top
    // of whatever the page did meanwhile, so a JS scroll made in between
    // (scrollIntoView before a click) is overridden and the click misses. Input
    // produces a frame, so a move at the same point applies the wheel now; a
    // capture is the fallback that always produces one. The wheel is never
    // re-sent: a held wheel plus a re-send scrolls twice (measured: 1800px for
    // one 900px request).
    const movedBy = async () => {
      const after = await evaluate(tabId, WHEEL_TARGET_POSITION);
      return after ? Math.round(Math.abs(after.top - before.top) + Math.abs(after.left - before.left)) : 0;
    };
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, modifiers: 0,
    });
    let moved = 0;
    for (const started = Date.now(); Date.now() - started < 1000; ) {
      moved = await movedBy();
      if (moved > 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (moved === 0) {
      await captureOnce(tabId, { format: 'jpeg', quality: 10, backgroundOnly: true });
      moved = await movedBy();
    }
    if (moved === 0) {
      return { scrolled: 'nothing: the wheel was sent but nothing scrolled — the page may handle the wheel itself' };
    }
    return { scrolled: 'wheel ' + deltaX + ',' + deltaY + ', moved ' + moved + 'px' };
  },

  /**
   * Wait until an expression turns truthy, rather than for a guessed number of
   * milliseconds.
   *
   * A fixed sleep has to cover the slowest case, so it is either too short and
   * flaky or too long and wasted; this returns the moment the page is ready.
   * The first check runs without any sleep at all, because the condition is
   * often already true by the time the model asks — a wait that has already
   * been satisfied must not cost a poll interval. Later checks back off from
   * 25ms to 100ms, so a fast condition is caught quickly without hammering a
   * page that is going to take a while. That ceiling is the overshoot on a
   * transition, which is all a poller can ever be late by: measured, a condition
   * that came true at 600ms was reported at 833ms behind a 250ms ceiling,
   * because the ladder had grown to the ceiling by then and slept a whole one
   * before looking again. A check costs about 2ms, so lowering the ceiling buys
   * less overshoot for evaluations that are still cheap.
   */
  async waitFor(params) {
    const tabId = await resolveTabId(params.tabId);
    const expression = typeof params.expression === 'string' ? params.expression : '';
    if (expression === '') throw new Error('chrome_wait_for needs an expression to wait on');
    const asked = Number(params.timeout);
    const timeout = Number.isFinite(asked) ? Math.max(0, Math.min(30000, Math.round(asked))) : 5000;
    const frameKey = normaliseFrameKey(params.frame);
    const started = Date.now();
    let checks = 0;
    let interval = 25;
    for (;;) {
      checks += 1;
      const value = await evaluateInFrame(tabId, frameKey, expression);
      if (value) return { matched: true, waited: Date.now() - started, checks: checks };
      const elapsed = Date.now() - started;
      if (elapsed >= timeout) {
        throw new Error('chrome_wait_for gave up after ' + elapsed + 'ms and ' + checks
          + ' check(s); the expression last evaluated to '
          + JSON.stringify(value === undefined ? null : value));
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, timeout - elapsed)));
      interval = Math.min(Math.round(interval * 1.5), 100);
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
    // Text that only exists inside a frame is invisible to a main-frame search,
    // so every frame is searched and each child's quotes say which frame they
    // came from. The main frame keeps the page's own world, exactly as it did
    // before frames existed and exactly as the snapshot reads it; a child frame
    // gets an isolated world the page cannot redefine.
    const flat = await framesFor(tabId);
    const matches = [];
    // Frames that failed to read, so count is not silently "readable frames
    // only". This mirrors the snapshot trailer: the frame tree and a frame's
    // context come from separate CDP calls, so a frame can navigate away between
    // them, and one going away must not cost every other frame's matches.
    const unread = [];
    let count = 0;
    for (let index = 0; index < flat.frames.length; index += 1) {
      const frame = flat.frames[index];
      const isMain = frame.key === 'f0';
      let parsed;
      try {
        const raw = isMain
          ? await evaluate(tabId, findExpression(needle))
          : await evaluateIn(tabId, await frameContext(tabId, frame.frameId), findExpression(needle));
        if (typeof raw !== 'string') {
          unread.push(frame.key + ': the search returned no value');
          continue;
        }
        parsed = JSON.parse(raw);
      } catch (error) {
        // Same reasoning as the snapshot: a systemic CDP failure or a detach
        // must not read as one frame quietly having no matches.
        unread.push(frame.key + ': ' + describe(error));
        continue;
      }
      count += Number(parsed.count) || 0;
      const found = Array.isArray(parsed.matches) ? parsed.matches : [];
      for (let m = 0; m < found.length && matches.length < 20; m += 1) {
        matches.push(isMain ? found[m] : '[' + frame.key + '] ' + found[m]);
      }
    }
    // skipped: frames the FRAME_LIMIT cap left out entirely, exactly as the
    // snapshot reports them. unread: frames that were in range but failed.
    return { count: count, matches: matches, skipped: flat.total - flat.frames.length, unread: unread };
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
    // The override is applied at the tab's next frame, about a second away on a
    // background tab: measured, a cleared 420px override still read 420 after
    // ~1s of polling. Wait for the page to report the new width, so the next
    // snapshot or click sees the layout this asked for.
    const settled = async (done) => {
      for (const started = Date.now(); Date.now() - started < 3000; ) {
        if (done(Number(await evaluate(tabId, 'window.innerWidth')))) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    };
    const late = ' (the page had not laid out at the new size after 3s)';
    if (width === 0 || height === 0) {
      const overridden = resizedTabs.get(tabId);
      await cdp(tabId, 'Emulation.clearDeviceMetricsOverride', {});
      resizedTabs.delete(tabId);
      if (overridden === undefined || await settled(now => now !== overridden)) return { resized: 'cleared' };
      return { resized: 'cleared' + late };
    }
    // Emulation rather than chrome.windows.update: it changes the layout the page
    // sees without moving the window the user is working in.
    await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: typeof params.scale === 'number' ? params.scale : 0,
      mobile: params.mobile === true,
    });
    resizedTabs.set(tabId, Math.round(width));
    const size = Math.round(width) + 'x' + Math.round(height);
    return { resized: await settled(now => now === Math.round(width)) ? size : size + late };
  },

  async upload(params) {
    const tabId = await resolveTabId(params.tabId);
    const files = Array.isArray(params.files)
      ? params.files.filter(file => typeof file === 'string' && file !== '')
      : [];
    if (files.length === 0) throw new Error('upload needs at least one absolute path in `files`');
    const uploadFrameKey = normaliseFrameKey(params.frame);
    // The main frame needs no frame tree: an undefined context is the page's own
    // world, matching evaluateInFrame, and only a child frame has a context to
    // open. Fetching the tree for the main frame was wasted work.
    const uploadContext = uploadFrameKey === ''
      ? undefined
      : await frameContext(tabId, (await frameFor(tabId, uploadFrameKey)).frame.frameId);
    const objectId = await evaluateHandle(tabId, uploadContext, uploadTargetExpression(params));
    if (objectId === null) throw new Error('no file input found — pass a ref or selector for the input[type=file]');
    await cdp(tabId, 'DOM.setFileInputFiles', { files: files, objectId: objectId });
    return { uploaded: files.length };
  },

  async type(params) {
    const tabId = await resolveTabId(params.tabId);
    const named = typeof params.ref === 'number' || typeof params.selector === 'string';
    const started = Date.now();
    try {
      return await typeWithInput(params);
    } catch (error) {
      // A login field whose focus brings a password manager's frame in cannot be
      // typed into through the debugger: every focus locks the tab again. Only
      // then, and only for a named field on the main page, the text goes in by script.
      const released = (releasedAt.get(tabId) || 0) >= started;
      if (!released || !named || normaliseFrameKey(params.frame) !== '') throw error;
      return typeByScript(tabId, params, typeof params.text === 'string' ? params.text : '');
    }
  },

  async key(params) {
    const tabId = await resolveTabId(params.tabId);
    // Keys are dropped on an unrendered tab exactly like mouse input.
    await ensureInputReady(tabId);
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
      '(async function () {',
      '  try {',
      '    var value = await (' + expression + ');',
      '    if (value === undefined) return "undefined";',
      '    return JSON.stringify(value);',
      '  } catch (error) { return "Error: " + (error && error.message); }',
      '})()',
    ].join('\n');
    const result = await evaluate(tabId, wrapped, { userCode: true });
    return { result: String(result) };
  },

  async close(params) {
    const tabId = typeof params.tabId === 'number' ? params.tabId : null;
    if (tabId === null) throw new Error('close needs a tabId');
    await assertTabAllowed(tabId);
    await guardLeaving(tabId, params, 'closed');
    attached.delete(tabId);
    await editTabs(() => chrome.tabs.remove(tabId));
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
    const shot = await captureBounded(tabId);
    const last = cursorAt.get(tabId);
    if (last) await paintCursor(tabId, last.x, last.y);
    return shot;
  },
};

/**
 * Decide before leaving a page that asks first, so Chrome never shows its
 * leave-page warning.
 *
 * Measured in test/probe-beforeunload.mjs: navigating a background tab whose
 * page has a beforeunload handler made Chrome activate that tab to show the
 * warning — moving the user's view — whether the navigation came from
 * chrome.tabs.update or Page.navigate, and a dismissed warning left
 * chrome_open waiting out its 20s load timeout. Both handler styles
 * (addEventListener and the onbeforeunload property) show up in
 * DOMDebugger.getEventListeners, so the page can be checked first: refused
 * unless the model passed dialog: "accept", and with it the handlers are taken
 * off before the page is left.
 *
 * A page this cannot inspect (a chrome:// page, a tab another extension's frame
 * locks) is left as before.
 */
async function guardLeaving(tabId, params, action) {
  // The handler functions only come back as objects when an objectGroup is named.
  const group = 'dsh-leave-guard';
  const find = async () => {
    const win = await cdp(tabId, 'Runtime.evaluate', { expression: 'window', objectGroup: group });
    const windowId = win && win.result ? win.result.objectId : null;
    if (!windowId) return { windowId: null, listeners: [] };
    const listed = await cdp(tabId, 'DOMDebugger.getEventListeners', { objectId: windowId });
    return { windowId, listeners: (listed && listed.listeners ? listed.listeners : []).filter(l => l.type === 'beforeunload') };
  };
  let found;
  try {
    found = await find();
  } catch (error) {
    return;
  }
  try {
    if (found.listeners.length === 0) return;
    if (params.dialog !== 'accept') {
      throw new Error('the page in tab ' + tabId + ' asks before it is left (it may have unsaved changes), so it was not '
        + action + ' — repeat with dialog: "accept" to leave it anyway');
    }
    await cdp(tabId, 'Runtime.evaluate', { expression: 'window.onbeforeunload = null' });
    for (const listener of found.listeners) {
      if (!listener.handler || !listener.handler.objectId) continue;
      await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: found.windowId,
        functionDeclaration: 'function (handler, capture) { this.removeEventListener("beforeunload", handler, capture); }',
        arguments: [{ objectId: listener.handler.objectId }, { value: listener.useCapture === true }],
      });
    }
    // A handler that survived would show the warning anyway and pull the tab forward.
    const left = await find();
    if (left.listeners.length > 0) {
      throw new Error('could not switch off the leave-page warning of the page in tab ' + tabId + ', so it was not '
        + action + ' — Chrome would bring the tab forward to show it');
    }
  } finally {
    await cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => { /* the page is going */ });
  }
}

/**
 * Give the user back the tab they were on, if a dialog made Chrome bring an
 * agent tab forward. Only the window of a tab that had a dialog during this
 * command is touched, and only when that tab took the view — or, when it has
 * since closed, when Chrome moved the view to whatever sat next to it — so a
 * switch the user made elsewhere is never undone.
 */
async function restoreViewAfterDialogs(dialogs, tabsBefore) {
  for (const tabId of new Set(dialogs.map(d => d.tabId))) {
    const known = tabsBefore.find(t => t.id === tabId);
    if (!known) continue;
    const previous = tabsBefore.find(t => t.active && t.windowId === known.windowId);
    if (!previous || previous.id === tabId) continue;
    const [now] = await chrome.tabs.query({ active: true, windowId: known.windowId });
    if (!now || now.id === previous.id) continue;
    const dialogTabGone = (await chrome.tabs.get(tabId).catch(() => null)) === null;
    if (now.id !== tabId && !dialogTabGone) continue;
    await editTabs(() => chrome.tabs.update(previous.id, { active: true })).catch(() => { /* that tab went away */ });
  }
}

/** The commands whose result carries the dialogs answered meanwhile. */
const DIALOG_COMMANDS = new Set(['click', 'key', 'type', 'eval', 'open', 'close']);

/** Dispatch one command by name. */
async function runCommand(method, params) {
  const handler = COMMANDS[method];
  if (typeof handler !== 'function') throw new Error('unknown command: ' + String(method));
  if (!DIALOG_COMMANDS.has(method)) return handler(params);
  dialogChoice = { dialog: params.dialog, promptText: params.promptText };
  const tabsBefore = await chrome.tabs.query({});
  try {
    const value = await handler(params);
    // Everything answered since the last report, including a dialog a timer
    // opened during some other command: the model must hear of each one once.
    const dialogs = dialogLog.splice(0);
    if (dialogs.length > 0 && value && typeof value === 'object' && !Array.isArray(value)) value.dialogs = dialogs;
    await restoreViewAfterDialogs(dialogs, tabsBefore);
    return value;
  } finally {
    dialogChoice = null;
  }
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
