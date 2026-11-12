/*!
 * render.js - turns a dictionary record (HTML) into safe DOM and marks its "chunks".
 *
 * Safety: scripts, forms, event handlers and external links are dropped. Only a small set of tags survives;
 * class and id (prefixed "d-"), lang, dir and a short whitelist of style properties are kept.
 * With opts.styled, the entry's stylesheets are collected (for Media.applyStyles) and images / sound links that
 * exist in a loaded .mdd (opts.has) are kept as <img data-res> / <a class="dict-sound" data-sound>.
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

  var STYLE_OK = set('color background background-color font-family font-size font-style font-weight font-variant text-decoration text-transform text-align text-indent letter-spacing line-height vertical-align white-space margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right border border-top border-bottom border-left border-right border-radius display width max-width');
  var COLOR_OK = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([\d\s.,%\/-]+\))$/i;

  // Keeps only harmless declarations from an inline style attribute.
  function safeStyle(css) {
    var out = [];
    String(css || '').split(';').forEach(function (d) {
      var i = d.indexOf(':');
      if (i < 0) return;
      var name = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).replace(/!important/i, '').trim();
      if (!STYLE_OK[name] || !val || /url\(|expression|javascript|\\/i.test(val)) return;
      if (name === 'display' && !/^(inline|block|inline-block)$/i.test(val)) return;
      out.push(name + ':' + val);
    });
    return out.join(';');
  }

  function copyAttrs(src, el, o) {
    var cls = src.getAttribute('class');
    if (cls) {
      var safe = cls.split(/\s+/).filter(Boolean).map(function (c) { return 'd-' + c.replace(/[^\w-]/g, ''); });
      if (safe.length) el.className = safe.join(' ');
    }
    ['lang', 'dir'].forEach(function (a) { if (src.hasAttribute(a)) el.setAttribute(a, src.getAttribute(a)); });
    if (!o.styled) return;
    var id = src.getAttribute('id');
    if (id && /^[\w-]+$/.test(id)) el.setAttribute('id', 'd-' + id);
    var st = safeStyle(src.getAttribute('style'));
    if (nameOf(src) === 'FONT') {
      var col = (src.getAttribute('color') || '').trim();
      if (COLOR_OK.test(col)) st = 'color:' + col + (st ? ';' + st : '');
    }
    if (st) el.setAttribute('style', st);
  }

  function copyInto(src, dest, o) {
    for (var n = src.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { dest.appendChild(document.createTextNode(n.nodeValue.replace(/\s+/g, ' '))); continue; }
      if (n.nodeType !== 1) continue;
      var tag = nameOf(n);
      var style = n.getAttribute('style');
      if (style && /display\s*:\s*none/i.test(style)) continue;
      if (tag === 'IMG' && o.styled && o.has) {
        var src = (n.getAttribute('src') || '').trim();
        if (src && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) && o.has(src)) {
          var im = document.createElement('img');
          im.className = 'dict-img';
          im.setAttribute('data-res', src);
          im.setAttribute('alt', n.getAttribute('alt') || '');
          dest.appendChild(im);
        }
        continue;
      }
      if (DROP[tag]) continue;
      if (tag === 'A') {
        var href = n.getAttribute('href') || '';
        var m = /^(?:entry|bword):\/\/(.+)$/i.exec(href);
        var snd = /^sound:\/\/(.+)$/i.exec(href);
        if (m) {
          var a = document.createElement('a');
          a.className = 'dict-link';
          a.setAttribute('data-word', safeDecode(m[1]).replace(/#.*$/, '').trim());
          copyInto(n, a, o);
          dest.appendChild(a);
        } else if (snd) {
          if (o.styled && o.has && o.has(snd[1])) {     // needs the .mdd file: dropped without it
            var sa = document.createElement('a');
            sa.className = 'dict-sound';
            sa.setAttribute('data-sound', snd[1]);
            sa.setAttribute('role', 'button');
            sa.setAttribute('aria-label', 'Play sound');
            copyInto(n, sa, o);
            dest.appendChild(sa);
          }
        } else {
          copyInto(n, dest, o);           // ordinary link: keep the text, drop the link
        }
        continue;
      }
      if (BLOCK[tag] || INLINE[tag]) {
        var el = document.createElement(tag.toLowerCase());
        copyAttrs(n, el, o);
        copyInto(n, el, o);
        dest.appendChild(el);
      } else {
        copyInto(n, dest, o);             // unknown tag: keep its content, drop the tag
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

  function buildOne(html, counter, o) {
    html = String(html);
    if (html.indexOf('<') < 0) html = html.replace(/&/g, '&amp;').replace(/\r\n?|\n/g, '<br>');   // plain-text record
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var box = document.createElement('div');
    box.className = 'entry';
    if (o.styled) {
      Array.prototype.forEach.call(parsed.querySelectorAll('link[rel~="stylesheet" i][href]'), function (l) { o.styles.push({ href: l.getAttribute('href') }); });
      Array.prototype.forEach.call(parsed.querySelectorAll('style'), function (st) { if (st.textContent.trim()) o.styles.push({ css: st.textContent }); });
    }
    copyInto(parsed.body, box, o);
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
  // opts: { styled: keep dictionary styling, has(path): is this resource in a loaded .mdd }
  function build(htmls, opts) {
    opts = opts || {};
    var wrap = document.createElement('div'), counter = { n: 0 };
    var o = { styled: !!opts.styled, has: opts.has || null, styles: [] };
    htmls.forEach(function (h, i) {
      if (i > 0) wrap.appendChild(document.createElement('hr')).className = 'entry-sep';
      wrap.appendChild(buildOne(h, counter, o));
    });
    return { node: wrap, chunkCount: counter.n, styles: o.styles };
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
