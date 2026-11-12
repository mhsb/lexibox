/*!
 * mdict.js - small, dependency-free reader for MDX dictionaries (engine v1.2 and v2.0).
 * Works in browsers and in Node 18+ (uses Blob, DecompressionStream, TextDecoder).
 *
 * Supported: zlib / LZO / uncompressed blocks, UTF-8 / UTF-16 / GBK / Big5 headwords,
 *            "Encrypted=2" (obfuscated key index, no password needed).
 * Also reads .mdd resource files (dict.meta.isMdd): keys are file paths, records are raw bytes
 *            (dict.readBytes(index)). Not supported: MDX v3, dictionaries locked with a registration code.
 *
 * Usage:
 *   const dict = await MDict.open(fileOrBlob, { onProgress: (frac, label) => {} });
 *   dict.suggest('hel')            -> [{ key, index }, ...]
 *   dict.lookup('hello')           -> [index, ...]   (all entries with that headword)
 *   await dict.entryHtml(index)    -> HTML string (follows @@@LINK= redirects)
 *   const saved = dict.exportIndex();           // plain object, safe to store in IndexedDB
 *   const again = MDict.fromIndex(blob, saved); // reopen without re-parsing keys
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MDict = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INDEX_VERSION = 1;
  var BLOCK_CACHE = 4;

  /* ------------------------------------------------------------------ helpers */

  async function readBytes(blob, start, len) {
    return new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
  }
  function be16(u, o) { return (u[o] << 8) | u[o + 1]; }
  function be32(u, o) { return ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0; }
  function beNum(u, o, width) {
    return width === 4 ? be32(u, o) : be32(u, o) * 4294967296 + be32(u, o + 4);
  }
  function yieldToUi() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function parseHeaderAttrs(text) {
    var attrs = {}, re = /(\w+)\s*=\s*"([^"]*)"/g, m;
    while ((m = re.exec(text))) {
      attrs[m[1]] = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }
    return attrs;
  }

  function pickEncoding(attr) {
    var e = String(attr || '').trim().toUpperCase();
    if (!e || e === 'UTF-8' || e === 'UTF8') return { name: 'utf-8', width: 1 };
    if (e === 'UTF-16' || e === 'UTF-16LE') return { name: 'utf-16le', width: 2 };
    if (e === 'GBK' || e === 'GB2312' || e === 'GB18030') return { name: 'gb18030', width: 1 };
    if (e === 'BIG5') return { name: 'big5', width: 1 };
    return { name: e.toLowerCase(), width: 1 };
  }

  /* ------------------------------------------------------------------ RIPEMD-128 */
  // Needed only for dictionaries with Encrypted="2" (key index obfuscation).

  var R1 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
            3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12, 1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2];
  var R2 = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12, 6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
            15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13, 8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14];
  var S1 = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8, 7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
            11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5, 11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12];
  var S2 = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6, 9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
            9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5, 15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8];
  var K1 = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC];
  var K2 = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x00000000];

  function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
  function rmdF(round, x, y, z) {
    switch (round) {
      case 0: return x ^ y ^ z;
      case 1: return (x & y) | (~x & z);
      case 2: return (x | ~y) ^ z;
      default: return (x & z) | (y & ~z);
    }
  }

  function ripemd128(msg) {
    var len = msg.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[len] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, (len * 8) >>> 0, true);
    dv.setUint32(total - 4, Math.floor(len / 536870912), true);
    var h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0, h3 = 0x10325476;
    var X = new Array(16);
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) X[i] = dv.getUint32(off + i * 4, true) | 0;
      var a = h0, b = h1, c = h2, d = h3, a2 = h0, b2 = h1, c2 = h2, d2 = h3, t;
      for (var j = 0; j < 64; j++) {
        var rnd = j >> 4;
        t = rol((a + rmdF(rnd, b, c, d) + X[R1[j]] + K1[rnd]) | 0, S1[j]);
        a = d; d = c; c = b; b = t;
        t = rol((a2 + rmdF(3 - rnd, b2, c2, d2) + X[R2[j]] + K2[rnd]) | 0, S2[j]);
        a2 = d2; d2 = c2; c2 = b2; b2 = t;
      }
      t = (h1 + c + d2) | 0;
      h1 = (h2 + d + a2) | 0;
      h2 = (h3 + a + b2) | 0;
      h3 = (h0 + b + c2) | 0;
      h0 = t;
    }
    var out = new Uint8Array(16), odv = new DataView(out.buffer);
    odv.setUint32(0, h0 >>> 0, true); odv.setUint32(4, h1 >>> 0, true);
    odv.setUint32(8, h2 >>> 0, true); odv.setUint32(12, h3 >>> 0, true);
    return out;
  }

  function fastDecrypt(data, key) {
    var out = new Uint8Array(data.length), prev = 0x36;
    for (var i = 0; i < data.length; i++) {
      var b = data[i];
      var t = ((b >> 4) | (b << 4)) & 0xff;
      out[i] = t ^ prev ^ (i & 0xff) ^ key[i % key.length];
      prev = b;
    }
    return out;
  }

  /* ------------------------------------------------------------------ LZO1X */
  // Port of the classic minilzo decompressor (used by some older MDX files).

  function lzoDecompress(src, outLen) {
    var out = new Uint8Array(outLen);
    var ip = 0, op = 0, t = 0, mpos = 0;
    var LOOP = 0, FIRST = 1, MATCH = 2, COPY = 3, DONE = 4, NEXT = 5;
    var state;
    if (src[0] > 17) {
      t = src[ip++] - 17;
      if (t < 4) state = NEXT;
      else { do { out[op++] = src[ip++]; } while (--t > 0); state = FIRST; }
    } else state = LOOP;

    for (;;) {
      if (ip > src.length || op > outLen) throw new Error('Corrupt LZO data');
      if (state === LOOP) {
        t = src[ip++];
        if (t >= 16) { state = MATCH; continue; }
        if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 15 + src[ip++]; }
        t += 3;
        do { out[op++] = src[ip++]; } while (--t > 0);
        state = FIRST;
      } else if (state === FIRST) {
        t = src[ip++];
        if (t >= 16) { state = MATCH; continue; }
        mpos = op - 0x801;
        mpos -= t >> 2;
        mpos -= src[ip++] << 2;
        out[op++] = out[mpos++]; out[op++] = out[mpos++]; out[op++] = out[mpos];
        state = DONE;
      } else if (state === MATCH) {
        if (t >= 64) {
          mpos = op - 1; mpos -= (t >> 2) & 7; mpos -= src[ip++] << 3; t = (t >> 5) - 1;
          state = COPY;
        } else if (t >= 32) {
          t &= 31;
          if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 31 + src[ip++]; }
          mpos = op - 1; mpos -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
          state = COPY;
        } else if (t >= 16) {
          mpos = op; mpos -= (t & 8) << 11;
          t &= 7;
          if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 7 + src[ip++]; }
          mpos -= (src[ip] >> 2) + (src[ip + 1] << 6); ip += 2;
          if (mpos === op) break; // end-of-stream marker
          mpos -= 0x4000;
          state = COPY;
        } else {
          mpos = op - 1; mpos -= t >> 2; mpos -= src[ip++] << 2;
          out[op++] = out[mpos++]; out[op++] = out[mpos];
          state = DONE;
        }
      } else if (state === COPY) {
        if (mpos < 0) throw new Error('Corrupt LZO data (bad back-reference)');
        out[op++] = out[mpos++]; out[op++] = out[mpos++];
        do { out[op++] = out[mpos++]; } while (--t > 0);
        state = DONE;
      } else if (state === DONE) {
        t = src[ip - 2] & 3;
        state = t === 0 ? LOOP : NEXT;
      } else { // NEXT
        do { out[op++] = src[ip++]; } while (--t > 0);
        t = src[ip++];
        state = MATCH;
      }
    }
    if (op !== outLen) throw new Error('LZO output size mismatch (' + op + ' vs ' + outLen + ')');
    return out;
  }

  /* ------------------------------------------------------------------ block decoding */

  async function inflateZlib(u8) {
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // block = [4 bytes type (LE)] [4 bytes adler32] [payload]
  async function decodeBlock(block, expectedSize) {
    var info = block[0] | (block[1] << 8) | (block[2] << 16) | (block[3] << 24);
    var comp = info & 0xf, enc = (info >>> 4) & 0xf;
    if (enc) throw new Error('This dictionary uses encrypted data blocks, which are not supported.');
    var payload = block.subarray(8), out;
    if (comp === 0) out = payload;
    else if (comp === 1) out = lzoDecompress(payload, expectedSize);
    else if (comp === 2) out = await inflateZlib(payload);
    else throw new Error('Unknown block compression type ' + comp + '.');
    if (expectedSize != null && out.length !== expectedSize) {
      throw new Error('Block size mismatch (' + out.length + ' vs ' + expectedSize + '); the file may be damaged.');
    }
    return out;
  }

  function decryptKeyInfo(info) {
    var seed = new Uint8Array(8);
    seed.set(info.subarray(4, 8), 0);
    seed.set([0x95, 0x36, 0x00, 0x00], 4);
    var key = ripemd128(seed);
    var out = new Uint8Array(info.length);
    out.set(info.subarray(0, 8), 0);
    out.set(fastDecrypt(info.subarray(8), key), 8);
    return out;
  }

  /* ------------------------------------------------------------------ Dictionary */

  function Dictionary(blob, idx) {
    this.blob = blob;
    this.meta = idx.meta;
    this.enc = idx.enc;
    this.keys = idx.keys;
    this.offsets = idx.offsets;
    this.order = idx.order;
    this.rec = idx.rec;            // Float64Array [fileOffset, compSize, decompOffset, decompSize] * blocks
    this.totalDecomp = idx.totalDecomp;
    this.decoder = new TextDecoder(idx.enc.name);
    this._cache = new Map();
  }

  Dictionary.prototype.exportIndex = function () {
    return {
      v: INDEX_VERSION, meta: this.meta, enc: this.enc, keys: this.keys,
      offsets: this.offsets, order: this.order, rec: this.rec, totalDecomp: this.totalDecomp
    };
  };

  Dictionary.prototype.size = function () { return this.keys.length; };

  Dictionary.prototype._lower = function (pos) { return this.keys[this.order[pos]].toLowerCase(); };

  Dictionary.prototype._lowerBound = function (s) {
    var lo = 0, hi = this.order.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (this._lower(mid) < s) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // Headwords starting with `prefix` (case-insensitive), de-duplicated, at most `limit`.
  Dictionary.prototype.suggest = function (prefix, limit) {
    limit = limit || 30;
    var s = String(prefix || '').trim().toLowerCase();
    if (!s) return [];
    var out = [], seen = new Set();
    for (var p = this._lowerBound(s); p < this.order.length && out.length < limit; p++) {
      var idx = this.order[p], k = this.keys[idx];
      if (k.toLowerCase().indexOf(s) !== 0) break;
      if (!seen.has(k)) { seen.add(k); out.push({ key: k, index: idx }); }
    }
    return out;
  };

  // Indexes of all entries whose headword equals `word` (case-insensitive).
  Dictionary.prototype.lookup = function (word) {
    var s = String(word || '').trim().toLowerCase();
    if (!s) return [];
    var out = [];
    for (var p = this._lowerBound(s); p < this.order.length; p++) {
      if (this._lower(p) !== s) break;
      out.push(this.order[p]);
    }
    return out.sort(function (a, b) { return a - b; });
  };

  Dictionary.prototype._blockFor = function (off) {
    var rec = this.rec, lo = 0, hi = rec.length / 4 - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (rec[mid * 4 + 2] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  Dictionary.prototype._block = async function (bi) {
    var c = this._cache;
    if (c.has(bi)) { var hit = c.get(bi); c.delete(bi); c.set(bi, hit); return hit; }
    var r = this.rec, o = bi * 4;
    var raw = await readBytes(this.blob, r[o], r[o + 1]);
    var data = await decodeBlock(raw, r[o + 3]);
    c.set(bi, data);
    if (c.size > BLOCK_CACHE) c.delete(c.keys().next().value);
    return data;
  };

  // Raw bytes of record i (what an .mdd stores: images, CSS, audio, fonts).
  Dictionary.prototype.readBytes = async function (i) {
    var start = this.offsets[i];
    var end = i + 1 < this.offsets.length ? this.offsets[i + 1] : this.totalDecomp;
    if (end <= start) end = this.totalDecomp;
    var nBlocks = this.rec.length / 4;
    var bi = this._blockFor(start);
    var within = start - this.rec[bi * 4 + 2];
    var need = end - start, parts = [], total = 0;
    while (need > 0 && bi < nBlocks) {
      var data = await this._block(bi);
      var take = Math.min(need, data.length - within);
      if (take > 0) { parts.push(data.subarray(within, within + take)); total += take; need -= take; }
      within = 0; bi++;
    }
    var bytes;
    if (parts.length === 1) bytes = parts[0];
    else { bytes = new Uint8Array(total); var p = 0; parts.forEach(function (x) { bytes.set(x, p); p += x.length; }); }
    return bytes;
  };

  Dictionary.prototype.readRecord = async function (i) {
    var text = this.decoder.decode(await this.readBytes(i));
    return text.replace(/\u0000+$/, '');
  };

  // Record text with "@@@LINK=word" redirects followed (max 5 hops).
  Dictionary.prototype.entryHtml = async function (i, depth) {
    depth = depth || 0;
    var text = await this.readRecord(i);
    var m = /^@@@LINK=([^\r\n]*)/.exec(text);
    if (m && depth < 5) {
      var target = this.lookup(m[1].trim());
      if (target.length) return this.entryHtml(target[0], depth + 1);
    }
    return text;
  };

  /* ------------------------------------------------------------------ opening */

  async function open(blob, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};

    var head = await readBytes(blob, 0, 4);
    var headerLen = be32(head, 0);
    if (blob.size < 16 || headerLen < 20 || headerLen > 1048576 || headerLen + 8 > blob.size) {
      throw new Error('This does not look like an MDX dictionary file.');
    }
    var headerBytes = await readBytes(blob, 4, headerLen);
    var headerText = new TextDecoder('utf-16le').decode(headerBytes);
    var attrs = parseHeaderAttrs(headerText);
    if (!attrs.GeneratedByEngineVersion) throw new Error('This does not look like an MDX dictionary file.');
    var isMdd = /^\s*<Library_Data/i.test(headerText);   // resource file: keys are paths, records are bytes

    var version = parseFloat(attrs.GeneratedByEngineVersion);
    if (!(version >= 1) || version >= 3) throw new Error('MDX version ' + attrs.GeneratedByEngineVersion + ' is not supported (only 1.x and 2.x).');
    var v2 = version >= 2;

    var encrypted = 0;
    if (attrs.Encrypted === 'Yes') encrypted = 1;
    else if (attrs.Encrypted && attrs.Encrypted !== 'No') encrypted = parseInt(attrs.Encrypted, 10) || 0;
    if (encrypted & 1) throw new Error('This dictionary is locked with a registration code, which is not supported.');

    var enc = isMdd ? { name: 'utf-16le', width: 2 } : pickEncoding(attrs.Encoding);
    try { new TextDecoder(enc.name); } catch (e) { throw new Error('Unsupported text encoding: ' + attrs.Encoding); }
    var decoder = new TextDecoder(enc.name);

    var numW = v2 ? 8 : 4;
    var pos = 4 + headerLen + 4;

    // --- key section header
    var kh = await readBytes(blob, pos, v2 ? 44 : 16);
    var nBlocks, nEntries, infoDecomp = null, infoSize, keysSize;
    if (v2) {
      nBlocks = beNum(kh, 0, 8); nEntries = beNum(kh, 8, 8); infoDecomp = beNum(kh, 16, 8);
      infoSize = beNum(kh, 24, 8); keysSize = beNum(kh, 32, 8); pos += 44;
    } else {
      nBlocks = be32(kh, 0); nEntries = be32(kh, 4); infoSize = be32(kh, 8); keysSize = be32(kh, 12); pos += 16;
    }
    if (pos + infoSize + keysSize > blob.size) throw new Error('The dictionary file is truncated or damaged.');

    // --- key block info
    progress(0, 'Reading index');
    var info = await readBytes(blob, pos, infoSize); pos += infoSize;
    if (v2) {
      if (encrypted & 2) info = decryptKeyInfo(info);
      info = await decodeBlock(info, infoDecomp);
    }
    var blocks = [], p = 0, sizeW = v2 ? 2 : 1, term = v2 ? 1 : 0;
    while (p < info.length) {
      p += numW;
      var hs = sizeW === 2 ? be16(info, p) : info[p]; p += sizeW; p += (hs + term) * enc.width;
      var ts = sizeW === 2 ? be16(info, p) : info[p]; p += sizeW; p += (ts + term) * enc.width;
      var comp = beNum(info, p, numW); p += numW;
      var decomp = beNum(info, p, numW); p += numW;
      blocks.push([comp, decomp]);
    }
    if (blocks.length !== nBlocks) throw new Error('Key index is inconsistent; the file may be damaged or encrypted.');

    // --- key blocks
    var keyData = await readBytes(blob, pos, keysSize); pos += keysSize;
    var keys = [], offs = [], kp = 0;
    for (var bi = 0; bi < blocks.length; bi++) {
      var raw = keyData.subarray(kp, kp + blocks[bi][0]); kp += blocks[bi][0];
      var blk = await decodeBlock(raw, blocks[bi][1]);
      var q = 0;
      while (q < blk.length) {
        var off = beNum(blk, q, numW); q += numW;
        var e = q;
        if (enc.width === 1) { while (e < blk.length && blk[e] !== 0) e++; }
        else { while (e + 1 < blk.length && !(blk[e] === 0 && blk[e + 1] === 0)) e += 2; }
        keys.push(decoder.decode(blk.subarray(q, e)));
        offs.push(off);
        q = e + enc.width;
      }
      if (bi % 8 === 7) { progress(0.7 * (bi + 1) / blocks.length, 'Reading headwords'); await yieldToUi(); }
    }

    // --- record section header + block table
    var rh = await readBytes(blob, pos, numW * 4); pos += numW * 4;
    var nRec = beNum(rh, 0, numW), recInfoSize = beNum(rh, numW * 2, numW);
    var ri = await readBytes(blob, pos, recInfoSize); pos += recInfoSize;
    var rec = new Float64Array(nRec * 4), fileOff = pos, decOff = 0;
    for (var i = 0; i < nRec; i++) {
      var rc = beNum(ri, i * numW * 2, numW), rd = beNum(ri, i * numW * 2 + numW, numW);
      rec[i * 4] = fileOff; rec[i * 4 + 1] = rc; rec[i * 4 + 2] = decOff; rec[i * 4 + 3] = rd;
      fileOff += rc; decOff += rd;
    }
    if (fileOff > blob.size) throw new Error('The dictionary file is truncated or damaged.');

    // --- sort order for case-insensitive search
    progress(0.8, 'Sorting headwords');
    await yieldToUi();
    var n = keys.length, lower = new Array(n), idx = new Array(n);
    for (var k = 0; k < n; k++) { lower[k] = isMdd ? '' : keys[k].toLowerCase(); idx[k] = k; }
    if (!isMdd) idx.sort(function (a, b) { return lower[a] < lower[b] ? -1 : lower[a] > lower[b] ? 1 : a - b; });
    progress(1, 'Done');

    var title = String(attrs.Title || '').replace(/<[^>]*>/g, '').trim();
    var meta = {
      title: title, version: attrs.GeneratedByEngineVersion, encoding: enc.name, entries: n,
      isMdd: isMdd, declaredEntries: nEntries, description: String(attrs.Description || '').replace(/<[^>]*>/g, '').trim()
    };
    return new Dictionary(blob, {
      meta: meta, enc: enc, keys: keys, offsets: Float64Array.from(offs),
      order: Uint32Array.from(idx), rec: rec, totalDecomp: decOff
    });
  }

  function fromIndex(blob, idx) {
    if (!idx || idx.v !== INDEX_VERSION) throw new Error('Saved index is from an incompatible version.');
    return new Dictionary(blob, idx);
  }

  /* ------------------------------------------------------------------ search helpers */

  // Plausible base forms for an inflected English word ("running" -> "run", "tried" -> "try").
  function variants(word) {
    var w = String(word || '').toLowerCase().trim(), out = [];
    function add(x) { if (x && x.length > 1 && x !== w && out.indexOf(x) < 0) out.push(x); }
    function undouble(b) { if (/([^aeiou])\1$/.test(b)) add(b.slice(0, -1)); }
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/(s|x|z|ch|sh)es$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); undouble(w.slice(0, -2)); }
    if (/ing$/.test(w)) { var b = w.slice(0, -3); add(b); add(b + 'e'); undouble(b); }
    if (/ly$/.test(w)) add(w.slice(0, -2));
    if (/ier$/.test(w)) add(w.slice(0, -3) + 'y');
    else if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); undouble(w.slice(0, -2)); }
    if (/iest$/.test(w)) add(w.slice(0, -4) + 'y');
    else if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); undouble(w.slice(0, -3)); }
    return out;
  }

  return {
    open: open, fromIndex: fromIndex, variants: variants,
    _internals: { ripemd128: ripemd128, fastDecrypt: fastDecrypt, lzoDecompress: lzoDecompress, decodeBlock: decodeBlock }
  };
});
