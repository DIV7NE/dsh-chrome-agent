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
  };
})(typeof self !== 'undefined' ? self : globalThis);
