/**
 * Live smoke test for the companion extension, against a real Chrome.
 *
 *   node test/live-extension.mjs [port]      # port defaults to 3099
 *
 * It is not part of `npm test` (that suite is hermetic). It starts a stand-in
 * bridge server and exercises the extension's whole protocol against the
 * browser the extension is loaded into: tabs, open, snapshot, eval, click,
 * type, key, screenshot.
 *
 * Chrome no longer honours --load-extension, so this cannot launch a browser
 * for you. Load extension/ unpacked in chrome://extensions, set its DSH web
 * port to the port below on its options page, then run this. Set the port back
 * to your server's afterwards.
 */
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 3099);

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log('  PASS  ' + name); return; }
  console.log('  FAIL  ' + name + ' :: ' + JSON.stringify(detail));
  failures.push(name);
}

let socket = null;
// 127.0.0.1, where the extension dials: on 0.0.0.0 a running DSH server holding
// 127.0.0.1 on the same port takes the extension and this suite just times out.
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
let nextId = 0;
const waiting = new Map();

wss.on('connection', ws => {
  console.log('extension connected (waiting for hello)');
  socket = ws;
  ws.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t === 'hello') {
      console.log('extension said hello: version ' + frame.version + ', protocol ' + frame.protocol);
      return;
    }
    if (frame.t === 'result') {
      const entry = waiting.get(frame.id);
      if (entry) {
        waiting.delete(frame.id);
        frame.ok ? entry.resolve(frame.value) : entry.reject(new Error(frame.error));
      }
    }
  });
});

/** The most recent command, so a harness failure says which call threw. */
let lastCall = null;

/** Every tab this run opened, closed at the end even when the run aborts. */
const openedTabs = new Set();

/**
 * Send one command. When another extension's frame interrupted it and the
 * extension cleared the frame, it asks for the action to be repeated — what
 * the model is told to do — so the harness repeats it once.
 */
async function call(method, params, timeoutMs) {
  try {
    return await callOnce(method, params, timeoutMs);
  } catch (error) {
    if (!/so repeat the action/.test(String(error.message))) throw error;
    console.log('        (repeated ' + method + ' after the extension cleared another extension\'s frame)');
    return callOnce(method, params, timeoutMs);
  }
}

function callOnce(method, params, timeoutMs) {
  if (!socket) return Promise.reject(new Error('no extension connected'));
  lastCall = { method, params };
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs || 25000);
    waiting.set(id, {
      resolve: v => {
        clearTimeout(timer);
        if (method === 'open' && v && typeof v.tabId === 'number') openedTabs.add(v.tabId);
        resolve(v);
      },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    socket.send(JSON.stringify({ t: 'command', id, method, params: params || {} }));
  });
}

