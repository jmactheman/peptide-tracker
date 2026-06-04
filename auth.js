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
        return;
    }
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    sb.auth.getSession().then(function(res) {
        authUser = (res && res.data && res.data.session) ? res.data.session.user : null;
        renderAccountUI();
    }).catch(function(e) {
        console.warn('[auth] getSession failed:', e && e.message);
        renderAccountUI();
    });

    sb.auth.onAuthStateChange(function(event, session) {
        authUser = session ? session.user : null;
        renderAccountUI();
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

async function signInWithMagicLink() {
    if (!authReady()) { setAuthMsg('Sign-in unavailable right now (offline?).'); return; }
    var input = document.getElementById('auth-email');
    var email = input ? (input.value || '').trim() : '';
    if (!email) { setAuthMsg('Enter your email first.'); return; }
    var btn = document.getElementById('auth-magic-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        var res = await sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirectURL() } });
        if (res.error) throw res.error;
        setAuthMsg('✅ Check your email for a sign-in link.');
    } catch (e) {
        setAuthMsg('Error: ' + (e && e.message ? e.message : 'could not send link'));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Send magic link'; }
    }
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
            '<button class="btn-ghost btn-small" onclick="signOutUser()">Sign out</button>';
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
