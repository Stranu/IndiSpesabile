// js/views/spesa.js — Shopping-list view (design §7/§8, decision D3).
// Three add paths ALL go through store.ensureListRef. Bought items stay, struck-through,
// sorted to the bottom (D3). Orphaned-ref rows render '(prodotto eliminato)'. All Italian.

import * as db from '../db.js';
import {
  getAllList,
  getProduct,
  getAllProducts,
  getAllWishlist,
  getOrCreateProduct,
  ensureListRef,
  updateListItem,
  markBought,
  discardListItem,
  listItemToPantry,
} from '../store.js';
import { el, toast, openSheet, openChoice, attachAutocomplete, qtyEditor } from '../ui.js';
import { formatQty } from '../units.js';

export function render(container) {
  // --- Add bar: typed input + autocomplete + optional qty + quick-pick buttons ---
  const input = el('input', {
    type: 'text',
    class: 'input',
    placeholder: 'Aggiungi un prodotto…',
    'aria-label': 'Aggiungi un prodotto',
  });
  const addQty = qtyEditor({});

  async function addTyped(product) {
    const ref = await ensureListRef(product.id);
    const { qtyValue, qtyUnit } = addQty.read();
    if (qtyValue != null) {
      await updateListItem(ref.id, { qtyValue, qtyUnit });
    }
    input.value = '';
    addQty.element.querySelector('.qty-value').value = '';
    toast('Aggiunto alla spesa', 'success');
  }

  const detachAuto = attachAutocomplete(input, {
    onPick: (product) => addTyped(product),
    onConfirmNew: async (name) => {
      const product = await getOrCreateProduct(name);
      await addTyped(product);
    },
  });

  const ricorrentiBtn = el(
    'button',
    { type: 'button', class: 'btn', onClick: pickRicorrenti },
    'Ricorrenti'
  );
  const desideriBtn = el(
    'button',
    { type: 'button', class: 'btn', onClick: pickDesideri },
    'Da desideri'
  );

  const addBar = el('div', { class: 'add-bar' }, [
    el('div', { class: 'add-row' }, [input]),
    el('div', { class: 'add-row' }, [addQty.element]),
    el('div', { class: 'add-row quick-picks' }, [ricorrentiBtn, desideriBtn]),
  ]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(addBar);
  container.appendChild(listEl);

  // --- Quick-pick: Ricorrenti ---
  async function pickRicorrenti() {
    const products = (await getAllProducts()).filter((p) => p.recurring === true);
    if (products.length === 0) {
      toast('Nessun prodotto ricorrente', 'info');
      return;
    }
    const value = await openSheet({
      title: 'Ricorrenti',
      items: products
        .sort((a, b) => a.name.localeCompare(b.name, 'it'))
        .map((p) => ({ label: p.name, value: p.id })),
    });
    if (value) {
      await ensureListRef(value);
      toast('Aggiunto alla spesa', 'success');
    }
  }

  // --- Quick-pick: Desideri ---
  async function pickDesideri() {
    const wishes = await getAllWishlist();
    const items = [];
    for (const w of wishes) {
      const p = await getProduct(w.productId);
      if (p) items.push({ label: p.name, value: p.id });
    }
    if (items.length === 0) {
      toast('Nessun desiderio in lista', 'info');
      return;
    }
    const value = await openSheet({
      title: 'Dai desideri',
      items: items.sort((a, b) => a.label.localeCompare(b.label, 'it')),
    });
    if (value) {
      await ensureListRef(value);
      toast('Aggiunto alla spesa', 'success');
    }
  }

  // --- Row kebab actions ---
  async function openRowMenu(voice, product) {
    const orphaned = product === undefined;
    const items = [];
    if (!orphaned) {
      if (voice.bought) {
        items.push({ label: 'Segna come da comprare', icon: '↩️', value: 'unbought' });
      } else {
        items.push({ label: 'Segna come comprato', icon: '✅', value: 'bought' });
      }
    }
    items.push({ label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' });
    items.push({ label: 'Scarta', icon: '🗑️', value: 'discard', danger: true });

    // Orphaned rows: only the destructive action is enabled.
    const menuItems = orphaned ? items.filter((i) => i.value === 'discard') : items;

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items: menuItems });
    if (choice === 'bought') {
      await markBought(voice.id, true);
    } else if (choice === 'unbought') {
      await markBought(voice.id, false);
    } else if (choice === 'discard') {
      await discardListItem(voice.id);
    } else if (choice === 'toPantry') {
      const where = await openChoice('Frigo o Dispensa?', ['Frigo', 'Dispensa']);
      if (!where) return;
      const location = where === 'Frigo' ? 'frigo' : 'dispensa';
      const result = await listItemToPantry(voice.id, location);
      if (result && result.merged === false && result.items.length === 2) {
        toast('Unità diverse: tengo le voci separate', 'info');
      } else {
        toast('Aggiunto in dispensa', 'success');
      }
    }
  }

  // --- Build a single row ---
  function buildRow(voice, product) {
    const orphaned = product === undefined;

    const title = el(
      'div',
      { class: `row-title${orphaned ? ' orphaned' : ''}` },
      orphaned ? '(prodotto eliminato)' : product.name
    );

    const main = el('div', { class: 'row-main' }, [title]);

    const qtyStr = formatQty(voice.qtyValue, voice.qtyUnit);
    if (qtyStr) main.appendChild(el('div', { class: 'row-sub' }, qtyStr));

    // Per-row compact qty editor committing via updateListItem.
    const editor = qtyEditor({ value: voice.qtyValue, unit: voice.qtyUnit });
    const commitBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn qty-commit',
        onClick: async () => {
          const { qtyValue, qtyUnit } = editor.read();
          await updateListItem(voice.id, { qtyValue, qtyUnit });
          toast('Quantità aggiornata', 'success');
        },
      },
      'OK'
    );
    const editorWrap = el('div', { class: 'row-qty-edit' }, [editor.element, commitBtn]);
    main.appendChild(editorWrap);

    const kebab = el(
      'button',
      { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(voice, product) },
      '⋮'
    );

    return el('div', { class: `row${voice.bought ? ' bought' : ''}` }, [main, kebab]);
  }

  // --- Render the whole list ---
  async function renderList() {
    const voices = await getAllList();
    listEl.textContent = '';

    if (voices.length === 0) {
      listEl.appendChild(el('div', { class: 'empty' }, 'La lista è vuota. Aggiungi un prodotto.'));
      return;
    }

    // Not-bought first; bought struck-through and sorted to the BOTTOM (D3).
    voices.sort((a, b) => {
      if (a.bought !== b.bought) return a.bought ? 1 : -1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

    for (const voice of voices) {
      const product = await getProduct(voice.productId); // may be undefined -> orphaned
      listEl.appendChild(buildRow(voice, product));
    }
  }

  // Reactivity: re-read the list store on any onChange for 'list' (tolerate type:'tx', id undefined).
  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'list' || payload.store === 'products') renderList();
  });

  renderList();

  return {
    destroy() {
      unsubscribe();
      detachAuto();
    },
  };
}
