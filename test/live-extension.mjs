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
import { WebSocketServer } from 'ws'

const PORT = Number(process.argv[2] || 3099);

const failures = [];
function check(name, condition, detail) {
  if (condition) { console.log('  PASS  ' + name); return; }
  console.log('  FAIL  ' + name + ' :: ' + JSON.stringify(detail));
  failures.push(name);
}

let socket = null;
const wss = new WebSocketServer({ port: PORT });
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

function call(method, params, timeoutMs) {
  if (!socket) return Promise.reject(new Error('no extension connected'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs || 25000);
    waiting.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
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

  const tabs = await call('tabs');
  check('tabs returns a list', Array.isArray(tabs) && tabs.length > 0, tabs);

  const opened = await call('open', { url: 'https://example.com', newTab: true });
  check('open reports a tab', typeof opened.tabId === 'number', opened);
  check('open lands on the url', String(opened.url).indexOf('example.com') !== -1, opened.url);

  const snap = await call('snapshot', { tabId: opened.tabId });
  check('snapshot sees the page', snap.snapshot.indexOf('Example Domain') !== -1, snap.snapshot.slice(0, 200));
  check('snapshot exposes refs', /\[ref=1\]/.test(snap.snapshot), snap.snapshot.slice(0, 200));

  const title = await call('eval', { expression: 'document.title', tabId: opened.tabId });
  check('eval reads the dom', String(title.result).indexOf('Example Domain') !== -1, title);

  const shot = await call('screenshot', { tabId: opened.tabId });
  check('screenshot returns png data', typeof shot.base64 === 'string' && shot.base64.length > 1000, { len: (shot.base64 || '').length });

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

  await call('type', { selector: '#q', text: 'by selector', tabId: form.tabId });
  const bySelector = await call('eval', { expression: 'document.activeElement.value', tabId: form.tabId });
  check('type by css selector', String(bySelector.result).indexOf('by selector') !== -1, bySelector);

  await call('key', { key: 'Control+a', tabId: form.tabId });
  const selected = await call('eval', {
    expression: 'document.activeElement.selectionEnd - document.activeElement.selectionStart',
    tabId: form.tabId,
  });
  check('a modifier chord selects the field', Number(selected.result) > 0, selected);
  // Key events need a visible tab; assert the documented exception holds.
  const afterKey = (await call('tabs')).find(t => t.id === form.tabId);
  check('a key press brings its tab forward', !!afterKey && afterKey.active === true, afterKey);

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
    expression: '(function () { document.body.innerHTML = \'<input id="k" type="text">\'; return "ok"; })()',
  });
  await call('type', { selector: '#k', text: 'background typing', tabId: bgA.tabId });
  const bgValue = await call('eval', { tabId: bgA.tabId, expression: 'document.activeElement.value' });
  check('typing reaches a background tab', String(bgValue.result).indexOf('background') !== -1, bgValue);
  await call('click', { selector: '#k', tabId: bgA.tabId });
  const afterClick = (await call('tabs')).find(t => t.id === bgA.tabId);
  check('a click does not steal the view', !!afterClick && afterClick.active === false, afterClick);

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
  let noTabError = '';
  try { await call('eval', { expression: 'location.search' }); } catch (error) { noTabError = String(error.message); }
  check('with no agent tab left a bare command fails instead of using the user tab',
    /no tab yet/.test(noTabError), noTabError);

  await call('close', { tabId: userTab.tabId });

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
    + '<div id="box" style="width:80px;height:80px;background:#ccc">box</div>';
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
    '  return "ok";',
    '})()',
  ].join('\n');
  await call('eval', { tabId: cap.tabId, expression: install });
  await new Promise(r => setTimeout(r, 600));

  // scroll: wheel by delta
  await call('scroll', { deltaY: 900, tabId: cap.tabId });
  const scrolled = await call('eval', { tabId: cap.tabId, expression: 'String(Math.round(window.scrollY))' });
  check('a wheel scroll moves the page', Number(scrolled.result) > 100, scrolled);

  // scroll: bring a ref into view
  const capSnap = await call('snapshot', { tabId: cap.tabId });
  const boxRef = /\[ref=(\d+)\] (?:div|button)?\s*"box"/i.exec(capSnap.snapshot);
  if (boxRef) {
    await call('scroll', { ref: Number(boxRef[1]), tabId: cap.tabId });
    const inView = await call('eval', { tabId: cap.tabId, expression: 'JSON.stringify((function () { var el = document.getElementById("box"); if (!el) return null; var r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })())' });
    check('scrolling to a ref brings it into view', String(inView.result) === 'true', inView);
  } else {
    check('snapshot exposes a ref for the probe div', false, capSnap.snapshot.slice(0, 300));
  }

  // A background tab gets no wheel event from the compositor, and Chrome never
  // acks the call. It must fall back quickly rather than burn the caller's
  // whole timeout, so time it with the tab deliberately put in the background.
  const allTabs = await call('tabs');
  const other = allTabs.filter(t => t.id !== cap.tabId && /^https?:/i.test(t.url))[0];
  if (other) {
    await call('key', { key: 'Escape', tabId: other.id });
    const bgStart = Date.now();
    const bg = await call('scroll', { deltaY: 400, tabId: cap.tabId }, 12000);
    const bgElapsed = Date.now() - bgStart;
    check('a background-tab scroll falls back instead of hanging', bgElapsed < 6000, { bgElapsed, bg });
    await call('key', { key: 'Escape', tabId: cap.tabId });
  }

  await call('hover', { selector: '#b', tabId: cap.tabId });
  const afterHover = await call('eval', { tabId: cap.tabId, expression: 'JSON.stringify(window.__ev)' });
  check('hover dispatches a move the page sees', String(afterHover.result).indexOf('mousemove') !== -1, afterHover);

  await call('click', { selector: '#b', clicks: 2, tabId: cap.tabId });
  const afterDouble = await call('eval', { tabId: cap.tabId, expression: 'JSON.stringify(window.__ev)' });
  check('a double click reaches detail 2', String(afterDouble.result).indexOf('dblclick:0:2') !== -1, afterDouble);

  await call('click', { selector: '#b', button: 'right', tabId: cap.tabId });
  const afterRight = await call('eval', { tabId: cap.tabId, expression: 'JSON.stringify(window.__ev)' });
  check('a right click reaches button 2', String(afterRight.result).indexOf('contextmenu:2') !== -1, afterRight);

  await call('drag', { fromSelector: '#box', toSelector: '#f', tabId: cap.tabId });
  const ev = JSON.parse(String((await call('eval', { tabId: cap.tabId, expression: 'JSON.stringify(window.__ev)' })).result));
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
  const sized = await call('eval', { tabId: cap.tabId, expression: 'String(window.innerWidth)' });
  check('resize changes the layout width', Number(sized.result) === 420, sized);
  await call('resize', { width: 0, height: 0, tabId: cap.tabId });
  const cleared = await call('eval', { tabId: cap.tabId, expression: 'String(window.innerWidth)' });
  check('resize clears again', Number(cleared.result) !== 420, cleared);

  const uploadPath = join(tmpdir(), 'dsh-chrome-upload-probe.txt');
  await writeFile(uploadPath, 'probe');
  await call('upload', { files: [uploadPath], selector: '#f', tabId: cap.tabId });
  const attached = await call('eval', { tabId: cap.tabId, expression: 'String(document.getElementById("f").files.length)' });
  check('upload attaches a file to the input', Number(attached.result) === 1, attached);

  // Close every test tab, including litter from earlier runs.
  const everything = await call('tabs');
  const litter = everything.filter(t => /^https?:\/\/(www\.)?(example\.com|duckduckgo\.com)/.test(t.url));
  let closed = 0;
  for (const tab of litter) {
    try { await call('close', { tabId: tab.id }); closed += 1; } catch (error) { /* already gone */ }
  }
  check('close removes a tab', closed > 0, { found: litter.length, closed: closed });
  const after = await call('tabs');
  check('closed tabs are gone', after.filter(t => /example\.com/.test(t.url)).length === 0, after.map(t => t.url).slice(0, 5));
} catch (error) {
  console.log('  FAIL  harness :: ' + String((error && error.message) || error));
  failures.push('harness');
}

wss.close();
console.log('');
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : 'FAILURES: ' + failures.join(', '));
process.exit(failures.length === 0 ? 0 : 1);
