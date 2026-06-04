'use strict';

// ── Supabase config ──────────────────────────────────────────────────────────
// The publishable (anon) key is meant to live in client code and be public —
// Row-Level Security is what protects user data. NEVER put the secret key here.
var SUPABASE_URL = 'https://mxcpjsdvdqhgutdzzggo.supabase.co';
var SUPABASE_KEY = 'sb_publishable_pouH8Pbp8THffNLTjavPdA_3RzW0NCf';

var sb       = null;   // Supabase client (null if the library didn't load)
var authUser = null;   // current signed-in user, or null

function authReady() { return !!sb; }
function currentUser() { return authUser; }

function initAuth() {
    if (typeof supabase === 'undefined' || !supabase.createClient) {
        // Library unavailable (offline / blocked). App still works locally.
        console.warn('[auth] Supabase library unavailable — running local-only.');
        renderAccountUI();
        renderAccountStrip();
        return;
    }
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    sb.auth.getSession().then(function(res) {
        authUser = (res && res.data && res.data.session) ? res.data.session.user : null;
        renderAccountUI();
        renderAccountStrip();
        maybeShowWelcome();
    }).catch(function(e) {
        console.warn('[auth] getSession failed:', e && e.message);
        renderAccountUI();
        renderAccountStrip();
        maybeShowWelcome();
    });

    sb.auth.onAuthStateChange(function(event, session) {
        authUser = session ? session.user : null;
        renderAccountUI();
        renderAccountStrip();
        if (authUser) { closeSignInSheet(); if (typeof closeModal === 'function') closeModal('welcome-modal'); }
        // Hand off to the sync layer (push on sign-in / returning session).
        if (session && typeof onAuthReady === 'function') {
            try { onAuthReady(authUser, event); } catch (e) { console.warn('[auth] onAuthReady error', e); }
        }
    });
}

// Land magic-link / OAuth returns on a clean URL (no leftover hash/query).
function redirectURL() {
    return window.location.href.split('#')[0].split('?')[0];
}

// Generalized so both the Settings box and the sign-in sheet can reuse it.
async function sendMagicLink(inputId, msgId, btnId) {
    var msgEl = msgId ? document.getElementById(msgId) : null;
    function msg(t) { if (msgEl) msgEl.textContent = t; }
    if (!authReady()) { msg('Sign-in unavailable right now (offline?).'); return; }
    var input = document.getElementById(inputId);
    var email = input ? (input.value || '').trim() : '';
    if (!email) { msg('Enter your email first.'); return; }
    var btn = btnId ? document.getElementById(btnId) : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        var res = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirectURL() } });
        if (res.error) throw res.error;
        msg('✅ Check your email for a sign-in link.');
    } catch (e) {
        msg('Error: ' + (e && e.message ? e.message : 'could not send link'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Send magic link'; }
    }
}
function signInWithMagicLink() { return sendMagicLink('auth-email', 'auth-msg', 'auth-magic-btn'); }
function sheetMagic()          { return sendMagicLink('sheet-email', 'sheet-msg', 'sheet-magic-btn'); }

// ── Account strip + sign-in sheet + first-launch welcome ─────────────────────
function renderAccountStrip() {
    var strip = document.getElementById('account-strip');
    if (!strip) return;
    if (!authReady() || authUser) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    strip.innerHTML =
        '<span class="as-text">🔒 Not backed up — your data only lives on this device.</span>' +
        '<button class="btn-primary btn-small" onclick="openSignInSheet()">Sign in</button>';
}
function openSignInSheet() {
    var m = document.getElementById('signin-sheet');
    if (m) m.classList.add('active');
    setTimeout(function() { var i = document.getElementById('sheet-email'); if (i) i.focus(); }, 50);
}
function closeSignInSheet() { if (typeof closeModal === 'function') closeModal('signin-sheet'); }

function maybeShowWelcome() {
    try { if (localStorage.getItem('pb_welcome_dismissed')) return; } catch (e) {}
    if (authReady() && authUser) return;   // already signed in → no welcome
    var m = document.getElementById('welcome-modal');
    if (m) m.classList.add('active');
}
function dismissWelcome() {
    try { localStorage.setItem('pb_welcome_dismissed', '1'); } catch (e) {}
    if (typeof closeModal === 'function') closeModal('welcome-modal');
}

async function signInWithGoogle() {
    if (!authReady()) { setAuthMsg('Sign-in unavailable right now (offline?).'); return; }
    try {
        var res = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectURL() } });
        if (res.error) throw res.error; // otherwise the page redirects to Google
    } catch (e) {
        setAuthMsg('Error: ' + (e && e.message ? e.message : 'Google sign-in failed'));
    }
}

async function signOutUser() {
    if (!authReady()) return;
    try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
    authUser = null;
    renderAccountUI();
}

function setAuthMsg(text) {
    var el = document.getElementById('auth-msg');
    if (el) el.textContent = text;
}

function renderAccountUI() {
    var box = document.getElementById('account-box');
    if (!box) return;
    var esc = (typeof escapeHtml === 'function') ? escapeHtml : function(s){ return s; };

    if (!authReady()) {
        box.innerHTML = '<p class="auth-sub">⚠️ Cloud sync is unavailable right now (offline or blocked). ' +
                        'The app works normally on this device — sign-in will appear when you reconnect.</p>';
        return;
    }

    if (authUser) {
        var email = authUser.email || (authUser.user_metadata && authUser.user_metadata.email) || 'your account';
        box.innerHTML =
            '<p class="auth-status">✅ Signed in as <strong>' + esc(email) + '</strong></p>' +
            '<p class="auth-sub" id="sync-status">Your data backs up to this account.</p>' +
            '<div class="auth-row">' +
                '<button class="btn-ghost btn-small" onclick="forceSync()">⟳ Sync now</button>' +
                '<button class="btn-ghost btn-small" onclick="signOutUser()">Sign out</button>' +
            '</div>' +
            '<p class="auth-sub" style="margin-top:6px;font-size:0.76rem;">🔒 Your data is private to your account and encrypted at rest. It also stays on this device, so the app keeps working offline.</p>';
    } else {
        box.innerHTML =
            '<p class="auth-sub">Sign in to back up your data and sync across devices. The app works without an account too.</p>' +
            '<div class="auth-row">' +
                '<input type="email" id="auth-email" placeholder="you@email.com" autocomplete="email" inputmode="email">' +
                '<button class="btn-primary btn-small" id="auth-magic-btn" onclick="signInWithMagicLink()">Send magic link</button>' +
            '</div>' +
            '<div class="auth-or"><span>or</span></div>' +
            '<button class="btn-ghost btn-small auth-google" onclick="signInWithGoogle()">Continue with Google</button>' +
            '<p class="auth-msg" id="auth-msg"></p>';
    }
}

// auth.js is loaded after app.js, so the DOM and app globals already exist.
initAuth();
