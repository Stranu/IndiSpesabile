// js/app.js — bootstrap (design §15): openDB guard, SW auto-update, router, header,
// auth-state-driven sync (the SOLE fullSync driver for login), sync.init(). All Italian.

import { openDB, onChange } from './db.js';
import { getMeta, setMeta, countListToBuy, countExpiring } from './store.js';
import { onAuthStateChange, getSession } from './supabase.js';
import * as sync from './sync.js';
import { startRouter, refresh as refreshRoute } from './router.js';
import { openModal, toast } from './ui.js';
import { render as renderSpesa } from './views/spesa.js';
import { render as renderDispensa } from './views/dispensa.js';
import { render as renderDesideri } from './views/desideri.js';
import { render as renderProdotti } from './views/prodotti.js';
import { render as renderAuth } from './views/auth.js';

async function main() {
  // 1) openDB guarded — on failure, show a blocking message and stop.
  try {
    await openDB();
  } catch (e) {
    console.error('openDB failed', e);
    const view = document.getElementById('view');
    if (view) {
      view.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'empty';
      msg.textContent = 'IndexedDB non disponibile. Attiva la memoria del browser e riprova.';
      view.appendChild(msg);
    }
    return; // fatal (local)
  }

  // 2) Register the service worker + wire SKIP_WAITING auto-update.
  registerServiceWorker();

  // 3) Start the router with the four section render fns; default '#/spesa'.
  const mount = document.getElementById('view');
  startRouter(
    {
      '/spesa': renderSpesa,
      '/dispensa': renderDispensa,
      '/desideri': renderDesideri,
      '/prodotti': renderProdotti,
    },
    { mount }
  );

  // 4) Wire the header: account chip + manual "Sincronizza" button.
  const chip = document.getElementById('sync-chip');
  const syncBtn = document.getElementById('sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      // Give immediate feedback: if there's no session, say so plainly instead
      // of silently doing nothing.
      try {
        const { data } = await getSession();
        if (!data.session) {
          toast('Accedi per sincronizzare con il server', 'info');
          return;
        }
      } catch (e) {
        console.warn('sync button getSession failed', e);
      }
      toast('Sincronizzazione in corso…', 'info', 1500);
      sync.fullSync(); // outcome (ok / error) is surfaced via renderStatus
    });
  }

  // Settings gear (top-right, every section): opens the same auth/settings modal.
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', openAuthModal);

  // Account chip: shows session email or 'Accedi' (opens the auth modal).
  if (chip) {
    chip.style.cursor = 'pointer';
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.addEventListener('click', openAuthModal);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAuthModal();
      }
    });
  }

  function openAuthModal() {
    const modal = openModal({ title: 'Account' });
    const content = renderAuth({ close: () => modal.close() });
    modal.element.appendChild(content);
  }

  // The header chip shows only connection STATE, never the email (which would
  // push the icons around). The account email lives in Impostazioni -> Account.
  function updateChip(session) {
    if (!chip) return;
    if (session && session.user) {
      chip.textContent = 'Collegato';
      chip.setAttribute('data-state', 'ok');
    } else {
      chip.textContent = 'Accedi';
      chip.removeAttribute('data-state');
    }
  }

  // Initial chip state from the current session (if any). If already logged in,
  // start the periodic auto-pull so a shared account stays fresh.
  try {
    const { data } = await getSession();
    updateChip(data.session);
    if (data.session) sync.startAutoPull();
  } catch (e) {
    console.warn('getSession at bootstrap failed', e);
    updateChip(null);
  }

  // 5) Auth-state handler — the SOLE fullSync driver for login.
  onAuthStateChange(async (event, session) => {
    updateChip(session);

    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
      // Sync must never block the UI refresh: even if it throws (server down,
      // tables missing), we still reflect the new session in the view below.
      try {
        const prev = await getMeta('lastSyncUser');
        if (prev != null && prev !== session.user.id) {
          // Account switch: clear domain stores + reset cursors + set lastSyncUser, THEN fullSync.
          await sync.switchAccount(session.user.id); // runs fullSync internally
        } else {
          await setMeta('lastSyncUser', session.user.id);
          await sync.fullSync();
        }
        // Keep a shared account fresh with the periodic auto-pull.
        sync.startAutoPull();
      } catch (e) {
        console.warn('auth SIGNED_IN sync failed', e);
      }
      // Re-render the current section + badges so a fresh login is reflected
      // immediately, even if the pull brought no new rows (no db.onChange fired)
      // or the sync failed above.
      refreshRoute();
      refreshBadges();
    } else if (event === 'SIGNED_OUT') {
      // Keep local data/cursors; leave lastSyncUser. Stop polling, flag offline.
      sync.stopAutoPull();
      renderStatus({ status: 'offline' });
      refreshRoute();
      refreshBadges();
    }
  });

  // 6) sync.init() + status chip updater.
  sync.onStatus(renderStatus);
  sync.init();

  // 7) Nav badges: Spesa = items left to buy, Dispensa = items expiring/expired.
  //    Recomputed on every store change (local edits and pulled remote changes).
  const badgeSpesa = document.getElementById('badge-spesa');
  const badgeDispensa = document.getElementById('badge-dispensa');

  function setBadge(node, count) {
    if (!node) return;
    if (count > 0) {
      node.textContent = count > 99 ? '99+' : String(count);
      node.hidden = false;
    } else {
      node.textContent = '';
      node.hidden = true;
    }
  }

  async function refreshBadges() {
    try {
      const [toBuy, expiring] = await Promise.all([countListToBuy(), countExpiring()]);
      setBadge(badgeSpesa, toBuy);
      setBadge(badgeDispensa, expiring);
    } catch (e) {
      console.warn('refreshBadges failed', e);
    }
  }

  onChange((payload) => {
    if (payload.store === 'list' || payload.store === 'pantry' || payload.store === 'products') {
      refreshBadges();
    }
  });
  refreshBadges();

  // Throttle error toasts so a burst of failed pushes doesn't spam the user.
  let _lastErrorToastAt = 0;
  const ERROR_TOAST_COOLDOWN_MS = 8000;

  function renderStatus(payload) {
    if (!chip) return;
    const status = payload && payload.status;
    if (status === 'ok') {
      chip.setAttribute('data-state', 'ok');
      chip.textContent = 'Collegato';
    } else if (status === 'error') {
      chip.setAttribute('data-state', 'error');
      chip.textContent = 'Errore sync';
      // Notify the user that communication with the server failed.
      const now = Date.now();
      if (now - _lastErrorToastAt > ERROR_TOAST_COOLDOWN_MS) {
        _lastErrorToastAt = now;
        toast('Sincronizzazione non riuscita. Modifiche salvate solo su questo dispositivo; riprovo più tardi.', 'error', 4000);
      }
    } else {
      // 'offline' / no session: not an error, just not syncing.
      chip.removeAttribute('data-state');
    }
  }
}

// --- Service worker registration + SKIP_WAITING auto-update (§16) -------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // Post SKIP_WAITING to a worker already waiting.
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // A new version is waiting -> activate it immediately.
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    })
    .catch((e) => console.warn('serviceWorker.register failed', e));
}

main();
