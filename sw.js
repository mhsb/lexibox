/*
 * Service worker: makes the app open and work offline.
 *
 * - The app files (listed below) are copied into a cache when the app is first opened.
 * - After that they are served from the cache at once and refreshed in the background,
 *   so a new version published on GitHub Pages shows up on the next visit. No version bump needed.
 * - The dictionary file under dict/ is NOT cached here: the app copies it into the phone's own
 *   storage (IndexedDB) the first time, so caching it again would only waste space.
 */
'use strict';

var CACHE = 'dictionary-notebook-shell-v3';
var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/config.js',
  'js/leitner.js',
  'js/mdict.js',
  'js/store.js',
  'js/render.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\/dict\//.test(url.pathname)) return;           // dictionary: straight to the network

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      // ?q=word and similar must still hit the cached page
      var key = req.mode === 'navigate' ? new Request('index.html') : req;
      return cache.match(key, { ignoreSearch: true }).then(function (cached) {
        var refresh = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
          return res;
        }).catch(function () { return null; });
        if (cached) { event.waitUntil(refresh); return cached; }
        return refresh.then(function (res) { return res || new Response('Offline', { status: 503, statusText: 'Offline' }); });
      });
    })
  );
});
