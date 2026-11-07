/*!
 * render.js - turns a dictionary record (HTML) into safe DOM and marks its "chunks".
 *
 * Safety: scripts, styles, images, media, forms, event handlers and external links are dropped.
 * Only a small set of tags survives; only class (prefixed "d-"), lang and dir attributes are kept.
 * entry:// and bword:// links become in-app lookups (<a class="dict-link" data-word="...">).
 *
 * Chunks: the smallest block-level pieces that contain text (a list item, a paragraph, a cell...).
 * Each gets class "chunk" and a running data-chunk number, so the UI can select one "paragraph"
 * and extend the selection to the following ones.
 */
(function (root) {
  'use strict';

  function set(list) { var o = {}; list.split(' ').forEach(function (t) { o[t] = 1; }); return o; }

  var BLOCK = set('DIV P LI DD DT H1 H2 H3 H4 H5 H6 BLOCKQUOTE TR TD TH UL OL DL TABLE TBODY THEAD TFOOT HR PRE CENTER SECTION ARTICLE HEADER FOOTER FIGURE CAPTION');
  var INLINE = set('A B I U EM STRONG SUP SUB SMALL BIG SPAN BR CODE FONT S STRIKE DEL INS MARK ABBR Q CITE TT RUBY RT RP WBR KBD VAR SAMP');
  var DROP = set('SCRIPT STYLE LINK META IFRAME OBJECT EMBED AUDIO VIDEO SOURCE TRACK IMG SVG CANVAS FORM INPUT BUTTON SELECT TEXTAREA NOSCRIPT TEMPLATE HEAD TITLE BASE MATH PICTURE MAP AREA DIALOG FRAME FRAMESET');
  var BLOCK_SELECTOR = Object.keys(BLOCK).join(',').toLowerCase();

  function nameOf(n) { return n.nodeName.toUpperCase(); }
  function isBlock(n) { return n.nodeType === 1 && BLOCK[nameOf(n)] === 1; }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function copyAttrs(src, el) {
    var cls = src.getAttribute('class');
    if (cls) {
      var safe = cls.split(/\s+/).filter(Boolean).map(function (c) { return 'd-' + c.replace(/[^\w-]/g, ''); });
      if (safe.length) el.className = safe.join(' ');
    }
    ['lang', 'dir'].forEach(function (a) { if (src.hasAttribute(a)) el.setAttribute(a, src.getAttribute(a)); });
  }

  function copyInto(src, dest) {
    for (var n = src.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue.replace(/\s+/g, ' '))); continue; }
      if (n.nodeType !== 1) continue;
      var tag = nameOf(n);
      if (DROP[tag]) continue;
      var style = n.getAttribute('style');
      if (style && /display\s*:\s*none/i.test(style)) continue;
      if (tag === 'A') {
        var href = n.getAttribute('href') || '';
        var m = /^(?:entry|bword):\/\/(.+)$/i.exec(href);
        if (m) {
          var a = document.createElement('a');
          a.className = 'dict-link';
          a.setAttribute('data-word', safeDecode(m[1]).replace(/#.*$/, '').trim());
          copyInto(n, a);
          dest.appendChild(a);
        } else if (!/^sound:/i.test(href)) {
          copyInto(n, dest);              // ordinary link: keep the text, drop the link
        }                                  // sound:// needs the .mdd file: drop it
        continue;
      }
      if (BLOCK[tag] || INLINE[tag]) {
        var el = document.createElement(tag.toLowerCase());
        copyAttrs(n, el);
        copyInto(n, el);
        dest.appendChild(el);
      } else {
        copyInto(n, dest);                // unknown tag: keep its content, drop the tag
      }
    }
  }

  // Wrap loose inline content that sits next to block elements into <div class="run"> blocks.
  function wrapRuns(container) {
    var kids = Array.prototype.slice.call(container.childNodes);
    kids.forEach(function (k) { if (isBlock(k)) wrapRuns(k); });
    if (!kids.some(isBlock)) return;
    var run = null;
    kids.forEach(function (k) {
      if (isBlock(k)) { run = null; return; }
      var blank = k.nodeType === 3 && !/\S/.test(k.nodeValue);
      if (blank && !run) return;
      if (!run) { run = document.createElement('div'); run.className = 'run'; container.insertBefore(run, k); }
      run.appendChild(k);
    });
  }

  // A block that holds only inline content separated by <br> becomes one <div class="run"> per line,
  // so that every line can be picked as a "paragraph".
  function splitBreaks(el) {
    Array.prototype.slice.call(el.children).forEach(function (c) { if (isBlock(c)) splitBreaks(c); });
    var kids = Array.prototype.slice.call(el.childNodes);
    var hasBr = kids.some(function (k) { return k.nodeType === 1 && nameOf(k) === 'BR'; });
    if (!hasBr || kids.some(isBlock)) return;
    var segs = [[]];
    kids.forEach(function (k) {
      if (k.nodeType === 1 && nameOf(k) === 'BR') segs.push([]); else segs[segs.length - 1].push(k);
    });
    segs = segs.filter(function (s) { return s.some(function (k) { return /\S/.test(k.textContent); }); });
    if (segs.length < 2) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    segs.forEach(function (s) {
      var run = document.createElement('div');
      run.className = 'run';
      s.forEach(function (k) { run.appendChild(k); });
      el.appendChild(run);
    });
  }

  function markChunks(container, counter) {
    (function walk(el) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (isBlock(c) && !c.querySelector(BLOCK_SELECTOR) && /\S/.test(c.textContent)) {
          c.classList.add('chunk');
          c.setAttribute('data-chunk', String(counter.n++));
        } else walk(c);
      }
    })(container);
  }

  function buildOne(html, counter) {
    html = String(html);
    if (html.indexOf('<') < 0) html = html.replace(/&/g, '&amp;').replace(/\r\n?|\n/g, '<br>');   // plain-text record
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var box = document.createElement('div');
    box.className = 'entry';
    copyInto(parsed.body, box);
    splitBreaks(box);
    if (!Array.prototype.some.call(box.childNodes, isBlock)) {
      var run = document.createElement('div');
      run.className = 'run';
      while (box.firstChild) run.appendChild(box.firstChild);
      box.appendChild(run);
    } else wrapRuns(box);
    markChunks(box, counter);
    return box;
  }

  // Builds one container for a list of record HTML strings (e.g. homographs) with continuous chunk numbers.
  function build(htmls) {
    var wrap = document.createElement('div'), counter = { n: 0 };
    htmls.forEach(function (h, i) {
      if (i > 0) wrap.appendChild(document.createElement('hr')).className = 'entry-sep';
      wrap.appendChild(buildOne(h, counter));
    });
    return { node: wrap, chunkCount: counter.n };
  }

  // Plain text of an element: whitespace collapsed, <br> -> newline.
  function textOf(el) {
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) { if (nameOf(c) === 'BR') out += '\n'; else walk(c); }
      }
    })(el);
    return out.replace(/[ \t\r\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  root.Render = { build: build, textOf: textOf };
})(typeof self !== 'undefined' ? self : this);
