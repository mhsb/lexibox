/*!
 * media.js - resources from .mdd files: images, audio, fonts and CSS for dictionary entries.
 *
 *   Media.set([mddDictionary, ...]);     // MDict.open() results with meta.isMdd
 *   Media.has('img/a.png')               // synchronous: is this path in a loaded .mdd?
 *   await Media.url('img/a.png')         // blob: URL (cached), or null
 *   await Media.applyStyles([{ href: 'oald.css' }, { css: '.x{color:red}' }])
 *   await Media.resolveImages(node)      // fills <img data-res="path"> with blob URLs
 *   Media.play('snd/a.mp3')              // plays an audio file
 *
 * Dictionary CSS is never applied as is: every selector is moved under ".entry" and its class and id
 * names get the same "d-" prefix that render.js gives the elements, so it can only restyle entries.
 * Positioning (fixed / sticky), z-index, !important, @import from outside and http(s) URLs are dropped.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Media = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCOPE = '.entry';
  var dicts = [], full = null, base = null;
  var urlCache = new Map(), loaded = new Set(), styleEls = [], audio = null;

  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    css: 'text/css', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', spx: 'audio/ogg',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject'
  };

  /* ------------------------------------------------------------------ paths */

  function norm(ref) {
    var s = String(ref == null ? '' : ref);
    try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
    return s.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^(\.{0,2}\/)+/, '').toLowerCase();
  }
  function baseName(n) { return n.slice(n.lastIndexOf('/') + 1); }
  function mime(path) {
    var m = /\.([a-z0-9]+)$/i.exec(path);
    return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
  }

  function index() {
    if (full) return;
    full = new Map(); base = new Map();
    dicts.forEach(function (d, di) {
      for (var i = 0; i < d.keys.length; i++) {
        var n = norm(d.keys[i]);
        if (!full.has(n)) full.set(n, [di, i]);
        var b = baseName(n);
        if (b && !base.has(b)) base.set(b, [di, i]);
      }
    });
  }
  function find(ref) {
    index();
    var n = norm(ref);
    if (!n) return null;
    return full.get(n) || base.get(baseName(n)) || null;
  }

  function reset() {
    urlCache.forEach(function (p) { p.then(function (u) { if (u) URL.revokeObjectURL(u); }); });
    urlCache.clear();
    loaded.clear();
    styleEls.forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    styleEls = [];
    if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } audio = null; }
    full = base = null;
  }

  function set(list) {
    reset();
    dicts = (list || []).filter(function (d) { return d && d.meta && d.meta.isMdd; });
  }
  function count() { return dicts.length; }
  function has(ref) { return !!find(ref); }

  async function bytes(ref) {
    var f = find(ref);
    return f ? dicts[f[0]].readBytes(f[1]) : null;
  }

  function url(ref) {
    var f = find(ref);
    if (!f) return Promise.resolve(null);
    var key = f[0] + ':' + f[1];
    if (!urlCache.has(key)) {
      urlCache.set(key, dicts[f[0]].readBytes(f[1]).then(function (b) {
        return URL.createObjectURL(new Blob([b], { type: mime(norm(ref)) }));
      }).catch(function () { return null; }));
    }
    return urlCache.get(key);
  }

  async function text(ref) {
    var b = await bytes(ref);
    if (!b) return null;
    return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
  }

  /* ------------------------------------------------------------------ CSS scoping */

  // Splits at top-level commas (not inside (), [] or quotes).
  function splitTop(s) {
    var out = [], depth = 0, q = '', cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  }

  // .name -> .d-name and #name -> #d-name, leaving [attribute="a.b"] and quoted strings alone.
  function prefixNames(sel) {
    var out = '', i = 0, n = sel.length;
    while (i < n) {
      var c = sel[i];
      if (c === '[') { var e = sel.indexOf(']', i); if (e < 0) e = n - 1; out += sel.slice(i, e + 1); i = e + 1; continue; }
      if (c === '"' || c === "'") { var j = i + 1; while (j < n && sel[j] !== c) j += sel[j] === '\\' ? 2 : 1; out += sel.slice(i, j + 1); i = j + 1; continue; }
      if (c === '.' || c === '#') {
        var m = /^-?[_a-zA-Z -￿][\w -￿-]*/.exec(sel.slice(i + 1));
        if (m) { out += c + 'd-' + m[0]; i += 1 + m[0].length; continue; }
      }
      out += c; i++;
    }
    return out;
  }

  var ROOT_RE = /^(html|body|:root)(?![\w-])\s*/i;

  // One selector (no commas) -> { sel, root } where root means "styles the entry box itself".
  function scopeOne(part) {
    var rest = part.trim();
    if (!rest) return null;
    var had = false, m;
    while ((m = ROOT_RE.exec(rest))) { rest = rest.slice(m[0].length); had = true; }
    rest = prefixNames(rest);
    if (!rest) return { sel: SCOPE, root: had };
    return { sel: SCOPE + ' ' + rest, root: false };
  }

  function scopeSelector(sel) {
    var parts = splitTop(sel).map(scopeOne).filter(Boolean);
    return { sel: parts.map(function (p) { return p.sel; }).join(','), root: parts.length > 0 && parts.every(function (p) { return p.root; }) };
  }

  var ROOT_DROP = /^(color|background|background-.*|font-size|line-height|margin.*|padding.*|width|max-width|min-width|height|min-height|max-height|overflow.*)$/;

  function filterStyle(style, rootOnly) {
    var out = '';
    for (var i = 0; i < style.length; i++) {
      var n = style[i], v = style.getPropertyValue(n);
      if (n === 'z-index') continue;
      if (n === 'position' && /fixed|sticky/i.test(v)) continue;
      if (rootOnly && ROOT_DROP.test(n)) continue;
      if (/expression\s*\(|javascript:|behavior|-moz-binding/i.test(v)) continue;
      out += n + ':' + v + ';';
    }
    return out;
  }

  function serialize(rules) {
    var out = '';
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 1) {
        var sc = scopeSelector(r.selectorText);
        var body = filterStyle(r.style, sc.root);
        if (sc.sel && body) out += sc.sel + '{' + body + '}\n';
      } else if (r.type === 4) {
        out += '@media ' + r.media.mediaText + '{' + serialize(r.cssRules) + '}\n';
      } else if (r.type === 12) {
        out += '@supports ' + r.conditionText + '{' + serialize(r.cssRules) + '}\n';
      } else if (r.type === 5 || r.type === 7) {
        out += r.cssText + '\n';                 // @font-face, @keyframes
      }                                           // @import, @charset, @page ... dropped
    }
    return out;
  }

  function parseRules(cssText) {
    if (typeof CSSStyleSheet === 'function') {
      try { var sh = new CSSStyleSheet(); sh.replaceSync(cssText); return sh.cssRules; } catch (e) { /* fall back */ }
    }
    var doc = document.implementation.createHTMLDocument('');
    var st = doc.createElement('style');
    st.textContent = cssText;
    doc.head.appendChild(st);
    return st.sheet ? st.sheet.cssRules : [];
  }

  var URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

  // url(...) -> blob: URLs from the .mdd; data: URLs stay; everything else (http, unknown) is removed.
  async function rewriteUrls(cssText) {
    var refs = [], m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(cssText))) if (refs.indexOf(m[2]) < 0) refs.push(m[2]);
    var map = {};
    for (var i = 0; i < refs.length; i++) {
      var u = refs[i];
      if (/^data:/i.test(u)) map[u] = u;
      else if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u)) map[u] = null;
      else map[u] = await url(u);
    }
    URL_RE.lastIndex = 0;
    return cssText.replace(URL_RE, function (all, q, u) { return map[u] ? 'url("' + map[u] + '")' : 'none'; });
  }

  var IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi;

  async function loadCss(ref, depth) {
    var t = await text(ref);
    if (t == null) return '';
    if (depth >= 3) return t.replace(IMPORT_RE, '');
    var out = '', last = 0, m;
    IMPORT_RE.lastIndex = 0;
    var found = [];
    while ((m = IMPORT_RE.exec(t))) found.push({ at: m.index, len: m[0].length, ref: m[2] });
    for (var i = 0; i < found.length; i++) {
      out += t.slice(last, found[i].at) + (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(found[i].ref) ? '' : await loadCss(found[i].ref, depth + 1));
      last = found[i].at + found[i].len;
    }
    return out + t.slice(last);
  }

  async function scopeCss(cssText) {
    return serialize(parseRules(await rewriteUrls(cssText)));
  }

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  // styles: [{ href } | { css }] collected from entries; each distinct one is scoped and added once.
  async function applyStyles(styles) {
    for (var i = 0; i < (styles || []).length; i++) {
      var st = styles[i], key = st.href ? 'h:' + norm(st.href) : 'c:' + hash(st.css || '');
      if (loaded.has(key)) continue;
      loaded.add(key);
      try {
        var raw = st.href ? await loadCss(st.href, 0) : st.css;
        if (!raw) continue;
        var out = await scopeCss(raw);
        if (!out) continue;
        var el = document.createElement('style');
        el.setAttribute('data-dict-css', key);
        el.textContent = out;
        document.head.appendChild(el);
        styleEls.push(el);
      } catch (e) { /* a broken stylesheet must not break the entry */ }
    }
  }

  async function resolveImages(node) {
    var imgs = Array.prototype.slice.call(node.querySelectorAll('img[data-res]'));
    await Promise.all(imgs.map(async function (img) {
      var u = await url(img.getAttribute('data-res'));
      if (u) img.src = u; else if (img.parentNode) img.parentNode.removeChild(img);
    }));
  }

  async function play(ref) {
    var u = await url(ref);
    if (!u) return false;
    if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } }
    audio = new Audio(u);
    try { await audio.play(); return true; } catch (e) { return false; }
  }

  return {
    set: set, count: count, has: has, url: url, text: text, applyStyles: applyStyles, resolveImages: resolveImages,
    play: play, reset: reset,
    _internals: { norm: norm, mime: mime, scopeSelector: scopeSelector, prefixNames: prefixNames, splitTop: splitTop }
  };
});
