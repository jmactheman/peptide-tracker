'use strict';

// ── Phase 1 · Increment 5 — bidirectional sync (pull + merge + push) ─────────
// Local IndexedDB stays the offline working copy; Supabase is the canonical
// per-user copy. On sign-in (and via "Sync now") we PULL the cloud down, MERGE
// it into local with last-write-wins + tombstones, then PUSH local-newer rows
// up. Edits during normal use push incrementally (debounced). Reconciliation is
// id-based; concurrent edits resolve by updatedAt, deletions by tombstone.

var SYNC_DEBOUNCE_MS = 1500;
var _pushTimer = null;
var _busy      = false;   // single lock so pull/push never overlap

function syncEnabled() {
    return typeof authReady === 'function' && authReady();
}

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

// ── PULL + MERGE ─────────────────────────────────────────────────────────────
// Apply remote rows to local with raw writes (so merged-in cloud data is NOT
// re-marked dirty). Returns the number of local changes applied.
async function _pullAll(uid) {
    var tombs = await dbGetTombstones();
    var tombByKey = {};
    tombs.forEach(function(t) { tombByKey[t.key] = t; });

    var applied = 0;
    for (var i = 0; i < STORES.length; i++) {
        var store = STORES[i];
        var res = await sb.from(store).select('id,data,updated_at,deleted');
        if (res.error) throw res.error;
        var rows = res.data || [];
        for (var r = 0; r < rows.length; r++) {
            applied += await _mergeRemoteRow(store, rows[r], tombByKey);
        }
    }
    return applied;
}

// Reconcile one remote row against the local copy. Returns 1 if local changed.
async function _mergeRemoteRow(store, row, tombByKey) {
    var id       = row.id;
    var remoteTs = row.updated_at || '';
    var key      = store + ':' + id;
    var localRec = await dbGet(store, id);
    var localTomb = tombByKey[key];

    if (row.deleted) {
        // Cloud says this record was deleted.
        if (localRec) {
            var lts = localRec.updatedAt || '';
            if (remoteTs >= lts) { await dbDelete(store, id, { raw: true }); return 1; }
        }
        return 0; // already absent, or local edit is newer (will push & resurrect)
    }

    // Cloud has a live record.
    if (localTomb) {
        // Locally deleted but not yet pushed.
        if (localTomb.updatedAt > remoteTs) return 0;   // local delete wins
        await dbPut(store, row.data, { raw: true });    // cloud is newer → resurrect
        await dbClearTombstone(key);
        return 1;
    }

    if (!localRec) { await dbPut(store, row.data, { raw: true }); return 1; } // new from cloud

    var localTs = localRec.updatedAt || '';
    if (remoteTs > localTs) { await dbPut(store, row.data, { raw: true }); return 1; } // cloud newer
    return 0; // local newer/equal → keep (pushed below if dirty)
}

// ── PUSH ─────────────────────────────────────────────────────────────────────
// Full upload of the local dataset (adopts pre-existing local data on first
// sign-in; idempotent thereafter). Returns count uploaded.
async function _pushAll(uid) {
    var pendBefore = await dbGetPending();
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
    return count;
}

// Incremental upload of only records changed since the last push.
async function _pushPending(uid) {
    var pend = await dbGetPending();
    if (!pend.length) return 0;
    var count = 0;
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
        if (res.error) throw res.error;          // leave pending → retried next nudge
        await dbClearPending(p.key);
        count++;
    }
    return count;
}

// Refresh the in-memory app state + UI after a pull mutates IndexedDB.
async function reloadLocalUI() {
    if (typeof loadAllData === 'function') await loadAllData();
    if (typeof applyTheme === 'function') { try { applyTheme(); } catch (e) {} }
    if (typeof initPeptideDropdown === 'function') { try { initPeptideDropdown(); } catch (e) {} }
    if (typeof renderAll === 'function') { try { renderAll(); } catch (e) {} }
    if (typeof renderProtocolTemplatesList === 'function') { try { renderProtocolTemplatesList(); } catch (e) {} }
}

// ── PUBLIC ENTRY POINTS ──────────────────────────────────────────────────────

// Full reconcile: pull → merge → refresh UI → push. Used on sign-in and "Sync now".
async function fullSync() {
    if (!syncEnabled() || _busy) return;
    _busy = true;
    try {
        var uid = await resolveUid();
        if (!uid) { setSyncStatus('Not signed in — sign in to sync.'); return; }
        setSyncStatus('Syncing…');
        var pulled = await _pullAll(uid);
        if (pulled) await reloadLocalUI();
        var pushed = await _pushAll(uid);
        setSyncStatus('Synced ✓' + (pulled ? (' — restored ' + pulled) : '') +
                      (pushed ? (', sent ' + pushed) : (pulled ? '' : ' — up to date')));
    } catch (e) {
        console.warn('[sync] fullSync failed:', e);
        setSyncStatus('Sync error: ' + errText(e));
    } finally {
        _busy = false;
    }
}

// Incremental push of local edits (debounced via onLocalChange).
async function pushChanges() {
    if (!syncEnabled() || _busy) return;
    _busy = true;
    try {
        var uid = await resolveUid();
        if (!uid) return;
        var n = await _pushPending(uid);
        if (n) setSyncStatus('Backed up ✓');
    } catch (e) {
        console.warn('[sync] pushChanges failed:', e);
        setSyncStatus('Sync error: ' + errText(e));
    } finally {
        _busy = false;
    }
}

// Manual button.
function forceSync() {
    if (!syncEnabled()) { setSyncStatus('Sync unavailable (offline?).'); return; }
    fullSync();
}

// db.js calls this after any local data write/delete.
function onLocalChange() {
    if (!syncEnabled()) return;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function() { pushChanges(); }, SYNC_DEBOUNCE_MS);
}

// auth.js calls this when a session becomes available (sign-in or returning).
function onAuthReady(user, event) {
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') fullSync();
}
