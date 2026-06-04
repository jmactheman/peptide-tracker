'use strict';

// ── Phase 1 · Increment 4 — PUSH (one-way upload to Supabase) ────────────────
// Pull + merge land in Increment 5. Push is intentionally SAFE: it only ever
// uploads; it never deletes or mutates local data. Any failure just logs and
// is retried on the next change. Nothing here runs unless a user is signed in.

var SYNC_DEBOUNCE_MS = 1500;
var _pushTimer = null;
var _pushing   = false;

function syncEnabled() {
    return typeof authReady === 'function' && authReady() &&
           typeof currentUser === 'function' && currentUser();
}

function setSyncStatus(text) {
    var el = document.getElementById('sync-status');
    if (el) el.textContent = text;
}

function rowForRecord(rec, uid) {
    return { id: rec.id, user_id: uid, data: rec, updated_at: rec.updatedAt || nowISO(), deleted: false };
}
function rowForTombstone(t, uid) {
    return { id: t.id, user_id: uid, data: {}, updated_at: t.updatedAt || nowISO(), deleted: true };
}

// Upload the entire local dataset. Used on sign-in (first adoption / returning).
async function pushAll() {
    if (!syncEnabled() || _pushing) return;
    _pushing = true;
    var uid = currentUser().id;
    try {
        setSyncStatus('Backing up…');
        // Snapshot pending keys BEFORE uploading so writes made mid-push survive.
        var pendBefore = await dbGetPending();

        for (var i = 0; i < STORES.length; i++) {
            var store = STORES[i];
            var recs  = await dbGetAll(store);
            if (!recs.length) continue;
            var rows = recs.map(function(r) { return rowForRecord(r, uid); });
            var res  = await sb.from(store).upsert(rows, { onConflict: 'user_id,id' });
            if (res.error) throw res.error;
        }

        // Deletions: push tombstones as deleted=true rows, grouped per store.
        var tombs   = await dbGetTombstones();
        var byStore = {};
        tombs.forEach(function(t) { (byStore[t.store] = byStore[t.store] || []).push(rowForTombstone(t, uid)); });
        for (var s in byStore) {
            if (!byStore.hasOwnProperty(s)) continue;
            var rt = await sb.from(s).upsert(byStore[s], { onConflict: 'user_id,id' });
            if (rt.error) throw rt.error;
        }

        // Clear only the pending entries we actually covered in this push.
        for (var j = 0; j < pendBefore.length; j++) await dbClearPending(pendBefore[j].key);
        setSyncStatus('Backed up ✓');

        // If new changes arrived during the push, flush them too.
        if ((await dbGetPending()).length) onLocalChange();
    } catch (e) {
        console.warn('[sync] pushAll failed:', e && e.message);
        setSyncStatus('Backup error — will retry');
    } finally {
        _pushing = false;
    }
}

// Upload only records changed since the last push. Used after edits.
async function pushPending() {
    if (!syncEnabled() || _pushing) return;
    _pushing = true;
    var uid = currentUser().id;
    try {
        var pend = await dbGetPending();
        if (!pend.length) return;
        setSyncStatus('Syncing…');
        for (var i = 0; i < pend.length; i++) {
            var p = pend[i], row;
            if (p.op === 'delete') {
                row = { id: p.id, user_id: uid, data: {}, updated_at: nowISO(), deleted: true };
            } else {
                var rec = await dbGet(p.store, p.id);
                if (!rec) { await dbClearPending(p.key); continue; } // record gone, nothing to push
                row = rowForRecord(rec, uid);
            }
            var res = await sb.from(p.store).upsert([row], { onConflict: 'user_id,id' });
            if (res.error) throw res.error;            // leave pending → retried next nudge
            await dbClearPending(p.key);
        }
        setSyncStatus('Backed up ✓');
    } catch (e) {
        console.warn('[sync] pushPending failed:', e && e.message);
        setSyncStatus('Sync error — will retry');
    } finally {
        _pushing = false;
    }
}

// Debounced trigger — db.js calls this after any local data write/delete.
function onLocalChange() {
    if (!syncEnabled()) return;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function() { pushPending(); }, SYNC_DEBOUNCE_MS);
}

// Called by auth.js whenever a session becomes available (sign-in or returning).
function onAuthReady(user, event) {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') pushAll();
}
