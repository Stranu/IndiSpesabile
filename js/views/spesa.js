// js/views/spesa.js — Shopping-list view (design §7/§8, decision D3).
// Add via a floating "+" that opens an input panel (name + autocomplete + optional qty),
// plus quick-pick shortcuts from Ricorrenti and Desideri. Quantity is edited from the
// row kebab ("Modifica"), not inline. Bought items stay, struck-through, sorted to the
// bottom (D3). Orphaned-ref rows render '(prodotto eliminato)'. All Italian.

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
  clearBoughtListItems,
  listItemToPantry,
} from '../store.js';
import { el, toast, openSheet, openChoice, openModal, confirmSheet, qtyEditor, nameField, fab } from '../ui.js';
import { formatQty } from '../units.js';

export function render(container) {
  // Bulk action bar: "Svuota comprati" — only shown when there are bought items.
  const clearBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost clear-bought-btn',
      onClick: async () => {
        const ok = await confirmSheet('Rimuovere tutti gli articoli comprati dalla lista?', {
          okLabel: 'Svuota comprati',
          danger: true,
        });
        if (!ok) return;
        const n = await clearBoughtListItems();
        toast(n > 0 ? `Rimossi ${n} articoli comprati` : 'Nessun articolo comprato', 'success');
      },
    },
    '🧹 Svuota comprati'
  );
  const actionBar = el('div', { class: 'action-bar', hidden: true }, [clearBtn]);
  container.appendChild(actionBar);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi alla spesa', onClick: openAddForm });
  container.appendChild(addFab);

  // --- Add panel: name + autocomplete + optional quantity ---
  function openAddForm() {
    const name = nameField({ label: 'Prodotto', placeholder: 'Es. Latte, Pane…' });
    const qty = qtyEditor({});
    const qtyField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Quantità (facoltativa)'),
      qty.element,
    ]);

    // Quick-pick shortcuts live inside the panel so the empty state is never a dead end.
    const ricorrentiBtn = el('button', { type: 'button', class: 'btn chip-btn', onClick: () => pickRicorrenti(close) }, '🔁 Ricorrenti');
    const desideriBtn = el('button', { type: 'button', class: 'btn chip-btn', onClick: () => pickDesideri(close) }, '⭐ Dai desideri');
    const shortcuts = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Oppure scegli da'),
      el('div', { class: 'chip-row' }, [ricorrentiBtn, desideriBtn]),
    ]);

    const content = el('div', {}, [name.element, qtyField, shortcuts]);
    let close = () => {};

    const modal = openModal({
      title: 'Aggiungi alla spesa',
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
            const ref = await ensureListRef(product.id);
            const { qtyValue, qtyUnit } = qty.read();
            if (qtyValue != null) await updateListItem(ref.id, { qtyValue, qtyUnit });
            name.detach();
            c();
            toast('Aggiunto alla spesa', 'success');
          },
        },
      ],
    });
    close = modal.close;
    name.inputEl.focus();
  }

  // --- Quick-pick: Ricorrenti (closes the add panel on choice) ---
  async function pickRicorrenti(closeParent) {
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
      if (typeof closeParent === 'function') closeParent();
      toast('Aggiunto alla spesa', 'success');
    }
  }

  // --- Quick-pick: Desideri ---
  async function pickDesideri(closeParent) {
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
      if (typeof closeParent === 'function') closeParent();
      toast('Aggiunto alla spesa', 'success');
    }
  }

  // --- Edit quantity (from kebab) ---
  function openEditQty(voice, product) {
    const qty = qtyEditor({ value: voice.qtyValue, unit: voice.qtyUnit });
    const content = el('div', {}, [
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Prodotto'),
        el('div', { class: 'row-title' }, product ? product.name : '(prodotto eliminato)'),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Quantità'),
        qty.element,
      ]),
    ]);
    openModal({
      title: 'Modifica quantità',
      content,
      actions: [
        { label: 'Annulla', onClick: (c) => c() },
        {
          label: 'Salva',
          primary: true,
          onClick: async (c) => {
            const { qtyValue, qtyUnit } = qty.read();
            await updateListItem(voice.id, { qtyValue, qtyUnit });
            c();
            toast('Quantità aggiornata', 'success');
          },
        },
      ],
    });
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
      items.push({ label: 'Modifica quantità', icon: '✏️', value: 'edit' });
      items.push({ label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' });
    }
    items.push({ label: 'Scarta', icon: '🗑️', value: 'discard', danger: true });

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items });
    if (choice === 'bought') {
      await markBought(voice.id, true);
    } else if (choice === 'unbought') {
      await markBought(voice.id, false);
    } else if (choice === 'edit') {
      openEditQty(voice, product);
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

  // --- Build a single row (clean: name + qty text, no inline editors) ---
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

    // Toggle the "Svuota comprati" bar based on whether any item is bought.
    actionBar.hidden = !voices.some((v) => v.bought === true);

    if (voices.length === 0) {
      listEl.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🛒'),
          el('p', {}, 'La lista è vuota.'),
          el('button', { type: 'button', class: 'btn btn-primary', onClick: openAddForm }, 'Aggiungi un prodotto'),
        ])
      );
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

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'list' || payload.store === 'products') renderList();
  });

  renderList();

  return {
    destroy() {
      unsubscribe();
    },
  };
}
