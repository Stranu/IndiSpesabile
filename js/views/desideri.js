// js/views/desideri.js — Wishlist view (design §8).
// Add via a floating "+" that opens a panel (name + autocomplete) ->
// getOrCreateProduct -> ensureWishlistRef (dedupes one live entry per product).
// Multi-select mode (long-press a row or tap "Seleziona") enables bulk
// add-to-list / add-to-pantry / remove. Orphaned-ref rows render '(prodotto eliminato)'.
// All Italian.

import * as db from '../db.js';
import {
  getAllWishlist,
  getProduct,
  getOrCreateProduct,
  ensureWishlistRef,
  ensureListRef,
  removeWishlistItem,
  removeWishlistItemsMany,
  voicesToList,
  voicesToPantry,
  mergePantryQuantity,
  updateProduct,
} from '../store.js';
import {
  el, toast, openSheet, openChoice, openModal, openRenameProduct, nameField, fab,
  selectionController, attachLongPress,
} from '../ui.js';

export function render(container) {
  let lastRendered = [];
  const longPressDetachers = [];

  const selection = selectionController(() => {
    updateSelectionUI();
    renderList();
  });

  // --- Selection action bar ---
  const selCount = el('span', { class: 'sel-count' }, '0 selezionati');
  const selAllBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: selectAllShown }, 'Tutti');
  const selActionsBtn = el('button', { type: 'button', class: 'btn btn-primary sel-actions-btn', onClick: openBulkActions }, 'Azioni');
  const selCancelBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: () => selection.exit() }, 'Annulla');
  const selectionBar = el('div', { class: 'selection-bar', hidden: true }, [
    el('div', { class: 'selection-bar-left' }, [selCancelBtn, selCount]),
    el('div', { class: 'selection-bar-right' }, [selAllBtn, selActionsBtn]),
  ]);

  // --- Toolbar: "Seleziona" ---
  const selectBtn = el('button', { type: 'button', class: 'filter-chip', onClick: () => selection.enter() }, '☑️ Seleziona');
  const toolbar = el('div', { class: 'filter-row toolbar-row' }, [selectBtn]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(toolbar);
  container.appendChild(selectionBar);
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi ai desideri', onClick: openAddForm });
  container.appendChild(addFab);

  function updateSelectionUI() {
    const active = selection.isActive();
    selectionBar.hidden = !active;
    toolbar.hidden = active;
    addFab.hidden = active;
    selCount.textContent = `${selection.count()} selezionati`;
    selActionsBtn.disabled = selection.count() === 0;
  }

  function selectAllShown() {
    for (const it of lastRendered) if (!selection.has(it.id)) selection.toggle(it.id);
  }

  async function openBulkActions() {
    const ids = selection.ids();
    if (ids.length === 0) return;
    const choice = await openSheet({
      title: `${ids.length} desideri selezionati`,
      items: [
        { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
        { label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' },
        { label: 'Rimuovi dai desideri', icon: '🗑️', value: 'remove', danger: true },
      ],
    });
    if (!choice) return;

    if (choice === 'toList') {
      const n = await voicesToList('wishlist', ids);
      toast(`Aggiunti ${n} alla spesa`, 'success');
      selection.exit();
    } else if (choice === 'toPantry') {
      const where = await openChoice('Frigo o Dispensa?', ['Frigo', 'Dispensa']);
      if (!where) return;
      const location = where === 'Frigo' ? 'frigo' : 'dispensa';
      const n = await voicesToPantry('wishlist', ids, location);
      toast(`Aggiunti ${n} in dispensa`, 'success');
      selection.exit();
    } else if (choice === 'remove') {
      const n = await removeWishlistItemsMany(ids);
      toast(`Rimossi ${n} desideri`, 'success');
      selection.exit();
    }
  }

  function openAddForm() {
    const name = nameField({ label: 'Prodotto', placeholder: 'Es. Cioccolato fondente…' });
    const content = el('div', {}, [name.element]);

    const modal = openModal({
      title: 'Aggiungi ai desideri',
      content,
      actions: [
        { label: 'Annulla', onClick: (c) => { name.detach(); c(); } },
        {
          label: 'Aggiungi',
          primary: true,
          onClick: async (c) => {
            const typed = name.value();
            if (typed === '') {
              toast('Inserisci un nome', 'info');
              return;
            }
            const product = await getOrCreateProduct(typed);
            await ensureWishlistRef(product.id);
            name.detach();
            c();
            toast('Aggiunto ai desideri', 'success');
          },
        },
      ],
    });
    name.inputEl.focus();
    return modal;
  }

  async function openRowMenu(item, product) {
    const orphaned = product === undefined;
    const items = [
      { label: 'Modifica nome', icon: '✏️', value: 'rename' },
      { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
      { label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' },
      { label: 'Seleziona più elementi', icon: '☑️', value: 'select' },
      { label: 'Rimuovi', icon: '🗑️', value: 'remove', danger: true },
    ];
    const menuItems = orphaned ? items.filter((i) => i.value === 'remove' || i.value === 'select') : items;

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items: menuItems });
    if (choice === 'rename') {
      if (product) openRenameProduct(product.name, (newName) => updateProduct(product.id, { name: newName }));
    } else if (choice === 'toList') {
      await ensureListRef(item.productId);
      toast('Aggiunto alla spesa', 'success');
    } else if (choice === 'toPantry') {
      const where = await openChoice('Frigo o Dispensa?', ['Frigo', 'Dispensa']);
      if (!where) return;
      const location = where === 'Frigo' ? 'frigo' : 'dispensa';
      const result = await mergePantryQuantity(location, item.productId, null, null);
      if (result && result.merged === false && result.items.length === 2) {
        toast('Unità diverse: tengo le voci separate', 'info');
      } else {
        toast('Aggiunto in dispensa', 'success');
      }
    } else if (choice === 'select') {
      selection.enter(item.id);
    } else if (choice === 'remove') {
      await removeWishlistItem(item.id);
    }
  }

  function buildRow(item, product) {
    const orphaned = product === undefined;
    const selMode = selection.isActive();
    const selected = selection.has(item.id);

    const title = el(
      'div',
      { class: `row-title${orphaned ? ' orphaned' : ''}` },
      orphaned ? '(prodotto eliminato)' : product.name
    );
    const main = el('div', { class: 'row-main' }, [title]);

    const children = [];
    if (selMode) {
      children.push(el('span', { class: `sel-check${selected ? ' checked' : ''}`, 'aria-hidden': 'true' }, selected ? '✓' : ''));
    }
    children.push(main);
    if (!selMode) {
      children.push(el('button', { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(item, product) }, '⋮'));
    }

    const row = el('div', { class: `row${selMode && selected ? ' row-selected' : ''}` }, children);
    if (selMode) {
      row.addEventListener('click', () => selection.toggle(item.id));
    } else {
      longPressDetachers.push(attachLongPress(row, () => selection.enter(item.id)));
    }
    return row;
  }

  function clearLongPress() {
    while (longPressDetachers.length) {
      const d = longPressDetachers.pop();
      try { d(); } catch (_) { /* noop */ }
    }
  }

  // Concurrency guard (see spesa.js): prevents overlapping async renders from
  // duplicating rows when a single mutation fires multiple db.onChange events.
  let _rendering = false;
  let _renderPending = false;
  async function renderList() {
    if (_rendering) { _renderPending = true; return; }
    _rendering = true;
    try {
      await renderListOnce();
    } finally {
      _rendering = false;
      if (_renderPending) {
        _renderPending = false;
        renderList();
      }
    }
  }

  async function renderListOnce() {
    clearLongPress();
    const items = await getAllWishlist();
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    lastRendered = items;

    listEl.textContent = '';
    if (items.length === 0) {
      listEl.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '⭐'),
          el('p', {}, 'Nessun desiderio.'),
          el('button', { type: 'button', class: 'btn btn-primary', onClick: openAddForm }, 'Aggiungi un prodotto'),
        ])
      );
      return;
    }
    for (const item of items) {
      const product = await getProduct(item.productId); // may be undefined -> orphaned
      listEl.appendChild(buildRow(item, product));
    }
  }

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'wishlist' || payload.store === 'products') renderList();
  });

  updateSelectionUI();
  renderList();

  return {
    destroy() {
      unsubscribe();
      clearLongPress();
    },
  };
}
