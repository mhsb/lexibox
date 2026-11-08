/*!
 * zip.js - a tiny ZIP reader for EPUB and DOCX files (browser).
 * Reads the central directory and inflates single entries on demand with the built-in
 * DecompressionStream('deflate-raw'). No ZIP64, no encryption, no writing.
 *
 *   var zip = await Zip.open(blob);
 *   zip.has('META-INF/container.xml');   // true / false
 *   zip.names();                         // all entry names
 *   var bytes = await zip.read('a.xml'); // Uint8Array
 *   var text  = await zip.text('a.xml'); // string (UTF-8)
 */
(function (root) {
  'use strict';

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function slice(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip files (no DecompressionStream).');
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function open(blob) {
    var size = blob.size;
    if (size < 22) throw new Error('Not a ZIP file.');
    // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
    var tailLen = Math.min(size, 65557);
    var tail = await slice(blob, size - tailLen, size);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no directory found).');
    var count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 files are not supported.');
    var cd = await slice(blob, cdOffset, cdOffset + cdSize);
    var entries = new Map(), p = 0, dec = new TextDecoder('utf-8');
    for (var n = 0; n < count && p + 46 <= cd.length; n++) {
      if (u32(cd, p) !== 0x02014b50) break;
      var flags = u16(cd, p + 8), method = u16(cd, p + 10);
      var comp = u32(cd, p + 20), plain = u32(cd, p + 24);
      var nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
      var local = u32(cd, p + 42);
      var name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
      if (!(flags & 1)) entries.set(name, { method: method, comp: comp, plain: plain, local: local });
      p += 46 + nameLen + extraLen + commentLen;
    }

    async function read(name) {
      var e = entries.get(name);
      if (!e) throw new Error('Missing file in archive: ' + name);
      var head = await slice(blob, e.local, e.local + 30);
      if (u32(head, 0) !== 0x04034b50) throw new Error('Damaged archive entry: ' + name);
      var start = e.local + 30 + u16(head, 26) + u16(head, 28);
      var data = await slice(blob, start, start + e.comp);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data);
      throw new Error('Unsupported compression in archive (method ' + e.method + ').');
    }

    return {
      has: function (name) { return entries.has(name); },
      names: function () { return Array.from(entries.keys()); },
      read: read,
      text: async function (name) { return dec.decode(await read(name)); }
    };
  }

  root.Zip = { open: open };
})(typeof window !== 'undefined' ? window : globalThis);
