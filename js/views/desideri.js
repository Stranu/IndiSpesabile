// js/views/desideri.js — Wishlist view (design §8).
// Add via a floating "+" that opens a panel (name + autocomplete) ->
// getOrCreateProduct -> ensureWishlistRef (dedupes one live entry per product).
// Orphaned-ref rows render '(prodotto eliminato)'. All Italian.

import * as db from '../db.js';
import {
  getAllWishlist,
  getProduct,
  getOrCreateProduct,
  ensureWishlistRef,
  ensureListRef,
  removeWishlistItem,
  mergePantryQuantity,
} from '../store.js';
import { el, toast, openSheet, openChoice, openModal, nameField, fab } from '../ui.js';

export function render(container) {
  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi ai desideri', onClick: openAddForm });
  container.appendChild(addFab);

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
      { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
      { label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' },
      { label: 'Rimuovi', icon: '🗑️', value: 'remove', danger: true },
    ];
    const menuItems = orphaned ? items.filter((i) => i.value === 'remove') : items;

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items: menuItems });
    if (choice === 'toList') {
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
    } else if (choice === 'remove') {
      await removeWishlistItem(item.id);
    }
  }

  function buildRow(item, product) {
    const orphaned = product === undefined;
    const title = el(
      'div',
      { class: `row-title${orphaned ? ' orphaned' : ''}` },
      orphaned ? '(prodotto eliminato)' : product.name
    );
    const main = el('div', { class: 'row-main' }, [title]);
    const kebab = el(
      'button',
      { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(item, product) },
      '⋮'
    );
    return el('div', { class: 'row' }, [main, kebab]);
  }

  async function renderList() {
    const items = await getAllWishlist();
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
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const item of items) {
      const product = await getProduct(item.productId); // may be undefined -> orphaned
      listEl.appendChild(buildRow(item, product));
    }
  }

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'wishlist' || payload.store === 'products') renderList();
  });

  renderList();

  return {
    destroy() {
      unsubscribe();
    },
  };
}
