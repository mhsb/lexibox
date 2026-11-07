/*!
 * leitner.js - pure logic for the notebook: scheduling, Anki export, JSON backup.
 * No DOM, no storage. Works in browsers and Node (so it can be unit-tested).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Leitner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BACKUP_FORMAT = 'leitner-dictionary-notebook';
  var BACKUP_VERSION = 1;

  var DEFAULT_SETTINGS = {
    intervals: [1, 2, 4, 8, 16],   // days between reviews for box 1..5
    sessionLimit: 30,              // max cards per review session (0 = unlimited)
    contextOnFront: false,         // show the context sentence on the front of review/Anki cards
    ankiDeck: 'Dictionary Notebook',
    ankiTag: 'dictionary-notebook'
  };

  /* ------------------------------------------------------------------ dates */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // Local calendar date as YYYY-MM-DD.
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    return todayStr(new Date(p[0], p[1] - 1, p[2] + n));
  }

  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /* ------------------------------------------------------------------ settings */

  // "1, 2, 4, 8, 16" -> [1,2,4,8,16]; returns null if invalid.
  function parseIntervals(text) {
    var parts = String(text || '').split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 10) return null;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d+$/.test(parts[i])) return null;
      var n = parseInt(parts[i], 10);
      if (n < 1 || n > 365) return null;
      out.push(n);
    }
    return out;
  }

  function normalizeSettings(s) {
    var out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    if (!Array.isArray(out.intervals) || !out.intervals.length ||
        !out.intervals.every(function (n) { return Number.isInteger(n) && n >= 1 && n <= 365; })) {
      out.intervals = DEFAULT_SETTINGS.intervals.slice();
    }
    out.sessionLimit = Math.max(0, Math.min(1000, parseInt(out.sessionLimit, 10) || 0));
    out.contextOnFront = !!out.contextOnFront;
    out.ankiDeck = String(out.ankiDeck || DEFAULT_SETTINGS.ankiDeck).trim() || DEFAULT_SETTINGS.ankiDeck;
    out.ankiTag = String(out.ankiTag == null ? DEFAULT_SETTINGS.ankiTag : out.ankiTag).trim();
    return out;
  }

  /* ------------------------------------------------------------------ entries */

  function newId() {
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function newEntry(fields, today, nowIso) {
    today = today || todayStr();
    nowIso = nowIso || new Date().toISOString();
    return {
      id: newId(),
      word: String(fields.word || '').trim(),
      definition: String(fields.definition || '').trim(),
      context: String(fields.context || '').trim(),
      source: String(fields.source || ''),
      created: nowIso, updated: nowIso,
      box: 1, due: today, learned: false,
      reps: 0, lapses: 0, lastReview: null, history: []
    };
  }

  // Coerce untrusted data (imported file) into a valid entry, or null.
  function normalizeEntry(raw, nBoxes, today) {
    if (!raw || typeof raw !== 'object') return null;
    var word = typeof raw.word === 'string' ? raw.word.trim() : '';
    if (!word || typeof raw.id !== 'string' || !raw.id) return null;
    var box = Number.isInteger(raw.box) ? Math.min(Math.max(raw.box, 1), nBoxes) : 1;
    var learned = !!raw.learned;
    var due = isDateStr(raw.due) ? raw.due : (learned ? null : (today || todayStr()));
    var nowIso = new Date().toISOString();
    return {
      id: raw.id, word: word,
      definition: typeof raw.definition === 'string' ? raw.definition : '',
      context: typeof raw.context === 'string' ? raw.context : '',
      source: typeof raw.source === 'string' ? raw.source : '',
      created: typeof raw.created === 'string' ? raw.created : nowIso,
      updated: typeof raw.updated === 'string' ? raw.updated : nowIso,
      box: box, due: due, learned: learned,
      reps: Math.max(0, parseInt(raw.reps, 10) || 0),
      lapses: Math.max(0, parseInt(raw.lapses, 10) || 0),
      lastReview: isDateStr(raw.lastReview) ? raw.lastReview : null,
      history: Array.isArray(raw.history) ? raw.history.filter(function (h) { return h && isDateStr(h.d); }) : []
    };
  }

  /* ------------------------------------------------------------------ scheduling */

  function isDue(entry, today) { return !entry.learned && !!entry.due && entry.due <= today; }

  // Ids of cards to review: most overdue first, shuffled within the same due date.
  function buildQueue(entries, today, limit, rand) {
    rand = rand || Math.random;
    var due = entries.filter(function (e) { return isDue(e, today); });
    var groups = {};
    due.forEach(function (e) { (groups[e.due] = groups[e.due] || []).push(e); });
    var out = [];
    Object.keys(groups).sort().forEach(function (day) {
      var g = groups[day];
      for (var i = g.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1)), t = g[i]; g[i] = g[j]; g[j] = t;
      }
      out = out.concat(g);
    });
    if (limit > 0) out = out.slice(0, limit);
    return out.map(function (e) { return e.id; });
  }

  // Returns an updated copy of the entry after the user answered.
  function answer(entry, ok, settings, today, nowIso) {
    var iv = settings.intervals, last = iv.length;
    var from = Math.min(Math.max(entry.box || 1, 1), last);
    var e = Object.assign({}, entry);
    e.reps = (entry.reps || 0) + 1;
    e.lastReview = today;
    e.updated = nowIso || new Date().toISOString();
    if (ok) {
      if (from >= last) { e.learned = true; e.due = null; e.box = last; }
      else { e.box = from + 1; e.due = addDays(today, iv[e.box - 1]); e.learned = false; }
    } else {
      e.box = 1; e.learned = false; e.lapses = (entry.lapses || 0) + 1; e.due = addDays(today, iv[0]);
    }
    e.history = (entry.history || []).concat([{ d: today, ok: !!ok, from: from, to: e.learned ? 'learned' : e.box }]);
    return e;
  }

  function resetProgress(entry, today, nowIso) {
    return Object.assign({}, entry, { box: 1, due: today, learned: false, updated: nowIso || new Date().toISOString() });
  }

  function stats(entries, today, nBoxes) {
    var boxes = [];
    for (var i = 0; i < nBoxes; i++) boxes.push(0);
    var s = { total: entries.length, due: 0, learned: 0, boxes: boxes, nextDue: null };
    entries.forEach(function (e) {
      if (e.learned) { s.learned++; return; }
      var b = Math.min(Math.max(e.box || 1, 1), nBoxes);
      s.boxes[b - 1]++;
      if (isDue(e, today)) s.due++;
      else if (e.due && (!s.nextDue || e.due < s.nextDue)) s.nextDue = e.due;
    });
    return s;
  }

  /* ------------------------------------------------------------------ text -> HTML (for Anki and review) */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nl2br(s) { return s.replace(/\r\n?|\n/g, '<br>'); }
  function textToHtml(s) { return nl2br(escapeHtml(s)); }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Context sentence as HTML with the headword in bold (exact whole-word match, case-insensitive).
  function contextHtml(context, word) {
    var text = String(context || ''), w = String(word || '').trim();
    if (!w) return textToHtml(text);
    var re = new RegExp('(^|[^\\p{L}\\p{N}])(' + escapeRegExp(w) + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
    var out = '', last = 0, m;
    while ((m = re.exec(text))) {
      var start = m.index + m[1].length;
      out += textToHtml(text.slice(last, start)) + '<b>' + escapeHtml(m[2]) + '</b>';
      last = start + m[2].length;
    }
    return out + textToHtml(text.slice(last));
  }

  /* ------------------------------------------------------------------ Anki export */

  function csvField(s) { return '"' + String(s).replace(/\t/g, ' ').replace(/"/g, '""') + '"'; }

  // Front / Back HTML for one card (used by the Anki export).
  function cardFaces(entry, settings) {
    var word = escapeHtml(entry.word);
    var def = textToHtml(entry.definition || '');
    var ctx = entry.context ? contextHtml(entry.context, entry.word) : '';
    if (settings.contextOnFront && ctx) {
      return { front: '<b>' + word + '</b><br><br><i>' + ctx + '</i>', back: def };
    }
    return { front: '<b>' + word + '</b>', back: def + (ctx ? (def ? '<br><br>' : '') + '<i>' + ctx + '</i>' : '') };
  }

  /**
   * Tab-separated text file for Anki / AnkiDroid ("Import" -> text file).
   * Columns: 1 GUID, 2 Front, 3 Back, 4 Tags. Every field is quoted, newlines are <br>.
   * The GUID makes re-importing update existing notes instead of creating duplicates.
   */
  function toAnkiTSV(entries, settings) {
    settings = normalizeSettings(settings);
    var deck = settings.ankiDeck.replace(/[\r\n\t]/g, ' ');
    var tag = settings.ankiTag.replace(/\s+/g, '-');
    var lines = [
      '#separator:tab', '#html:true', '#guid column:1', '#notetype:Basic',
      '#deck:' + deck, '#tags column:4'
    ];
    entries.forEach(function (e) {
      var f = cardFaces(e, settings);
      lines.push([csvField(e.id), csvField(f.front), csvField(f.back), csvField(tag)].join('\t'));
    });
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ JSON backup */

  function toBackup(entries, settings, dictionaryInfo, nowIso) {
    return {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: nowIso || new Date().toISOString(),
      dictionary: dictionaryInfo || null, settings: normalizeSettings(settings), entries: entries
    };
  }

  // Parses and validates a backup file. Throws Error with a readable message.
  function parseBackup(text, today) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('This file is not valid JSON.'); }
    if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.entries)) {
      throw new Error('This is not a notebook backup file from this app.');
    }
    if (data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app.');
    var settings = normalizeSettings(data.settings);
    var entries = [], skipped = 0;
    data.entries.forEach(function (raw) {
      var e = normalizeEntry(raw, settings.intervals.length, today);
      if (e) entries.push(e); else skipped++;
    });
    return { entries: entries, settings: settings, skipped: skipped };
  }

  // Merge imported entries into existing ones by id; the more recently updated copy wins.
  function mergeEntries(existing, incoming) {
    var byId = new Map();
    existing.forEach(function (e) { byId.set(e.id, e); });
    var added = 0, updated = 0, kept = 0;
    var toWrite = [];
    incoming.forEach(function (e) {
      var cur = byId.get(e.id);
      if (!cur) { byId.set(e.id, e); toWrite.push(e); added++; }
      else if ((e.updated || '') > (cur.updated || '')) { byId.set(e.id, e); toWrite.push(e); updated++; }
      else kept++;
    });
    return { entries: Array.from(byId.values()), toWrite: toWrite, added: added, updated: updated, kept: kept };
  }

  return {
    BACKUP_FORMAT: BACKUP_FORMAT, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    todayStr: todayStr, addDays: addDays, isDateStr: isDateStr,
    parseIntervals: parseIntervals, normalizeSettings: normalizeSettings,
    newEntry: newEntry, normalizeEntry: normalizeEntry,
    isDue: isDue, buildQueue: buildQueue, answer: answer, resetProgress: resetProgress, stats: stats,
    escapeHtml: escapeHtml, textToHtml: textToHtml, contextHtml: contextHtml, cardFaces: cardFaces,
    toAnkiTSV: toAnkiTSV, toBackup: toBackup, parseBackup: parseBackup, mergeEntries: mergeEntries
  };
});