function waitForExtension(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (socket) return resolve();
      if (Date.now() > deadline) return reject(new Error('the extension never connected'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

console.log('stand-in bridge listening on ws://127.0.0.1:' + PORT + '/chrome-agent/bridge');
console.log('waiting up to 90s for the extension (options page port must be ' + PORT + ')');

try {
  await waitForExtension(90000);
  await new Promise(r => setTimeout(r, 500));
  // The tab the user is looking at in each window. Nothing in this suite may change it.
  const userActive = (await call('tabs')).filter(t => t.active).map(t => t.id).sort();

  const tabs = await call('tabs');
  check('tabs returns a list', Array.isArray(tabs) && tabs.length > 0, tabs);

  const opened = await call('open', { url: 'https://example.com', newTab: true });
  check('open reports a tab', typeof opened.tabId === 'number', opened);
  check('open lands on the url', String(opened.url).indexOf('example.com') !== -1, opened.url);

  const snap = await call('snapshot', { tabId: opened.tabId });
  // example.com dropped its "Example Domain" heading in 2026; the phrase now lives only in <title>.
  check('snapshot sees the page', snap.snapshot.indexOf('documentation examples') !== -1, snap.snapshot.slice(0, 200));
  check('snapshot exposes refs', /\[ref=1\]/.test(snap.snapshot), snap.snapshot.slice(0, 200));

  const title = await call('eval', { expression: 'document.title', tabId: opened.tabId });
  check('eval reads the dom', String(title.result).indexOf('Example Domain') !== -1, title);

  const shot = await call('screenshot', { tabId: opened.tabId });
  check('screenshot returns png data', typeof shot.base64 === 'string' && shot.base64.length > 1000, { len: (shot.base64 || '').length });

  const shotInfo = await call('screenshot', { tabId: opened.tabId });
  check('a screenshot reports the format it was encoded in',
    shotInfo.format === 'png' || shotInfo.format === 'jpeg', shotInfo.format);

  const click = await call('click', { ref: 1, tabId: opened.tabId });
  check('click resolves a ref', typeof click.clicked === 'string' && click.clicked.length > 0, click);

  // Text entry on a page this test owns, so the check does not depend on a
  // third party's markup or render timing.
  const form = await call('open', { url: 'https://example.com', newTab: true });
  const formHtml = '<h1>form</h1><input id="q" type="text" placeholder="search">';
  await call('eval', {
    tabId: form.tabId,
    expression: '(function () { document.body.innerHTML = ' + JSON.stringify(formHtml) + '; return "ok"; })()',
  });
  const formSnap = await call('snapshot', { tabId: form.tabId });
  const inputRef = /\[ref=(\d+)\] input/i.exec(formSnap.snapshot);
  check('snapshot lists the injected input', inputRef !== null, formSnap.snapshot.slice(0, 300));
  if (inputRef) {
    const ref = Number(inputRef[1]);
    const typed = await call('type', { ref: ref, text: 'deepseek harness', tabId: form.tabId });
    check('type reports success', typed.typed === true, typed);
    const value = await call('eval', { expression: 'document.activeElement.value', tabId: form.tabId });
    check('typed text reached the field', String(value.result).indexOf('deepseek') !== -1, value);
  }

  const pressed = await call('key', { key: 'Escape', tabId: form.tabId });
  check('key dispatches', pressed.pressed === 'Escape', pressed);

  // Each keydown the page sees, as key/code/shift, on a field of its own.
  await call('eval', { tabId: form.tabId, expression: '(function () { document.body.insertAdjacentHTML("beforeend", "<input id=\\"keys\\" data-bwignore autocomplete=\\"off\\">"); window.__keys = []; document.getElementById("keys").addEventListener("keydown", function (e) { window.__keys.push(e.key + "/" + e.code + (e.shiftKey ? "/shift" : "")); }); return "ok"; })()' });
  const keysOf = async () => JSON.parse((await call('eval', { tabId: form.tabId, expression: 'window.__keys.splice(0)' })).result);
  await call('click', { selector: '#keys', tabId: form.tabId });
  await keysOf();
  await call('key', { key: '1', tabId: form.tabId });
  check('a digit is sent with its real key code', JSON.stringify(await keysOf()) === '["1/Digit1"]');
  await call('key', { key: '!', tabId: form.tabId });
  check('a shifted symbol holds shift on its own key', JSON.stringify(await keysOf()) === '["!/Digit1/shift"]');
  const sequence = await call('key', { key: 'a b c', tabId: form.tabId });
  check('a key sequence is pressed in order', JSON.stringify(await keysOf()) === '["a/KeyA","b/KeyB","c/KeyC"]', sequence);
  await call('key', { key: 'ArrowLeft', repeat: 3, tabId: form.tabId });
  check('repeat presses the sequence again', JSON.stringify(await keysOf()) === '["ArrowLeft/ArrowLeft","ArrowLeft/ArrowLeft","ArrowLeft/ArrowLeft"]');
  const keysValue = await call('eval', { tabId: form.tabId, expression: 'document.getElementById("keys").value' });
  check('the keys typed what they should', JSON.parse(keysValue.result) === '1!abc', keysValue);

  // --- edge cases -------------------------------------------------------------
  console.log('');
  console.log('edge cases');

  const selectorClick = await call('click', { selector: 'a', tabId: opened.tabId });
  check('click by css selector', typeof selectorClick.clicked === 'string' && selectorClick.clicked.length > 0, selectorClick);

  let staleRefError = null;
  try { await call('click', { ref: 9999, tabId: opened.tabId }); } catch (error) { staleRefError = String(error.message); }
  check('a stale ref fails with guidance', staleRefError !== null && /snapshot/i.test(staleRefError), staleRefError);

  const circular = await call('eval', { expression: '(function () { var o = {}; o.self = o; return o; })()', tabId: opened.tabId });
  check('a circular value is reported, not thrown', /Error/i.test(String(circular.result)), circular);
  // The wrapper used to serialise a Promise before it settled, so this read "{}".
  const later = await call('eval', { expression: 'new Promise(function (r) { setTimeout(function () { r({ answer: 42 }); }, 50); })', tabId: opened.tabId });
  check('a promise is awaited before its value comes back', String(later.result) === '{"answer":42}', later);
  const awaited = await call('eval', { expression: '(await Promise.resolve(6)) * 7', tabId: opened.tabId });
  check('an expression can use await', String(awaited.result) === '42', awaited);

  await call('type', { selector: '#q', text: 'by selector', tabId: form.tabId });
  const bySelector = await call('eval', { expression: 'document.activeElement.value', tabId: form.tabId });
  check('type by css selector', String(bySelector.result).indexOf('by selector') !== -1, bySelector);

  await call('key', { key: 'Control+a', tabId: form.tabId });
  const selected = await call('eval', {
    expression: 'document.activeElement.selectionEnd - document.activeElement.selectionStart',
    tabId: form.tabId,
  });
  check('a modifier chord selects the field', Number(selected.result) > 0, selected);
  // The chord above landed, and focus emulation is what let it land without activating the tab.
  const afterKey = (await call('tabs')).find(t => t.id === form.tabId);
  check('a key press leaves its tab in the background', !!afterKey && afterKey.active === false, afterKey);

  // The same page captured while it is a BACKGROUND tab must not go blank.
  const background = await call('screenshot', { tabId: opened.tabId });
  const activeLen = (shot.base64 || '').length;
  const backgroundLen = (background.base64 || '').length;
  check('a background tab still renders', backgroundLen > activeLen * 0.5, { activeLen: activeLen, backgroundLen: backgroundLen });

  let badUrlError = null;
  try { await call('open', { url: 'ftp://example.com' }); } catch (error) { badUrlError = String(error.message); }
  check('a non-http url is refused', badUrlError !== null && /http/i.test(badUrlError), badUrlError);

  let unknownError = null;
  try { await call('nope'); } catch (error) { unknownError = String(error.message); }
  check('an unknown command is refused', unknownError !== null && /unknown command/i.test(unknownError), unknownError);

  // Coverage: an icon-only control must report a usable label, and ARIA-only
  // widgets must appear at all.
  const widgetHtml = '<button title="Close dialog" style="width:80px;height:24px"></button>'
    + '<div role="combobox" aria-label="Language" style="width:120px;height:24px"></div>';
  await call('eval', {
    tabId: form.tabId,
    expression: '(function () { document.body.innerHTML = ' + JSON.stringify(widgetHtml) + '; return "ok"; })()',
  });
  const widgetSnap = await call('snapshot', { tabId: form.tabId });
  check('an icon-only button reports its title', widgetSnap.snapshot.indexOf('Close dialog') !== -1, widgetSnap.snapshot.slice(0, 300));
  check('an aria-only combobox is listed', /combobox/i.test(widgetSnap.snapshot) && /Language/.test(widgetSnap.snapshot), widgetSnap.snapshot.slice(0, 300));

  // A page-level alert() blocks the renderer; the extension must dismiss it or
  // the click and every later command hang (reproduced before the fix).
  const dlgHtml = '<button id="dlg" onclick="alert(1)" style="width:200px;height:60px">Press</button>';
  await call('eval', {
    tabId: form.tabId,
    expression: '(function () { document.body.innerHTML = ' + JSON.stringify(dlgHtml) + '; return "ok"; })()',
  });
  const dlgSnap = await call('snapshot', { tabId: form.tabId });
  const dlgRef = /\[ref=(\d+)\] button/.exec(dlgSnap.snapshot);
  let dialogOk = false;
  if (dlgRef) {
    try {
      await call('click', { ref: Number(dlgRef[1]), tabId: form.tabId }, 8000);
      const afterDialog = await call('eval', { tabId: form.tabId, expression: '2 + 2' }, 8000);
      dialogOk = String(afterDialog.result) === '4';
    } catch (error) { dialogOk = false; }
  }
  check('an alert() does not wedge the tab', dialogOk, dlgRef ? dlgRef[1] : 'no button ref');

  // --- background operation and the agent's own group -------------------------
  console.log('');
  console.log('background and grouping');
  const bgA = await call('open', { url: 'https://example.com', newTab: true });
  const bgB = await call('open', { url: 'https://example.com/?two', newTab: true });
  const listAfter = await call('tabs');
  const tabA = listAfter.find(t => t.id === bgA.tabId);
  const tabB = listAfter.find(t => t.id === bgB.tabId);
  check('an opened tab joins the agent group', !!tabA && tabA.groupId !== -1 && !!tabB && tabB.groupId === tabA.groupId, { a: tabA && tabA.groupId, b: tabB && tabB.groupId });
  check('opening a tab does not steal the view', !!tabA && tabA.active === false, tabA);
  const shotBackground = await call('screenshot', { tabId: bgA.tabId });
  check('a background capture still returns an image', typeof shotBackground.base64 === 'string' && shotBackground.base64.length > 1000, { len: (shotBackground.base64 || '').length });
  const afterShot = (await call('tabs')).find(t => t.id === bgA.tabId);
  check('a capture does not steal the view', !!afterShot && afterShot.active === false, afterShot);
  await call('eval', {
    tabId: bgA.tabId,
    expression: '(function () { document.body.innerHTML = \'<input id="k" type="text">\'; document.getElementById("k").addEventListener("click", function () { this.dataset.clicked = "yes"; }); return "ok"; })()',
  });
  await call('type', { selector: '#k', text: 'background typing', tabId: bgA.tabId });
  const bgValue = await call('eval', { tabId: bgA.tabId, expression: 'document.activeElement.value' });
  check('typing reaches a background tab', String(bgValue.result).indexOf('background') !== -1, bgValue);
  // chrome_type clicks its field, so clear that click's mark before testing the click itself.
  await call('eval', { tabId: bgA.tabId, expression: '(function () { delete document.getElementById("k").dataset.clicked; return "ok"; })()' });
  // The click must actually land, not just leave the tab inactive. A click that
  // dispatches nothing would pass a "the view did not move" check vacuously.
  await call('click', { selector: '#k', tabId: bgA.tabId });
  const clickLanding = await call('eval', { tabId: bgA.tabId, expression: 'document.getElementById("k").dataset.clicked === "yes"' });
  check('a click on a background tab actually reaches the page', String(clickLanding.result) === 'true', clickLanding);
  const afterClick = (await call('tabs')).find(t => t.id === bgA.tabId);
  check('a click leaves its tab in the background', !!afterClick && afterClick.active === false, afterClick);

  // Targeting: a command with no tabId must use the agent's own tab. The old
  // fallback was "the active tab of the last focused window", which means a bare
  // call could click whatever the user happened to be looking at.
  console.log('tab targeting');
  const userTab = await call('open', { url: 'https://example.com/?user=1', newTab: true });
  const agentTab = await call('open', { url: 'https://example.com/?agent=1', newTab: true });
  const implicit = await call('eval', { expression: 'location.search' });
  check('a command without a tabId uses the agent tab it opened last',
    String(implicit.result).indexOf('agent=1') !== -1, implicit);

  await call('close', { tabId: agentTab.tabId });
  // The remembered tab is cleared by tabs.onRemoved, which is asynchronous: a bare
  // command sent the instant after close can still see the closed id and fail with
  // "No tab with id" instead of "no tab yet". Both mean nothing resolved; what
  // must never happen is a success, which would mean a bare command reached a tab
  // the agent did not open. Retry so the listener has time to catch up.
  let noTabError = '';
  let bareValue = null;
  const targetingDeadline = Date.now() + 5000;
  for (;;) {
    try {
      bareValue = await call('eval', { expression: 'location.search' });
      break;
    } catch (error) {
      noTabError = String(error.message);
      if (/no tab yet/.test(noTabError) || Date.now() > targetingDeadline) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  check('with the remembered tab closed a bare command fails instead of using the user tab',
    bareValue === null && /no tab yet/.test(noTabError), { bareValue, noTabError });

  await call('close', { tabId: userTab.tabId });

  // The listing has to say which tabs are the agent's own; every targeting
  // decision the model makes reads this flag.
  const ownTab = await call('open', { url: 'https://example.com/?own=1', newTab: true });
  const listing = await call('tabs');
  const own = listing.filter(t => t.id === ownTab.tabId)[0];
  // The agent's own tabs all share one group; anything outside it is the user's.
  const foreign = listing.filter(t => t.groupId !== own.groupId);
  check('a tab the agent opened is reported as its own', own && own.agent === true, own);
  // Whether the user happens to have a tab outside the group is not this check's
  // business; when one exists it must not be marked as the agent's. A browser
  // whose only tabs are the agent's own must not fail it, so the count is
  // reported separately rather than required to be non-zero.
  check('a tab outside the agent group is not marked as the agent\'s',
    foreign.every(t => t.agent === false), { foreignCount: foreign.length, foreign: foreign.slice(0, 3) });
  await call('close', { tabId: ownTab.tabId });

  // --- agent cursor -----------------------------------------------------------
  console.log('');
  console.log('agent cursor');
  const cur = await call('open', { url: 'https://example.com', newTab: true });
  await new Promise(r => setTimeout(r, 800));
  await call('click', { x: 260, y: 200, tabId: cur.tabId });
  const atFirst = await call('screenshot', { tabId: cur.tabId });
  // Move the overlay somewhere else. Both frames are taken AFTER a click, on an
  // unchanged page, so the only difference between them is where the cursor is
  // — which isolates the overlay from anything else the click changed.
  await call('click', { x: 430, y: 330, tabId: cur.tabId });
  const overlay = await call('eval', {
    tabId: cur.tabId,
    // chrome_eval already serialises the value, so return the object itself;
    // stringifying here would double-encode it.
    expression: '(function () { var el = document.getElementById("dsh-agent-cursor");'
      + ' if (!el) return null;'
      + ' return { opacity: el.style.opacity, transform: el.style.transform, pointerEvents: getComputedStyle(el).pointerEvents, ariaHidden: el.getAttribute("aria-hidden") }; })()',
  });
  const state = JSON.parse(String(overlay.result));
  check('the cursor exists after a click', state !== null, overlay.result);
  // Asserted against the SECOND click, which is where the cursor currently is.
  check('it sits where the click landed', state !== null && state.transform.indexOf('430px') !== -1 && state.transform.indexOf('330px') !== -1, state);
  check('it is visible between actions', state !== null && state.opacity === '1', state);
  check('it takes no pointer events', state !== null && state.pointerEvents === 'none', state);
  const atSecond = await call('screenshot', { tabId: cur.tabId });
  check('the overlay never reaches the model frames', atFirst.base64 === atSecond.base64, {
    first: atFirst.base64.length, second: atSecond.base64.length,
  });

  // --- input beyond left-click, and observation --------------------------------
  console.log('');
  console.log('scroll / hover / clicks / drag / observation');

  const cap = await call('open', { url: 'https://example.com', newTab: true });
  const pageHtml = '<div style="height:3000px">tall</div>'
    + '<button id="b" style="width:120px;height:40px">B</button>'
    + '<input id="f" type="file">'
    // role=button + tabindex make #box genuinely interactive, so chrome_snapshot
    // lists it and the scroll-to-ref and drag checks below have a real ref.
    + '<div id="box" role="button" tabindex="0" style="width:80px;height:80px;background:#ccc">box</div>';
  const install = [
    '(function () {',
    '  document.body.innerHTML = ' + JSON.stringify(pageHtml) + ';',
    '  window.__ev = [];',
    '  var kinds = ["mousemove","mousedown","mouseup","click","dblclick","contextmenu"];',
    '  for (var i = 0; i < kinds.length; i++) {',
    '    document.addEventListener(kinds[i], function (e) {',
    '      window.__ev.push(e.type + ":" + e.button + ":" + (e.detail || 0));',
    '    }, true);',
    '  }',
    '  console.log("capability-probe-log");',
    '  void fetch("https://example.com/?probe=1").catch(function () {});',
    'var frame = document.createElement("iframe");',
    'frame.id = "probe-frame";',
    'frame.style.cssText = "position:absolute;top:200px;left:40px;width:400px;height:200px;border:0";',
    'frame.srcdoc = ' + JSON.stringify('<button id="inner-btn" style="width:200px;height:60px">inner target</button>') + ';',
    'document.body.appendChild(frame);',
    '  return "ok";',
    '})()',
  ].join('\n');
  await call('eval', { tabId: cap.tabId, expression: install });
  await new Promise(r => setTimeout(r, 600));

  // scroll: wheel by delta
  await call('scroll', { deltaY: 900, tabId: cap.tabId });
  const scrolled = await call('eval', { tabId: cap.tabId, expression: 'Math.round(window.scrollY)' });
  check('a wheel scroll moves the page', Number(scrolled.result) > 100, scrolled);

  // scroll: bring a ref into view
  const capSnap = await call('snapshot', { tabId: cap.tabId });
  const boxRef = /\[ref=(\d+)\] (?:div|button)?\s*"box"/i.exec(capSnap.snapshot);
  // A real assertion that always runs: the probe div is interactive (role=button),
  // so a snapshot that does not list it is a broken snapshot, not a branch.
  check('snapshot exposes a ref for the probe div', boxRef !== null, capSnap.snapshot.slice(0, 300));
  if (boxRef) {
    await call('scroll', { ref: Number(boxRef[1]), tabId: cap.tabId });
    const inView = await call('eval', { tabId: cap.tabId, expression: '(function () { var el = document.getElementById("box"); if (!el) return null; var r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()' });
    check('scrolling to a ref brings it into view', String(inView.result) === 'true', inView);
  }

  // Content inside a frame is invisible to a main-frame-only snapshot.
  await new Promise(r => setTimeout(r, 600));
  const framed = await call('snapshot', { tabId: cap.tabId });
  check('a snapshot reports a ref from inside an iframe',
    /frame=f\d+\]/.test(framed.snapshot), framed.snapshot.slice(0, 400));
  check('a snapshot still reports main-frame refs unchanged',
    /\[ref=\d+\] (?!.*frame=)/.test(framed.snapshot), framed.snapshot.slice(0, 200));

  // A main-frame ref is resolved in the page's own world, so walking child frames
  // must not have moved the main frame's refs into an isolated world. Refs are
  // per-snapshot, so the ref has to come from the snapshot just taken.
  const mainRef = /^\[ref=(\d+)\] (?![^\n]*frame=)/m.exec(framed.snapshot);
  check('a main-frame ref is still listed after a frame snapshot', mainRef !== null, framed.snapshot.slice(0, 300));
  let mainRefError = null;
  if (mainRef) {
    try {
      await call('scroll', { ref: Number(mainRef[1]), tabId: cap.tabId });
    } catch (error) {
      mainRefError = String(error.message);
    }
  }
  check('a main-frame ref still resolves after a frame snapshot',
    mainRef !== null && mainRefError === null, mainRefError);

  // A ref inside a frame resolves in that frame's coordinates, which are not the
  // page's. Clicking must apply the frame's offset.
  const innerRef = /\[ref=(\d+) frame=(f\d+)\]/.exec(framed.snapshot);
  if (innerRef) {
    await call('eval', { tabId: cap.tabId, expression: '(function () { window.__hit = false; document.querySelector("#probe-frame").contentWindow.document.getElementById("inner-btn").addEventListener("click", function () { window.__hit = true; }); return "ok"; })()' });
    await call('click', { ref: Number(innerRef[1]), frame: innerRef[2], tabId: cap.tabId });
    const hit = await call('eval', { tabId: cap.tabId, expression: 'document.querySelector("#probe-frame").contentWindow.__hit === true || window.__hit === true' });
    check('a ref from a frame clicks the element inside it', String(hit.result) === 'true', hit);
  } else {
    check('a ref from a frame clicks the element inside it', false, framed.snapshot.slice(0, 300));
  }

  // page_text is deliberately main-frame only: its job is reading the article,
  // and frame text is usually widget noise. Assert the decision, not just intend it.
  const mainOnly = await call('pageText', { tabId: cap.tabId });
  check('page_text stays on the main page by decision',
    String(mainOnly.text).indexOf('inner target') === -1, String(mainOnly.text).slice(0, 200));

  const framedFind = await call('find', { text: 'inner target', tabId: cap.tabId });
  check('find reaches text that only exists inside a frame',
    framedFind.count > 0, framedFind);
  check('a match from a frame says which frame it came from',
    framedFind.matches.some(m => /^\[f\d+\]/.test(m)), framedFind.matches);

  // The agent's tab is in the background here; focus emulation must let a real
  // wheel through. Measured on this fixture: the wheel acked after ~1s and the
  // page moved ~1s after that (1992ms in all), and 3049-3078ms when the ack
  // was slower, so the bound is for a hang, not for the cost of each frame.
  const bgStart = Date.now();
  const bg = await call('scroll', { deltaY: 400, tabId: cap.tabId }, 12000);
  const bgElapsed = Date.now() - bgStart;
  check('a background-tab scroll is a real wheel', /^wheel/.test(String(bg.scrolled)), bg);
  check('a background-tab scroll does not hang', bgElapsed < 5000, { bgElapsed });

  await call('hover', { selector: '#b', tabId: cap.tabId });
  const afterHover = await call('eval', { tabId: cap.tabId, expression: 'window.__ev' });
  check('hover dispatches a move the page sees', String(afterHover.result).indexOf('mousemove') !== -1, afterHover);

  await call('click', { selector: '#b', clicks: 2, tabId: cap.tabId });
  const afterDouble = await call('eval', { tabId: cap.tabId, expression: 'window.__ev' });
  check('a double click reaches detail 2', String(afterDouble.result).indexOf('dblclick:0:2') !== -1, afterDouble);

  await call('click', { selector: '#b', button: 'right', tabId: cap.tabId });
  const afterRight = await call('eval', { tabId: cap.tabId, expression: 'window.__ev' });
  check('a right click reaches button 2', String(afterRight.result).indexOf('contextmenu:2') !== -1, afterRight);

  await call('eval', { tabId: cap.tabId, expression: '(function () { window.__held = null; document.getElementById("b").addEventListener("click", function (e) { window.__held = (e.ctrlKey ? "ctrl " : "") + (e.shiftKey ? "shift " : "") + (e.altKey ? "alt " : "") + (e.metaKey ? "meta" : ""); }, { once: true }); return "ok"; })()' });
  const heldClick = await call('click', { selector: '#b', modifiers: 'Control+Shift', tabId: cap.tabId });
  const held = await call('eval', { tabId: cap.tabId, expression: 'window.__held' });
  check('a click with modifiers holds them', JSON.parse(held.result) === 'ctrl shift ', { held, heldClick });
  let badModifier = null;
  try { await call('click', { selector: '#b', modifiers: 'Hyper', tabId: cap.tabId }); } catch (error) { badModifier = String(error.message); }
  check('an unknown modifier is refused', badModifier !== null && /unknown modifier/.test(badModifier), badModifier);

  await call('drag', { fromSelector: '#box', toSelector: '#f', tabId: cap.tabId });
  const ev = JSON.parse(String((await call('eval', { tabId: cap.tabId, expression: 'window.__ev' })).result));
  const startAt = ev.indexOf('mousedown:0:1');
  const endAt = ev.lastIndexOf('mouseup:0:1');
  const movesBetween = startAt >= 0 && endAt > startAt && ev.slice(startAt, endAt).filter(k => k.indexOf('mousemove:0') === 0).length;
  check('drag presses, moves through, and releases', startAt >= 0 && endAt > startAt && movesBetween >= 5, { movesBetween: movesBetween });

  const prose = await call('pageText', { tabId: cap.tabId });
  check('pageText returns the prose', String(prose.text).indexOf('tall') !== -1, prose.text.slice(0, 120));

  const found = await call('find', { text: 'tall', tabId: cap.tabId });
  check('find reports matches', found.count >= 1 && found.matches.length >= 1, found);

  const logs = await call('console', { tabId: cap.tabId });
  check('console captures a log line', JSON.stringify(logs.entries).indexOf('capability-probe-log') !== -1, logs.entries.slice(0, 3));
  const logsAgain = await call('console', { tabId: cap.tabId });
  check('console is one-shot unless kept', logsAgain.entries.length === 0, logsAgain.entries.length);

  const reqs = await call('network', { tabId: cap.tabId });
  check('network captures the probe request', JSON.stringify(reqs.entries).indexOf('probe=1') !== -1, reqs.entries.slice(0, 4));

  await call('resize', { width: 420, height: 640, tabId: cap.tabId });
  const sized = await call('eval', { tabId: cap.tabId, expression: 'window.innerWidth' });
  check('resize changes the layout width', Number(sized.result) === 420, sized);
  await call('resize', { width: 0, height: 0, tabId: cap.tabId });
  // The renderer applies the cleared override asynchronously, so poll briefly
  // rather than asserting on the first read. The check still fails if the width
  // never leaves the override.
  let cleared = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    cleared = await call('eval', { tabId: cap.tabId, expression: 'window.innerWidth' });
    if (Number(cleared.result) !== 420) break;
    await new Promise(r => setTimeout(r, 50));
  }
  check('resize clears again', Number(cleared.result) !== 420, cleared);

  const uploadPath = join(tmpdir(), 'dsh-chrome-upload-probe.txt');
  await writeFile(uploadPath, 'probe');
  await call('upload', { files: [uploadPath], selector: '#f', tabId: cap.tabId });
  const attached = await call('eval', { tabId: cap.tabId, expression: 'document.getElementById("f").files.length' });
  check('upload attaches a file to the input', Number(attached.result) === 1, attached);

  // Back, forward and reload move one tab through its history, and come back
  // only when the resulting page has loaded.
  const hist = await call('open', { url: 'https://example.com/?h=1', newTab: true });
  let noHistory = null;
  try { await call('open', { url: 'back', tabId: hist.tabId }); } catch (error) { noHistory = String(error.message); }
  check('back with no history is refused with Chrome\'s reason', noHistory !== null && /could not go back/.test(noHistory), noHistory);
  await call('open', { url: 'https://example.com/?h=2', tabId: hist.tabId });
  const wentBack = await call('open', { url: 'back', tabId: hist.tabId });
  const backHere = await call('eval', { tabId: hist.tabId, expression: 'location.search' });
  check('back returns to the previous page', /\?h=1$/.test(String(wentBack.url)) && JSON.parse(backHere.result) === '?h=1', { wentBack, backHere });
  const wentForward = await call('open', { url: 'forward', tabId: hist.tabId });
  check('forward returns to the next page', /\?h=2$/.test(String(wentForward.url)), wentForward);
  await call('eval', { tabId: hist.tabId, expression: '(function () { window.__beforeReload = true; return "ok"; })()' });
  await call('open', { url: 'reload', tabId: hist.tabId });
  const reloaded = await call('eval', { tabId: hist.tabId, expression: 'window.__beforeReload === true ? "same page" : "fresh page"' });
  check('reload loads the page again', JSON.parse(reloaded.result) === 'fresh page', reloaded);
  await call('close', { tabId: hist.tabId });

  // A snapshot lists 400 refs per frame; it used to stop there without saying so.
  const many = await call('open', { url: 'https://example.com/?many', newTab: true });
  await call('eval', { tabId: many.tabId, expression: '(function () { var html = ""; for (var i = 1; i <= 450; i++) html += "<button>b" + i + "</button>"; document.body.innerHTML = html; return "ok"; })()' });
  const manySnap = await call('snapshot', { tabId: many.tabId });
  const listed = (manySnap.snapshot.match(/^\[ref=\d+\]/gm) || []).length;
  check('a snapshot past the cap lists 400 and says how many it left out', listed === 400 && /50 more interactive element\(s\) were not listed/.test(manySnap.snapshot), { listed, tail: manySnap.snapshot.slice(manySnap.snapshot.indexOf('…'), manySnap.snapshot.indexOf('…') + 160) });
  await call('close', { tabId: many.tabId });

  // --- click accuracy: every case here clicked the wrong thing, or clicked at
  // (0,0), and still reported success before the pre-click hit test ---------
  console.log('');
  console.log('click accuracy');
  const acc = await call('open', { url: 'https://example.com', newTab: true });
  const accHtml = '<style>body{margin:0}</style>'
    + '<button id="half" style="position:absolute;left:20px;top:20px;width:200px;height:40px">half covered</button>'
    // Covers the left 130 of 200px, so the button's centre (x=120) is under it.
    + '<div id="halfcover" style="position:absolute;left:20px;top:20px;width:130px;height:40px;background:red"></div>'
    + '<button id="full" style="position:absolute;left:20px;top:100px;width:200px;height:40px">fully covered</button>'
    + '<div id="fullcover" style="position:absolute;left:10px;top:90px;width:220px;height:60px;background:red">cookie banner</div>'
    + '<div style="position:absolute;left:20px;top:180px;width:120px;font:16px/40px sans-serif">xx <a id="wrap" href="#w">wrapped link text here</a></div>'
    + '<button id="stale" style="position:absolute;left:20px;top:300px">stale</button>'
    + '<button id="hide" style="position:absolute;left:120px;top:300px">hide</button>'
    + '<iframe id="cf" style="position:absolute;left:20px;top:360px;width:300px;height:100px;border:0" srcdoc="<button id=&quot;fb&quot; style=&quot;width:200px;height:50px&quot;>framed</button>"></iframe>'
    + '<div id="framecover" style="position:absolute;left:10px;top:350px;width:320px;height:120px;background:rgba(0,0,0,0.5)"></div>';
  await call('eval', { tabId: acc.tabId, expression: '(function () { document.body.innerHTML = ' + JSON.stringify(accHtml) + '; window.__clicks = []; document.addEventListener("click", function (e) { window.__clicks.push(e.target.id || e.target.tagName); }, true); return "ok"; })()' });
  await new Promise(r => setTimeout(r, 600));
  const clicksOf = async () => JSON.parse((await call('eval', { tabId: acc.tabId, expression: 'window.__clicks.splice(0)' })).result);
  const refusal = async params => {
    try { await call('click', { ...params, tabId: acc.tabId }); return null; } catch (error) { return String(error.message); }
  };

  await call('click', { selector: '#half', tabId: acc.tabId });
  const halfClicks = await clicksOf();
  check('a half-covered button is clicked on its visible half', JSON.stringify(halfClicks) === '["half"]', halfClicks);

  const fullError = await refusal({ selector: '#full' });
  const fullClicks = await clicksOf();
  check('a fully covered button is refused, naming what covers it', fullError !== null && /covered by div#fullcover/.test(fullError), fullError);
  check('the refused click landed nowhere', fullClicks.length === 0, fullClicks);

  await call('click', { selector: '#wrap', tabId: acc.tabId });
  const wrapClicks = await clicksOf();
  check('a wrapped link is clicked on its text, not between its lines', JSON.stringify(wrapClicks) === '["wrap"]', wrapClicks);

  const accSnap = await call('snapshot', { tabId: acc.tabId });
  const staleRef = /\[ref=(\d+)\] button "stale"/.exec(accSnap.snapshot);
  const hideRef = /\[ref=(\d+)\] button "hide"/.exec(accSnap.snapshot);
  const frameRef = /\[ref=(\d+) frame=(f\d+)\] button "framed"/.exec(accSnap.snapshot);
  check('the accuracy fixture is in the snapshot', staleRef !== null && hideRef !== null && frameRef !== null, accSnap.snapshot.slice(0, 600));
  await call('eval', { tabId: acc.tabId, expression: '(function () { var old = document.getElementById("stale"); var fresh = old.cloneNode(true); old.replaceWith(fresh); document.getElementById("hide").style.display = "none"; return "ok"; })()' });
  const staleError = staleRef ? await refusal({ ref: Number(staleRef[1]) }) : 'no ref';
  check('a ref whose element re-rendered is refused', staleError !== null && /no longer on the page/.test(staleError), staleError);
  const hideError = hideRef ? await refusal({ ref: Number(hideRef[1]) }) : 'no ref';
  check('a ref whose element was hidden is refused', hideError !== null && /no visible size/.test(hideError), hideError);
  const frameError = frameRef ? await refusal({ ref: Number(frameRef[1]), frame: frameRef[2] }) : 'no ref';
  check('a frame ref under an overlay is refused', frameError !== null && /covered by div#framecover/.test(frameError), frameError);
  const strayClicks = await clicksOf();
  check('no refused click landed anywhere, not even at 0,0', strayClicks.length === 0, strayClicks);

  // --- typing: a real click into the field, then the field read back --------
  // A password manager that injects its autofill frame into the page locks the debugger out of the
  // whole tab, so these fields opt out; that interaction gets its own section.
  const typeHtml = '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="t1" style="position:absolute;left:20px;top:520px">'
    + '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="t3" maxlength="3" style="position:absolute;left:220px;top:520px">'
    + '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="tpw" type="password" style="position:absolute;left:420px;top:520px">'
    + '<input data-bwignore data-1p-ignore data-lpignore autocomplete="off" id="tcov" style="position:absolute;left:20px;top:580px">'
    + '<div id="tcovered" style="position:absolute;left:10px;top:570px;width:220px;height:40px;background:red"></div>'
    + '<div id="tce" contenteditable="true" style="position:absolute;left:220px;top:580px;width:200px">hello</div>';
  await call('eval', { tabId: acc.tabId, expression: '(function () { document.body.insertAdjacentHTML("beforeend", ' + JSON.stringify(typeHtml) + '); document.getElementById("t1").value = "old"; return "ok"; })()' });
  const t1 = await call('type', { selector: '#t1', text: 'replaced', tabId: acc.tabId });
  check('typing replaces the field and reads it back', t1.value === 'replaced' && t1.matches === true, t1);
  const t3 = await call('type', { selector: '#t3', text: 'abcdef', tabId: acc.tabId });
  check('a field that truncates is reported, with what it really holds', t3.value === 'abc' && t3.matches === false, t3);
  const tpw = await call('type', { selector: '#tpw', text: 'hunter22', tabId: acc.tabId });
  check('a password is read back as a length only', /hidden: 8 characters/.test(tpw.value) && tpw.value.indexOf('hunter') === -1, tpw);
  let tcovError = null;
  try { await call('type', { selector: '#tcov', text: 'nope', tabId: acc.tabId }); } catch (error) { tcovError = String(error.message); }
  const tcovValue = await call('eval', { tabId: acc.tabId, expression: 'document.getElementById("tcov").value' });
  check('typing into a covered field is refused', tcovError !== null && /covered by div#tcovered/.test(tcovError), tcovError);
  check('the refused text went nowhere', JSON.parse(tcovValue.result) === '', tcovValue);
  const tce = await call('type', { selector: '#tce', text: ' world', tabId: acc.tabId });
  check('a contenteditable is appended to, not wiped', tce.value === 'hello world', tce);

  // --- dialogs: reported every time, and nothing agreed to unasked ----------
  const dialogHtml = '<button id="dconfirm" style="position:absolute;left:20px;top:660px" onclick="window.__confirm = confirm(\'Delete forever?\')">confirm</button>'
    + '<button id="dalert" style="position:absolute;left:120px;top:660px" onclick="alert(\'Saved\')">alert</button>'
    + '<button id="dprompt" style="position:absolute;left:220px;top:660px" onclick="window.__prompt = prompt(\'Name?\', \'default\')">prompt</button>';
  await call('eval', { tabId: acc.tabId, expression: '(function () { document.body.insertAdjacentHTML("beforeend", ' + JSON.stringify(dialogHtml) + '); return "ok"; })()' });
  const confirmDefault = await call('click', { selector: '#dconfirm', tabId: acc.tabId });
  const confirmAnswer = await call('eval', { tabId: acc.tabId, expression: 'window.__confirm' });
  check('a confirm is dismissed by default', JSON.parse(confirmAnswer.result) === false, confirmAnswer);
  check('the dismissed confirm is reported with its message',
    Array.isArray(confirmDefault.dialogs) && confirmDefault.dialogs.length === 1 && confirmDefault.dialogs[0].type === 'confirm'
    && confirmDefault.dialogs[0].message === 'Delete forever?' && confirmDefault.dialogs[0].accepted === false, confirmDefault);
  const confirmAccepted = await call('click', { selector: '#dconfirm', dialog: 'accept', tabId: acc.tabId });
  const confirmYes = await call('eval', { tabId: acc.tabId, expression: 'window.__confirm' });
  check('dialog: "accept" answers a confirm OK', JSON.parse(confirmYes.result) === true && confirmAccepted.dialogs[0].accepted === true, confirmAccepted);
  const alerted = await call('click', { selector: '#dalert', tabId: acc.tabId });
  check('an alert is accepted and reported', Array.isArray(alerted.dialogs) && alerted.dialogs[0].type === 'alert' && alerted.dialogs[0].accepted === true, alerted);
  await call('click', { selector: '#dprompt', dialog: 'accept', promptText: 'deepseek', tabId: acc.tabId });
  const prompted = await call('eval', { tabId: acc.tabId, expression: 'window.__prompt' });
  check('a prompt is answered with promptText', JSON.parse(prompted.result) === 'deepseek', prompted);
  const quiet = await call('click', { selector: '#t1', tabId: acc.tabId });
  check('an action that opens no dialog reports none', quiet.dialogs === undefined, quiet);
  await call('close', { tabId: acc.tabId });

  // A page that asks before it is left. Chrome brings a background tab forward
  // to show that warning, so the extension decides first and Chrome never shows it.
  const activeNow = async () => JSON.stringify((await call('tabs')).filter(t => t.active).map(t => t.id).sort());
  const armLeave = async tabId => {
    await call('eval', { tabId, expression: '(function () { window.addEventListener("beforeunload", function (e) { e.preventDefault(); e.returnValue = ""; }); document.body.insertAdjacentHTML("beforeend", "<a id=\\"away\\" href=\\"https://example.com/?clicked-away\\" style=\\"position:absolute;left:20px;top:300px\\">away</a>"); return "ok"; })()' });
    await call('click', { x: 10, y: 10, tabId });
  };
  const leave = await call('open', { url: 'https://example.com/?leave', newTab: true });
  await armLeave(leave.tabId);
  const viewBefore = await activeNow();
  const stayStart = Date.now();
  let stayError = null;
  try { await call('open', { url: 'https://example.com/?left', tabId: leave.tabId }); } catch (error) { stayError = String(error.message); }
  const stayMs = Date.now() - stayStart;
  const stillThere = await call('eval', { tabId: leave.tabId, expression: 'location.search' });
  check('navigating away from a page that asks first is refused by default', stayError !== null && /asks before it is left/.test(stayError), stayError);
  check('the refused navigation kept the page', JSON.parse(stillThere.result) === '?leave', stillThere);
  check('the refusal is immediate, not a load timeout', stayMs < 3000, { stayMs });
  check('the refusal did not move the user\'s view', await activeNow() === viewBefore, { before: viewBefore, after: await activeNow() });
  let closeError = null;
  try { await call('close', { tabId: leave.tabId }); } catch (error) { closeError = String(error.message); }
  check('closing a page that asks first is refused by default', closeError !== null && /asks before it is left/.test(closeError), closeError);
  const left = await call('open', { url: 'https://example.com/?left', tabId: leave.tabId, dialog: 'accept' });
  check('dialog: "accept" leaves the page', /\?left/.test(String(left.url)), left);
  check('leaving with accept showed no warning and did not move the view', left.dialogs === undefined && await activeNow() === viewBefore, { left, after: await activeNow() });
  // A link click can trigger the warning too; it is dismissed, and the view is given back.
  await armLeave(leave.tabId);
  const linkClick = await call('click', { selector: '#away', tabId: leave.tabId });
  await new Promise(r => setTimeout(r, 500));
  const afterLink = await call('eval', { tabId: leave.tabId, expression: 'location.search' });
  check('a link click on a page that asks first is held by the dismissed warning', JSON.parse(afterLink.result) === '?left'
    && Array.isArray(linkClick.dialogs) && linkClick.dialogs[0].type === 'beforeunload', { linkClick, afterLink });
  check('the warning a click raised did not keep the user\'s view', await activeNow() === viewBefore, { before: viewBefore, after: await activeNow() });
  const closedLeave = await call('close', { tabId: leave.tabId, dialog: 'accept' });
  check('closing it with accept showed no warning and did not move the view', closedLeave.dialogs === undefined && await activeNow() === viewBefore, { closedLeave, after: await activeNow() });

  // --- a real login form, which a password manager will want to fill ---------
  // With one installed (Bitwarden here), focusing these fields injects its
  // frame and Chrome locks the debugger out of the tab; the extension must get
  // the tab back and still fill the form. Without one, the same checks pass on
  // the ordinary path, so the note says which path ran.
  console.log('');
  console.log('login form');
  const login = await call('open', { url: 'https://example.com/?login', newTab: true });
  await call('eval', { tabId: login.tabId, expression: '(function () { document.body.innerHTML = \'<form id="lf" action="#" onsubmit="window.__submitted = (window.__submitted || 0) + 1; return false;"><input id="user" name="username" autocomplete="username" style="position:absolute;left:20px;top:20px"><input id="pw" type="password" name="password" autocomplete="current-password" style="position:absolute;left:20px;top:80px"><button id="go" style="position:absolute;left:20px;top:140px">Sign in</button></form>\'; return "ok"; })()' });
  const typedUser = await call('type', { selector: '#user', text: 'alice@example.com', tabId: login.tabId });
  console.log('        path: ' + (typedUser.note ? 'script fallback (' + typedUser.note.slice(0, 60) + '…)' : 'keystrokes'));
  check('a login form\'s username is filled and read back', typedUser.value === 'alice@example.com' && typedUser.matches === true, typedUser);
  const typedPw = await call('type', { selector: '#pw', text: 'hunter22', submit: true, tabId: login.tabId });
  check('its password is filled, reported only as a length', /hidden: 8 characters/.test(typedPw.value) && typedPw.matches === true, typedPw);
  const submitted = await call('eval', { tabId: login.tabId, expression: 'window.__submitted || 0' });
  check('submit sends the form', Number(submitted.result) >= 1, { submitted, typedPw });
  const loginSnap = await call('snapshot', { tabId: login.tabId });
  check('the tab answers ordinary commands afterwards', /Sign in/.test(loginSnap.snapshot), loginSnap.snapshot.slice(0, 200));
  await call('close', { tabId: login.tabId });

  const stillActive = (await call('tabs')).filter(t => t.active).map(t => t.id).sort();
  check('the user\'s active tabs never changed', JSON.stringify(stillActive) === JSON.stringify(userActive), { before: userActive, after: stillActive });

  // Close every test tab, including litter from earlier runs.
  const everything = await call('tabs');
  // The snapshot click follows example.com's "Learn more" link to iana.org.
  const litter = everything.filter(t => t.agent === true
    && /^https?:\/\/(www\.)?(example\.com|duckduckgo\.com|iana\.org)/.test(t.url));
  let closed = 0;
  for (const tab of litter) {
    try { await call('close', { tabId: tab.id }); closed += 1; } catch (error) { /* already gone */ }
  }
  check('close removes a tab', closed > 0, { found: litter.length, closed: closed });
  const after = await call('tabs');
  check('closed tabs are gone', after.filter(t => /example\.com/.test(t.url)).length === 0, after.map(t => t.url).slice(0, 5));
} catch (error) {
  console.log('  FAIL  harness :: ' + String((error && error.message) || error));
  console.log('        last call: ' + JSON.stringify(lastCall).slice(0, 300));
  failures.push('harness');
}

// Hygiene: an aborted run used to leave every tab it had opened behind.
const stillOpen = new Set(socket ? (await call('tabs').catch(() => [])).map(t => t.id) : []);
let leftovers = 0;
for (const tabId of openedTabs) {
  if (!stillOpen.has(tabId)) continue;
  try { await call('close', { tabId, dialog: 'accept' }, 5000); leftovers += 1; } catch (error) { /* already gone */ }
}
if (leftovers > 0) console.log('closed ' + leftovers + ' tab(s) this run left open');

wss.close();
console.log('');
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES: ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
