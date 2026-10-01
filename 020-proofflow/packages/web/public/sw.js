// Minimal PWA service worker: app shell cache only (API responses are never cached).
const CACHE = 'proofflow-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); });
self.addEventListener('fetch', (e) => { const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.pathname.startsWith('/api') || u.pathname.startsWith('/artifacts') || u.pathname.startsWith('/runner')) return; e.respondWith(fetch(e.request).catch(() => caches.match('/'))); });
