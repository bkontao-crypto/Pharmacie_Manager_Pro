'use strict';
/** Enregistrement du service worker et bandeau « hors connexion ». */
(() => {
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA facultative */ }));
  const bar = document.createElement('div'); bar.className = 'offline-bar hidden'; bar.setAttribute('role', 'status');
  bar.textContent = 'Hors connexion : les données ne sont pas disponibles. Reconnectez-vous pour continuer.';
  document.addEventListener('DOMContentLoaded', () => document.body.prepend(bar));
  const sync = () => bar.classList.toggle('hidden', navigator.onLine); window.addEventListener('online', sync); window.addEventListener('offline', sync); sync();
})();
