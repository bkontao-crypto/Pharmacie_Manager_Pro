'use strict';
/**
 * Service worker : met en cache UNIQUEMENT la coquille statique de l'application (HTML, CSS, JS, icônes).
 * Les appels /api/* ne sont JAMAIS interceptés ni mis en cache : les données de santé ne doivent pas rester sur l'appareil.
 * Stratégie « réseau d'abord » : l'utilisateur reçoit toujours la dernière version ; le cache ne sert qu'hors connexion.
 */
const CACHE = 'pmp-shell-v0.9.0';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/api.js', '/js/ui.js', '/js/modules.js', '/js/modules2.js', '/js/modules3.js', '/js/modules4.js', '/js/pwa.js', '/js/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;   // API : réseau uniquement, jamais en cache
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
