// js/router.js — hash-based routing (design §10).
// Routes: '#/spesa' (default), '#/dispensa', '#/desideri', '#/prodotti'.
// Each view module exports render(container) -> { destroy }.

import { el } from './ui.js';

const DEFAULT_ROUTE = '/spesa';

let _routes = null;
let _mount = null;
let _current = null; // { path, destroy }

// Resolve the current hash to a known route path, falling back to '/spesa'.
function resolvePath() {
  const hash = location.hash || '';
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (_routes && Object.prototype.hasOwnProperty.call(_routes, path)) return path;
  return DEFAULT_ROUTE;
}

function render() {
  const path = resolvePath();

  // Tear down the previous view (unregisters its onChange listener, etc.).
  if (_current && typeof _current.destroy === 'function') {
    try {
      _current.destroy();
    } catch (e) {
      console.warn('router: previous view destroy threw', e);
    }
  }
  _current = null;

  // Clear the mount container.
  _mount.textContent = '';

  const renderFn = _routes[path];
  let handle = {};
  try {
    handle = renderFn(_mount) || {};
  } catch (e) {
    // Defense in depth: a view throw must never leave a mute section.
    console.warn('router: view render threw', e);
    _mount.textContent = '';
    _mount.appendChild(
      el('div', { class: 'empty' }, 'Si è verificato un errore nel caricare questa sezione.')
    );
  }
  _current = { path, destroy: handle.destroy };

  // Reflect the active route on the bottom-nav buttons.
  updateNav(path);
}

function updateNav(path) {
  const buttons = document.querySelectorAll('.nav-btn');
  buttons.forEach((btn) => {
    const route = btn.getAttribute('data-route');
    btn.classList.toggle('active', route === path);
  });
}

// startRouter(routes, { mount }) — routes: { '/spesa': renderFn, ... }
export function startRouter(routes, { mount }) {
  _routes = routes;
  _mount = mount;

  // Wire bottom-nav buttons to navigate.
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const route = btn.getAttribute('data-route');
    if (route) btn.addEventListener('click', () => navigate(route));
  });

  window.addEventListener('hashchange', render);

  // Normalize an empty hash to the default (updates the address bar without a reload).
  if ((location.hash || '') === '') {
    // Use replaceState so we don't push an extra history entry; render below handles it.
    history.replaceState(null, '', '#' + DEFAULT_ROUTE);
  }
  render();
}

// refresh() — re-render the current route in place (tears down + rebuilds the
// current view). Used after an auth state change so the mounted section reflects
// the new session immediately, without waiting for a store write to arrive.
export function refresh() {
  if (_routes && _mount) render();
}

// navigate(path) — sets location.hash (triggers hashchange -> render).
export function navigate(path) {
  const target = '#' + path;
  if (location.hash === target) {
    // Same hash: hashchange won't fire; re-render directly.
    render();
  } else {
    location.hash = target;
  }
}
