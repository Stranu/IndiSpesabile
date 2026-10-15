// js/views/spesa.js — Shopping-list view (design §7/§8, decision D3).
// Add via a floating "+" that opens an input panel (name + autocomplete + optional qty),
// plus quick-pick shortcuts from Ricorrenti and Desideri. Quantity is edited from the
// row kebab ("Modifica"), not inline. Bought items stay, struck-through, sorted to the
// bottom (D3). Multi-select mode (long-press a row or tap "Seleziona") enables bulk
// mark-bought / to-pantry / discard. Orphaned-ref rows render '(prodotto eliminato)'.
// All Italian.

import * as db from '../db.js';
import {
  getAllList,
  getProduct,
  getAllProducts,
  getAllWishlist,
  getOrCreateProduct,
  ensureListRef,
  updateListItem,
  updateProduct,
  markBought,
  markBoughtMany,
  discardListItem,
  discardListItemsMany,
  clearBoughtListItems,
  listItemToPantry,
  listItemsToPantryMany,
} from '../store.js';
import {
  el, toast, openSheet, openChoice, openModal, openRenameProduct, confirmSheet, qtyEditor, nameField, fab,
  selectionController, attachLongPress, swipeRow,
} from '../ui.js';
import { formatQty } from '../units.js';

export function render(container) {
  let lastRendered = [];
  const longPressDetachers = [];
  const swipeDetachers = [];

  const selection = selectionController(() => {
    updateSelectionUI();
    renderList();
  });

  // --- "Svuota comprati" bar (shown only when there are bought items & not selecting) ---
  const clearBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn-ghost clear-bought-btn',
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
  const selectBtn = el('button', { type: 'button', class: 'filter-chip', onClick: () => selection.enter() }, '☑️ Seleziona');
  const actionBar = el('div', { class: 'action-bar between', hidden: true }, [selectBtn, clearBtn]);
  container.appendChild(actionBar);

  // --- Selection action bar ---
  const selCount = el('span', { class: 'sel-count' }, '0 selezionati');
  const selAllBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: selectAllShown }, 'Tutti');
  const selActionsBtn = el('button', { type: 'button', class: 'btn btn-primary sel-actions-btn', onClick: openBulkActions }, 'Azioni');
  const selCancelBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: () => selection.exit() }, 'Annulla');
  const selectionBar = el('div', { class: 'selection-bar', hidden: true }, [
    el('div', { class: 'selection-bar-left' }, [selCancelBtn, selCount]),
    el('div', { class: 'selection-bar-right' }, [selAllBtn, selActionsBtn]),
  ]);
  container.appendChild(selectionBar);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi alla spesa', onClick: openAddForm });
  container.appendChild(addFab);

  function updateSelectionUI() {
    const active = selection.isActive();
    selectionBar.hidden = !active;
    addFab.hidden = active;
    selCount.textContent = `${selection.count()} selezionati`;
    selActionsBtn.disabled = selection.count() === 0;
    // The "Svuota comprati"/"Seleziona" bar is managed in renderList (depends on data),
    // but it must always hide while selecting.
    if (active) actionBar.hidden = true;
  }

  function selectAllShown() {
    for (const v of lastRendered) if (!selection.has(v.id)) selection.toggle(v.id);
  }

  async function openBulkActions() {
    const ids = selection.ids();
    if (ids.length === 0) return;
    const choice = await openSheet({
      title: `${ids.length} articoli selezionati`,
      items: [
        { label: 'Segna come comprato', icon: '✅', value: 'bought' },
        { label: 'Segna come da comprare', icon: '↩️', value: 'unbought' },
        { label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' },
        { label: 'Scarta (rimuovi)', icon: '🗑️', value: 'discard', danger: true },
      ],
    });
    if (!choice) return;

    if (choice === 'bought') {
      const n = await markBoughtMany(ids, true);
      toast(`${n} segnati come comprati`, 'success');
      selection.exit();
    } else if (choice === 'unbought') {
      const n = await markBoughtMany(ids, false);
      toast(`${n} segnati come da comprare`, 'success');
      selection.exit();
    } else if (choice === 'toPantry') {
      const where = await openChoice('Frigo o Dispensa?', ['Frigo', 'Dispensa']);
      if (!where) return;
      const location = where === 'Frigo' ? 'frigo' : 'dispensa';
      const n = await listItemsToPantryMany(ids, location);
      toast(`Spostati ${n} in dispensa`, 'success');
      selection.exit();
    } else if (choice === 'discard') {
      const ok = await confirmSheet(`Scartare ${ids.length} articoli dalla lista?`, { okLabel: 'Scarta', danger: true });
      if (ok) {
        const n = await discardListItemsMany(ids);
        toast(`Scartati ${n} articoli`, 'success');
        selection.exit();
      }
    }
  }

  // --- Add panel: name + autocomplete + optional quantity ---
  function openAddForm() {
    const name = nameField({ label: 'Prodotto', placeholder: 'Es. Latte, Pane…' });
    const qty = qtyEditor({});
    const qtyField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Quantità (facoltativa)'),
      qty.element,
    ]);

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
      items.push({ label: 'Modifica quantità', icon: '🔢', value: 'edit' });
      items.push({ label: 'Modifica nome', icon: '✏️', value: 'rename' });
      items.push({ label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' });
    }
    items.push({ label: 'Seleziona più elementi', icon: '☑️', value: 'select' });
    items.push({ label: 'Scarta', icon: '🗑️', value: 'discard', danger: true });

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items });
    if (choice === 'bought') {
      await markBought(voice.id, true);
    } else if (choice === 'unbought') {
      await markBought(voice.id, false);
    } else if (choice === 'edit') {
      openEditQty(voice, product);
    } else if (choice === 'rename') {
      if (product) openRenameProduct(product.name, (newName) => updateProduct(product.id, { name: newName }));
    } else if (choice === 'select') {
      selection.enter(voice.id);
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
    const selMode = selection.isActive();
    const selected = selection.has(voice.id);

    const title = el(
      'div',
      { class: `row-title${orphaned ? ' orphaned' : ''}` },
      orphaned ? '(prodotto eliminato)' : product.name
    );
    const main = el('div', { class: 'row-main' }, [title]);

    const qtyStr = formatQty(voice.qtyValue, voice.qtyUnit);
    if (qtyStr) main.appendChild(el('div', { class: 'row-sub' }, qtyStr));

    const children = [];
    if (selMode) {
      children.push(el('span', { class: `sel-check${selected ? ' checked' : ''}`, 'aria-hidden': 'true' }, selected ? '✓' : ''));
    }
    children.push(main);
    if (!selMode) {
      children.push(el('button', { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(voice, product) }, '⋮'));
    }

    const row = el('div', { class: `row${voice.bought ? ' bought' : ''}${selMode && selected ? ' row-selected' : ''}` }, children);
    if (selMode) {
      row.addEventListener('click', () => selection.toggle(voice.id));
      return row;
    }

    longPressDetachers.push(attachLongPress(row, () => selection.enter(voice.id)));

    // Swipe: right = mark bought (only for not-yet-bought, non-orphan rows),
    // left = discard. Orphan rows can still be discarded.
    const sw = swipeRow(row, {
      onSwipeLeft: () => discardListItem(voice.id),
      onSwipeRight: (!orphaned && !voice.bought) ? () => markBought(voice.id, true) : undefined,
      leftLabel: 'Elimina',
      leftIcon: '🗑️',
      rightLabel: 'Comprato',
      rightIcon: '✅',
    });
    swipeDetachers.push(sw.detach);
    return sw.element;
  }

  function clearLongPress() {
    while (longPressDetachers.length) {
      const d = longPressDetachers.pop();
      try { d(); } catch (_) { /* noop */ }
    }
    while (swipeDetachers.length) {
      const d = swipeDetachers.pop();
      try { d(); } catch (_) { /* noop */ }
    }
  }

  // --- Render the whole list ---
  // Concurrency guard: renderList is async and a single add fires multiple
  // db.onChange events (product + voice). Without this, overlapping renders each
  // clear + append and the list shows duplicates until reload. If a render is
  // requested while one runs, we re-run exactly once after it finishes.
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
    const voices = await getAllList();

    // "Svuota comprati"/"Seleziona" bar: shown when there are items and NOT selecting.
    const hasBought = voices.some((v) => v.bought === true);
    clearBtn.hidden = !hasBought;
    actionBar.hidden = selection.isActive() || voices.length === 0;

    listEl.textContent = '';

    if (voices.length === 0) {
      lastRendered = [];
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
    lastRendered = voices;

    for (const voice of voices) {
      const product = await getProduct(voice.productId); // may be undefined -> orphaned
      listEl.appendChild(buildRow(voice, product));
    }
  }

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'list' || payload.store === 'products') renderList();
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
