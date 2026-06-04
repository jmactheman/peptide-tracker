'use strict';

// ── Phase 1 · Increment 4 — PUSH (one-way upload to Supabase) ────────────────
// Pull + merge land in Increment 5. Push is intentionally SAFE: it only ever
// uploads; it never deletes or mutates local data. Any failure just surfaces in
// the status line and is retried on the next change. Nothing runs unless signed in.

var SYNC_DEBOUNCE_MS = 1500;
var _pushTimer = null;
var _pushing   = false;

// Client exists? (Actual user is resolved per-push via resolveUid.)
function syncEnabled() {
    return typeof authReady === 'function' && authReady();
}

// Resolve the signed-in user id robustly — prefer the cached global, but fall
// back to asking Supabase directly so a timing quirk can't make us bail.
async function resolveUid() {
    if (typeof currentUser === 'function' && currentUser()) return currentUser().id;
    try {
        var u = await sb.auth.getUser();
        return (u && u.data && u.data.user) ? u.data.user.id : null;
    } catch (e) { return null; }
}

function setSyncStatus(text) {
    var el = document.getElementById('sync-status');
    if (el) el.textContent = text;
}

function errText(e) {
    if (!e) return 'unknown error';
    return e.message || e.error_description || e.hint || e.code || JSON.stringify(e);
}

function rowForRecord(rec, uid) {
    return { id: rec.id, user_id: uid, data: rec, updated_at: rec.updatedAt || nowISO(), deleted: false };
}
function rowForTombstone(t, uid) {
    return { id: t.id, user_id: uid, data: {}, updated_at: t.updatedAt || nowISO(), deleted: true };
}

// Upload the entire local dataset. Used on sign-in and by the "Back up now" button.
async function pushAll() {
    if (!syncEnabled() || _pushing) return;
    _pushing = true;
    try {
        var uid = await resolveUid();
        if (!uid) { setSyncStatus('Not signed in — sign in to back up.'); return; }
        setSyncStatus('Backing up…');

        var pendBefore = await dbGetPending(); // snapshot so mid-push writes survive
        var count = 0;

        for (var i = 0; i < STORES.length; i++) {
            var store = STORES[i];
            var recs  = await dbGetAll(store);
            if (!recs.length) continue;
            var rows = recs.map(function(r) { return rowForRecord(r, uid); });
            var res  = await sb.from(store).upsert(rows, { onConflict: 'user_id,id' });
            if (res.error) throw res.error;
            count += rows.length;
        }

        var tombs   = await dbGetTombstones();
        var byStore = {};
        tombs.forEach(function(t) { (byStore[t.store] = byStore[t.store] || []).push(rowForTombstone(t, uid)); });
        for (var s in byStore) {
            if (!byStore.hasOwnProperty(s)) continue;
            var rt = await sb.from(s).upsert(byStore[s], { onConflict: 'user_id,id' });
            if (rt.error) throw rt.error;
            count += byStore[s].length;
        }

        for (var j = 0; j < pendBefore.length; j++) await dbClearPending(pendBefore[j].key);
        setSyncStatus(count ? ('Backed up ✓ — ' + count + ' records') : 'Backed up ✓ — nothing to sync yet');

        if ((await dbGetPending()).length) onLocalChange();
    } catch (e) {
        console.warn('[sync] pushAll failed:', e);
        setSyncStatus('Backup error: ' + errText(e));
    } finally {
        _pushing = false;
    }
}

// Upload only records changed since the last push. Used after edits (debounced).
async function pushPending() {
    if (!syncEnabled() || _pushing) return;
    _pushing = true;
    try {
        var uid = await resolveUid();
        if (!uid) return;
        var pend = await dbGetPending();
        if (!pend.length) return;
        setSyncStatus('Syncing…');
        for (var i = 0; i < pend.length; i++) {
            var p = pend[i], row;
            if (p.op === 'delete') {
                row = { id: p.id, user_id: uid, data: {}, updated_at: nowISO(), deleted: true };
            } else {
                var rec = await dbGet(p.store, p.id);
                if (!rec) { await dbClearPending(p.key); continue; }
                row = rowForRecord(rec, uid);
            }
            var res = await sb.from(p.store).upsert([row], { onConflict: 'user_id,id' });
            if (res.error) throw res.error;       // leave pending → retried next nudge
            await dbClearPending(p.key);
        }
        setSyncStatus('Backed up ✓');
    } catch (e) {
        console.warn('[sync] pushPending failed:', e);
        setSyncStatus('Sync error: ' + errText(e));
    } finally {
        _pushing = false;
    }
}

// Manual trigger for the "Back up now" button — clear feedback even when idle.
function forceSync() {
    if (!syncEnabled()) { setSyncStatus('Sync unavailable (offline?).'); return; }
    pushAll();
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
