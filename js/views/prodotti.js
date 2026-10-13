// js/views/prodotti.js — Catalog view (design §8, decision D2).
// Search bar (filters the catalog) + 'Solo ricorrenti' chip. Add a product via the
// floating "+". 'Elimina' -> confirmSheet -> deleteProductCascade (D2). All Italian.

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
import { el, toast, openSheet, openChoice, confirmSheet, openModal, fab } from '../ui.js';

export function render(container) {
  let query = '';
  let onlyRecurring = false;

  // --- Search bar (this input IS a search, not an add) ---
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

  const controls = el('div', { class: 'search-bar' }, [
    el('div', { class: 'search-row' }, [searchInput]),
    el('div', { class: 'filter-row' }, [recurringChip]),
  ]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(controls);
  container.appendChild(listEl);

  const addFab = fab({ label: 'Nuovo prodotto', onClick: openAddProduct });
  container.appendChild(addFab);

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
      toast(product.recurring ? 'Rimosso dai ricorrenti' : 'Aggiunto ai ricorrenti', 'success');
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
    const title = el('div', { class: 'row-title' }, product.name);
    const main = el('div', { class: 'row-main' }, [title]);
    if (product.recurring) {
      main.appendChild(el('div', { class: 'row-chips' }, [el('span', { class: 'tag recurring' }, '🔁 Ricorrente')]));
    }
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
