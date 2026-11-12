/* Builds MDX files (v1.2 / v2.0) for tests and for the demo dictionary. Node only. */
'use strict';
const zlib = require('zlib');
const MDict = require('../js/mdict.js');
const { ripemd128 } = MDict._internals;

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function adler32(buf) {
  let a = 1, b = 0;
  for (const x of buf) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function swapNibbles(x) { return ((x >> 4) | (x << 4)) & 0xff; }
function fastEncrypt(plain, key) {
  const out = Buffer.alloc(plain.length);
  let prev = 0x36;
  for (let i = 0; i < plain.length; i++) {
    const e = swapNibbles(plain[i] ^ prev ^ (i & 0xff) ^ key[i % key.length]);
    out[i] = e; prev = e;
  }
  return out;
}
function packBlock(data, type) {
  const body = type === 'zlib' ? zlib.deflateSync(data) : data;
  const head = Buffer.alloc(4); head.writeUInt32LE(type === 'zlib' ? 2 : 0);
  return Buffer.concat([head, u32be(adler32(data)), body]);
}

/**
 * entries: [{ key, text }]
 * opts: version (2|1.2), encoding ('utf-8'|'utf-16le'), compress ('zlib'|'none'),
 *       encryptInfo (bool, version 2 only), keysPerBlock, recBlockSize, title, extraHeader
 *       mdd (bool): build a resource file; entries are { key: 'path', data: Buffer } and keys are UTF-16
 */
function buildMdx(entries, opts) {
  opts = opts || {};
  const version = opts.version || 2;
  const v2 = version >= 2;
  const mdd = !!opts.mdd;
  const encoding = mdd ? 'utf-16le' : (opts.encoding || 'utf-8');
  const compress = opts.compress || 'zlib';
  const unit = encoding === 'utf-16le' ? 2 : 1;
  const keysPerBlock = opts.keysPerBlock || 3;
  const recBlockSize = opts.recBlockSize || 200;
  const num = (n) => (v2 ? u64be(n) : u32be(n));
  const enc = (s) => Buffer.from(s, encoding === 'utf-16le' ? 'utf16le' : 'utf8');
  const sizeOf = (s) => (unit === 2 ? s.length : Buffer.byteLength(s, 'utf8'));

  const sorted = entries.slice().sort((a, b) => {
    const x = a.key.toLowerCase(), y = b.key.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // records
  const recs = sorted.map((e) => (mdd ? Buffer.from(e.data) : Buffer.concat([enc(e.text), Buffer.alloc(unit)])));
  const offsets = [];
  let off = 0;
  for (const r of recs) { offsets.push(off); off += r.length; }
  const stream = Buffer.concat(recs);

  // record blocks
  const recBlocks = [];
  for (let p = 0; p < stream.length; p += recBlockSize) {
    const chunk = stream.subarray(p, p + recBlockSize);
    recBlocks.push({ decomp: chunk.length, packed: packBlock(chunk, compress) });
  }
  if (!recBlocks.length) recBlocks.push({ decomp: 0, packed: packBlock(Buffer.alloc(0), compress) });

  // key blocks
  const keyBlocks = [];
  for (let i = 0; i < sorted.length; i += keysPerBlock) {
    const group = sorted.slice(i, i + keysPerBlock);
    const parts = [];
    group.forEach((e, j) => { parts.push(num(offsets[i + j]), enc(e.key), Buffer.alloc(unit)); });
    const raw = Buffer.concat(parts);
    keyBlocks.push({ group, decomp: raw.length, packed: packBlock(raw, compress) });
  }

  // key block info
  const infoParts = [];
  for (const kb of keyBlocks) {
    const first = kb.group[0].key, last = kb.group[kb.group.length - 1].key;
    const sz = (n) => (v2 ? Buffer.from([n >> 8, n & 255]) : Buffer.from([n]));
    infoParts.push(num(kb.group.length));
    infoParts.push(sz(sizeOf(first)), enc(first), v2 ? Buffer.alloc(unit) : Buffer.alloc(0));
    infoParts.push(sz(sizeOf(last)), enc(last), v2 ? Buffer.alloc(unit) : Buffer.alloc(0));
    infoParts.push(num(kb.packed.length), num(kb.decomp));
  }
  const infoRaw = Buffer.concat(infoParts);
  let infoOut;
  if (v2) {
    const head = Buffer.alloc(4); head.writeUInt32LE(2);
    const adler = u32be(adler32(infoRaw));
    let body = zlib.deflateSync(infoRaw);
    if (opts.encryptInfo) {
      const seed = Buffer.concat([adler, Buffer.from([0x95, 0x36, 0, 0])]);
      body = fastEncrypt(body, ripemd128(seed));
    }
    infoOut = Buffer.concat([head, adler, body]);
  } else infoOut = infoRaw;

  const keysData = Buffer.concat(keyBlocks.map((k) => k.packed));

  // header
  const attrs = Object.assign({
    GeneratedByEngineVersion: v2 ? '2.0' : '1.2', RequiredEngineVersion: v2 ? '2.0' : '1.2',
    Encrypted: opts.encryptInfo ? '2' : '0',
    Encoding: mdd ? '' : (encoding === 'utf-16le' ? 'UTF-16' : 'UTF-8'), Format: mdd ? '' : 'Html', KeyCaseSensitive: 'No',
    Title: opts.title || 'Test Dictionary', Description: 'Built for tests'
  }, opts.extraHeader || {});
  const headerText = '<' + (mdd ? 'Library_Data' : 'Dictionary') + ' ' + Object.entries(attrs).map(([k, v]) => k + '="' + String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"').join(' ') + '/>\r\n\u0000';
  const headerBuf = Buffer.from(headerText, 'utf16le');
  const headerLenAndData = Buffer.concat([u32be(headerBuf.length), headerBuf]);
  const headerAdler = Buffer.alloc(4); headerAdler.writeUInt32LE(adler32(headerBuf));

  // key section header
  let keyHeader;
  if (v2) {
    const five = Buffer.concat([u64be(keyBlocks.length), u64be(sorted.length), u64be(infoRaw.length), u64be(infoOut.length), u64be(keysData.length)]);
    keyHeader = Buffer.concat([five, u32be(adler32(five))]);
  } else {
    keyHeader = Buffer.concat([u32be(keyBlocks.length), u32be(sorted.length), u32be(infoOut.length), u32be(keysData.length)]);
  }

  // record section
  const recInfo = Buffer.concat(recBlocks.map((r) => Buffer.concat([num(r.packed.length), num(r.decomp)])));
  const recData = Buffer.concat(recBlocks.map((r) => r.packed));
  const recHeader = Buffer.concat([num(recBlocks.length), num(sorted.length), num(recInfo.length), num(recData.length)]);

  return Buffer.concat([headerLenAndData, headerAdler, keyHeader, infoOut, keysData, recHeader, recInfo, recData]);
}

const buildMdd = (files, opts) => buildMdx(files, Object.assign({}, opts, { mdd: true }));

module.exports = { buildMdx, buildMdd };
