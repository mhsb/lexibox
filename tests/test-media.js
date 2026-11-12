/* Unit tests for the pure parts of media.js (path matching and CSS selector scoping).  node tests/test-media.js */
'use strict';
const assert = require('assert');
const Media = require('../js/media.js');
const { norm, mime, scopeSelector, prefixNames, splitTop } = Media._internals;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('Paths');
test('norm: backslashes, leading slashes, case, query', () => {
  assert.strictEqual(norm('\\img\\Logo.PNG'), 'img/logo.png');
  assert.strictEqual(norm('/img/a.png?x=1'), 'img/a.png');
  assert.strictEqual(norm('./a%20b.png'), 'a b.png');
  assert.strictEqual(norm('../../x.css'), 'x.css');
});
test('mime types', () => {
  assert.strictEqual(mime('a/b.PNG'), 'image/png');
  assert.strictEqual(mime('s.mp3'), 'audio/mpeg');
  assert.strictEqual(mime('noext'), 'application/octet-stream');
});

console.log('CSS selectors');
test('class and id names get the d- prefix', () => {
  assert.strictEqual(prefixNames('.hw .pos#main'), '.d-hw .d-pos#d-main');
  assert.strictEqual(prefixNames('a:not(.x) > span.y'), 'a:not(.d-x) > span.d-y');
});
test('attribute selectors and strings are left alone', () => {
  assert.strictEqual(prefixNames('a[href$=".html"].x'), 'a[href$=".html"].d-x');
});
test('splitTop ignores commas inside parentheses and strings', () => {
  assert.deepStrictEqual(splitTop('a, b:not(.x, .y), c[d="1,2"]').map(s => s.trim()), ['a', 'b:not(.x, .y)', 'c[d="1,2"]']);
});
test('everything is moved under .entry', () => {
  assert.strictEqual(scopeSelector('.hw').sel, '.entry .d-hw');
  assert.strictEqual(scopeSelector('p, .a b').sel, '.entry p,.entry .d-a b');
  assert.strictEqual(scopeSelector('#entry-word').sel, '.entry #d-entry-word');
});
test('html and body style the entry box itself and are flagged as root', () => {
  assert.deepStrictEqual(scopeSelector('body'), { sel: '.entry', root: true });
  assert.deepStrictEqual(scopeSelector('html, body'), { sel: '.entry,.entry', root: true });
  assert.deepStrictEqual(scopeSelector('body .x'), { sel: '.entry .d-x', root: false });
  assert.deepStrictEqual(scopeSelector('html body > p'), { sel: '.entry > p', root: false });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
