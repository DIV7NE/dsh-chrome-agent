/**
 * The live suite's eval-contract probe. No Chrome, no server, no sockets.
 *
 *   node test/probe-eval-contract.mjs
 *
 * The bridge's `eval` command serialises an expression's value exactly once:
 * it runs `var value = (<expression>); return JSON.stringify(value);` and returns
 * `String(...)` of that. So an expression argument must yield a JSON-native value
 * and must NOT itself call String(...) or JSON.stringify(...), or the value is
 * serialised twice and every comparison against the once-serialised text breaks.
 *
 * This probe copies that wrapper verbatim and, for every expression the live suite
 * uses, shows the result string and the live check's outcome for a correct page
 * state (must PASS) and a wrong one (must FAIL). The OLD* cases show the
 * double-serialising expressions the suite used before, for comparison.
 *
 * Exit 0 means every current expression passes on the correct state and fails on
 * the wrong state.
 */
import vm from 'node:vm'

// Byte-for-byte copy of the `eval` command's wrapper (extension/service-worker.js, `async eval`).
function bridgeEval(expression, sandbox) {
  const wrapped = [
    '(function () {',
    '  try {',
    '    var value = (' + expression + ');',
    '    if (value === undefined) return "undefined";',
    '    return JSON.stringify(value);',
    '  } catch (error) { return "Error: " + (error && error.message); }',
    '})()',
  ].join('\n')
  const context = vm.createContext(sandbox)
  return String(vm.runInContext(wrapped, context))
}

let bad = 0
function safe(check, result) {
  try { return check(result) } catch (error) { return 'THREW: ' + error.message }
}
function probe(name, expression, check, expectState, wrongState) {
  const showcase = name.indexOf('OLD') === 0
  const expectResult = bridgeEval(expression, expectState)
  const wrongResult = bridgeEval(expression, wrongState)
  const expectPass = safe(check, expectResult)
  const wrongPass = safe(check, wrongResult)
  const ok = expectPass === true && wrongPass === false
  if (!ok && !showcase) bad += 1
  console.log((showcase ? (ok ? 'OK (old)' : 'BUGGY (old)') : (ok ? 'OK  ' : 'BAD ')) + ' ' + name)
  console.log('     expr: ' + expression)
  console.log('     expected value -> result ' + JSON.stringify(expectResult) + ' -> check ' + expectPass)
  console.log('     wrong value    -> result ' + JSON.stringify(wrongResult) + ' -> check ' + wrongPass)
}

// --- the old (double-serialising) expressions, to show the bug ---
probe('OLD scrollY (bug)', 'String(Math.round(window.scrollY))',
  r => Number(r) > 100, { window: { scrollY: 600 } }, { window: { scrollY: 0 } })
probe('OLD innerWidth (bug)', 'String(window.innerWidth)',
  r => Number(r) === 420, { window: { innerWidth: 420 } }, { window: { innerWidth: 1920 } })
probe('OLD files.length (bug)', 'String(document.getElementById("f").files.length)',
  r => Number(r) === 1,
  { document: { getElementById: () => ({ files: { length: 1 } }) } },
  { document: { getElementById: () => ({ files: { length: 0 } }) } })
probe('OLD __ev drag (bug: JSON.parse yields a string, .filter throws)', 'JSON.stringify(window.__ev)',
  r => { const ev = JSON.parse(String(r)); const s = ev.indexOf('mousedown:0:1'); const e = ev.lastIndexOf('mouseup:0:1'); return s >= 0 && e > s && ev.slice(s, e).filter(k => k.indexOf('mousemove:0') === 0).length >= 5 },
  { window: { __ev: ['mousedown:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mouseup:0:1'] } },
  { window: { __ev: [] } })

console.log('')

// --- the fixed expressions, exactly as they now appear in test/live-extension.mjs ---
const box = top => ({ document: { getElementById: () => ({ getBoundingClientRect: () => ({ top }) }) }, innerHeight: 800 })

probe(':324 a wheel scroll moves the page', 'Math.round(window.scrollY)',
  r => Number(r) > 100, { window: { scrollY: 600 } }, { window: { scrollY: 0 } })

probe(':332 scrolling to a ref brings it into view', '(function () { var el = document.getElementById("box"); if (!el) return null; var r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()',
  r => String(r) === 'true', box(100), box(-50))
console.log('     (missing element -> result ' + JSON.stringify(bridgeEval('(function () { var el = document.getElementById("box"); if (!el) return null; var r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()', { document: { getElementById: () => null }, innerHeight: 800 })) + ' -> check ' + (String(bridgeEval('(function () { var el = document.getElementById("box"); if (!el) return null; var r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()', { document: { getElementById: () => null }, innerHeight: 800 })) === 'true') + ')')

const hitState = h => ({ window: {}, document: { querySelector: () => ({ contentWindow: { __hit: h } }) } })
probe(':368 a ref from a frame clicks the element inside it', 'document.querySelector("#probe-frame").contentWindow.__hit === true || window.__hit === true',
  r => String(r) === 'true', hitState(true), hitState(false))

const dragEvents = ['mousemove:0:0', 'mousedown:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mousemove:0:1', 'mouseup:0:1']
const dragCheck = r => { const ev = JSON.parse(String(r)); const s = ev.indexOf('mousedown:0:1'); const e = ev.lastIndexOf('mouseup:0:1'); return s >= 0 && e > s && ev.slice(s, e).filter(k => k.indexOf('mousemove:0') === 0).length >= 5 }
probe(':401 drag presses, moves through, and releases', 'window.__ev',
  dragCheck, { window: { __ev: dragEvents } }, { window: { __ev: ['mousedown:0:1', 'mouseup:0:1'] } })

probe(':390 hover dispatches a move the page sees', 'window.__ev',
  r => String(r).indexOf('mousemove') !== -1, { window: { __ev: dragEvents } }, { window: { __ev: ['click:0:1'] } })
probe(':394 a double click reaches detail 2', 'window.__ev',
  r => String(r).indexOf('dblclick:0:2') !== -1, { window: { __ev: ['mousemove:0:0', 'mousedown:0:1', 'mouseup:0:1', 'click:0:1', 'mousedown:0:2', 'mouseup:0:2', 'click:0:2', 'dblclick:0:2'] } }, { window: { __ev: ['mousedown:0:1', 'mouseup:0:1', 'click:0:1'] } })
probe(':398 a right click reaches button 2', 'window.__ev',
  r => String(r).indexOf('contextmenu:2') !== -1, { window: { __ev: ['mousedown:2:1', 'mouseup:2:1', 'contextmenu:2'] } }, { window: { __ev: ['mousedown:0:1', 'mouseup:0:1', 'click:0:1'] } })

probe(':422 resize changes the layout width', 'window.innerWidth',
  r => Number(r) === 420, { window: { innerWidth: 420 } }, { window: { innerWidth: 1920 } })
probe(':425 resize clears again', 'window.innerWidth',
  r => Number(r) !== 420, { window: { innerWidth: 1920 } }, { window: { innerWidth: 420 } })

probe(':431 upload attaches a file to the input', 'document.getElementById("f").files.length',
  r => Number(r) === 1,
  { document: { getElementById: () => ({ files: { length: 1 } }) } },
  { document: { getElementById: () => ({ files: { length: 0 } }) } })

console.log('')
console.log(bad === 0 ? 'ALL EXPRESSIONS: expected-state PASS and wrong-state FAIL' : 'FAILURES: ' + bad)
process.exit(bad === 0 ? 0 : 1)
