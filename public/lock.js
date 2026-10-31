// Fingerprint lock for People, Tasks and My QR. The Add tab stays open, so cards can be captured at once.
// It uses the phone's own fingerprint or screen lock through WebAuthn (a platform authenticator). It is a gate on this phone only:
// it keeps people who pick up your unlocked phone out of your network, it does not encrypt what the browser has stored.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage off */ } },
  };
  const CRED = 'cc.lock.cred', MINS = 'cc.lock.mins';
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  let open = false;      // unlocked right now (memory only: a freshly opened app starts locked)
  let hiddenAt = 0;
  const enabled = () => !!store.get(CRED);
  const isOpen = () => !enabled() || open;
  const minutes = () => { const n = Number(store.get(MINS, '5')); return Number.isFinite(n) && n >= 0 ? n : 5; };
  const supported = async () => {
    try { return !!(window.PublicKeyCredential && navigator.credentials && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())); } catch { return false; }
  };

  async function register() {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32), rp: { name: 'Pocket CRM', id: location.hostname },
      user: { id: rand(16), name: 'pocket-crm', displayName: 'Pocket CRM' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000, attestation: 'none',
    } });
    store.set(CRED, b64(cred.rawId));
  }

  /** Asks for the fingerprint (or the phone's PIN). Resolves true when it was given. */
  async function unlock() {
    if (!enabled()) return true;
    try {
      await navigator.credentials.get({ publicKey: { challenge: rand(32), rpId: location.hostname, userVerification: 'required', timeout: 60000, allowCredentials: [{ type: 'public-key', id: unb64(store.get(CRED)), transports: ['internal'] }] } });
      open = true; refresh();
      return true;
    } catch { return false; }
  }

  function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden')); }
  function lockNow() {
    if (!enabled()) return;
    open = false; closeSheets(); refresh();
    if (window.CCTab && window.__tab && window.__tab !== 'add') window.CCTab(window.__tab); // shows the lock screen in place of the tab
  }

  // ---- the lock screen shown instead of People, Tasks or My QR ------------------------------------
  const NAMES = { recent: 'People', tasks: 'Tasks', qr: 'My QR' };
  function show(name) {
    $('lockTitle').textContent = (NAMES[name] || 'This tab') + ' is locked';
    $('lockMsg').textContent = 'Touch the fingerprint sensor to open.';
    $('lockBtn').onclick = async () => {
      $('lockMsg').textContent = 'Waiting for the fingerprint…';
      if (await unlock()) { if (window.CCTab) window.CCTab(window.__tab || name); }
      else $('lockMsg').textContent = 'Not unlocked. Try again, or use the phone\'s PIN when asked.';
    };
    unlock().then((ok) => { if (ok && window.__tab === name && window.CCTab) window.CCTab(name); else if (!ok) $('lockMsg').textContent = 'Not unlocked yet. Tap Unlock to try again.'; });
  }

  // ---- settings ---------------------------------------------------------------------------------
  async function refresh() {
    const on = $('lockOn'); if (!on) return;
    const ok = await supported();
    on.checked = enabled(); on.disabled = !ok && !enabled();
    $('lockMins').value = String(minutes());
    $('lockOpts').classList.toggle('hidden', !enabled());
    $('lockHelp').textContent = !ok && !enabled()
      ? 'This phone has no fingerprint or screen lock that the app can use. Set one up in the phone\'s settings first.'
      : enabled() ? (open ? 'Unlocked. It locks again when you leave the app for the time below.' : 'Locked. Open People, Tasks or My QR to unlock.') : 'Locks People, Tasks and My QR. Add stays open for scanning cards.';
    if (window.CCMeet && window.CCMeet.render) window.CCMeet.render();
  }
  function bind() {
    if (!$('lockOn')) return;
    $('lockOn').onchange = async () => {
      const msg = $('lockMsg2'); msg.textContent = '';
      if ($('lockOn').checked) {
        try { await register(); open = true; } catch (e) { msg.textContent = e && e.name === 'NotAllowedError' ? 'Cancelled.' : 'The lock could not be set up on this phone.'; }
      } else if (!open && !(await unlock())) msg.textContent = 'Unlock first to switch the lock off.';
      else { store.del(CRED); open = true; }
      refresh();
    };
    $('lockMins').onchange = () => { store.set(MINS, $('lockMins').value); };
    $('lockNow').onclick = () => lockNow();
    $('lockReset').onclick = () => {
      if (!confirm('This removes the lock AND the access token from this phone. You will have to enter the access token again. Continue?')) return;
      store.del(CRED); store.del('cc.tok'); location.reload();
    };
  }

  document.addEventListener('visibilitychange', () => {
    if (!enabled()) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (open && hiddenAt && Date.now() - hiddenAt >= minutes() * 60000) lockNow();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { bind(); refresh(); }); else { bind(); refresh(); }

  window.CCLock = { isOpen, enabled, unlock, lockNow, show };
})();
