'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const MDict = require('../js/mdict.js');
const { buildMdx, buildMdd } = require('./build-mdx.js');
const { ripemd128, lzoDecompress } = MDict._internals;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const hex = (u8) => Buffer.from(u8).toString('hex');
const blobOf = (buf) => new Blob([buf]);

// ----- sample data
const words = ['apple', 'Banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'honeydew', 'kiwi', 'lemon',
  'mango', 'nectarine', 'orange', 'papaya', 'quince', 'raspberry', 'strawberry', 'tangerine', 'ugli', 'vanilla'];
function makeEntries(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = words[i % words.length] + (i >= words.length ? ' ' + Math.floor(i / words.length) : '');
    out.push({ key, text: '<div class="e"><b>' + key + '</b> <i>/ˈfɔːm/</i> definition number ' + i + ' ' + 'lorem ipsum '.repeat(i % 7) + '</div>' });
  }
  return out;
}

(async () => {
  console.log('RIPEMD-128 / LZO');
  await test('ripemd128 official vectors', () => {
    const v = {
      '': 'cdf26213a150dc3ecb610f18f6b38b46',
      'a': '86be7afa339d0fc7cfc785e72f578d33',
      'abc': 'c14a12199c66e4ba84636b0f69144c77',
      'message digest': '9e327b3d6e523062afc1132d7df9d1b8',
      'abcdefghijklmnopqrstuvwxyz': 'fd2aa607f71dc8f510714922b371834e'
    };
    for (const [m, h] of Object.entries(v)) assert.strictEqual(hex(ripemd128(Buffer.from(m))), h, 'input "' + m + '"');
  });
  await test('ripemd128 handles multi-block input (1000 x "a" is deterministic and 16 bytes)', () => {
    assert.strictEqual(ripemd128(Buffer.alloc(1000, 97)).length, 16);
  });
  await test('LZO decompress matches real liblzo2 output (all vectors)', () => {
    const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'lzo-vectors.json'), 'utf8'));
    assert(cases.length >= 8);
    for (const c of cases) {
      const plain = Buffer.from(c.plain, 'base64'), comp = Buffer.from(c.comp, 'base64');
      const out = lzoDecompress(new Uint8Array(comp), plain.length);
      assert(Buffer.from(out).equals(plain), 'mismatch in ' + c.name);
    }
  });

  console.log('MDX parsing');
  const variants = [
    ['v2 zlib utf-8', { version: 2 }],
    ['v2 zlib utf-8, encrypted key index (Encrypted=2)', { version: 2, encryptInfo: true }],
    ['v2 uncompressed', { version: 2, compress: 'none' }],
    ['v2 utf-16', { version: 2, encoding: 'utf-16le' }],
    ['v1.2 zlib utf-8', { version: 1.2 }],
    ['v1.2 utf-16 uncompressed', { version: 1.2, encoding: 'utf-16le', compress: 'none' }],
    ['v2 tiny blocks (every record spans blocks)', { version: 2, keysPerBlock: 1, recBlockSize: 37 }],
    ['v2 one huge block', { version: 2, keysPerBlock: 1000, recBlockSize: 1 << 20 }]
  ];
  for (const [name, opts] of variants) {
    await test(name + ': every entry reads back exactly', async () => {
      const entries = makeEntries(45);
      const d = await MDict.open(blobOf(buildMdx(entries, opts)));
      assert.strictEqual(d.size(), 45);
      for (const e of entries) {
        const idxs = d.lookup(e.key);
        assert.strictEqual(idxs.length, 1, 'lookup ' + e.key);
        assert.strictEqual(await d.readRecord(idxs[0]), e.text, 'record ' + e.key);
      }
    });
  }

  await test('case-insensitive lookup, prefix suggestions and de-duplication', async () => {
    const entries = makeEntries(45);
    const d = await MDict.open(blobOf(buildMdx(entries)));
    assert.strictEqual(d.lookup('BANANA').length, 1);
    assert.strictEqual(d.lookup('  banana ').length, 1);
    assert.strictEqual(d.lookup('nonexistent').length, 0);
    const s = d.suggest('ba', 10).map((x) => x.key);
    assert.deepStrictEqual(s, ['Banana', 'Banana 1', 'Banana 2']);
    assert.strictEqual(d.suggest('', 10).length, 0);
    assert(d.suggest('a', 3).length <= 3);
  });

  await test('non-ASCII headwords and phonetics survive (UTF-8 and UTF-16)', async () => {
    const entries = [
      { key: 'café', text: '<p>/kæˈfeɪ/ coffee shop</p>' },
      { key: 'naïve', text: '<p>/naɪˈiv/ innocent</p>' },
      { key: 'zebra', text: '<p>/ˈziːbrə/ striped animal</p>' }
    ];
    for (const encoding of ['utf-8', 'utf-16le']) {
      const d = await MDict.open(blobOf(buildMdx(entries, { encoding })));
      const i = d.lookup('café')[0];
      assert.strictEqual(await d.readRecord(i), entries[0].text);
      assert.strictEqual(d.suggest('naï')[0].key, 'naïve');
    }
  });

  await test('duplicate headwords return all entries in file order', async () => {
    const entries = [
      { key: 'bank', text: '<p>1. river side</p>' },
      { key: 'bank', text: '<p>2. money place</p>' },
      { key: 'bark', text: '<p>tree skin</p>' }
    ];
    const d = await MDict.open(blobOf(buildMdx(entries, { keysPerBlock: 2 })));
    const idxs = d.lookup('bank');
    assert.strictEqual(idxs.length, 2);
    const texts = [await d.readRecord(idxs[0]), await d.readRecord(idxs[1])].sort();
    assert.deepStrictEqual(texts, ['<p>1. river side</p>', '<p>2. money place</p>']);
  });

  await test('@@@LINK= redirects are followed and loops are cut off', async () => {
    const entries = [
      { key: 'ran', text: '@@@LINK=run' },
      { key: 'run', text: '<p>to move fast</p>' },
      { key: 'loopa', text: '@@@LINK=loopb' },
      { key: 'loopb', text: '@@@LINK=loopa' }
    ];
    const d = await MDict.open(blobOf(buildMdx(entries)));
    assert.strictEqual(await d.entryHtml(d.lookup('ran')[0]), '<p>to move fast</p>');
    const r = await d.entryHtml(d.lookup('loopa')[0]);
    assert(r.startsWith('@@@LINK='));
  });

  await test('index export / fromIndex round trip (structured-clone safe)', async () => {
    const entries = makeEntries(45);
    const blob = blobOf(buildMdx(entries, { keysPerBlock: 4, recBlockSize: 120 }));
    const d = await MDict.open(blob);
    const saved = structuredClone(d.exportIndex());
    const d2 = MDict.fromIndex(blob, saved);
    assert.strictEqual(d2.size(), 45);
    assert.strictEqual(await d2.readRecord(d2.lookup('mango')[0]), entries.find((e) => e.key === 'mango').text);
    assert.throws(() => MDict.fromIndex(blob, { v: 99 }));
  });

  await test('metadata: title (tags stripped), version, encoding, entry count', async () => {
    const d = await MDict.open(blobOf(buildMdx(makeEntries(5), { title: '<font color="red">My Dict</font>' })));
    assert.strictEqual(d.meta.title, 'My Dict');
    assert.strictEqual(d.meta.version, '2.0');
    assert.strictEqual(d.meta.encoding, 'utf-8');
    assert.strictEqual(d.meta.entries, 5);
  });

  await test('progress callback reports 0..1', async () => {
    const seen = [];
    await MDict.open(blobOf(buildMdx(makeEntries(45), { keysPerBlock: 1 })), { onProgress: (f) => seen.push(f) });
    assert(seen.length >= 2 && seen[0] === 0 && seen[seen.length - 1] === 1);
  });

  await test('larger dictionary (20,000 entries) opens and answers lookups', async () => {
    const entries = [];
    for (let i = 0; i < 20000; i++) entries.push({ key: 'word' + String(i).padStart(5, '0'), text: '<p>entry ' + i + '</p>' });
    const d = await MDict.open(blobOf(buildMdx(entries, { keysPerBlock: 200, recBlockSize: 4096 })));
    assert.strictEqual(d.size(), 20000);
    for (const i of [0, 1, 777, 12345, 19999]) {
      assert.strictEqual(await d.entryHtml(d.lookup('word' + String(i).padStart(5, '0'))[0]), '<p>entry ' + i + '</p>');
    }
    assert.strictEqual(d.suggest('word0123', 50).length, 10);
  });

  console.log('Resource files (.mdd)');
  await test('an .mdd opens, is flagged, and returns exact bytes for each path', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254, 0, 0, 7]);   // binary, with NULs
    const files = [
      { key: '\\img\\logo.png', data: png },
      { key: '\\style.css', data: Buffer.from('.hw{color:red}') },
      { key: '\\snd\\é.wav', data: Buffer.alloc(3000, 7) }
    ];
    for (const opts of [{}, { version: 1.2 }, { compress: 'none', keysPerBlock: 2, recBlockSize: 1000 }]) {
      const d = await MDict.open(blobOf(buildMdd(files, opts)));
      assert.strictEqual(d.meta.isMdd, true);
      assert.strictEqual(d.size(), 3);
      for (const f of files) {
        const i = d.keys.indexOf(f.key);
        assert.ok(i >= 0, 'key ' + f.key);
        assert.deepStrictEqual(Buffer.from(await d.readBytes(i)), f.data);
      }
    }
  });
  await test('an .mdx is not flagged as a resource file', async () => {
    const d = await MDict.open(blobOf(buildMdx(makeEntries(3))));
    assert.strictEqual(d.meta.isMdd, false);
  });

  console.log('Error handling');
  await test('rejects non-MDX data with a friendly message', async () => {
    await assert.rejects(MDict.open(blobOf(Buffer.from('hello world, this is not a dictionary'))), /does not look like an MDX/);
    await assert.rejects(MDict.open(blobOf(Buffer.alloc(0))), /does not look like an MDX/);
  });
  await test('rejects MDX v3 and registration-locked files', async () => {
    await assert.rejects(MDict.open(blobOf(buildMdx(makeEntries(3), { extraHeader: { GeneratedByEngineVersion: '3.0' } }))), /not supported/);
    await assert.rejects(MDict.open(blobOf(buildMdx(makeEntries(3), { extraHeader: { Encrypted: '1' } }))), /registration code/);
  });
  await test('truncated file is reported, not crashed on', async () => {
    const buf = buildMdx(makeEntries(30), { keysPerBlock: 5 });
    await assert.rejects(MDict.open(blobOf(buf.subarray(0, Math.floor(buf.length / 2)))));
  });

  console.log('Search helpers');
  await test('variants() proposes sensible base forms', () => {
    const v = MDict.variants;
    assert(v('running').includes('run')); assert(v('tried').includes('try'));
    assert(v('stopped').includes('stop')); assert(v('hoped').includes('hope'));
    assert(v('boxes').includes('box')); assert(v('cities').includes('city'));
    assert(v('walks').includes('walk')); assert(v('happier').includes('happy'));
    assert(v('biggest').includes('big')); assert(v('making').includes('make'));
    assert.deepStrictEqual(v('a'), []);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
