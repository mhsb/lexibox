'use strict';
const assert = require('assert');
const L = require('../js/leitner.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

// Minimal parser for what Anki's text importer reads: '#' header lines, then tab-separated, double-quoted fields.
function parseAnkiFile(text) {
  const headers = {}, rows = [];
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length && lines[i].startsWith('#'); i++) {
    const m = /^#([^:]+):(.*)$/.exec(lines[i]);
    headers[m[1]] = m[2];
  }
  const body = lines.slice(i).join('\n');
  let pos = 0;
  while (pos < body.length) {
    const row = [];
    for (;;) {
      let field = '';
      if (body[pos] === '"') {
        pos++;
        for (;;) {
          if (body[pos] === '"' && body[pos + 1] === '"') { field += '"'; pos += 2; }
          else if (body[pos] === '"') { pos++; break; }
          else field += body[pos++];
        }
      } else { while (pos < body.length && body[pos] !== '\t' && body[pos] !== '\n') field += body[pos++]; }
      row.push(field);
      if (body[pos] === '\t') { pos++; continue; }
      if (body[pos] === '\n') pos++;
      break;
    }
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return { headers, rows };
}

console.log('Dates and settings');
test('addDays crosses month, year and leap-day boundaries', () => {
  assert.strictEqual(L.addDays('2026-11-06', 1), '2026-11-07');
  assert.strictEqual(L.addDays('2026-11-30', 1), '2026-12-01');
  assert.strictEqual(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(L.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(L.addDays('2026-11-06', 16), '2026-11-22');
});
test('todayStr uses the local calendar date', () => {
  assert.strictEqual(L.todayStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.strictEqual(L.todayStr(new Date(2026, 0, 5, 0, 1)), '2026-01-05');
});
test('parseIntervals accepts sane input and rejects the rest', () => {
  assert.deepStrictEqual(L.parseIntervals('1, 2, 4, 8, 16'), [1, 2, 4, 8, 16]);
  assert.deepStrictEqual(L.parseIntervals('1 3 7'), [1, 3, 7]);
  assert.strictEqual(L.parseIntervals(''), null);
  assert.strictEqual(L.parseIntervals('1,0,3'), null);
  assert.strictEqual(L.parseIntervals('1,x'), null);
  assert.strictEqual(L.parseIntervals('1,2,3,4,5,6,7,8,9,10,11'), null);
  assert.strictEqual(L.parseIntervals('1,400'), null);
});
test('normalizeSettings repairs bad values', () => {
  const s = L.normalizeSettings({ intervals: [0, 'a'], sessionLimit: 'abc', ankiDeck: '  ', contextOnFront: 1 });
  assert.deepStrictEqual(s.intervals, [1, 2, 4, 8, 16]);
  assert.strictEqual(s.sessionLimit, 0);
  assert.strictEqual(s.ankiDeck, 'Dictionary Notebook');
  assert.strictEqual(s.contextOnFront, true);
});

console.log('Leitner scheduling');
const S = L.normalizeSettings({});
const T0 = '2026-11-06';
test('new entry starts in box 1 and is due today', () => {
  const e = L.newEntry({ word: ' ephemeral ', definition: 'short-lived', context: '' }, T0);
  assert.strictEqual(e.word, 'ephemeral');
  assert.strictEqual(e.box, 1); assert.strictEqual(e.due, T0); assert(L.isDue(e, T0));
  assert(!L.isDue(e, '2026-11-05'));
});
test('correct answers climb the boxes with growing intervals, then graduate', () => {
  let e = L.newEntry({ word: 'w', definition: 'd' }, T0), day = T0;
  const expectedDue = ['2026-11-08', '2026-11-12', '2026-11-20', '2026-12-06'];   // +2, +4, +8, +16
  for (let k = 0; k < 4; k++) {
    e = L.answer(e, true, S, day);
    assert.strictEqual(e.box, k + 2); assert.strictEqual(e.due, expectedDue[k]); assert(!e.learned);
    day = e.due;
  }
  e = L.answer(e, true, S, day);
  assert(e.learned); assert.strictEqual(e.due, null); assert(!L.isDue(e, '2099-01-01'));
  assert.strictEqual(e.reps, 5); assert.strictEqual(e.history.length, 5);
  assert.strictEqual(e.history[4].to, 'learned');
});
test('a wrong answer sends the card back to box 1 for tomorrow and counts a lapse', () => {
  let e = L.newEntry({ word: 'w', definition: 'd' }, T0);
  e = L.answer(e, true, S, T0); e = L.answer(e, true, S, e.due);
  assert.strictEqual(e.box, 3);
  e = L.answer(e, false, S, '2026-11-12');
  assert.strictEqual(e.box, 1); assert.strictEqual(e.lapses, 1); assert.strictEqual(e.due, '2026-11-13');
});
test('answer() does not mutate its input', () => {
  const e = L.newEntry({ word: 'w', definition: 'd' }, T0);
  const snap = JSON.stringify(e);
  L.answer(e, true, S, T0);
  assert.strictEqual(JSON.stringify(e), snap);
});
test('custom interval list changes the number of boxes', () => {
  const s = L.normalizeSettings({ intervals: [1, 3] });
  let e = L.newEntry({ word: 'w', definition: 'd' }, T0);
  e = L.answer(e, true, s, T0); assert.strictEqual(e.box, 2); assert.strictEqual(e.due, '2026-11-09');
  e = L.answer(e, true, s, e.due); assert(e.learned);
});
test('shortening the interval list does not break cards sitting in a removed box', () => {
  const e = Object.assign(L.newEntry({ word: 'w', definition: 'd' }, T0), { box: 5 });
  const out = L.answer(e, true, L.normalizeSettings({ intervals: [1, 2] }), T0);
  assert(out.learned);
});
test('resetProgress puts a learned card back in box 1, due today', () => {
  let e = L.newEntry({ word: 'w', definition: 'd' }, T0);
  e = Object.assign(e, { learned: true, due: null, box: 5 });
  const r = L.resetProgress(e, '2027-01-01');
  assert(!r.learned); assert.strictEqual(r.box, 1); assert.strictEqual(r.due, '2027-01-01');
});
test('buildQueue: only due cards, most overdue first, respects the limit', () => {
  const mk = (word, due, extra) => Object.assign(L.newEntry({ word, definition: 'd' }, T0), { due }, extra);
  const entries = [mk('a', '2026-11-06'), mk('b', '2026-11-01'), mk('c', '2026-11-07'), mk('d', '2026-11-05'),
    mk('e', null, { learned: true })];
  const q = L.buildQueue(entries, '2026-11-06', 0).map((id) => entries.find((x) => x.id === id).word);
  assert.deepStrictEqual(q, ['b', 'd', 'a']);
  assert.strictEqual(L.buildQueue(entries, '2026-11-06', 2).length, 2);
  assert.strictEqual(L.buildQueue([], T0, 5).length, 0);
});
test('buildQueue shuffles within a day but keeps every card exactly once', () => {
  const entries = Array.from({ length: 50 }, (_, i) => L.newEntry({ word: 'w' + i, definition: 'd' }, T0));
  const q = L.buildQueue(entries, T0, 0);
  assert.strictEqual(new Set(q).size, 50);
  assert.notDeepStrictEqual(q, entries.map((e) => e.id));
});
test('stats counts boxes, due, learned and next due date', () => {
  const mk = (box, due, learned) => Object.assign(L.newEntry({ word: 'w', definition: 'd' }, T0), { box, due, learned: !!learned });
  const s = L.stats([mk(1, T0), mk(1, '2026-11-09'), mk(3, '2026-11-20'), mk(5, null, true)], T0, 5);
  assert.deepStrictEqual(s.boxes, [2, 0, 1, 0, 0]);
  assert.strictEqual(s.due, 1); assert.strictEqual(s.learned, 1); assert.strictEqual(s.total, 4);
  assert.strictEqual(s.nextDue, '2026-11-09');
});

console.log('Anki export');
test('header lines are exactly what Anki documents', () => {
  const t = L.toAnkiTSV([], L.DEFAULT_SETTINGS);
  const lines = t.split('\n');
  assert.deepStrictEqual(lines.slice(0, 6), ['#separator:tab', '#html:true', '#guid column:1', '#notetype:Basic',
    '#deck:Dictionary Notebook', '#tags column:4']);
});
test('rows round-trip through a quoted-TSV parser (quotes, tabs, newlines, HTML, unicode)', () => {
  const e1 = Object.assign(L.newEntry({ word: 'café', definition: 'a "small" shop\nwith <b>tags</b> & more\tand a tab', context: 'We met at the café, near the cafés.' }, T0), { id: 'id-1' });
  const e2 = Object.assign(L.newEntry({ word: 'run', definition: 'to move fast', context: '' }, T0), { id: 'id-2' });
  const out = parseAnkiFile(L.toAnkiTSV([e1, e2], Object.assign({}, L.DEFAULT_SETTINGS, { ankiDeck: 'My Deck', ankiTag: 'my tag' })));
  assert.strictEqual(out.headers.deck, 'My Deck');
  assert.strictEqual(out.rows.length, 2);
  assert.strictEqual(out.rows[0][0], 'id-1');
  assert.strictEqual(out.rows[0][1], '<b>café</b>');
  assert.strictEqual(out.rows[0][2],
    'a &quot;small&quot; shop<br>with &lt;b&gt;tags&lt;/b&gt; &amp; more and a tab<br><br><i>We met at the <b>café</b>, near the cafés.</i>');
  assert.strictEqual(out.rows[0][3], 'my-tag');
  assert.deepStrictEqual(out.rows[1], ['id-2', '<b>run</b>', 'to move fast', 'my-tag']);
  assert(out.rows.every((r) => r.length === 4));
});
test('contextOnFront moves the sentence to the front', () => {
  const e = Object.assign(L.newEntry({ word: 'keen', definition: 'eager', context: 'She is keen to learn.' }, T0), { id: 'x' });
  const row = parseAnkiFile(L.toAnkiTSV([e], Object.assign({}, L.DEFAULT_SETTINGS, { contextOnFront: true }))).rows[0];
  assert.strictEqual(row[1], '<b>keen</b><br><br><i>She is <b>keen</b> to learn.</i>');
  assert.strictEqual(row[2], 'eager');
});
test('headword highlighting is whole-word only and survives regex characters', () => {
  assert.strictEqual(L.contextHtml('Catalog the cat. Cats purr.', 'cat'), 'Catalog the <b>cat</b>. Cats purr.');
  assert.strictEqual(L.contextHtml('a.b and axb', 'a.b'), '<b>a.b</b> and axb');
  assert.strictEqual(L.contextHtml('go go go', 'go'), '<b>go</b> <b>go</b> <b>go</b>');
  assert.strictEqual(L.contextHtml('x < y', ''), 'x &lt; y');
});
test('file ends with a newline and has no blank data rows', () => {
  const t = L.toAnkiTSV([L.newEntry({ word: 'a', definition: 'b' }, T0)], L.DEFAULT_SETTINGS);
  assert(t.endsWith('\n') && !t.endsWith('\n\n'));
});

console.log('JSON backup');
test('backup round trip keeps every field and the settings', () => {
  let e = L.newEntry({ word: 'w', definition: 'd', context: 'c', source: 'Demo' }, T0);
  e = L.answer(e, true, S, T0);
  const text = JSON.stringify(L.toBackup([e], { intervals: [1, 3, 9] }, { title: 'Demo' }));
  const back = L.parseBackup(text, T0);
  assert.deepStrictEqual(back.entries, [e]);
  assert.deepStrictEqual(back.settings.intervals, [1, 3, 9]);
  assert.strictEqual(back.skipped, 0);
});
test('parseBackup rejects wrong files with readable errors', () => {
  assert.throws(() => L.parseBackup('not json'), /not valid JSON/);
  assert.throws(() => L.parseBackup('{"a":1}'), /not a notebook backup/);
  assert.throws(() => L.parseBackup(JSON.stringify({ format: L.BACKUP_FORMAT, version: 99, entries: [] })), /newer version/);
});
test('parseBackup skips broken entries and repairs odd values', () => {
  const text = JSON.stringify({ format: L.BACKUP_FORMAT, version: 1, entries: [
    { id: 'a', word: 'ok', box: 99, due: 'garbage' }, { id: 'b' }, null, { word: 'no id' }, 'x'
  ] });
  const r = L.parseBackup(text, T0);
  assert.strictEqual(r.entries.length, 1); assert.strictEqual(r.skipped, 4);
  assert.strictEqual(r.entries[0].box, 5); assert.strictEqual(r.entries[0].due, T0);
});
test('mergeEntries: adds new, newer wins, older ignored', () => {
  const mk = (id, upd, box) => Object.assign(L.newEntry({ word: id, definition: 'd' }, T0), { id, updated: upd, box });
  const existing = [mk('a', '2026-11-01T00:00:00Z', 1), mk('b', '2026-11-05T00:00:00Z', 3)];
  const incoming = [mk('a', '2026-11-03T00:00:00Z', 2), mk('b', '2026-11-02T00:00:00Z', 1), mk('c', '2026-11-01T00:00:00Z', 1)];
  const m = L.mergeEntries(existing, incoming);
  assert.deepStrictEqual([m.added, m.updated, m.kept], [1, 1, 1]);
  const by = Object.fromEntries(m.entries.map((e) => [e.id, e.box]));
  assert.deepStrictEqual(by, { a: 2, b: 3, c: 1 });
  assert.deepStrictEqual(m.toWrite.map((e) => e.id).sort(), ['a', 'c']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
