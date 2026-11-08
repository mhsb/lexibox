/*!
 * reader.js - the paginated reader on the home page.
 *
 * - The current section is laid out in CSS columns (one column per page) and slid sideways.
 * - Swipe sideways or tap the screen edges to turn pages; swipe down for the search drawer, up to hide it.
 * - Tap a word: the word and its surrounding sentence go to the app, and the dictionary sheet opens.
 * - The dictionary sheet (the #dict-pane element) can be resized by its handle and hidden.
 *
 * app.js passes callbacks to Reader.init({ onWord, onPosition, onPrefs }) and loads documents with
 * Reader.load(doc, pos). Documents come from docs.js.
 */
(function (root) {
  'use strict';

  var PAD_X = 22, PAD_Y = 16, GAP = PAD_X * 2 + 2;
  var MIN_SCALE = 0.8, MAX_SCALE = 1.9;

  var S = {
    doc: null, sec: 0, page: 0, pages: 1, W: 0, H: 0, step: 0, dirty: true,
    prefs: { scale: 1, serif: true, sheet: 0.46 },
    word: null, shift: 0, g: null
  };
  var cb = {};
  var posTimer = null, resizeTimer = null;
  var highlights = !!(root.CSS && root.CSS.highlights && root.Highlight);

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function restart(node, cls) { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }
  function reduced() { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* ================================================================ layout and rendering */

  function layout() {
    var view = $('rd-view'), flow = $('rd-flow');
    var w = view.clientWidth - 2 * PAD_X, h = view.clientHeight - 2 * PAD_Y;
    if (w < 80 || h < 80) { S.dirty = true; return false; }
    S.W = Math.floor(w); S.H = Math.floor(h); S.step = S.W + GAP;
    flow.style.width = S.W + 'px';
    flow.style.height = S.H + 'px';
    flow.style.columnWidth = S.W + 'px';
    flow.style.columnGap = GAP + 'px';
    S.dirty = false;
    return true;
  }

  function measure() {
    var flow = $('rd-flow');
    S.pages = Math.max(1, Math.round((flow.scrollWidth + GAP) / S.step));
  }

  var TAGS = { p: 'p', li: 'p', q: 'p', pre: 'pre', hr: 'hr', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };

  function renderSection() {
    var sec = S.doc.sections[S.sec], frag = document.createDocumentFragment();
    sec.blocks.forEach(function (b, i) {
      var e = document.createElement(TAGS[b.t] || 'p');
      e.className = 'b-' + b.t;
      e.setAttribute('data-i', String(i));
      if (b.h) e.innerHTML = b.h;                          // inline markup produced by docs.js (escaped text + a few tags)
      if (b.d) e.style.marginLeft = (b.d * 1.2) + 'em';
      frag.appendChild(e);
    });
    var flow = $('rd-flow');
    flow.textContent = '';
    flow.appendChild(frag);
  }

  function pageForBlock(b) {
    var kids = $('rd-flow').children;
    if (!kids.length) return 0;
    var e = kids[Math.min(b, kids.length - 1)];
    return clamp(Math.floor((e.offsetLeft + 2) / S.step), 0, S.pages - 1);
  }

  // Index of the first block shown on the current page (used to remember the position).
  function currentBlock() {
    var kids = $('rd-flow').children, start = S.page * S.step;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetLeft >= start - 2) return kids[i].offsetLeft < start + S.step ? i : Math.max(0, i - 1);
    }
    return Math.max(0, kids.length - 1);
  }

  function gotoSection(i, where, noFade) {
    S.sec = clamp(i, 0, S.doc.sections.length - 1);
    renderSection();
    measure();
    var p = where === 'end' ? S.pages - 1 : (typeof where === 'number' ? pageForBlock(where) : 0);
    setPage(p, false);
    if (!noFade && !reduced()) restart($('rd-flow'), 'rd-fade');
  }

  function setPage(p, animate) {
    S.page = clamp(p, 0, S.pages - 1);
    var flow = $('rd-flow');
    flow.style.transition = animate && !reduced() ? 'transform .34s cubic-bezier(.2,.8,.2,1)' : 'none';
    flow.style.transform = 'translateX(' + (-S.page * S.step) + 'px)';
    clearWord();
    setShift(0);
    footer();
    schedulePos();
  }

  function next() {
    hideSheet();
    if (S.page < S.pages - 1) setPage(S.page + 1, true);
    else if (S.sec < S.doc.sections.length - 1) gotoSection(S.sec + 1, 0);
    else nudge(-1);
  }
  function prev() {
    hideSheet();
    if (S.page > 0) setPage(S.page - 1, true);
    else if (S.sec > 0) gotoSection(S.sec - 1, 'end');
    else nudge(1);
  }
  // small bounce at the very beginning or end of the book
  function nudge(dir) {
    if (reduced()) return;
    var flow = $('rd-flow'), base = -S.page * S.step;
    flow.style.transition = 'transform .12s ease-out';
    flow.style.transform = 'translateX(' + (base + dir * 22) + 'px)';
    setTimeout(function () { flow.style.transition = 'transform .3s cubic-bezier(.2,.8,.2,1)'; flow.style.transform = 'translateX(' + base + 'px)'; }, 120);
  }

  function chapterTitle() {
    var i = S.sec;
    while (i > 0 && S.doc.sections[i].sub) i--;
    return S.doc.sections[i].title || S.doc.title;
  }

  function progress() {
    var before = 0;
    for (var i = 0; i < S.sec; i++) before += S.doc.sections[i].chars;
    var within = S.doc.sections[S.sec].chars * ((S.page + 1) / S.pages);
    return clamp((before + within) / S.doc.total, 0, 1);
  }

  function footer() {
    var pr = progress();
    $('rd-title').textContent = chapterTitle();
    $('rd-pos').textContent = Math.round(pr * 100) + '%  ·  ' + (S.page + 1) + '/' + S.pages;
    $('rd-prog').style.width = (pr * 100).toFixed(1) + '%';
  }

  function schedulePos() {
    clearTimeout(posTimer);
    posTimer = setTimeout(function () { if (S.doc && cb.onPosition) cb.onPosition(getPos()); }, 500);
  }
  function getPos() { return { s: S.sec, b: currentBlock() }; }

  function relayout() {
    if (!S.doc) return;
    if ($('rd-view').clientWidth === 0) return;
    var anchor = S.dirty ? S.pendingBlock : currentBlock();
    if (!layout()) return;
    measure();
    setPage(pageForBlock(anchor || 0), false);
    if (S.sheetOpen) ensureVisible();
  }

  /* ================================================================ preferences */

  function applyPrefs() {
    var r = $('reader');
    r.style.setProperty('--rd-size', Math.round(18 * S.prefs.scale * 10) / 10 + 'px');
    r.classList.toggle('sans', !S.prefs.serif);
    Array.prototype.forEach.call(document.querySelectorAll('#prefs-dialog [data-face]'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-face') === 'serif') === !!S.prefs.serif);
    });
    $('pf-smaller').disabled = S.prefs.scale <= MIN_SCALE + 0.001;
    $('pf-bigger').disabled = S.prefs.scale >= MAX_SCALE - 0.001;
  }
  function changePrefs(patch, relayoutNow) {
    var anchor = S.doc && !S.dirty ? currentBlock() : 0;
    Object.keys(patch).forEach(function (k) { S.prefs[k] = patch[k]; });
    applyPrefs();
    if (S.doc && relayoutNow) { S.pendingBlock = anchor; S.dirty = true; relayout(); }
    if (cb.onPrefs) cb.onPrefs(S.prefs);
  }
  function setPrefs(p) {
    if (!p) return;
    if (typeof p.scale === 'number') S.prefs.scale = clamp(p.scale, MIN_SCALE, MAX_SCALE);
    if (typeof p.serif === 'boolean') S.prefs.serif = p.serif;
    if (typeof p.sheet === 'number') S.prefs.sheet = clamp(p.sheet, 0.2, 0.9);
    applyPrefs();
  }

  /* ================================================================ contents */

  function renderToc() {
    var ul = $('toc-list'), secs = S.doc.sections;
    ul.textContent = '';
    var items = [];
    secs.forEach(function (s, i) { if (!s.sub) items.push(i); });
    if (items.length < 2 && secs.length > 1) items = secs.map(function (_, i) { return i; });
    items.forEach(function (i) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.textContent = secs[i].title;
      b.setAttribute('data-sec', String(i));
      li.appendChild(b);
      ul.appendChild(li);
    });
  }
  function openToc() {
    if (!S.doc) return;
    var cur = S.sec;
    while (cur > 0 && S.doc.sections[cur].sub) cur--;
    Array.prototype.forEach.call($('toc-list').querySelectorAll('button'), function (b) {
      var on = +b.getAttribute('data-sec') <= S.sec && +b.getAttribute('data-sec') >= cur;
      b.classList.toggle('on', on && +b.getAttribute('data-sec') === cur);
    });
    $('toc-dialog').showModal();
    var on = $('toc-list').querySelector('button.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'center' });
  }

  /* ================================================================ word and sentence under a tap */

  var WORDCH = /[\p{L}\p{N}'’­-]/u;
  var EDGE = /['’-]/;
  var ABBR = /(?:^|[\s("'“‘\[])(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|etc|no|nos|fig|vol|ch|cf|approx|inc|ltd|co|e\.g|i\.e)$/i;
  var CLOSERS = /["'”’)\]]/;

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  function isSentenceEnd(text, k) {
    var c = text[k];
    if (c === '\n') return true;
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') return false;
    if (/[.!?…]/.test(text[k + 1] || '')) return false;                 // inside "?!" or "..."
    var m = k + 1;
    while (m < text.length && CLOSERS.test(text[m])) m++;
    if (m < text.length && !/\s/.test(text[m])) return false;           // "3.14", "e.g.x"
    if (c === '.' && ABBR.test(text.slice(Math.max(0, k - 6), k))) return false;
    return true;
  }

  // Sentence of `text` that contains the character range [i, j).
  function sentenceBounds(text, i, j) {
    var start = 0, end = text.length, k;
    for (k = i - 1; k >= 0; k--) {
      if (isSentenceEnd(text, k)) {
        start = k + 1;
        while (start < text.length && (CLOSERS.test(text[start]) || /\s/.test(text[start]))) start++;
        break;
      }
    }
    for (k = j; k < text.length; k++) {
      if (isSentenceEnd(text, k)) {
        end = k + 1;
        while (end < text.length && CLOSERS.test(text[end])) end++;
        break;
      }
    }
    if (start > i) start = i;
    if (end - start > 420) {                                            // very long run-on: keep a window around the word
      start = Math.max(start, i - 200);
      end = Math.min(end, j + 200);
      while (start < i && !/\s/.test(text[start - 1] || ' ')) start++;
      while (end > j && !/\s/.test(text[end] || ' ')) end--;
    }
    return [start, end];
  }

  function rangeFromOffsets(block, a, b) {
    var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), n, pos = 0, r = document.createRange(), started = false;
    while ((n = w.nextNode())) {
      var len = n.nodeValue.length;
      if (!started && a < pos + len) { r.setStart(n, a - pos); started = true; }
      if (started && b <= pos + len) { r.setEnd(n, b - pos); return r; }
      pos += len;
    }
    return started ? r : null;
  }

  function wordAt(x, y) {
    var c = caretAt(x, y);
    if (!c || !c.node || c.node.nodeType !== 3 || !$('rd-flow').contains(c.node)) return null;
    var text = c.node.nodeValue, s = c.offset, e = c.offset;
    while (s > 0 && WORDCH.test(text[s - 1])) s--;
    while (e < text.length && WORDCH.test(text[e])) e++;
    while (s < e && EDGE.test(text[s])) s++;
    while (e > s && EDGE.test(text[e - 1])) e--;
    if (e <= s) return null;
    var wr = document.createRange();
    wr.setStart(c.node, s);
    wr.setEnd(c.node, e);
    var hit = false, rects = wr.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 6 && y <= r.bottom + 6) { hit = true; break; }
    }
    if (!hit) return null;
    var block = c.node.parentNode;
    while (block && block !== $('rd-flow') && !(block.getAttribute && block.getAttribute('data-i') !== null)) block = block.parentNode;
    var sentence = '', sentRange = null;
    if (block && block !== $('rd-flow')) {
      var pre = document.createRange();
      pre.setStart(block, 0);
      pre.setEnd(c.node, s);
      var i0 = pre.toString().length, bt = block.textContent, b = sentenceBounds(bt, i0, i0 + (e - s));
      sentence = bt.slice(b[0], b[1]).replace(/\s+/g, ' ').trim();
      if (b[0] > 0 || b[1] < bt.length) sentRange = rangeFromOffsets(block, b[0], b[1]);
    }
    return { word: text.slice(s, e).replace(/­/g, ''), sentence: sentence, range: wr, sentRange: sentRange };
  }

  function clearWord() {
    S.word = null;
    if (highlights) { root.CSS.highlights.delete('rd-word'); root.CSS.highlights.delete('rd-sent'); }
  }
  function markWord(hit) {
    S.word = hit;
    if (!highlights) return;
    if (hit.sentRange) root.CSS.highlights.set('rd-sent', new root.Highlight(hit.sentRange));
    root.CSS.highlights.set('rd-word', new root.Highlight(hit.range));
  }

  /* ================================================================ dictionary sheet */

  function sheetPx() {
    var h = $('reader').clientHeight;
    return clamp(Math.round(h * S.prefs.sheet), 150, Math.max(150, h - 40));
  }
  function applySheetHeight() { $('dict-pane').style.setProperty('--sheet-h', sheetPx() + 'px'); }

  function showSheet() {
    if (!S.doc) return;
    applySheetHeight();
    S.sheetOpen = true;
    document.body.classList.add('sheet-open');
    if (S.word) ensureVisible();
  }
  function hideSheet() {
    if (!S.sheetOpen) return;
    S.sheetOpen = false;
    document.body.classList.remove('sheet-open');
    setShift(0);
    clearWord();
  }

  function setShift(px) {
    S.shift = px;
    $('rd-view').style.transform = px ? 'translateY(' + (-px) + 'px)' : '';
  }

  // Slides the page up when the tapped word would hide behind the sheet.
  function ensureVisible() {
    if (!S.word) return;
    var r = S.word.range.getBoundingClientRect(), rd = $('reader').getBoundingClientRect();
    var bottom = r.bottom + S.shift, top = r.top + S.shift;
    var need = bottom + 28 - (rd.bottom - sheetPx());
    var shift = need > 0 ? need : 0;
    var room = top - (rd.top + 12);
    if (shift > room) shift = Math.max(0, room);
    setShift(Math.round(shift));
  }

  function bindGrip() {
    var grip = $('sheet-grip'), pane = $('dict-pane'), g = null;
    grip.addEventListener('pointerdown', function (e) {
      if (e.target.closest('#sheet-hide')) return;
      g = { y: e.clientY, h: sheetPx(), id: e.pointerId };
      grip.setPointerCapture(e.pointerId);
      pane.classList.add('dragging');
    });
    grip.addEventListener('pointermove', function (e) {
      if (!g) return;
      var max = Math.max(150, $('reader').clientHeight - 40);
      var h = clamp(g.h + (g.y - e.clientY), 60, max);
      g.now = h;
      pane.style.setProperty('--sheet-h', h + 'px');
    });
    function end() {
      if (!g) return;
      var h = g.now || g.h;
      pane.classList.remove('dragging');
      g = null;
      if (h < 110) { hideSheet(); applySheetHeight(); return; }
      changePrefs({ sheet: clamp(h / $('reader').clientHeight, 0.2, 0.9) }, false);
      applySheetHeight();
      ensureVisible();
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    $('sheet-hide').addEventListener('click', hideSheet);
  }

  /* ================================================================ search drawer */

  function openDrawer() {
    document.body.classList.add('search-open');
    if (cb.onDrawer) cb.onDrawer();
    var q = $('q');
    q.focus();
    q.select();
  }
  function closeDrawer() {
    if (!document.body.classList.contains('search-open')) return;
    document.body.classList.remove('search-open');
    $('q').blur();
    $('suggest').hidden = true;
  }

  /* ================================================================ gestures */

  function bindGestures() {
    var view = $('rd-view'), flow = $('rd-flow');

    view.addEventListener('pointerdown', function (e) {
      if (!S.doc || (e.pointerType === 'mouse' && e.button !== 0)) return;
      S.g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), dx: 0, dy: 0, mode: null };
      try { view.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    view.addEventListener('pointermove', function (e) {
      var g = S.g;
      if (!g || e.pointerId !== g.id) return;
      g.dx = e.clientX - g.x;
      g.dy = e.clientY - g.y;
      if (!g.mode && (Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10)) g.mode = Math.abs(g.dx) > Math.abs(g.dy) ? 'h' : 'v';
      if (g.mode === 'h') {
        var dx = g.dx;
        var atStart = S.page === 0 && S.sec === 0 && dx > 0, atEnd = S.page === S.pages - 1 && S.sec === S.doc.sections.length - 1 && dx < 0;
        if (atStart || atEnd) dx *= 0.25;
        flow.style.transition = 'none';
        flow.style.transform = 'translateX(' + (-S.page * S.step + dx) + 'px)';
      }
    });

    function finish(e, cancelled) {
      var g = S.g;
      if (!g || e.pointerId !== g.id) return;
      S.g = null;
      if (cancelled) { setPage(S.page, true); return; }
      var dt = Date.now() - g.t;
      if (g.mode === 'h') {
        var fast = Math.abs(g.dx) > 28 && dt < 260;
        if (g.dx < -60 || (fast && g.dx < 0)) next();
        else if (g.dx > 60 || (fast && g.dx > 0)) prev();
        else setPage(S.page, true);
      } else if (g.mode === 'v') {
        if (g.dy > 55) openDrawer();
        else if (g.dy < -55) closeDrawer();
      } else {
        tap(e.clientX, e.clientY);
      }
    }
    view.addEventListener('pointerup', function (e) { finish(e, false); });
    view.addEventListener('pointercancel', function (e) { finish(e, true); });
    view.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    document.addEventListener('keydown', function (e) {
      if (!S.doc || !document.body.classList.contains('reading')) return;
      if (document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') { hideSheet(); closeDrawer(); }
    });
  }

  function tap(x, y) {
    if (document.body.classList.contains('search-open')) { closeDrawer(); return; }
    var rect = $('rd-view').getBoundingClientRect(), rel = (x - rect.left) / rect.width;
    var hit = wordAt(x, y);   // a word always wins; empty space near the edges turns the page
    if (!hit) {
      if (rel < 0.2) prev();
      else if (rel > 0.8) next();
      else hideSheet();
      return;
    }
    markWord(hit);
    showSheet();
    if (cb.onWord) cb.onWord(hit.word, hit.sentence);
  }

  /* ================================================================ public */

  function load(doc, pos) {
    S.doc = doc;
    S.sheetOpen = false;
    document.body.classList.remove('sheet-open', 'search-open');
    $('reader').hidden = false;
    renderToc();
    var sec = pos && doc.sections[pos.s] ? pos.s : 0;
    S.sec = sec;
    S.pendingBlock = pos && typeof pos.b === 'number' ? pos.b : 0;
    S.dirty = true;
    if (layout()) gotoSection(sec, S.pendingBlock, true);
    else { renderSection(); footerSafe(); }
  }
  function footerSafe() { $('rd-title').textContent = S.doc.title; $('rd-pos').textContent = ''; $('rd-prog').style.width = '0'; }

  function close() {
    S.doc = null;
    clearWord();
    setShift(0);
    S.sheetOpen = false;
    document.body.classList.remove('sheet-open', 'search-open');
    $('reader').hidden = true;
    $('rd-flow').textContent = '';
  }

  function init(opts) {
    cb = opts || {};
    bindGestures();
    $('rd-pull').addEventListener('click', openDrawer);
    bindGrip();
    $('rd-btn-toc').addEventListener('click', function () { closeDrawer(); openToc(); });
    $('rd-btn-aa').addEventListener('click', function () { closeDrawer(); $('prefs-dialog').showModal(); });
    $('toc-close').addEventListener('click', function () { $('toc-dialog').close(); });
    $('toc-list').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-sec]');
      if (!b) return;
      $('toc-dialog').close();
      hideSheet();
      gotoSection(+b.getAttribute('data-sec'), 0);
    });
    $('pf-close').addEventListener('click', function () { $('prefs-dialog').close(); });
    $('pf-smaller').addEventListener('click', function () { changePrefs({ scale: Math.round(clamp(S.prefs.scale - 0.1, MIN_SCALE, MAX_SCALE) * 100) / 100 }, true); });
    $('pf-bigger').addEventListener('click', function () { changePrefs({ scale: Math.round(clamp(S.prefs.scale + 0.1, MIN_SCALE, MAX_SCALE) * 100) / 100 }, true); });
    Array.prototype.forEach.call(document.querySelectorAll('#prefs-dialog [data-face]'), function (b) {
      b.addEventListener('click', function () { changePrefs({ serif: b.getAttribute('data-face') === 'serif' }, true); });
    });
    root.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (S.doc) { S.dirty = false; relayout(); if (S.sheetOpen) applySheetHeight(); } }, 150);
    });
    applyPrefs();
  }

  root.Reader = {
    init: init, load: load, close: close, relayout: relayout,
    showSheet: showSheet, hideSheet: hideSheet, openDrawer: openDrawer, closeDrawer: closeDrawer,
    isOpen: function () { return !!S.doc; }, getPos: getPos, setPrefs: setPrefs, prefs: function () { return S.prefs; },
    _state: S, _internals: { sentenceBounds: sentenceBounds }
  };
})(window);
