'use strict';

var DB_NAME    = 'PeptideTrackerDB';
var DB_VERSION = 2;
var STORES     = ['peptides','doses','cycles','protocols','settings'];

var idb = null;

function openDB() {
    return new Promise(function(resolve, reject) {
        if (idb) { resolve(idb); return; }
        var req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = function(e) {
            var db  = e.target.result;
            var old = e.oldVersion;

            if (old < 1) {
                // Fresh install — create all active stores
                STORES.forEach(function(s) {
                    if (!db.objectStoreNames.contains(s)) {
                        db.createObjectStore(s, { keyPath: 'id' });
                    }
                });
            }

            if (old >= 1 && old < 2) {
                // Upgrade from v1: drop ordering stores
                ['orders','templates'].forEach(function(s) {
                    if (db.objectStoreNames.contains(s)) {
                        db.deleteObjectStore(s);
                    }
                });
            }
        };

        req.onsuccess = function(e) { idb = e.target.result; resolve(idb); };
        req.onerror   = function(e) { reject(e.target.error); };
    });
}

function dbGetAll(store) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).getAll();
            req.onsuccess = function() { resolve(req.result || []); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbPut(store, obj) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).put(obj);
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbDelete(store, id) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).delete(id);
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbClear(store) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).clear();
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbGet(store, id) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).get(id);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}
