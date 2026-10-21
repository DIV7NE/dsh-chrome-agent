/**
 * The parts of this extension that need no browser: frame keys, the screenshot
 * quality ladder, the tab-confinement predicate, and the frame offset sum.
 *
 * They live here rather than in the service worker so `npm test` can exercise
 * them without Chrome. The worker loads this file with importScripts (a classic
 * MV3 service worker, so that is allowed); the node test loads it with
 * vm.runInThisContext. One implementation, two loaders.
 *
 * Nothing here may touch `chrome.*` or the DOM.
 */
(function (root) {
  'use strict';

  /** How many frames a snapshot reads, main frame included. */
  var FRAME_LIMIT = 12;

  /** The base64 length above which a screenshot is re-captured as JPEG. */
  var SCREENSHOT_BASE64_LIMIT = 2000000;

  /** CDP's JPEG quality values (0-100), tried in order until the image fits. */
  var JPEG_QUALITIES = [90, 75, 60, 45, 30];

  /**
   * Flatten a CDP frame tree into the order a snapshot reads it.
   *
   * Keys are assigned before the cap is applied, so a key that was handed out
   * always means the same frame even when later frames go unread.
   *
   * @param frameTree - the `frameTree` member of Page.getFrameTree.
   * @param limit - the most frames to return; a non-positive or non-finite value
   *   falls back to FRAME_LIMIT.
   * @returns `{ frames, total }`; frames are `{ key, frameId, parentKey, url }`
   *   breadth-first with the main frame as `f0`. A node whose `frame.id` is not a
   *   string is not a frame and is dropped with its whole childFrames subtree, so
   *   total counts the well-formed frames that were kept, not the raw nodes.
   */
  function flattenFrameTree(frameTree, limit) {
    var max = typeof limit === 'number' && limit > 0 ? limit : FRAME_LIMIT;
    var frames = [];
    var total = 0;
    var queue = frameTree ? [{ node: frameTree, parentKey: null }] : [];
    while (queue.length > 0) {
      var entry = queue.shift();
      var node = entry.node;
      if (!node || !node.frame || typeof node.frame.id !== 'string') continue;
      var key = 'f' + total;
      total += 1;
      if (frames.length < max) {
        frames.push({
          key: key,
          frameId: node.frame.id,
          parentKey: entry.parentKey,
          url: typeof node.frame.url === 'string' ? node.frame.url : '',
        });
      }
      var children = Array.isArray(node.childFrames) ? node.childFrames : [];
      for (var i = 0; i < children.length; i += 1) {
        queue.push({ node: children[i], parentKey: key });
      }
    }
    return { frames: frames, total: total };
  }

  /**
   * Normalise a caller's frame argument.
   *
   * @returns '' for the main frame, otherwise the key.
   * @throws on anything malformed, because a silently ignored key would resolve
   *   a ref against the wrong document.
   */
  function normaliseFrameKey(value) {
    if (value === undefined || value === null || value === '' || value === 'f0') return '';
    if (typeof value !== 'string' || !/^f[1-9][0-9]*$/.test(value)) {
      throw new Error('frame must look like "f1" (as chrome_snapshot writes it), not '
        + JSON.stringify(value));
    }
    return value;
  }

  /**
   * The next JPEG quality to try.
   *
   * @param attempt - how many JPEG captures have already been made.
   * @returns the quality, or null when the ladder is exhausted.
   */
  function nextJpegQuality(attempt) {
    var index = typeof attempt === 'number' && isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    return index < JPEG_QUALITIES.length ? JPEG_QUALITIES[index] : null;
  }

  /**
   * Choose which JPEG attempt to use.
   *
   * @param sizes - base64 lengths produced by the ladder so far, in order; a null
   *   entry means that attempt produced no data.
   * @param limit - the base64 length the caller can send.
   * @returns the index of the FIRST entry within the limit; otherwise the index of
   *   the smallest non-null entry; otherwise null when every attempt produced
   *   nothing.
   */
  function chooseJpegAttempt(sizes, limit) {
    var list = Array.isArray(sizes) ? sizes : [];
    var smallest = -1;
    for (var i = 0; i < list.length; i += 1) {
      var size = list[i];
      if (typeof size !== 'number') continue;
      if (size <= limit) return i;
      if (smallest === -1 || size < list[smallest]) smallest = i;
    }
    return smallest === -1 ? null : smallest;
  }

  /**
   * Whether a tab may be acted on.
   *
   * @param tabGroupId - the tab's group, or -1 when it has none.
   * @param agentGroupId - the agent's group, or null when it has not made one.
   * @param confine - true when the user asked for confinement.
   */
  function isTabAllowed(tabGroupId, agentGroupId, confine) {
    // Fail closed: any truthy value confines, so a stored '1' or 'true' string
    // cannot silently turn confinement off.
    if (!confine) return true;
    if (typeof agentGroupId !== 'number') return false;
    return tabGroupId === agentGroupId;
  }

  /**
   * Whether a point about to be dispatched lies inside a viewport.
   *
   * Mouse input dispatched outside the viewport is silently dropped, so this is
   * the guard that turns "clicked" into a lie. A point exactly on the edge is
   * inside; only genuinely outside points fail.
   *
   * @param x - the point's horizontal coordinate.
   * @param y - the point's vertical coordinate.
   * @param width - the viewport's width.
   * @param height - the viewport's height.
   */
  function pointInViewport(x, y, width, height) {
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (typeof width !== 'number' || typeof height !== 'number') return false;
    if (!isFinite(x) || !isFinite(y) || !isFinite(width) || !isFinite(height)) return false;
    return x >= 0 && y >= 0 && x <= width && y <= height;
  }

  /**
   * Sum a frame chain's offsets.
   *
   * Each entry is a CDP box model's border quad — eight numbers, top-left first —
   * expressed in that frame's parent. Summing the chain moves a point from a
   * frame's own coordinates to the top-level ones a CDP mouse event needs.
   *
   * @returns the offset, or null when any quad is missing, so a caller refuses
   *   rather than clicks at a guessed position.
   */
  function sumFrameOffsets(quads) {
    if (!Array.isArray(quads)) return null;
    var x = 0;
    var y = 0;
    for (var i = 0; i < quads.length; i += 1) {
      var quad = quads[i];
      if (!Array.isArray(quad) || quad.length < 8) return null;
      if (typeof quad[0] !== 'number' || typeof quad[1] !== 'number') return null;
      x += quad[0];
      y += quad[1];
    }
    return { x: x, y: y };
  }

  /**
   * Convert a frame-local point into the top frame's viewport coordinates.
   *
   * `sumFrameOffsets` sums `DOM.getBoxModel` quads, and those are
   * scroll-unadjusted: the sum names the frame element's position in the top
   * DOCUMENT. CDP mouse events take top-level VIEWPORT coordinates, so the top
   * frame's own scroll offsets are subtracted here. Only the top frame's scroll
   * applies: each level's box is already in its parent's document space, and a
   * point measured inside the deepest frame with `getBoundingClientRect` is in
   * that frame's viewport, so the frames between cancel out of the sum. Reading
   * the sum as viewport coordinates is correct only while the top page is
   * unscrolled, which is the bug this conversion exists to fix.
   *
   * @param point - the point in the deepest frame's own viewport.
   * @param offset - the summed document-space offset of the frame chain.
   * @param scroll - the top frame's `window.scrollX`/`window.scrollY`.
   * @returns the point, or null when any input is malformed, so a caller refuses
   *   rather than clicks at a guessed position.
   */
  function framePointToViewport(point, offset, scroll) {
    if (!point || !offset || !scroll) return null;
    var values = [point.x, point.y, offset.x, offset.y, scroll.x, scroll.y];
    for (var i = 0; i < values.length; i += 1) {
      if (typeof values[i] !== 'number' || !isFinite(values[i])) return null;
    }
    return { x: point.x + offset.x - scroll.x, y: point.y + offset.y - scroll.y };
  }

  /** US-layout punctuation: unshifted character, shifted character, code, virtual key. */
  var PUNCTUATION_KEYS = [
    ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
    ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
    [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
    ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ];
  var SHIFTED_DIGITS = ')!@#$%^&*(';

  /**
   * The physical key a US keyboard presses for one character: its `code`, its
   * Windows virtual key, and whether shift is held. Pages that read
   * KeyboardEvent.code (shortcuts, games) need the real one; "1" used to be
   * sent as "Key1", which no keyboard has.
   *
   * @param ch - a single character.
   * @returns `{ code, windowsVirtualKeyCode, shift }`, or null for a character
   *   no US key produces.
   */
  function keyCodeFor(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return null;
    if (/[a-z]/.test(ch)) return { code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), shift: false };
    if (/[A-Z]/.test(ch)) return { code: 'Key' + ch, windowsVirtualKeyCode: ch.charCodeAt(0), shift: true };
    if (/[0-9]/.test(ch)) return { code: 'Digit' + ch, windowsVirtualKeyCode: ch.charCodeAt(0), shift: false };
    var shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
    if (shiftedDigit !== -1) return { code: 'Digit' + shiftedDigit, windowsVirtualKeyCode: 48 + shiftedDigit, shift: true };
    for (var i = 0; i < PUNCTUATION_KEYS.length; i += 1) {
      var entry = PUNCTUATION_KEYS[i];
      if (ch === entry[0]) return { code: entry[2], windowsVirtualKeyCode: entry[3], shift: false };
      if (ch === entry[1]) return { code: entry[2], windowsVirtualKeyCode: entry[3], shift: true };
    }
    return null;
  }

  /**
   * Split a chrome_key argument into the chords to press, in order.
   *
   * @param text - one chord or several separated by spaces, e.g. "Tab Tab Enter".
   * @param repeat - how many times to press the whole sequence: a whole number
   *   from 1 to 100; anything else is clamped, or taken as 1.
   * @returns the chords, or an empty list for no chord at all.
   */
  function parseKeySequence(text, repeat) {
    if (typeof text !== 'string') return [];
    var chords = text.split(/\s+/).filter(function (part) { return part !== ''; });
    var times = typeof repeat === 'number' && isFinite(repeat) ? Math.floor(repeat) : 1;
    times = Math.max(1, Math.min(100, times));
    var out = [];
    for (var n = 0; n < times; n += 1) out = out.concat(chords);
    return out;
  }

  /** CDP's modifier bits, with the names people use for each key. */
  var MODIFIER_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };

  /**
   * A click's held keys, e.g. "Control+Shift", as CDP's modifier bitmask.
   *
   * @param text - modifier names joined by "+", case-insensitive; empty or
   *   absent for none.
   * @returns the bitmask, or null when a name is not a modifier, so a typo is
   *   refused rather than silently clicking without the key.
   */
  function modifierMask(text) {
    if (text === undefined || text === null || text === '') return 0;
    if (typeof text !== 'string') return null;
    var mask = 0;
    var parts = text.split('+');
    for (var i = 0; i < parts.length; i += 1) {
      var name = parts[i].trim().toLowerCase();
      if (name === '') continue;
      if (!Object.prototype.hasOwnProperty.call(MODIFIER_BITS, name)) return null;
      mask |= MODIFIER_BITS[name];
    }
    return mask;
  }

  root.DSH_PURE = {
    FRAME_LIMIT: FRAME_LIMIT,
    SCREENSHOT_BASE64_LIMIT: SCREENSHOT_BASE64_LIMIT,
    JPEG_QUALITIES: JPEG_QUALITIES,
    flattenFrameTree: flattenFrameTree,
    normaliseFrameKey: normaliseFrameKey,
    nextJpegQuality: nextJpegQuality,
    chooseJpegAttempt: chooseJpegAttempt,
    isTabAllowed: isTabAllowed,
    pointInViewport: pointInViewport,
    sumFrameOffsets: sumFrameOffsets,
    framePointToViewport: framePointToViewport,
    keyCodeFor: keyCodeFor,
    parseKeySequence: parseKeySequence,
    modifierMask: modifierMask,
  };
})(typeof self !== 'undefined' ? self : globalThis);
