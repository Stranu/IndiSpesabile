// js/app.js — bootstrap (design §15): openDB guard, SW auto-update, router, header,
// auth-state-driven sync (the SOLE fullSync driver for login), sync.init(). All Italian.

import { openDB } from './db.js';
import { getMeta, setMeta } from './store.js';
import { onAuthStateChange, getSession } from './supabase.js';
import * as sync from './sync.js';
import { startRouter } from './router.js';
import { openModal } from './ui.js';
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
  if (syncBtn) syncBtn.addEventListener('click', () => sync.fullSync());

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

  function updateChip(session) {
    if (!chip) return;
    if (session && session.user) {
      chip.textContent = session.user.email || 'Collegato';
    } else {
      chip.textContent = 'Accedi';
    }
  }

  // Initial chip state from the current session (if any).
  try {
    const { data } = await getSession();
    updateChip(data.session);
  } catch (e) {
    console.warn('getSession at bootstrap failed', e);
    updateChip(null);
  }

  // 5) Auth-state handler — the SOLE fullSync driver for login.
  onAuthStateChange(async (event, session) => {
    updateChip(session);

    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
      const prev = await getMeta('lastSyncUser');
      if (prev != null && prev !== session.user.id) {
        // Account switch: clear domain stores + reset cursors + set lastSyncUser, THEN fullSync.
        await sync.switchAccount(session.user.id); // runs fullSync internally
      } else {
        await setMeta('lastSyncUser', session.user.id);
        await sync.fullSync();
      }
    } else if (event === 'SIGNED_OUT') {
      // Keep local data/cursors; leave lastSyncUser. Just flag offline.
      renderStatus({ status: 'offline' });
    }
  });

  // 6) sync.init() + status chip updater.
  sync.onStatus(renderStatus);
  sync.init();

  function renderStatus(payload) {
    if (!chip) return;
    const status = payload && payload.status;
    if (status === 'ok') {
      chip.setAttribute('data-state', 'ok');
    } else if (status === 'error') {
      chip.setAttribute('data-state', 'error');
    } else {
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
