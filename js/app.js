/*!
 * app.js - user interface: lookup, selection, notebook, review, settings.
 * Depends on: config.js, leitner.js, mdict.js, store.js, render.js (all loaded before this file).
 */
(function () {
  'use strict';

  var L = window.Leitner, MD = window.MDict, Store = window.Store, Render = window.Render;
  var CONFIG = window.APP_CONFIG || {};
  var APP_VERSION = '1.0.0';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var state = {
    tab: 'lookup',
    dict: null, dictRec: null,
    settings: L.normalizeSettings({}),
    entries: [],
    lastBackup: null,
    current: null,        // { key, indexes } of the entry on screen
    chunkEls: [],         // chunk elements of the entry on screen
    pick: null,           // { mode: 'chunks', start, end } | { mode: 'text', text }
    cardCtx: null,        // { entry } while the card dialog is open
    session: null,        // review session
    context: '',          // sentence around the word tapped in the reader; prefilled as the context of new cards
    doc: null,            // the document open in the reader
    media: [],            // stored .mdd records for the current dictionary
    mediaReady: false,    // media were set up during this start already
    dictStyle: true       // use the dictionary's own styling, images and sounds
  };

  /* ================================================================ small UI helpers */

  // Replays a CSS animation that is driven by a class.
  function restart(node, cls) { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }
  function reducedMotion() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var toastTimer = null;
  function toast(msg, ms, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.style.background = isError ? '#8c1d18' : '';
    t.style.color = isError ? '#fff' : '';
    t.classList.remove('leaving');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.add('leaving');
      toastTimer = setTimeout(function () { t.hidden = true; t.classList.remove('leaving'); }, 190);
    }, ms || 2600);
  }

  function showProgress(title, text, frac) {
    var d = $('progress-dialog');
    $('pg-title').textContent = title;
    $('pg-text').textContent = text || '';
    var bar = $('pg-bar');
    if (frac == null) bar.removeAttribute('value'); else bar.value = Math.round(frac * 100);
    if (!d.open) d.showModal();
  }
  function hideProgress() { var d = $('progress-dialog'); if (d.open) d.close(); }

  function daysUntil(due, today) {
    var a = due.split('-').map(Number), b = today.split('-').map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 864e5);
  }
  function friendlyDue(due, today) {
    var n = daysUntil(due, today);
    if (n <= 0) return n === 0 ? 'due today' : 'overdue';
    return n === 1 ? 'tomorrow' : 'in ' + n + ' days';
  }
  function byId(id) {
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === id) return state.entries[i];
    return null;
  }
  function replaceEntry(e) {
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === e.id) { state.entries[i] = e; return; }
    state.entries.push(e);
  }

  /* ================================================================ tabs */

  function showTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    syncReading();
    renderBar();
    if (name === 'lookup') Reader.relayout();
    if (name === 'notebook') renderNotebook();
    if (name === 'review') renderReview();
    if (name === 'settings') renderSettings();
    $('main').scrollTop = 0;
  }

  function renderBadges() {
    var st = L.stats(state.entries, L.todayStr(), state.settings.intervals.length);
    var b = $('badge-due');
    var txt = st.due > 99 ? '99+' : String(st.due);
    var changed = b.textContent !== txt;
    b.hidden = st.due === 0;
    b.textContent = txt;
    if (changed && st.due) restart(b, 'pop');
  }

  /* ================================================================ dictionary loading */

  function dictName() {
    if (!state.dict) return '';
    return state.dict.meta.title || (state.dictRec && state.dictRec.name) || '';
  }

  function useDictionary(dict, rec) {
    state.dict = dict;
    state.dictRec = rec;
    $('dict-title').textContent = dictName();
    $('q').disabled = false;
    $('empty-state').hidden = true;
    $('lookup-hint').hidden = false;
    $('lookup-hint').textContent = 'Type a word above. Tap a paragraph of a definition to pick it, or long-press to select your own text, then add it to your notebook.';
    $('entry-wrap').hidden = true;
    state.current = null;
    clearPick();
  }

  function setNoDict(msg) {
    state.dict = null;
    state.dictRec = null;
    $('dict-title').textContent = '';
    $('q').disabled = true;
    $('entry-wrap').hidden = true;
    $('lookup-hint').hidden = true;
    $('empty-msg').textContent = msg || 'No dictionary is loaded yet.';
    $('empty-state').hidden = false;
  }

  function progressCb(title) {
    return function (frac, label) { showProgress(title, (label || '') + ' - this happens only once.', frac); };
  }

  // Parses a blob, stores the file and its index on the device, and starts using it.
  async function installDictionary(blob, info) {
    showProgress('Preparing dictionary', 'Starting...', 0);
    try {
      var dict = await MD.open(blob, { onProgress: progressCb('Preparing dictionary') });
      if (dict.meta.isMdd) throw new Error('That is a resource (.mdd) file. Choose it together with the .mdx file, or use "Add media files".');
      var rec = {
        name: info.name, size: blob.size, source: info.source, bundledVersion: info.bundledVersion || null,
        sig: [info.source, info.bundledVersion || '', info.name, blob.size, info.lastModified || 0].join('|'), blob: blob
      };
      try {
        await Store.putDictRecord(rec);
        await Store.putDictIndex({ sig: rec.sig, data: dict.exportIndex() });
      } catch (e) {
        toast('The dictionary works now but could not be saved on this device (storage full?).', 6000, true);
      }
      useDictionary(dict, rec);
    } finally { hideProgress(); }
  }

  async function openStoredDictionary(rec) {
    var dict = null;
    try {
      var idx = await Store.getDictIndex();
      if (idx && idx.sig === rec.sig) dict = MD.fromIndex(rec.blob, idx.data);
    } catch (e) { dict = null; }
    if (!dict) {
      showProgress('Preparing dictionary', 'Starting...', 0);
      try {
        dict = await MD.open(rec.blob, { onProgress: progressCb('Preparing dictionary') });
        try { await Store.putDictIndex({ sig: rec.sig, data: dict.exportIndex() }); } catch (e) { /* not fatal */ }
      } finally { hideProgress(); }
    }
    useDictionary(dict, rec);
  }

  async function fetchBundled() {
    var res = await fetch(CONFIG.BUNDLED_DICT, { cache: 'no-cache' });
    if (!res.ok) throw new Error('The bundled dictionary was not found (' + res.status + ').');
    return res.blob();
  }

  /* ---- resource files (.mdd): styles, images, audio ---- */

  function mediaRec(blob, info) {
    return {
      name: info.name, size: blob.size, source: info.source || 'custom', bundledVersion: info.bundledVersion || null,
      sig: [info.source || 'custom', info.bundledVersion || '', info.name, blob.size, info.lastModified || 0].join('|'), blob: blob
    };
  }

  // Parses (or reloads the saved index of) every record and returns the .mdd dictionaries.
  async function openMediaRecs(recs) {
    var saved = {};
    try { saved = (await Store.getMediaIndex()) || {}; } catch (e) { saved = {}; }
    var fresh = {}, dicts = [], dirty = false;
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i], d = null;
      if (saved[rec.sig]) { try { d = MD.fromIndex(rec.blob, saved[rec.sig]); } catch (e) { d = null; } }
      if (!d) {
        showProgress('Preparing media', rec.name, 0);
        try { d = await MD.open(rec.blob, { onProgress: progressCb('Preparing media') }); } finally { hideProgress(); }
        dirty = true;
      }
      if (!d.meta.isMdd) throw new Error(rec.name + ' is not an .mdd resource file.');
      fresh[rec.sig] = d.exportIndex();
      dicts.push(d);
    }
    if (dirty || Object.keys(saved).length !== recs.length) { try { await Store.putMediaIndex(fresh); } catch (e) { /* not fatal */ } }
    return dicts;
  }

  async function setMedia(recs, dicts) {
    state.media = recs;
    state.mediaReady = true;
    Media.set(dicts);
    renderSettings();
  }

  async function loadStoredMedia() {
    var recs = [];
    try { recs = (await Store.getMedia()) || []; } catch (e) { recs = []; }
    if (!recs.length) { await setMedia([], []); return; }
    try { await setMedia(recs, await openMediaRecs(recs)); }
    catch (e) { toast('Media files could not be opened: ' + (e && e.message ? e.message : e), 6000, true); await setMedia([], []); }
  }

  // files: [{ blob, name, lastModified, source, bundledVersion }]. replace=true drops the media of the old dictionary.
  async function installMedia(files, replace) {
    var recs = files.map(function (f) { return mediaRec(f.blob, f); });
    var keep = replace ? [] : state.media.filter(function (r) { return !recs.some(function (n) { return n.name === r.name; }); });
    var all = keep.concat(recs);
    var dicts = await openMediaRecs(all);            // also checks that they are .mdd files
    try { await Store.putMedia(all); } catch (e) { toast('The media files work now but could not be saved on this device.', 6000, true); }
    await setMedia(all, dicts);
  }

  async function clearMedia() {
    try { await Store.putMedia([]); await Store.putMediaIndex({}); } catch (e) { /* not fatal */ }
    await setMedia([], []);
  }

  async function installBundled() {
    var blob = await fetchBundled();
    await installDictionary(blob, {
      name: CONFIG.BUNDLED_DICT.split('/').pop(), source: 'bundled', bundledVersion: CONFIG.BUNDLED_DICT_VERSION
    });
    var list = CONFIG.BUNDLED_MEDIA || [], files = [];
    try {
      for (var i = 0; i < list.length; i++) {
        var res = await fetch(list[i], { cache: 'no-cache' });
        if (!res.ok) throw new Error('The bundled media file ' + list[i] + ' was not found (' + res.status + ').');
        files.push({ blob: await res.blob(), name: list[i].split('/').pop(), source: 'bundled', bundledVersion: CONFIG.BUNDLED_DICT_VERSION });
      }
      if (files.length) await installMedia(files, true); else await clearMedia();
    } catch (e) { toast('Dictionary ready, but its media could not be loaded: ' + (e && e.message ? e.message : e), 6000, true); await clearMedia(); }
  }

  async function loadDictionary() {
    var rec = null;
    try { rec = await Store.getDictRecord(); } catch (e) { rec = null; }
    var stale = rec && rec.source === 'bundled' && CONFIG.BUNDLED_DICT && rec.bundledVersion !== CONFIG.BUNDLED_DICT_VERSION;
    try {
      if ((!rec || stale) && CONFIG.BUNDLED_DICT) {
        showProgress('Downloading dictionary', 'Only needed the first time.', null);
        try { await installBundled(); return; }
        catch (e) {
          hideProgress();
          if (!rec) throw e;          // offline with an older copy: keep using it
        }
      }
      if (rec) { await openStoredDictionary(rec); await loadStoredMedia(); return; }
      setNoDict(CONFIG.BUNDLED_DICT ? '' : 'Choose a dictionary file to get started.');
    } catch (e) {
      hideProgress();
      setNoDict((e && e.message ? e.message : 'The dictionary could not be loaded.') + ' You can choose a dictionary file from your phone instead.');
    }
  }

  async function chooseDictionaryFile(input) {
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (!files.length) return;
    var mdds = files.filter(function (f) { return /\.mdd$/i.test(f.name); });
    var mdx = files.filter(function (f) { return !/\.mdd$/i.test(f.name); });
    if (mdx.length > 1) { toast('Choose one .mdx file at a time (you can select several .mdd files with it).', 6000, true); return; }
    function asMedia(list) { return list.map(function (f) { return { blob: f, name: f.name, lastModified: f.lastModified }; }); }
    if (mdx.length) {
      try {
        await installDictionary(mdx[0], { name: mdx[0].name, source: 'custom', lastModified: mdx[0].lastModified });
      } catch (e) {
        toast('Could not open this file: ' + (e && e.message ? e.message : e), 7000, true);
        return;
      }
      try {
        if (mdds.length) await installMedia(asMedia(mdds), true); else await clearMedia();
      } catch (e) { toast('The dictionary is ready, but a media file could not be used: ' + (e && e.message ? e.message : e), 7000, true); await clearMedia(); }
      toast('Dictionary ready: ' + dictName() + (state.media.length ? ' with ' + state.media.length + ' media file' + (state.media.length > 1 ? 's' : '') : ''));
      showTab('lookup');
    } else await addMediaFiles(mdds);
  }

  async function addMediaFiles(list) {
    if (!list.length) return;
    var bad = list.filter(function (f) { return !/\.mdd$/i.test(f.name); });
    if (bad.length) { toast('Media files end in .mdd. Skipped: ' + bad[0].name, 5000, true); list = list.filter(function (f) { return /\.mdd$/i.test(f.name); }); if (!list.length) return; }
    try {
      await installMedia(list.map(function (f) { return { blob: f, name: f.name, lastModified: f.lastModified }; }), false);
      toast('Media ready: ' + state.media.length + ' file' + (state.media.length > 1 ? 's' : ''));
      refreshEntry();
    } catch (e) { toast('Could not use this file: ' + (e && e.message ? e.message : e), 7000, true); }
  }

  // Draw the current entry again (after media or the styling setting changed).
  function refreshEntry() {
    if (state.current) showEntries(state.current.indexes, $('entry-note').textContent);
  }

  /* ================================================================ lookup */

  var suggestTimer = null;
  function updateSuggestions() {
    var ul = $('suggest'), q = $('q').value;
    ul.textContent = '';
    if (!state.dict || !q.trim()) { ul.hidden = true; return; }
    var list = state.dict.suggest(q, 12);
    list.forEach(function (s) {
      var li = el('li', null, s.key);
      li.addEventListener('click', function () { $('q').value = s.key; Reader.closeDrawer(); lookupWord(s.key, ''); });
      ul.appendChild(li);
    });
    ul.hidden = list.length === 0;
  }

  // ctx: the sentence the word came from (undefined keeps the current one, '' clears it)
  async function lookupWord(raw, ctx) {
    if (ctx !== undefined) state.context = ctx;
    await findWord(raw);
    if (document.body.classList.contains('reading')) Reader.showSheet();
  }

  async function findWord(raw) {
    if (!state.dict) return;
    var w = String(raw || '').replace(/[‘’]/g, "'").trim();
    if (!w) return;
    $('suggest').hidden = true;
    var idxs = state.dict.lookup(w), note = '';
    if (!idxs.length) {
      var vs = MD.variants(w);
      for (var i = 0; i < vs.length && !idxs.length; i++) {
        idxs = state.dict.lookup(vs[i]);
        if (idxs.length) note = 'Showing “' + vs[i] + '” for “' + w + '”.';
      }
    }
    if (!idxs.length) {
      var sug = state.dict.suggest(w, 1);
      if (sug.length) { idxs = state.dict.lookup(sug[0].key); note = 'No exact match for “' + w + '”. Showing the closest entry.'; }
    }
    if (!idxs.length) {
      $('entry-wrap').hidden = true;
      $('lookup-hint').hidden = false;
      $('lookup-hint').textContent = 'No entry found for “' + w + '”.';
      state.current = null;
      clearPick();
      return;
    }
    await showEntries(idxs, note);
  }

  async function showEntries(idxs, note) {
    var htmls = [];
    try {
      for (var i = 0; i < idxs.length; i++) htmls.push(await state.dict.entryHtml(idxs[i]));
    } catch (e) {
      toast('Could not read this entry: ' + (e && e.message ? e.message : e), 6000, true);
      return;
    }
    var styled = state.dictStyle;
    var built = Render.build(htmls, { styled: styled, has: Media.has });
    if (styled) { try { await Media.applyStyles(built.styles); } catch (e) { /* plain entry */ } }
    var view = $('entry-view');
    view.textContent = '';
    view.appendChild(built.node);
    if (styled) Media.resolveImages(built.node);
    state.current = { key: state.dict.keys[idxs[0]], indexes: idxs };
    state.chunkEls = Array.prototype.slice.call(view.querySelectorAll('.chunk'));
    clearPick();
    $('entry-word').textContent = state.current.key;
    var n = $('entry-note');
    n.hidden = !note;
    n.textContent = note || '';
    $('raw-source').textContent = htmls.join('\n\n---- next entry ----\n\n');
    $('raw-wrap').open = false;
    $('entry-wrap').hidden = false;
    restart($('entry-wrap'), 'enter');
    $('lookup-hint').hidden = true;
    $('main').scrollTop = 0;
    var sb = document.querySelector('.sheet-body');
    if (sb) sb.scrollTop = 0;
  }

  /* ================================================================ selection (paragraphs or free text) */

  function highlight() {
    var p = state.pick;
    state.chunkEls.forEach(function (c, i) {
      c.classList.toggle('picked', !!p && p.mode === 'chunks' && i >= p.start && i <= p.end);
    });
  }

  function renderBar() {
    var bar = $('actionbar'), p = state.pick;
    if (!p || state.tab !== 'lookup') { bar.hidden = true; document.body.classList.remove('has-bar'); return; }
    bar.hidden = false;
    document.body.classList.add('has-bar');
    var prev = $('ab-prev'), next = $('ab-next');
    if (p.mode === 'chunks') {
      var n = p.end - p.start + 1;
      $('ab-text').textContent = n === 1 ? 'Paragraph selected' : n + ' paragraphs selected';
      prev.hidden = next.hidden = false;
      prev.disabled = p.end <= p.start;
      next.disabled = p.end >= state.chunkEls.length - 1;
    } else {
      $('ab-text').textContent = 'Selected text (' + p.text.length + ' characters)';
      prev.hidden = next.hidden = true;
    }
  }

  function setPick(p) { state.pick = p; highlight(); renderBar(); }
  function pickChunk(i) { setPick({ mode: 'chunks', start: i, end: i }); }

  function extendPick(delta) {
    var p = state.pick;
    if (!p || p.mode !== 'chunks') return;
    var end = p.end + delta;
    if (end < p.start || end > state.chunkEls.length - 1) return;
    p.end = end;
    setPick(p);
    var target = state.chunkEls[delta > 0 ? end : p.start];
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
  }

  function clearPick() {
    state.pick = null;
    highlight();
    renderBar();
    var s = window.getSelection && window.getSelection();
    if (s && s.rangeCount) s.removeAllRanges();
  }

  function pickedText() {
    var p = state.pick;
    if (!p) return '';
    if (p.mode === 'text') return p.text;
    return state.chunkEls.slice(p.start, p.end + 1).map(Render.textOf).join('\n');
  }

  var selTimer = null;
  function onSelectionChange() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;       // collapsed: keep the last pick so the Add button still works
    var view = $('entry-view');
    if (!view.contains(sel.anchorNode) || !view.contains(sel.focusNode)) return;
    var text = sel.toString().replace(/[ \t\r\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (text) setPick({ mode: 'text', text: text });
  }

  /* ================================================================ add / edit card dialog */

  function cardMeta(e) {
    var today = L.todayStr();
    var parts = [];
    parts.push(e.learned ? 'Learned' : 'Box ' + e.box + ' · ' + (e.due ? friendlyDue(e.due, today) : ''));
    parts.push('reviewed ' + (e.reps || 0) + ' time' + (e.reps === 1 ? '' : 's'));
    if (e.lapses) parts.push(e.lapses + ' lapse' + (e.lapses === 1 ? '' : 's'));
    parts.push('added ' + String(e.created).slice(0, 10));
    return parts.join(' · ');
  }

  function updateDup() {
    var w = $('cd-word').value.trim().toLowerCase();
    var self = state.cardCtx && state.cardCtx.entry;
    var hit = null;
    if (w) state.entries.forEach(function (e) { if (e.word.toLowerCase() === w && (!self || e.id !== self.id)) hit = e; });
    var d = $('cd-dup');
    d.hidden = !hit;
    if (hit) d.textContent = 'This word is already in your notebook (' + (hit.learned ? 'learned' : 'box ' + hit.box) + '). You can still add another card, for example for a different meaning.';
  }

  function openCardDialog(opts) {
    var ent = opts.entry || null;
    state.cardCtx = { entry: ent };
    $('cd-title').textContent = ent ? 'Edit card' : 'Add to notebook';
    $('cd-word').value = ent ? ent.word : (opts.word || '');
    $('cd-def').value = ent ? ent.definition : (opts.definition || '');
    $('cd-ctx').value = ent ? ent.context : state.context;
    $('cd-delete').hidden = $('cd-reset').hidden = !ent;
    var meta = $('cd-meta');
    meta.hidden = !ent;
    if (ent) meta.textContent = cardMeta(ent);
    $('cd-error').hidden = true;
    updateDup();
    $('card-dialog').showModal();
    if (!ent) ($('cd-def').value ? $('cd-ctx') : $('cd-def')).focus();
  }

  function cardError(msg) { var e = $('cd-error'); e.textContent = msg; e.hidden = false; }

  async function saveCard() {
    var word = $('cd-word').value.trim(), def = $('cd-def').value.trim(), ctx = $('cd-ctx').value.trim();
    if (!word) return cardError('Please enter the word.');
    if (!def) return cardError('Please add a definition: select text in the entry first, or type it here.');
    var ent = state.cardCtx && state.cardCtx.entry, now = new Date().toISOString(), saved;
    try {
      if (ent) {
        saved = Object.assign({}, ent, { word: word, definition: def, context: ctx, updated: now });
        await Store.putEntry(saved);
        replaceEntry(saved);
        toast('Card saved');
      } else {
        saved = L.newEntry({ word: word, definition: def, context: ctx, source: dictName() }, L.todayStr(), now);
        await Store.putEntry(saved);
        state.entries.push(saved);
        toast('Added to notebook');
        clearPick();
      }
    } catch (e) { return cardError('Could not save: ' + (e && e.message ? e.message : e)); }
    $('card-dialog').close();
    renderBadges();
    if (state.tab === 'notebook') renderNotebook();
  }

  async function deleteCard() {
    var ent = state.cardCtx && state.cardCtx.entry;
    if (!ent || !window.confirm('Delete the card “' + ent.word + '”?')) return;
    await Store.deleteEntry(ent.id);
    state.entries = state.entries.filter(function (e) { return e.id !== ent.id; });
    $('card-dialog').close();
    renderBadges();
    renderNotebook();
    toast('Card deleted');
  }

  async function resetCard() {
    var ent = state.cardCtx && state.cardCtx.entry;
    if (!ent) return;
    var r = L.resetProgress(ent, L.todayStr());
    await Store.putEntry(r);
    replaceEntry(r);
    state.cardCtx.entry = r;
    $('cd-meta').textContent = cardMeta(r);
    renderBadges();
    renderNotebook();
    toast('Progress reset: back to box 1');
  }

  async function pasteContext() {
    try {
      var t = await navigator.clipboard.readText();
      if (t && t.trim()) $('cd-ctx').value = t.trim(); else toast('The clipboard is empty.');
    } catch (e) {
      toast('Could not read the clipboard. Long-press the box and choose Paste.', 4500);
      $('cd-ctx').focus();
    }
  }

  /* ================================================================ notebook + export */

  function renderNotebook() {
    var today = L.todayStr(), iv = state.settings.intervals;
    var s = L.stats(state.entries, today, iv.length);
    $('nb-summary').textContent = s.total === 0
      ? 'No cards yet. Look up a word and add it.'
      : s.total + ' card' + (s.total === 1 ? '' : 's') + ' · ' + s.due + ' due today · ' + s.learned + ' learned';
    var bx = $('nb-boxes');
    bx.textContent = '';
    s.boxes.forEach(function (count, i) {
      var d = el('div', 'box');
      d.appendChild(el('b', null, String(count)));
      var sp = el('span');
      sp.appendChild(document.createTextNode('Box ' + (i + 1)));
      sp.appendChild(document.createElement('br'));
      sp.appendChild(document.createTextNode(iv[i] + (iv[i] === 1 ? ' day' : ' days')));
      d.appendChild(sp);
      bx.appendChild(d);
    });
    var changed = state.entries.filter(function (e) { return !state.lastBackup || e.updated > state.lastBackup; }).length;
    var info = state.lastBackup
      ? 'Last backup: ' + state.lastBackup.slice(0, 10) + (changed ? ' (' + changed + ' card' + (changed === 1 ? '' : 's') + ' changed since).' : '. Nothing changed since.')
      : 'No backup yet. Your notebook is stored only on this device, so download a backup now and then.';
    $('nb-backup-info').textContent = info;
    renderList();
  }

  function renderList() {
    var today = L.todayStr();
    var q = $('nb-filter').value.trim().toLowerCase();
    var list = state.entries.slice().sort(function (a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : 0; });
    if (q) list = list.filter(function (e) { return (e.word + ' ' + e.definition + ' ' + e.context).toLowerCase().indexOf(q) >= 0; });
    var CAP = 300, ul = $('nb-list');
    ul.textContent = '';
    list.slice(0, CAP).forEach(function (e) {
      var li = el('li');
      var row = el('div', 'row');
      row.appendChild(el('b', null, e.word));
      row.appendChild(el('span', 'tag', e.learned ? 'learned ✓' : 'Box ' + e.box + ' · ' + (e.due ? friendlyDue(e.due, today) : '')));
      li.appendChild(row);
      li.appendChild(el('div', 'snip', e.definition.replace(/\s+/g, ' ').slice(0, 160)));
      li.addEventListener('click', function () { openCardDialog({ entry: e }); });
      ul.appendChild(li);
    });
    var more = $('nb-more');
    more.hidden = list.length <= CAP;
    more.textContent = 'Showing the newest ' + CAP + ' of ' + list.length + ' cards. Use the filter to find others.';
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  async function exportBackup() {
    if (!state.entries.length) { toast('There are no cards to back up yet.'); return; }
    var now = new Date().toISOString();
    var info = state.dict ? { title: state.dict.meta.title, file: state.dictRec && state.dictRec.name, entries: state.dict.size() } : null;
    download('dictionary-notebook-' + L.todayStr() + '.json',
      JSON.stringify(L.toBackup(state.entries, state.settings, info, now), null, 2), 'application/json');
    state.lastBackup = now;
    try { await Store.setKV('lastBackup', now); } catch (e) { /* not fatal */ }
    renderNotebook();
    toast('Backup downloaded');
  }

  function exportAnki() {
    if (!state.entries.length) { toast('There are no cards to export yet.'); return; }
    download('anki-import-' + L.todayStr() + '.txt', L.toAnkiTSV(state.entries, state.settings), 'text/plain;charset=utf-8');
    toast('Exported ' + state.entries.length + ' cards. In AnkiDroid, choose Import and pick this file.', 6000);
  }

  async function importBackup(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      var res = L.parseBackup(await file.text(), L.todayStr());
      var wasEmpty = state.entries.length === 0;
      var m = L.mergeEntries(state.entries, res.entries);
      await Store.putEntries(m.toWrite);
      state.entries = m.entries;
      if (wasEmpty) { state.settings = res.settings; await Store.setKV('settings', state.settings); }
      renderBadges();
      renderNotebook();
      toast('Restored: ' + m.added + ' new, ' + m.updated + ' updated, ' + m.kept + ' unchanged' + (res.skipped ? ', ' + res.skipped + ' skipped' : '') + '.', 6000);
    } catch (e) { toast(e && e.message ? e.message : 'Could not read this file.', 6000, true); }
  }

  /* ================================================================ review */

  function show(id, on) { $(id).hidden = !on; }

  function renderReview() {
    var s = state.session;
    if (s && !s.done) { show('rv-idle', false); show('rv-done', false); show('rv-session', true); renderCard(); return; }
    if (s && s.done) { show('rv-idle', false); show('rv-session', false); show('rv-done', true); return; }
    show('rv-session', false); show('rv-done', false); show('rv-idle', true);
    var today = L.todayStr(), st = L.stats(state.entries, today, state.settings.intervals.length), lim = state.settings.sessionLimit;
    var start = $('rv-start');
    start.disabled = st.due === 0;
    if (st.total === 0) {
      $('rv-summary').textContent = 'Your notebook is empty. Add words from the Dictionary tab.';
      $('rv-next').textContent = '';
    } else if (st.due === 0) {
      $('rv-summary').textContent = 'Nothing is due today.';
      $('rv-next').textContent = st.nextDue ? 'Next cards are due ' + friendlyDue(st.nextDue, today) + ' (' + st.nextDue + ').'
        : (st.learned === st.total ? 'All cards are learned.' : '');
    } else {
      $('rv-summary').textContent = st.due + ' card' + (st.due === 1 ? '' : 's') + ' due today' + (lim && st.due > lim ? ' (' + lim + ' in this session)' : '') + '.';
      $('rv-next').textContent = '';
    }
  }

  function startReview() {
    var ids = L.buildQueue(state.entries, L.todayStr(), state.settings.sessionLimit);
    if (!ids.length) { renderReview(); return; }
    state.session = {
      queue: ids.map(function (id) { return { id: id, retry: false }; }),
      pos: 0, firstTry: 0, forgot: 0, total: ids.length, revealed: false, done: false
    };
    renderReview();
  }

  function renderCard() {
    var s = state.session;
    while (s.pos < s.queue.length && !byId(s.queue[s.pos].id)) s.pos++;
    if (s.pos >= s.queue.length) { finishSession(); return; }
    var item = s.queue[s.pos], e = byId(item.id);
    $('rv-progress').textContent = 'Card ' + (s.pos + 1) + ' of ' + s.queue.length + (item.retry ? ' · again' : '');

    var front = $('rv-front');
    front.textContent = '';
    front.appendChild(el('div', 'rv-word', e.word));
    var ctxFront = state.settings.contextOnFront && e.context;
    if (ctxFront) { var c = el('div', 'rv-ctx'); c.innerHTML = L.contextHtml(e.context, e.word); front.appendChild(c); }

    var back = $('rv-back');
    back.textContent = '';
    back.appendChild(el('div', 'rv-def', e.definition));
    if (e.context && !ctxFront) { var c2 = el('div', 'rv-back-ctx'); c2.innerHTML = L.contextHtml(e.context, e.word); back.appendChild(c2); }
    back.appendChild(el('div', 'rv-meta', item.retry ? 'Second look: this will not change the schedule.' : (e.learned ? 'Learned' : 'Box ' + e.box)));

    s.revealed = false;
    show('rv-back', false); show('rv-answer', false); show('rv-show', true);
    $('rv-bar-fill').style.width = Math.round(s.pos / s.queue.length * 100) + '%';
    var card = document.querySelector('.rv-card');
    card.classList.remove('rv-out', 'no');
    restart(card, 'rv-in');
  }

  function revealAnswer() {
    var s = state.session;
    if (!s || s.done || s.revealed || s.busy) return;
    s.revealed = true;
    show('rv-back', true); show('rv-show', false); show('rv-answer', true);
  }

  async function answerCard(ok) {
    var s = state.session;
    if (!s || s.done || !s.revealed || s.busy) return;
    s.busy = true;
    var item = s.queue[s.pos], e = byId(item.id);
    if (e && !item.retry) {
      var upd = L.answer(e, ok, state.settings, L.todayStr());
      replaceEntry(upd);
      try { await Store.putEntry(upd); } catch (err) { toast('Could not save progress: ' + err.message, 5000, true); }
      if (ok) s.firstTry++; else s.forgot++;
    }
    if (!ok) s.queue.push({ id: item.id, retry: true });
    s.pos++;
    renderBadges();
    if (!reducedMotion()) {
      var card = document.querySelector('.rv-card');
      card.classList.remove('rv-in');
      card.classList.toggle('no', !ok);
      card.classList.add('rv-out');
      $('rv-bar-fill').style.width = Math.round(s.pos / s.queue.length * 100) + '%';
      await wait(200);
    }
    s.busy = false;
    if (state.session !== s) return;
    renderCard();
  }

  function finishSession() {
    var s = state.session;
    s.done = true;
    var st = L.stats(state.entries, L.todayStr(), state.settings.intervals.length);
    var txt = 'You went through ' + s.total + ' card' + (s.total === 1 ? '' : 's') + ': ' + s.firstTry + ' remembered first time' +
      (s.forgot ? ', ' + s.forgot + ' to practise again (back in box 1).' : '.');
    if (st.due) txt += ' ' + st.due + ' more still due today.';
    $('rv-done-text').textContent = txt;
    show('rv-session', false); show('rv-idle', false); show('rv-done', true);
    renderBadges();
  }

  function endSession() { state.session = null; renderBadges(); renderReview(); }

  /* ================================================================ settings */

  function renderSettings() {
    var s = state.settings;
    $('set-intervals').value = s.intervals.join(', ');
    $('set-limit').value = s.sessionLimit;
    $('set-ctx-front').checked = s.contextOnFront;
    $('set-deck').value = s.ankiDeck;
    $('set-tag').value = s.ankiTag;
    var dl = $('dict-info');
    dl.textContent = '';
    function row(k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    if (state.dict) {
      var m = state.dict.meta, r = state.dictRec || {};
      row('Title', m.title || '(none)');
      row('Entries', String(state.dict.size()));
      row('Format', 'MDX ' + m.version + ', ' + m.encoding);
      row('File', (r.name || '') + (r.size ? ' (' + (r.size / 1048576).toFixed(1) + ' MB)' : ''));
      row('Source', r.source === 'bundled' ? 'bundled with the app' : 'chosen by you');
      row('Media', state.media.length ? state.media.map(function (m) { return m.name; }).join(', ') : 'none');
    } else row('Status', 'No dictionary loaded');
    $('btn-clear-media').hidden = !state.media.length;
    $('set-dict-style').checked = state.dictStyle;
    $('btn-bundled').hidden = !CONFIG.BUNDLED_DICT;
    Store.isPersisted().then(function (p) {
      $('storage-info').textContent = 'App version ' + APP_VERSION + '. ' + (Store.isVolatile()
        ? 'Storage is NOT available in this mode.'
        : (p ? 'Storage is marked persistent: the browser will not clear it automatically.' : 'The browser may clear stored data if the phone runs very low on space, so keep a backup.'));
    });
  }

  async function saveSettings(patch) {
    state.settings = L.normalizeSettings(Object.assign({}, state.settings, patch));
    try { await Store.setKV('settings', state.settings); } catch (e) { toast('Could not save settings.', 4000, true); }
    renderBadges();
  }

  async function wipeData() {
    if (!window.confirm('Delete ALL cards and settings from this device? Download a backup first if you may need them. The dictionary is kept.')) return;
    await Store.clearAll();
    state.entries = [];
    state.settings = L.normalizeSettings({});
    state.lastBackup = null;
    state.session = null;
    renderBadges();
    renderSettings();
    toast('All notebook data deleted.');
  }

  /* ================================================================ wiring */

  function bindUI() {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });

    // lookup
    $('search-form').addEventListener('submit', function (e) { e.preventDefault(); var w = $('q').value; Reader.closeDrawer(); lookupWord(w, ''); $('q').blur(); });
    $('q').addEventListener('input', function () { clearTimeout(suggestTimer); suggestTimer = setTimeout(updateSuggestions, 60); });
    $('q').addEventListener('focus', function () { if ($('q').value.trim()) updateSuggestions(); });
    $('file-dict-empty').addEventListener('change', function () { chooseDictionaryFile(this); });

    // pronunciation buttons from the .mdd: play instead of picking the paragraph
    $('entry-view').addEventListener('click', function (e) {
      var snd = e.target.closest && e.target.closest('.dict-sound');
      if (!snd) return;
      e.preventDefault();
      e.stopPropagation();
      Media.play(snd.getAttribute('data-sound')).then(function (ok) { if (!ok) toast('This sound could not be played.'); });
    }, true);

    $('entry-view').addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('a.dict-link') : null;
      if (link) {
        e.preventDefault();
        var w = link.getAttribute('data-word');
        if (w) { $('q').value = w; lookupWord(w); }
        return;
      }
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;   // the user is selecting text
      var chunk = e.target.closest ? e.target.closest('.chunk') : null;
      if (chunk) pickChunk(parseInt(chunk.getAttribute('data-chunk'), 10));
    });
    document.addEventListener('selectionchange', function () { clearTimeout(selTimer); selTimer = setTimeout(onSelectionChange, 120); });

    $('actionbar').addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep a text selection alive
    $('ab-prev').addEventListener('click', function () { extendPick(-1); });
    $('ab-next').addEventListener('click', function () { extendPick(1); });
    $('ab-clear').addEventListener('click', clearPick);
    $('ab-add').addEventListener('click', function () {
      if (state.current) openCardDialog({ word: state.current.key, definition: pickedText() });
    });
    $('btn-add-word').addEventListener('click', function () {
      if (state.current) openCardDialog({ word: state.current.key, definition: pickedText() });
    });

    // card dialog
    $('card-form').addEventListener('submit', function (e) { e.preventDefault(); saveCard(); });
    $('cd-cancel').addEventListener('click', function () { $('card-dialog').close(); });
    $('cd-delete').addEventListener('click', deleteCard);
    $('cd-reset').addEventListener('click', resetCard);
    $('cd-paste').addEventListener('click', pasteContext);
    $('cd-word').addEventListener('input', updateDup);
    $('progress-dialog').addEventListener('cancel', function (e) { e.preventDefault(); });

    // notebook
    $('btn-backup').addEventListener('click', exportBackup);
    $('btn-anki').addEventListener('click', exportAnki);
    $('file-backup').addEventListener('change', function () { importBackup(this); });
    $('nb-filter').addEventListener('input', renderList);

    // review
    $('rv-start').addEventListener('click', startReview);
    $('rv-show').addEventListener('click', revealAnswer);
    $('rv-ok').addEventListener('click', function () { answerCard(true); });
    $('rv-forgot').addEventListener('click', function () { answerCard(false); });
    $('rv-quit').addEventListener('click', endSession);
    $('rv-back-home').addEventListener('click', endSession);
    document.addEventListener('keydown', function (e) {
      if (state.tab !== 'review' || !state.session || state.session.done) return;
      var t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'Enter') { if (!state.session.revealed) { e.preventDefault(); revealAnswer(); } }
      else if (e.key === '1') answerCard(false);
      else if (e.key === '2') answerCard(true);
    });

    // settings
    $('file-dict').addEventListener('change', function () { chooseDictionaryFile(this); });
    $('file-media').addEventListener('change', function () { var l = Array.prototype.slice.call(this.files || []); this.value = ''; addMediaFiles(l); });
    $('btn-clear-media').addEventListener('click', async function () { await clearMedia(); toast('Media files removed.'); refreshEntry(); });
    $('set-dict-style').addEventListener('change', function () {
      state.dictStyle = this.checked;
      Store.setKV('dictStyle', state.dictStyle).catch(function () { /* not fatal */ });
      Media.reset();
      refreshEntry();
    });
    $('btn-bundled').addEventListener('click', async function () {
      try { await installBundled(); toast('Bundled dictionary loaded.'); showTab('lookup'); }
      catch (e) { hideProgress(); toast('Could not load the bundled dictionary: ' + e.message, 6000, true); }
    });
    $('set-intervals').addEventListener('change', function () {
      var iv = L.parseIntervals(this.value);
      if (!iv) {
        toast('Use 1 to 10 whole numbers between 1 and 365, for example 1, 2, 4, 8, 16.', 5000, true);
        this.value = state.settings.intervals.join(', ');
        return;
      }
      this.value = iv.join(', ');
      saveSettings({ intervals: iv });
    });
    $('set-limit').addEventListener('change', function () { saveSettings({ sessionLimit: this.value }); });
    $('set-ctx-front').addEventListener('change', function () { saveSettings({ contextOnFront: this.checked }); });
    $('set-deck').addEventListener('change', function () { saveSettings({ ankiDeck: this.value }); this.value = state.settings.ankiDeck; });
    $('set-tag').addEventListener('change', function () { saveSettings({ ankiTag: this.value }); this.value = state.settings.ankiTag; });
    $('btn-wipe').addEventListener('click', wipeData);

    var deferredInstall = null;
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('btn-install').hidden = false; });
    $('btn-install').addEventListener('click', async function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
      deferredInstall = null;
      this.hidden = true;
    });
  }

  /* ================================================================ intro tutorial */

  var TOUR = [
    { title: 'Welcome', html:
      '<p>Look up words in your own MDict dictionary, keep the ones you want to learn, and review them with Leitner boxes.</p>' +
      '<p>Everything stays on this phone, and it works offline.</p>' },
    { title: 'Look up a word', html:
      '<p>Type in the search box, then tap a suggestion or press <b>Go</b>.</p>' +
      '<p>Word forms such as <i>ran</i> or <i>running</i> find their base word. Tap a linked word inside a definition to jump to it.</p>' +
      '<p>In any other app, select a word, tap <b>Share</b> and choose Dictionary Notebook (once the app is installed).</p>' },
    { title: 'Read anything', html:
      '<p>Tap <b>Open or paste text</b> to read an EPUB, DOCX, Markdown, HTML or plain text file, or text you pasted. Longer text shared from another app opens here too.</p>' +
      '<p>Swipe sideways or tap the page edges to turn pages. <b>Tap a word</b> to open its definition from the bottom; drag the handle to resize the panel, or press Hide.</p>' +
      '<p>Swipe down to show the search box. The sentence around the word is filled in as the context of the card you add.</p>' },
    { title: 'Pick what to remember', html:
      '<p>Tap a paragraph of the definition to highlight it. <b>+ ¶</b> adds the next paragraph, <b>− ¶</b> takes one back.</p>' +
      '<div class="tour-entry"><div class="picked">1. to move quickly on foot</div><div class="picked">2. to manage or operate a business</div><div>3. to flow, as water does</div></div>' +
      '<div class="tour-mock"><span class="grow">2 paragraphs selected</span><span class="b">− ¶</span><span class="b">+ ¶</span><span class="b p">Add</span></div>' +
      '<p>Prefer your own words? Long-press to select any text. Tap <b>Add</b>, then paste the sentence where you met the word as its context.</p>' },
    { title: 'Review with boxes', html:
      '<p>New cards start in box 1 and are due today. <b>Remembered</b> moves a card up a box, so it returns after a longer gap. <b>Forgot</b> sends it back to box 1.</p>' +
      '<div class="boxes"><div class="box"><b>1</b><span>1 day</span></div><div class="box"><b>2</b><span>2 days</span></div><div class="box"><b>3</b><span>4 days</span></div><div class="box"><b>4</b><span>8 days</span></div><div class="box"><b>5</b><span>16 days</span></div></div>' +
      '<p>The red number on <b>Review</b> shows how many cards are due. You can change the gaps in Settings.</p>' },
    { title: 'Keep your notebook safe', html:
      '<p>Your notebook is stored only in this browser. In <b>Notebook</b>, download a JSON backup now and then, or an Anki file to import into AnkiDroid.</p>' +
      '<p>In <b>Settings</b> you can switch to a dictionary file (.mdx) from your phone, and reopen this tutorial.</p>' +
      '<p class="tour-credit">Developed by Hosein Sheibah · <a href="https://sheibah.ir" target="_blank" rel="noopener">Sheibah.ir</a></p>' }
  ];
  var tourStep = 0;

  function renderTour() {
    var last = tourStep === TOUR.length - 1;
    $('tour-title').textContent = TOUR[tourStep].title;
    $('tour-body').innerHTML = TOUR[tourStep].html;   // static text defined above
    $('tour-dots').innerHTML = TOUR.map(function (_, i) { return '<i' + (i === tourStep ? ' class="on"' : '') + '></i>'; }).join('');
    $('tour-back').hidden = tourStep === 0;
    $('tour-skip').textContent = last ? 'Not now' : 'Skip';
    $('tour-next').textContent = last ? 'Try the demo' : 'Next';
  }

  function openTour() {
    tourStep = 0;
    renderTour();
    if (!$('tour-dialog').open) $('tour-dialog').showModal();
  }

  function bindTour() {
    $('tour-next').addEventListener('click', function () {
      if (tourStep < TOUR.length - 1) { tourStep++; renderTour(); } else { $('tour-dialog').close(); startDemo(); }
    });
    $('tour-back').addEventListener('click', function () { if (tourStep > 0) { tourStep--; renderTour(); } });
    $('tour-skip').addEventListener('click', function () { $('tour-dialog').close(); });
    // closing in any way (finish, skip, Esc) counts as seen
    $('tour-dialog').addEventListener('close', function () {
      Store.setKV('tourSeen', true).catch(function () { /* not fatal */ });
    });
    $('btn-tour').addEventListener('click', openTour);
  }

  /* ================================================================ reader: opening books and shared text */

  function syncReading() {
    document.body.classList.toggle('reading', !!state.doc && state.tab === 'lookup');
  }

  function setTopbarVar() {
    var tb = document.querySelector('.topbar');
    if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  }

  async function startReading(doc, pos) {
    state.doc = doc;
    state.context = '';
    try {
      await Store.setKV('doc', doc);
      await Store.setKV('docPos', pos || { s: 0, b: 0 });
    } catch (e) { toast('The book could not be saved for next time: ' + e.message, 5000, true); }
    showTab('lookup');
    Reader.load(doc, pos);
  }

  async function openDocFile(file) {
    if (!file) return;
    showProgress('Opening book', file.name, null);
    var doc = null, err = null;
    try { doc = await Docs.open(file); } catch (e) { err = e; }
    hideProgress();
    if (err) { toast(err.message || 'This file could not be opened.', 6000, true); return; }
    await startReading(doc);
  }

  function openOpenDialog() {
    Reader.closeDrawer();
    $('od-text').value = '';
    $('od-read').disabled = true;
    $('open-dialog').showModal();
  }

  async function readPasted() {
    var t = $('od-text').value;
    if (!t.trim()) return;
    $('open-dialog').close();
    try { await startReading(Docs.fromText(t, 'Pasted text')); } catch (e) { toast(e.message, 5000, true); }
  }

  async function pasteFromClipboard() {
    try {
      var t = await navigator.clipboard.readText();
      if (!t || !t.trim()) { toast('The clipboard is empty.'); return; }
      $('od-text').value = t;
      $('od-read').disabled = false;
    } catch (e) {
      toast('Clipboard access was blocked. Long-press in the box and choose Paste instead.', 5000, true);
    }
  }

  async function closeBook() {
    if (!state.doc) return;
    if (!window.confirm('Clear “' + state.doc.title + '” from the reader? Your reading position will be forgotten.')) return;
    Reader.close();
    if (coach.on) coachStop();
    state.doc = null;
    state.context = '';
    try { await Store.setKV('doc', null); await Store.setKV('docPos', null); } catch (e) { /* not fatal */ }
    syncReading();
  }

  // One to three shared words are looked up; anything longer opens as text in the reader.
  async function handleShared(text, title) {
    var t = String(text || '').trim();
    if (!t) return;
    var flat = t.replace(/\s+/g, ' ').replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
    if (flat.split(' ').length <= 3) {
      $('q').value = flat;
      await lookupWord(flat, '');
      return;
    }
    try {
      var name = title && title.trim() && title.trim() !== flat ? title.trim() : 'Shared text';
      await startReading(Docs.fromText(t, name));
    } catch (e) { toast(e.message, 5000, true); }
  }

  /* ================================================================ guided demo */

  var DEMO_MD = [
    '# A Walk in the Morning', '',
    '*A short demo text. Tap any word to look it up.*', '',
    'Maya woke early and walked down to the harbour. The air was cool, and a faint mist hung over the water. She had always found the quiet hour before sunrise strangely comforting.', '',
    '## The market', '',
    'By the time she reached the market, the stalls were opening one by one. A vendor was arranging oranges into a careful pyramid, and the smell of fresh bread drifted from the bakery on the corner. "You are up with the gulls," he said with a smile.', '',
    'She bought a warm loaf and a small bag of figs, then wandered on between crates of silver fish and baskets of herbs. Every stall had its own noise: scales clanking, knives tapping, a radio playing somewhere behind a curtain.', '',
    '## The lighthouse', '',
    'At the far end of the quay stood the old lighthouse, its paint peeling after countless storms. Maya climbed the narrow stairs slowly, counting each step. At the top the wind was fierce, but the view was worth every breath.', '',
    '> The sea was calm, and the horizon looked almost within reach.', '',
    'Below her, the first boats were leaving the harbour. She ate a fig, watched the light turn from grey to gold, and decided that mornings like this deserved to be remembered.', '',
    '## What she carried home', '',
    '- a warm loaf of bread', '- a bag of sweet figs', '- one quiet, unhurried hour', '',
    'On the way back she stopped to listen to the gulls, and thought how few words she would need to describe the morning, yet how many she would keep trying to find.', ''
  ].join('\n');

  var COACH = [
    { ev: 'word', text: 'Tap any word in the text to look it up.' },
    { ev: 'grip', text: 'The definition rises from the bottom. Drag the handle at its top to change its height, or press the arrow to hide it.', tag: 'grip' },
    { ev: 'dialog', text: 'Tap “Add to notebook”. The sentence you tapped is saved as the card’s context. You can Cancel if you don’t want this card.', tag: 'add' },
    { ev: 'drawer', text: 'Need another word? Swipe down, or tap the tab at the top, to show the search box and options.', tag: 'drawer', hideSheet: true },
    { ev: 'page', text: 'Swipe sideways, or tap the empty edges of the page, to turn it.', startPos: true },
    { ev: null, text: 'That’s it! Use Open in the search panel to read your own file or pasted text, and Clear to empty the reader.', last: true }
  ];
  var coach = { on: false, step: 0, pos: null, timer: 0 };

  function coachShow() {
    var st = COACH[coach.step];
    $('coach-text').textContent = st.text;
    $('coach-n').textContent = st.last ? 'Demo complete' : 'Demo · step ' + (coach.step + 1) + ' of ' + (COACH.length - 1);
    $('coach-next').textContent = st.last ? 'Done' : 'Skip step';
    $('coach-end').hidden = !!st.last;
    document.body.setAttribute('data-coach', st.tag || '');
    var c = $('coach');
    c.hidden = false;
    restart(c, 'coach-in');
    if (st.hideSheet) Reader.hideSheet();
    if (st.startPos) coach.pos = JSON.stringify(Reader.getPos());
  }
  function coachNext() {
    if (!coach.on) return;
    clearTimeout(coach.timer);
    if (COACH[coach.step].last) { coachStop(); return; }
    coach.step++;
    coachShow();
  }
  function coachStop() {
    coach.on = false;
    clearTimeout(coach.timer);
    $('coach').hidden = true;
    document.body.removeAttribute('data-coach');
    Store.setKV('demoSeen', true).catch(function () { /* not fatal */ });
  }
  function coachEvent(name, pos) {
    if (!coach.on || COACH[coach.step].ev !== name) return;
    if (name === 'page' && JSON.stringify(pos) === coach.pos) return;
    var at = coach.step;
    clearTimeout(coach.timer);
    coach.timer = setTimeout(function () { if (coach.on && coach.step === at) coachNext(); }, name === 'word' ? 900 : 450);
  }

  async function startDemo() {
    if (state.doc && !window.confirm('The demo replaces the book that is open now. Continue?')) return;
    var doc = null;
    try { doc = await Docs.open(new File([DEMO_MD], 'demo.md', { type: 'text/markdown' })); } catch (e) { toast(e.message, 5000, true); return; }
    await startReading(doc);
    coach.on = true;
    coach.step = 0;
    coachShow();
  }

  function bindReader() {
    Reader.init({
      onWord: function (word, sentence) { lookupWord(word, sentence); coachEvent('word'); },
      onDrawer: function () { coachEvent('drawer'); },
      onPosition: function (pos) { Store.setKV('docPos', pos).catch(function () { /* not fatal */ }); coachEvent('page', pos); },
      onPrefs: function (p) { Store.setKV('readerPrefs', p).catch(function () { /* not fatal */ }); }
    });
    $('btn-open-doc').addEventListener('click', openOpenDialog);
    $('rd-btn-open').addEventListener('click', openOpenDialog);
    $('od-file').addEventListener('click', function () { $('file-doc').click(); });
    $('od-text').addEventListener('input', function () { $('od-read').disabled = !this.value.trim(); });
    $('od-read').addEventListener('click', readPasted);
    $('od-paste').addEventListener('click', pasteFromClipboard);
    $('od-cancel').addEventListener('click', function () { $('open-dialog').close(); });
    $('file-doc').addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; if ($('open-dialog').open) $('open-dialog').close(); openDocFile(f); });
    $('rd-btn-close').addEventListener('click', function () { Reader.closeDrawer(); closeBook(); });
    $('btn-demo').addEventListener('click', startDemo);
    $('coach-next').addEventListener('click', function () { coachNext(); });
    $('coach-end').addEventListener('click', coachStop);
    $('sheet-grip').addEventListener('pointerup', function () { coachEvent('grip'); });
    $('card-dialog').addEventListener('close', function () { coachEvent('dialog'); });
    window.addEventListener('resize', setTopbarVar);
    setTopbarVar();
  }

  /* ================================================================ boot */

  async function boot() {
    bindUI();
    bindTour();
    bindReader();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* offline install is optional */ });
    var st = await Store.init();
    if (st.volatile) $('storage-warning').hidden = false;
    try {
      state.settings = L.normalizeSettings(await Store.getKV('settings'));
      state.lastBackup = (await Store.getKV('lastBackup')) || null;
      state.dictStyle = (await Store.getKV('dictStyle')) !== false;
      state.entries = await Store.getEntries();
    } catch (e) { toast('Could not read your saved notebook: ' + e.message, 7000, true); }
    renderBadges();
    Store.requestPersist();
    await loadDictionary();
    try {
      Reader.setPrefs(await Store.getKV('readerPrefs'));
      var saved = await Store.getKV('doc');
      if (saved && saved.sections && saved.sections.length) {
        state.doc = saved;
        syncReading();
        Reader.load(saved, await Store.getKV('docPos'));
      }
    } catch (e) { /* the saved book is optional */ }
    var params = new URLSearchParams(location.search);
    var q = params.get('q'), shared = params.get('text');
    if (q && state.dict) { $('q').value = q; lookupWord(q, ''); }
    else if (shared) await handleShared(shared, params.get('title'));
    if (q || shared) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
    var seen = false;
    try { seen = !!(await Store.getKV('tourSeen')); } catch (e) { /* show it */ }
    if (!seen) openTour();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
