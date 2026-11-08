/*!
 * docs.js - turns a book or text file into a simple document model for the reader.
 *
 *   var doc = await Docs.open(file);          // File / Blob (EPUB, DOCX, Markdown, HTML, any text)
 *   var doc = Docs.fromText(text, 'Title');   // pasted or shared text
 *
 * doc = { id, title, author, format, total, sections: [ { title, sub, chars, blocks: [block] } ] }
 * block = { t: 'p' | 'h1'..'h6' | 'li' | 'q' | 'pre' | 'hr', h: safeInlineHtml, d?: listDepth }
 *
 * Inline HTML is limited to <b> <i> <u> <s> <sup> <sub> <code> <br>; all text is escaped, so the
 * reader can put it straight into the page. Images, styles and scripts are dropped on purpose.
 * Needs zip.js for EPUB and DOCX.
 */
(function (root) {
  'use strict';

  var MAX_CHARS = 50000;      // longest stretch of text rendered as one reading section
  var MIN_SECTION = 1500;     // do not start a new section at a heading before this much text
  var MAX_FILE = 40 * 1024 * 1024;

  /* ---------------------------------------------------------------- helpers */

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function textOf(h) {
    return String(h).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  // Collapses whitespace; \u0001 marks a forced line break.
  function tidy(h) {
    return String(h).replace(/[ \t\r\n\u00a0\u2028]+/g, ' ').replace(/ ?\u0001 ?/g, '<br>\n').replace(/^(?: |<br>\n)+|(?: |<br>\n)+$/g, '');
  }

  function parseXml(text, type) {
    return new DOMParser().parseFromString(text, type || 'application/xml');
  }

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  function looksBinary(bytes) {
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
    var n = Math.min(bytes.length, 8000);
    for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }

  function baseName(name) { return String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''); }

  /* ---------------------------------------------------------------- plain text */

  var CHAPTER_WORDS = /^(chapter|part|book|section|volume|act|scene|canto)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|last|final)\b.{0,50}$/i;
  var SINGLE_WORDS = /^(prologue|epilogue|preface|foreword|introduction|contents|appendix|afterword|acknowledg(?:e)?ments|dedication)\b.{0,30}$/i;

  function headingLevel(line) {
    if (line.length > 70) return 0;
    if (CHAPTER_WORDS.test(line) || SINGLE_WORDS.test(line)) return 2;
    var letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3 && line === line.toUpperCase() && line.length <= 50 && !/[.!?,;:]$/.test(line)) return 3;
    return 0;
  }

  function textToBlocks(text) {
    text = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    var blocks = [];
    text.split(/\n[ \t]*\n+/).forEach(function (para) {
      var lines = para.split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).filter(function (l) { return l.trim(); });
      if (!lines.length) return;
      if (lines.length === 1) {
        var one = lines[0].trim(), lvl = headingLevel(one);
        if (lvl) { blocks.push({ t: 'h' + lvl, h: esc(one) }); return; }
      }
      var longest = 0;
      lines.forEach(function (l) { if (l.length > longest) longest = l.length; });
      if (lines.length > 1 && longest < 50) {
        blocks.push({ t: 'p', h: lines.map(function (l) { return esc(l.trim()); }).join('<br>\n') });   // verse, lists, addresses
      } else {
        blocks.push({ t: 'p', h: esc(lines.map(function (l) { return l.trim(); }).join(' ').replace(/\s+/g, ' ')) });
      }
    });
    return blocks;
  }

  /* ---------------------------------------------------------------- markdown */

  function mdInline(src) {
    var s = esc(src), codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0002' + (codes.length - 1) + '\u0003'; });
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
         .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
         .replace(/&lt;(https?:[^&\s]*)&gt;/g, '$1')
         .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '<b>$2</b>')
         .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '$1<i>$2</i>')
         .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>')
         .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
         .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1');
    return s.replace(/\u0002(\d+)\u0003/g, function (_, n) { return '<code>' + codes[+n] + '</code>'; });
  }

  function mdToBlocks(src) {
    var lines = src.replace(/\r\n?/g, '\n').split('\n'), blocks = [], para = [], i, m;
    function flush() { if (para.length) { blocks.push({ t: 'p', h: mdInline(para.join(' ')) }); para = []; } }
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        flush();
        var fence = [];
        i++;
        while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) fence.push(lines[i++]);
        blocks.push({ t: 'pre', h: esc(fence.join('\n')) });
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      if (para.length && (m = /^\s{0,3}(=+|-+)\s*$/.exec(line))) {          // setext heading
        blocks.push({ t: m[1][0] === '=' ? 'h1' : 'h2', h: mdInline(para.join(' ')) });
        para = [];
        continue;
      }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); blocks.push({ t: 'h' + m[1].length, h: mdInline(m[2]) }); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr', h: '' }); continue; }
      if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
        flush();
        var q = [m[1]];
        while (i + 1 < lines.length && (m = /^\s{0,3}>\s?(.*)$/.exec(lines[i + 1]))) { q.push(m[1]); i++; }
        q.join('\n').split(/\n\s*\n/).forEach(function (p) { if (p.trim()) blocks.push({ t: 'q', h: mdInline(p.replace(/\n/g, ' ').trim()) }); });
        continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        flush();
        var mark = /\d/.test(m[2]) ? m[2].replace(/\)$/, '.') + ' ' : '• ';
        blocks.push({ t: 'li', d: Math.min(3, Math.floor(m[1].length / 2)), h: esc(mark) + mdInline(m[3]) });
        continue;
      }
      if (/^\s*\|/.test(line)) {
        flush();
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;                  // table separator row
        blocks.push({ t: 'p', h: line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return mdInline(c.trim()); }).filter(Boolean).join(' · ') });
        continue;
      }
      var last = blocks[blocks.length - 1];
      if (!para.length && last && last.t === 'li' && /^\s{2,}\S/.test(line)) { last.h += ' ' + mdInline(line.trim()); continue; }
      para.push(line.trim());
    }
    flush();
    return blocks;
  }

  /* ---------------------------------------------------------------- HTML / XHTML */

  var BLOCK = {};
  ('address article aside blockquote body caption center dd details div dl dt fieldset figcaption figure footer form ' +
   'h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul').split(' ').forEach(function (t) { BLOCK[t] = 1; });
  var BLOCK_SEL = Object.keys(BLOCK).join(',');
  var SKIP = {};
  ('script style head title svg math audio video canvas object embed iframe noscript template img select button input textarea map').split(' ').forEach(function (t) { SKIP[t] = 1; });
  var INLINE_MAP = { b: 'b', strong: 'b', i: 'i', em: 'i', cite: 'i', dfn: 'i', var: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's',
                     sup: 'sup', sub: 'sub', code: 'code', tt: 'code', kbd: 'code', samp: 'code' };

  function inlineHtml(el) {
    var out = '';
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { out += esc(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (SKIP[tag]) continue;
      if (tag === 'br') { out += '\u0001'; continue; }
      var inner = inlineHtml(c), wrap = INLINE_MAP[tag];
      if (wrap) { out += '<' + wrap + '>' + inner + '</' + wrap + '>'; continue; }
      var st = c.getAttribute('style') || '';
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) inner = '<b>' + inner + '</b>';
      if (/font-style\s*:\s*italic/i.test(st)) inner = '<i>' + inner + '</i>';
      out += inner;
    }
    return out;
  }

  function domToBlocks(rootEl) {
    var blocks = [], inl = [], quote = 0, looseT = null, lists = [];
    function defaultT() { return looseT || (quote ? 'q' : 'p'); }
    function emit(t, h, d) {
      h = tidy(h);
      if (!textOf(h).trim()) return;
      var b = { t: t, h: h };
      if (d) b.d = d;
      blocks.push(b);
    }
    function flushLoose() {
      if (!inl.length) return;
      emit(defaultT(), inl.join(''), looseT === 'li' ? Math.min(3, lists.length - 1) : 0);
      inl = [];
    }
    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { inl.push(esc(c.nodeValue)); continue; }
        if (c.nodeType !== 1) continue;
        var tag = c.tagName.toLowerCase();
        if (SKIP[tag]) continue;
        if (tag === 'br') { inl.push('\u0001'); continue; }
        if (tag === 'hr') { flushLoose(); blocks.push({ t: 'hr', h: '' }); continue; }
        if (!BLOCK[tag]) {
          if (c.querySelector(BLOCK_SEL)) walk(c); else inl.push(inlineHtml(c));
          continue;
        }
        flushLoose();
        if (/^h[1-6]$/.test(tag)) { emit(tag, inlineHtml(c)); continue; }
        if (tag === 'pre') { var txt = c.textContent.replace(/\s+$/, ''); if (txt.trim()) blocks.push({ t: 'pre', h: esc(txt) }); continue; }
        if (tag === 'tr') {
          var cells = [];
          for (var td = c.firstChild; td; td = td.nextSibling) if (td.nodeType === 1 && /^t[dh]$/i.test(td.tagName)) cells.push(tidy(inlineHtml(td)));
          emit(defaultT(), cells.filter(Boolean).join(' · '));
          continue;
        }
        if (tag === 'ul' || tag === 'ol') { lists.push({ ordered: tag === 'ol', n: 0 }); walk(c); flushLoose(); lists.pop(); continue; }
        if (tag === 'li') {
          var L = lists[lists.length - 1] || { ordered: false, n: 0 };
          L.n++;
          var prevT = looseT;
          looseT = 'li';
          inl.push(esc(L.ordered ? L.n + '. ' : '• '));
          walk(c);
          flushLoose();
          looseT = prevT;
          continue;
        }
        if (tag === 'blockquote') { quote++; walk(c); flushLoose(); quote--; continue; }
        if (c.querySelector(BLOCK_SEL)) { walk(c); flushLoose(); }
        else emit(defaultT(), inlineHtml(c), looseT === 'li' ? Math.min(3, lists.length - 1) : 0);
      }
    }
    walk(rootEl);
    flushLoose();
    return blocks;
  }

  function htmlToBlocks(htmlText) {
    var doc = parseXml(htmlText, 'text/html');
    return { blocks: domToBlocks(doc.body || doc.documentElement), title: (doc.title || '').trim() };
  }

  /* ---------------------------------------------------------------- EPUB */

  function resolvePath(base, href) {
    href = href.replace(/#.*$/, '');
    try { href = decodeURIComponent(href); } catch (e) { /* keep as is */ }
    var parts = (base + href).split('/'), out = [];
    parts.forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }

  function firstNS(el, name) { return el.getElementsByTagNameNS('*', name)[0] || null; }

  async function parseEpub(zip) {
    var container = parseXml(await zip.text('META-INF/container.xml'));
    var rf = firstNS(container, 'rootfile');
    if (!rf) throw new Error('This EPUB has no package file.');
    var opfPath = rf.getAttribute('full-path'), base = opfPath.indexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    var opf = parseXml(await zip.text(opfPath));
    var manifest = {};
    Array.prototype.forEach.call(opf.getElementsByTagNameNS('*', 'item'), function (it) {
      manifest[it.getAttribute('id')] = { href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
    });
    var spineEl = firstNS(opf, 'spine'), spine = [];
    if (spineEl) Array.prototype.forEach.call(spineEl.getElementsByTagNameNS('*', 'itemref'), function (r) {
      var it = manifest[r.getAttribute('idref')];
      if (it && /html|xml/.test(it.type) && r.getAttribute('linear') !== 'no') spine.push(resolvePath(base, it.href));
    });
    if (!spine.length) throw new Error('This EPUB has no readable chapters.');

    // Chapter titles from the table of contents (EPUB 3 nav document or EPUB 2 NCX).
    var labels = {};
    function addLabel(href, label) {
      var p = resolvePath(base, href);
      label = (label || '').replace(/\s+/g, ' ').trim();
      if (label && !(p in labels)) labels[p] = label;
    }
    try {
      var navItem = Object.keys(manifest).map(function (k) { return manifest[k]; }).filter(function (m) { return /\bnav\b/.test(m.props); })[0];
      var ncxItem = Object.keys(manifest).map(function (k) { return manifest[k]; }).filter(function (m) { return /ncx/.test(m.type); })[0];
      if (navItem) {
        var navBase = resolvePath(base, navItem.href).replace(/[^/]*$/, '');
        var nav = parseXml(await zip.text(resolvePath(base, navItem.href)), 'text/html');
        Array.prototype.forEach.call(nav.querySelectorAll('nav a[href]'), function (a) { addLabel(navBase.slice(base.length) + a.getAttribute('href'), a.textContent); });
      } else if (ncxItem) {
        var ncxBase = resolvePath(base, ncxItem.href).replace(/[^/]*$/, '');
        var ncx = parseXml(await zip.text(resolvePath(base, ncxItem.href)));
        Array.prototype.forEach.call(ncx.getElementsByTagNameNS('*', 'navPoint'), function (np) {
          var content = firstNS(np, 'content'), text = firstNS(np, 'text');
          if (content && text) addLabel(ncxBase.slice(base.length) + content.getAttribute('src'), text.textContent);
        });
      }
    } catch (e) { /* titles are optional */ }

    var sections = [];
    for (var i = 0; i < spine.length; i++) {
      if (!zip.has(spine[i])) continue;
      var html = decodeText(await zip.read(spine[i]));
      var blocks = htmlToBlocks(html).blocks;
      if (!blocks.length) continue;
      sections.push({ title: labels[spine[i]] || '', blocks: blocks });
    }
    if (!sections.length) throw new Error('This EPUB has no readable text.');
    var title = firstNS(opf, 'title'), creator = firstNS(opf, 'creator');
    return { title: title ? title.textContent.trim() : '', author: creator ? creator.textContent.trim() : '', sections: sections };
  }

  /* ---------------------------------------------------------------- DOCX */

  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  function wKids(el, name) { return Array.prototype.filter.call(el.children, function (c) { return c.localName === name; }); }
  function wFirst(el, name) { return wKids(el, name)[0] || null; }
  function wAttr(el, name) { return el ? (el.getAttributeNS(W_NS, name) || el.getAttribute('w:' + name)) : null; }
  function wOn(el) { if (!el) return false; var v = wAttr(el, 'val'); return v !== '0' && v !== 'false' && v !== 'none'; }

  async function parseDocx(zip) {
    var doc = parseXml(await zip.text('word/document.xml'));
    var body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
    if (!body) throw new Error('This Word file has no text.');

    // heading levels by style id (follows "based on" chains)
    var styleInfo = {};
    if (zip.has('word/styles.xml')) {
      var styles = parseXml(await zip.text('word/styles.xml'));
      Array.prototype.forEach.call(styles.getElementsByTagNameNS(W_NS, 'style'), function (st) {
        var id = wAttr(st, 'styleId'), nameEl = wFirst(st, 'name'), name = nameEl ? (wAttr(nameEl, 'val') || '') : '';
        var lvl = 0, m = /^heading\s*(\d)/i.exec(name);
        if (m) lvl = +m[1]; else if (/^title$/i.test(name)) lvl = 1; else if (/^subtitle$/i.test(name)) lvl = 2;
        var ppr = wFirst(st, 'pPr'), ol = ppr ? wFirst(ppr, 'outlineLvl') : null;
        if (!lvl && ol) lvl = (+wAttr(ol, 'val') || 0) + 1;
        var based = wFirst(st, 'basedOn');
        styleInfo[id] = { lvl: lvl, name: name, based: based ? wAttr(based, 'val') : null };
      });
    }
    function styleLevel(id, depth) {
      var s = styleInfo[id];
      if (!s || (depth || 0) > 6) return { lvl: 0, list: false };
      if (s.lvl) return { lvl: Math.min(6, s.lvl), list: false };
      if (/^list/i.test(s.name)) return { lvl: 0, list: true };
      return s.based ? styleLevel(s.based, (depth || 0) + 1) : { lvl: 0, list: false };
    }

    function runHtml(r) {
      var rpr = wFirst(r, 'rPr'), text = '';
      for (var c = r.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var n = c.localName;
        if (n === 't') text += esc(c.textContent);
        else if (n === 'tab') text += ' ';
        else if (n === 'br') { if (wAttr(c, 'type') !== 'page') text += '\u0001'; }
        else if (n === 'noBreakHyphen') text += '-';
      }
      if (!text) return '';
      if (rpr) {
        var va = wFirst(rpr, 'vertAlign'), vv = va ? wAttr(va, 'val') : '';
        if (vv === 'superscript') text = '<sup>' + text + '</sup>';
        else if (vv === 'subscript') text = '<sub>' + text + '</sub>';
        if (wOn(wFirst(rpr, 'strike'))) text = '<s>' + text + '</s>';
        if (wOn(wFirst(rpr, 'u'))) text = '<u>' + text + '</u>';
        if (wOn(wFirst(rpr, 'i'))) text = '<i>' + text + '</i>';
        if (wOn(wFirst(rpr, 'b'))) text = '<b>' + text + '</b>';
      }
      return text;
    }
    function inlineOf(node) {
      var out = '';
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (c.localName === 'r') out += runHtml(c);
        else if (c.localName !== 'pPr' && c.localName !== 'del' && c.localName !== 'bookmarkStart' && c.localName !== 'proofErr') out += inlineOf(c);
      }
      return out;
    }

    var blocks = [];
    function para(p) {
      var h = tidy(inlineOf(p));
      if (!textOf(h).trim()) return;
      var ppr = wFirst(p, 'pPr'), lvl = 0, list = false;
      if (ppr) {
        var ps = wFirst(ppr, 'pStyle');
        if (ps) { var si = styleLevel(wAttr(ps, 'val')); lvl = si.lvl; list = si.list; }
        var ol = wFirst(ppr, 'outlineLvl');
        if (!lvl && ol) lvl = Math.min(6, (+wAttr(ol, 'val') || 0) + 1);
        var np = wFirst(ppr, 'numPr'), nid = np ? wFirst(np, 'numId') : null;
        if (np && !(nid && wAttr(nid, 'val') === '0')) list = true;
      }
      if (lvl && h.length < 300) blocks.push({ t: 'h' + lvl, h: h.replace(/<\/?b>/g, '') });
      else if (list) blocks.push({ t: 'li', h: '• ' + h });
      else blocks.push({ t: 'p', h: h });
    }
    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var n = c.localName;
        if (n === 'p') para(c);
        else if (n === 'tbl') {
          wKids(c, 'tr').forEach(function (tr) {
            var cells = wKids(tr, 'tc').map(function (tc) { return tidy(wKids(tc, 'p').map(function (p) { return inlineOf(p); }).join(' ')); }).filter(function (x) { return textOf(x).trim(); });
            if (cells.length) blocks.push({ t: 'p', h: cells.join(' · ') });
          });
        } else if (n === 'sdt' || n === 'sdtContent') walk(c);
      }
    }
    walk(body);
    if (!blocks.length) throw new Error('This Word file has no text.');

    var title = '';
    if (zip.has('docProps/core.xml')) {
      try { var core = parseXml(await zip.text('docProps/core.xml')); var t = firstNS(core, 'title'); title = t ? t.textContent.trim() : ''; } catch (e) { /* optional */ }
    }
    return { title: title, sections: [{ title: '', blocks: blocks }] };
  }

  /* ---------------------------------------------------------------- sections */

  function headingLvl(b) { var m = /^h([1-6])$/.exec(b.t); return m ? +m[1] : 9; }
  function blockChars(b) { return textOf(b.h).length + 1; }
  function firstHeading(blocks) {
    for (var i = 0; i < blocks.length && i < 6; i++) if (headingLvl(blocks[i]) < 9) return textOf(blocks[i].h).replace(/\s+/g, ' ').trim();
    return '';
  }

  // Splits a long run of blocks into reading sections: at top-level headings (once a section has some
  // text) and never letting one grow past MAX_CHARS.
  function splitBlocks(blocks) {
    var minLvl = 9;
    blocks.forEach(function (b) { var l = headingLvl(b); if (l <= 2 && l < minLvl) minLvl = l; });
    var secs = [], cur = { title: '', blocks: [], chars: 0 };
    function push() { if (cur.blocks.length) secs.push(cur); cur = { title: '', blocks: [], chars: 0 }; }
    blocks.forEach(function (b) {
      var l = headingLvl(b);
      if (cur.chars >= MIN_SECTION && l <= minLvl && l <= 2) push();
      else if (cur.chars >= MAX_CHARS && (l <= 3 || cur.chars >= MAX_CHARS * 1.3)) push();
      cur.blocks.push(b);
      cur.chars += blockChars(b);
    });
    push();
    return secs;
  }

  function finalize(raw, fallbackTitle, format) {
    var sections = [];
    function add(parts, givenTitle) {
      parts.forEach(function (p, i) {
        var heading = firstHeading(p.blocks);
        p.title = (i === 0 && givenTitle) || heading || '';
        p.sub = i > 0 && !heading;           // a continuation of the previous section: kept out of the contents
        sections.push(p);
      });
    }
    if (raw.sections) raw.sections.forEach(function (s) { add(splitBlocks(s.blocks), s.title); });
    else add(splitBlocks(raw.blocks), '');
    sections.forEach(function (s, i) {
      if (!s.title && sections.length > 1) s.title = 'Part ' + (i + 1);
      s.chars = s.blocks.reduce(function (a, b) { return a + blockChars(b); }, 0);
    });
    var total = sections.reduce(function (a, s) { return a + s.chars; }, 0);
    var title = (raw.title || '').trim() || (fallbackTitle || '').trim() || 'Untitled';
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.slice(0, 120), author: (raw.author || '').slice(0, 120), format: format,
      total: Math.max(1, total), sections: sections, added: new Date().toISOString()
    };
  }

  /* ---------------------------------------------------------------- entry points */

  async function open(file) {
    if (file.size > MAX_FILE) throw new Error('This file is too large to open (limit 40 MB).');
    var name = file.name || '', ext = (name.split('.').pop() || '').toLowerCase();
    var head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) {
      var zip = await Zip.open(file);
      if (zip.has('META-INF/container.xml')) return finalize(await parseEpub(zip), baseName(name), 'epub');
      if (zip.has('word/document.xml')) return finalize(await parseDocx(zip), baseName(name), 'docx');
      throw new Error('This ZIP file is not an EPUB or a Word document.');
    }
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytes)) throw new Error('This file does not look like text. Supported: EPUB, DOCX, Markdown, HTML and plain text.');
    var text = decodeText(bytes);
    if (/^(md|markdown|mdown|mkd)$/.test(ext)) {
      var mb = mdToBlocks(text), h1 = mb.filter(function (b) { return b.t === 'h1'; })[0];
      return finalize({ blocks: mb, title: h1 ? textOf(h1.h) : '' }, baseName(name), 'markdown');
    }
    if (/^(html?|xhtml)$/.test(ext) || /^\s*(<\?xml|<!doctype html|<html)/i.test(text.slice(0, 300))) {
      var hb = htmlToBlocks(text);
      if (!hb.blocks.length) throw new Error('This file has no readable text.');
      return finalize({ blocks: hb.blocks, title: hb.title }, baseName(name), 'html');
    }
    var tb = textToBlocks(text);
    if (!tb.length) throw new Error('This file is empty.');
    return finalize({ blocks: tb }, baseName(name), 'text');
  }

  function fromText(text, title) {
    var tb = textToBlocks(String(text || ''));
    if (!tb.length) throw new Error('There is no text to open.');
    return finalize({ blocks: tb }, title || 'Shared text', 'text');
  }

  root.Docs = {
    open: open, fromText: fromText, textOf: textOf,
    _internals: { textToBlocks: textToBlocks, mdToBlocks: mdToBlocks, htmlToBlocks: htmlToBlocks, finalize: finalize }
  };
})(typeof window !== 'undefined' ? window : globalThis);
