// js/views/prodotti.js — Catalog view (design §8, decision D2).
// Lists all live products; search by nameLower.includes + 'solo ricorrenti' toggle.
// 'Elimina' -> confirmSheet -> deleteProductCascade (D2). All Italian.

import * as db from '../db.js';
import {
  getAllProducts,
  normalizeName,
  deleteProductCascade,
  ensureListRef,
  ensureWishlistRef,
  mergePantryQuantity,
  toggleRecurring,
  getOrCreateProduct,
} from '../store.js';
import { el, toast, openSheet, openChoice, confirmSheet, openModal, attachAutocomplete } from '../ui.js';

export function render(container) {
  let query = '';
  let onlyRecurring = false;

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

  const recurringToggle = el('input', {
    type: 'checkbox',
    onChange: (e) => {
      onlyRecurring = e.target.checked;
      renderList();
    },
  });
  const toggleLabel = el('label', { class: 'toggle-label' }, [recurringToggle, el('span', {}, 'Solo ricorrenti')]);

  const addBtn = el(
    'button',
    { type: 'button', class: 'btn btn-primary', onClick: () => openAddProduct() },
    'Aggiungi prodotto'
  );

  const controls = el('div', { class: 'add-bar' }, [
    el('div', { class: 'add-row' }, [searchInput]),
    el('div', { class: 'add-row' }, [addBtn]),
    el('div', { class: 'add-row' }, [toggleLabel]),
  ]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(controls);
  container.appendChild(listEl);

  // --- Add product: name (autocomplete surfaces duplicates) + 'Ricorrente' ---
  function openAddProduct() {
    const nameInput = el('input', {
      type: 'text',
      class: 'input',
      placeholder: 'Nome prodotto…',
      'aria-label': 'Nome prodotto',
    });
    const nameWrap = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Nome'),
      nameInput,
    ]);

    const recurringCheck = el('input', { type: 'checkbox' });
    const recurringLabel = el('label', { class: 'toggle-label' }, [
      recurringCheck,
      el('span', {}, 'Ricorrente'),
    ]);

    const content = el('div', {}, [nameWrap, recurringLabel]);
    const detach = attachAutocomplete(nameInput, {
      onPick: (product) => {
        nameInput.value = product.name;
      },
      onConfirmNew: () => {},
    });

    openModal({
      title: 'Nuovo prodotto',
      content,
      actions: [
        { label: 'Annulla', onClick: (close) => { detach(); close(); } },
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
            detach();
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
        { label: product.recurring ? 'Togli dai ricorrenti' : 'Ricorrenti', icon: '🔁', value: 'recurring' },
        { label: 'Elimina', icon: '🗑️', value: 'delete', danger: true },
      ],
    });

    if (choice === 'toList') {
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
    } else if (choice === 'delete') {
      const ok = await confirmSheet(`Elimina «${product.name}» e le sue voci?`, { okLabel: 'Elimina', danger: true });
      if (ok) {
        await deleteProductCascade(product.id);
        toast('Prodotto eliminato', 'success');
      }
    }
  }

  function buildRow(product) {
    const title = el('div', { class: 'row-title' }, product.name);
    const main = el('div', { class: 'row-main' }, [title]);
    if (product.recurring) main.appendChild(el('div', { class: 'row-sub' }, 'Ricorrente'));
    const kebab = el(
      'button',
      { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(product) },
      '⋮'
    );
    return el('div', { class: 'row' }, [main, kebab]);
  }

  async function renderList() {
    let products = await getAllProducts();
    const q = normalizeName(query);
    if (q !== '') products = products.filter((p) => p.nameLower.includes(q));
    if (onlyRecurring) products = products.filter((p) => p.recurring === true);

    listEl.textContent = '';
    if (products.length === 0) {
      listEl.appendChild(el('div', { class: 'empty' }, 'Nessun prodotto.'));
      listEl.appendChild(
        el(
          'button',
          { type: 'button', class: 'btn btn-primary empty-cta', onClick: () => openAddProduct() },
          'Aggiungi il primo elemento'
        )
      );
      return;
    }

    products.sort((a, b) => a.name.localeCompare(b.name, 'it'));
    for (const product of products) listEl.appendChild(buildRow(product));
  }

  const unsubscribe = db.onChange((payload) => {
    if (payload.store === 'products') renderList();
  });

  renderList();

  return {
    destroy() {
      unsubscribe();
    },
  };
}
