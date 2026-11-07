/*!
 * store.js - persistence in IndexedDB: notebook entries, settings, and the dictionary file + its index.
 * Falls back to memory (and reports volatile=true) if IndexedDB is unavailable.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'leitner-dict', DB_VERSION = 1;
  var dbPromise = null;
  var volatile = false;
  var mem = { entries: new Map(), kv: new Map(), blobs: new Map() };

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('IndexedDB is not available'));
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    }).catch(function () { volatile = true; return null; });
    return dbPromise;
  }

  // Runs `work(objectStore)` inside one transaction; resolves with the result of the request it returns.
  function withStore(name, mode, work) {
    return openDb().then(function (db) {
      if (!db) return memWork(name, work);
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var out = work(tx.objectStore(name));
        tx.oncomplete = function () { resolve(out && 'result' in out ? out.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Storage transaction failed')); };
      });
    });
  }

  // Memory fallback: emulate just the object-store calls we use.
  function memWork(name, work) {
    var m = mem[name];
    var fake = {
      get: function (k) { return { result: m.get(k) }; },
      put: function (v, k) { m.set(name === 'entries' ? v.id : k, v); return { result: undefined }; },
      delete: function (k) { m.delete(k); return { result: undefined }; },
      getAll: function () { return { result: Array.from(m.values()) }; },
      clear: function () { m.clear(); return { result: undefined }; }
    };
    return work(fake).result;
  }

  var Store = {
    init: function () { return openDb().then(function () { return { volatile: volatile }; }); },

    getEntries: function () { return withStore('entries', 'readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; }); },
    putEntry: function (e) { return withStore('entries', 'readwrite', function (s) { return s.put(e); }); },
    putEntries: function (list) { return withStore('entries', 'readwrite', function (s) { list.forEach(function (e) { s.put(e); }); }); },
    deleteEntry: function (id) { return withStore('entries', 'readwrite', function (s) { return s.delete(id); }); },
    clearEntries: function () { return withStore('entries', 'readwrite', function (s) { return s.clear(); }); },

    getKV: function (k) { return withStore('kv', 'readonly', function (s) { return s.get(k); }); },
    setKV: function (k, v) { return withStore('kv', 'readwrite', function (s) { return s.put(v, k); }); },

    // The dictionary file (a Blob) and its parsed index are stored separately.
    getDictRecord: function () { return withStore('blobs', 'readonly', function (s) { return s.get('dict'); }); },
    putDictRecord: function (rec) { return withStore('blobs', 'readwrite', function (s) { return s.put(rec, 'dict'); }); },
    getDictIndex: function () { return withStore('blobs', 'readonly', function (s) { return s.get('dictIndex'); }); },
    putDictIndex: function (idx) { return withStore('blobs', 'readwrite', function (s) { return s.put(idx, 'dictIndex'); }); },

    clearAll: function () {
      return Promise.all([
        withStore('entries', 'readwrite', function (s) { return s.clear(); }),
        withStore('kv', 'readwrite', function (s) { return s.clear(); })
      ]);
    },

    // Ask the browser not to evict our data under storage pressure.
    requestPersist: function () {
      if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
      return Promise.resolve(false);
    },
    isPersisted: function () {
      if (navigator.storage && navigator.storage.persisted) return navigator.storage.persisted().catch(function () { return false; });
      return Promise.resolve(false);
    },
    isVolatile: function () { return volatile; }
  };

  root.Store = Store;
})(typeof self !== 'undefined' ? self : this);
