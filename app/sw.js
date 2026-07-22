/* ================================================================
   Electric Budget — service worker (F4, SPEC §7.4)
   Estratégia: precache do app shell + stale-while-revalidate.
   Só intercepta GET — o HEAD da verificação de relógio (§8.2)
   precisa ir à rede pra ler um header Date confiável.
   ================================================================ */

var CACHE = 'electricbudget-v4';

var ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/db.js',
  './js/app.js',
  './vendor/jspdf.umd.min.js', /* PDF precisa funcionar offline (§7.2) */
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c) { return c.addAll(ASSETS); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; })
        .map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return; /* HEAD do relógio passa direto */

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function(cached) {
      var daRede = fetch(e.request).then(function(resp) {
        if (resp && resp.ok && e.request.url.indexOf('http') === 0) {
          var copia = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, copia); });
        }
        return resp;
      }).catch(function() {
        /* offline: navegação cai no shell */
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return cached;
      });
      return cached || daRede;
    })
  );
});
