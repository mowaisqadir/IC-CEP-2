// frontend/sw.js
// Service Worker – cache strategy and background sync. Not yet implemented.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

