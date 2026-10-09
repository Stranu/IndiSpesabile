// js/views/desideri.js — Wishlist view (design §8).
// Typed add -> getOrCreateProduct -> ensureWishlistRef (dedupes one live entry per product).
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
import { el, toast, openSheet, openChoice, attachAutocomplete } from '../ui.js';

export function render(container) {
  const input = el('input', {
    type: 'text',
    class: 'input',
    placeholder: 'Aggiungi ai desideri…',
    'aria-label': 'Aggiungi un prodotto ai desideri',
  });

  async function addWish(product) {
    await ensureWishlistRef(product.id);
    input.value = '';
    toast('Aggiunto ai desideri', 'success');
  }

  const detachAuto = attachAutocomplete(input, {
    onPick: (product) => addWish(product),
    onConfirmNew: async (name) => {
      const product = await getOrCreateProduct(name);
      await addWish(product);
    },
  });

  const addBar = el('div', { class: 'add-bar' }, [el('div', { class: 'add-row' }, [input])]);
  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(addBar);
  container.appendChild(listEl);

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
      listEl.appendChild(el('div', { class: 'empty' }, 'Nessun desiderio. Aggiungi un prodotto.'));
      listEl.appendChild(
        el(
          'button',
          { type: 'button', class: 'btn btn-primary empty-cta', onClick: () => input.focus() },
          'Aggiungi il primo elemento'
        )
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
      detachAuto();
    },
  };
}
