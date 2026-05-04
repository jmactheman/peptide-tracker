'use strict';

var CACHE = 'pepbros-v15';
var ASSETS = [
    '/peptide-tracker/',
    '/peptide-tracker/index.html',
    '/peptide-tracker/styles.css',
    '/peptide-tracker/data.js',
    '/peptide-tracker/db.js',
    '/peptide-tracker/app.js',
    '/peptide-tracker/manifest.json',
    '/peptide-tracker/icon.png',
    '/peptide-tracker/icon.svg',
    '/peptide-tracker/logo.png'
];

// Pre-cache on install and take over immediately
self.addEventListener('install', function(e) {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }));
});

// Delete old caches and claim all clients on activate
self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys()
            .then(function(keys) {
                return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
            })
            .then(function() { return self.clients.claim(); })
    );
});

// Network-first: always try to fetch fresh, fall back to cache when offline
self.addEventListener('fetch', function(e) {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request)
            .then(function(response) {
                var clone = response.clone();
                caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
                return response;
            })
            .catch(function() { return caches.match(e.request); })
    );
});
