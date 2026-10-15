// js/views/prodotti.js — Catalog view (design §8, decision D2).
// Search bar (filters the catalog) + 'Solo ricorrenti' chip. Add a product via the
// floating "+". Single-item actions via the row kebab; multi-select mode (long-press
// a row or tap "Seleziona") enables bulk add-to-list / wishlist / recurring / delete.
// All Italian.

import * as db from '../db.js';
import {
  getAllProducts,
  normalizeName,
  deleteProductCascade,
  deleteProductsCascade,
  addProductsToList,
  addProductsToWishlist,
  setRecurringMany,
  ensureListRef,
  ensureWishlistRef,
  mergePantryQuantity,
  toggleRecurring,
  updateProduct,
  getOrCreateProduct,
} from '../store.js';
import {
  el, toast, openSheet, openChoice, confirmSheet, openModal, openRenameProduct, fab,
  selectionController, attachLongPress,
} from '../ui.js';

export function render(container) {
  let query = '';
  let onlyRecurring = false;
  let lastRendered = []; // products currently shown (for "seleziona tutti")
  const longPressDetachers = [];

  const selection = selectionController(() => {
    updateSelectionUI();
    renderList();
  });

  // --- Search bar ---
  const searchInput = el('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Cerca un prodotto…',
    'aria-label': 'Cerca un prodotto',
    onInput: (e) => {
      query = e.target.value;
      renderList();
    },
  });

  const recurringChip = el(
    'button',
    {
      type: 'button',
      class: 'filter-chip',
      'aria-pressed': 'false',
      onClick: () => {
        onlyRecurring = !onlyRecurring;
        recurringChip.classList.toggle('active', onlyRecurring);
        recurringChip.setAttribute('aria-pressed', String(onlyRecurring));
        renderList();
      },
    },
    '🔁 Solo ricorrenti'
  );

  const selectBtn = el(
    'button',
    { type: 'button', class: 'filter-chip', onClick: () => selection.enter() },
    '☑️ Seleziona'
  );

  const controls = el('div', { class: 'search-bar' }, [
    el('div', { class: 'search-row' }, [searchInput]),
    el('div', { class: 'filter-row' }, [recurringChip, selectBtn]),
  ]);

  // --- Selection action bar (shown only in selection mode) ---
  const selCount = el('span', { class: 'sel-count' }, '0 selezionati');
  const selAllBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: selectAllShown }, 'Tutti');
  const selActionsBtn = el('button', { type: 'button', class: 'btn btn-primary sel-actions-btn', onClick: openBulkActions }, 'Azioni');
  const selCancelBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: () => selection.exit() }, 'Annulla');
  const selectionBar = el('div', { class: 'selection-bar', hidden: true }, [
    el('div', { class: 'selection-bar-left' }, [selCancelBtn, selCount]),
    el('div', { class: 'selection-bar-right' }, [selAllBtn, selActionsBtn]),
  ]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(controls);
  container.appendChild(selectionBar);
  container.appendChild(listEl);

  const addFab = fab({ label: 'Nuovo prodotto', onClick: openAddProduct });
  container.appendChild(addFab);

  function updateSelectionUI() {
    const active = selection.isActive();
    selectionBar.hidden = !active;
    controls.hidden = active; // hide search/filters while selecting to reduce clutter
    addFab.hidden = active;
    selCount.textContent = `${selection.count()} selezionati`;
    selActionsBtn.disabled = selection.count() === 0;
  }

  function selectAllShown() {
    for (const p of lastRendered) if (!selection.has(p.id)) selection.toggle(p.id);
  }

  // --- Bulk actions sheet ---
  async function openBulkActions() {
    const ids = selection.ids();
    if (ids.length === 0) return;
    const choice = await openSheet({
      title: `${ids.length} prodotti selezionati`,
      items: [
        { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
        { label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' },
        { label: 'Aggiungi ai ricorrenti', icon: '🔁', value: 'recOn' },
        { label: 'Togli dai ricorrenti', icon: '🚫', value: 'recOff' },
        { label: 'Elimina selezionati', icon: '🗑️', value: 'delete', danger: true },
      ],
    });
    if (!choice) return;

    if (choice === 'toList') {
      const n = await addProductsToList(ids);
      toast(`Aggiunti ${n} alla spesa`, 'success');
      selection.exit();
    } else if (choice === 'toWish') {
      const n = await addProductsToWishlist(ids);
      toast(`Aggiunti ${n} ai desideri`, 'success');
      selection.exit();
    } else if (choice === 'recOn') {
      const n = await setRecurringMany(ids, true);
      toast(`${n} segnati come ricorrenti`, 'success');
      selection.exit();
    } else if (choice === 'recOff') {
      const n = await setRecurringMany(ids, false);
      toast(`${n} rimossi dai ricorrenti`, 'success');
      selection.exit();
    } else if (choice === 'delete') {
      const ok = await confirmSheet(
        `Eliminare ${ids.length} prodotti? Verranno rimossi dal catalogo e da spesa, dispensa e desideri. L'azione non è reversibile.`,
        { okLabel: 'Elimina', danger: true }
      );
      if (ok) {
        const n = await deleteProductsCascade(ids);
        toast(`Eliminati ${n} prodotti`, 'success');
        selection.exit();
      }
    }
  }

  // --- Add product: name + 'Ricorrente' flag ---
  function openAddProduct() {
    const nameInput = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'Nome prodotto…',
      autocomplete: 'off',
      'aria-label': 'Nome prodotto',
    });
    const nameWrap = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Nome'),
      nameInput,
    ]);

    const recurringCheck = el('input', { type: 'checkbox' });
    const recurringLabel = el('label', { class: 'toggle-label' }, [
      recurringCheck,
      el('span', {}, 'Ricorrente (preferito)'),
    ]);

    const content = el('div', {}, [nameWrap, recurringLabel]);

    openModal({
      title: 'Nuovo prodotto',
      content,
      actions: [
        { label: 'Annulla', onClick: (close) => close() },
        {
          label: 'Aggiungi',
          primary: true,
          onClick: async (close) => {
            const name = nameInput.value.trim();
            if (name === '') {
              toast('Inserisci un nome', 'info');
              return;
            }
            const product = await getOrCreateProduct(name);
            if (recurringCheck.checked && product.recurring !== true) {
              await toggleRecurring(product.id);
            }
            close();
            toast('Prodotto aggiunto', 'success');
          },
        },
      ],
    });

    nameInput.focus();
  }

  async function openRowMenu(product) {
    const choice = await openSheet({
      title: product.name,
      items: [
        { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
        { label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' },
        { label: 'Aggiungi alla dispensa', icon: '🧺', value: 'toPantry' },
        { label: product.recurring ? 'Togli dai ricorrenti' : 'Aggiungi ai ricorrenti', icon: '🔁', value: 'recurring' },
        { label: 'Modifica nome', icon: '✏️', value: 'rename' },
        { label: 'Seleziona più elementi', icon: '☑️', value: 'select' },
        { label: 'Elimina', icon: '🗑️', value: 'delete', danger: true },
      ],
    });

    if (choice === 'rename') {
      openRenameProduct(product.name, (newName) => updateProduct(product.id, { name: newName }));
    } else if (choice === 'toList') {
      await ensureListRef(product.id);
      toast('Aggiunto alla spesa', 'success');
    } else if (choice === 'toWish') {
      await ensureWishlistRef(product.id);
      toast('Aggiunto ai desideri', 'success');
    } else if (choice === 'toPantry') {
      const where = await openChoice('Frigo o Dispensa?', ['Frigo', 'Dispensa']);
      if (!where) return;
      const location = where === 'Frigo' ? 'frigo' : 'dispensa';
      const result = await mergePantryQuantity(location, product.id, null, null);
      if (result && result.merged === false && result.items.length === 2) {
        toast('Unità diverse: tengo le voci separate', 'info');
      } else {
        toast('Aggiunto in dispensa', 'success');
      }
    } else if (choice === 'recurring') {
      await toggleRecurring(product.id);
      toast(product.recurring ? 'Rimosso dai ricorrenti' : 'Aggiunto ai ricorrenti', 'success');
    } else if (choice === 'select') {
      selection.enter(product.id);
    } else if (choice === 'delete') {
      const ok = await confirmSheet(
        `Eliminare «${product.name}»? Verrà rimosso dal catalogo e da spesa, dispensa e desideri. L'azione non è reversibile.`,
        { okLabel: 'Elimina', danger: true }
      );
      if (ok) {
        await deleteProductCascade(product.id);
        toast('Prodotto eliminato', 'success');
      }
    }
  }

  function buildRow(product) {
    const selMode = selection.isActive();
    const selected = selection.has(product.id);

    const title = el('div', { class: 'row-title' }, product.name);
    const main = el('div', { class: 'row-main' }, [title]);
    if (product.recurring) {
      main.appendChild(el('div', { class: 'row-chips' }, [el('span', { class: 'tag recurring' }, '🔁 Ricorrente')]));
    }

    const children = [];
    if (selMode) {
      // A checkbox marker replaces the kebab while selecting.
      children.push(
        el('span', { class: `sel-check${selected ? ' checked' : ''}`, 'aria-hidden': 'true' }, selected ? '✓' : '')
      );
    }
    children.push(main);
    if (!selMode) {
      children.push(
        el('button', { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(product) }, '⋮')
      );
    }

    const row = el('div', { class: `row${selMode && selected ? ' row-selected' : ''}` }, children);

    if (selMode) {
      // Tapping the row toggles selection.
      row.addEventListener('click', () => selection.toggle(product.id));
    } else {
      // Long-press enters selection mode pre-selecting this row.
      const detach = attachLongPress(row, () => selection.enter(product.id));
      longPressDetachers.push(detach);
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
    let products = await getAllProducts();
    const q = normalizeName(query);
    if (q !== '') products = products.filter((p) => p.nameLower.includes(q));
    if (onlyRecurring) products = products.filter((p) => p.recurring === true);

    products.sort((a, b) => a.name.localeCompare(b.name, 'it'));
    lastRendered = products;

    listEl.textContent = '';
    if (products.length === 0) {
      const emptyMsg = query || onlyRecurring ? 'Nessun prodotto trovato.' : 'Nessun prodotto.';
      listEl.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '📋'),
          el('p', {}, emptyMsg),
          el('button', { type: 'button', class: 'btn btn-primary', onClick: openAddProduct }, 'Aggiungi un prodotto'),
        ])
      );
      return;
    }

    for (const product of products) listEl.appendChild(buildRow(product));
  }

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'products') renderList();
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
