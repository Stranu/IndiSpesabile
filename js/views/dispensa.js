// js/views/dispensa.js — Pantry view (design §8).
// Filter tabs Frigo | Dispensa (+ Tutti). Expiry classification via store.daysUntil (no
// string arithmetic). Orphaned-ref rows render '(prodotto eliminato)'. All Italian.

import * as db from '../db.js';
import {
  getAllPantry,
  getProduct,
  getOrCreateProduct,
  daysUntil,
  mergePantryQuantity,
  updatePantryItem,
  removePantryItem,
  ensureListRef,
  ensureWishlistRef,
} from '../store.js';
import { el, toast, openSheet, openModal, attachAutocomplete, qtyEditor } from '../ui.js';
import { formatQty } from '../units.js';

const TABS = [
  { label: 'Frigo', value: 'frigo' },
  { label: 'Dispensa', value: 'dispensa' },
  { label: 'Tutti', value: 'tutti' },
];

export function render(container) {
  let activeTab = 'frigo'; // default Frigo

  // --- Add bar: typed input + autocomplete, then frigo/dispensa choice ---
  const input = el('input', {
    type: 'text',
    class: 'input',
    placeholder: 'Aggiungi alla dispensa…',
    'aria-label': 'Aggiungi un prodotto alla dispensa',
  });

  // Open the add form for a resolved product. Collects location (Frigo/Dispensa),
  // optional quantity, and an optional expiry date, then merges via the store.
  function openAddForm(product) {
    // Default location = active tab unless 'tutti', then 'frigo'.
    let location = activeTab === 'dispensa' ? 'dispensa' : 'frigo';

    const nameLine = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Prodotto'),
      el('div', { class: 'row-title' }, product.name),
    ]);

    const frigoBtn = el('button', { type: 'button', class: 'seg-btn' }, 'Frigo');
    const dispensaBtn = el('button', { type: 'button', class: 'seg-btn' }, 'Dispensa');
    function syncSeg() {
      frigoBtn.classList.toggle('active', location === 'frigo');
      dispensaBtn.classList.toggle('active', location === 'dispensa');
    }
    frigoBtn.addEventListener('click', () => {
      location = 'frigo';
      syncSeg();
    });
    dispensaBtn.addEventListener('click', () => {
      location = 'dispensa';
      syncSeg();
    });
    syncSeg();
    const locField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Posizione'),
      el('div', { class: 'seg' }, [frigoBtn, dispensaBtn]),
    ]);

    const addQty = qtyEditor({});
    const qtyField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Quantità'),
      addQty.element,
    ]);

    const dateInput = el('input', {
      type: 'date',
      class: 'input',
      'aria-label': 'Scadenza',
    });
    const expiryField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Scadenza (facoltativa)'),
      dateInput,
    ]);

    const content = el('div', {}, [nameLine, locField, qtyField, expiryField]);

    openModal({
      title: 'Aggiungi alla dispensa',
      content,
      actions: [
        { label: 'Annulla', onClick: (close) => close() },
        {
          label: 'Aggiungi',
          primary: true,
          onClick: async (close) => {
            const { qtyValue, qtyUnit } = addQty.read();
            const expiry = dateInput.value || null;
            const result = await mergePantryQuantity(location, product.id, qtyValue, qtyUnit);
            if (expiry != null && result && result.items.length) {
              // The just-created/updated entry is the last element of result.items.
              const entry = result.items[result.items.length - 1];
              await updatePantryItem(entry.id, { expiry });
            }
            input.value = '';
            close();
            if (result && result.merged === false && result.items.length === 2) {
              toast('Unità diverse: tengo le voci separate', 'info');
            } else {
              toast('Aggiunto in dispensa', 'success');
            }
          },
        },
      ],
    });
  }

  const detachAuto = attachAutocomplete(input, {
    onPick: (product) => openAddForm(product),
    onConfirmNew: async (name) => {
      const product = await getOrCreateProduct(name);
      openAddForm(product);
    },
  });

  const addBar = el('div', { class: 'add-bar' }, [el('div', { class: 'add-row' }, [input])]);

  // --- Filter tabs ---
  const tabsEl = el('div', { class: 'tabs' });
  TABS.forEach((t) => {
    const btn = el(
      'button',
      {
        type: 'button',
        class: `tab${activeTab === t.value ? ' active' : ''}`,
        onClick: () => {
          activeTab = t.value;
          Array.from(tabsEl.children).forEach((c) =>
            c.classList.toggle('active', c.getAttribute('data-tab') === t.value)
          );
          renderList();
        },
        dataset: { tab: t.value },
      },
      t.label
    );
    tabsEl.appendChild(btn);
  });

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(addBar);
  container.appendChild(tabsEl);
  container.appendChild(listEl);

  // --- Expiry chip ---
  function expiryChip(expiry) {
    if (expiry == null) return null;
    const d = daysUntil(expiry);
    let cls = 'neutral';
    let label = `Scade ${expiry}`;
    if (d < 0) {
      cls = 'scaduto';
      label = 'Scaduto';
    } else if (d <= 3) {
      cls = 'in-scadenza';
      label = d === 0 ? 'Scade oggi' : `Scade tra ${d} g`;
    }
    return el('span', { class: `expiry ${cls}` }, label);
  }

  // --- Row kebab ---
  async function openRowMenu(item, product) {
    const orphaned = product === undefined;
    const items = [
      { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
      { label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' },
      { label: 'Rimuovi', icon: '🗑️', value: 'remove', danger: true },
    ];
    const menuItems = orphaned ? items.filter((i) => i.value === 'remove') : items;

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items: menuItems });
    if (choice === 'toList') {
      await ensureListRef(item.productId);
      toast('Aggiunto alla spesa', 'success');
    } else if (choice === 'toWish') {
      await ensureWishlistRef(item.productId);
      toast('Aggiunto ai desideri', 'success');
    } else if (choice === 'remove') {
      await removePantryItem(item.id);
    }
  }

  // --- Build a row ---
  function buildRow(item, product) {
    const orphaned = product === undefined;

    const title = el(
      'div',
      { class: `row-title${orphaned ? ' orphaned' : ''}` },
      orphaned ? '(prodotto eliminato)' : product.name
    );
    const main = el('div', { class: 'row-main' }, [title]);

    const subBits = [];
    const qtyStr = formatQty(item.qtyValue, item.qtyUnit);
    if (qtyStr) subBits.push(qtyStr);
    if (activeTab === 'tutti') subBits.push(item.location === 'frigo' ? 'Frigo' : 'Dispensa');
    if (subBits.length) main.appendChild(el('div', { class: 'row-sub' }, subBits.join(' · ')));

    const chip = expiryChip(item.expiry);
    if (chip) main.appendChild(chip);

    // Qty editor -> updatePantryItem.
    const editor = qtyEditor({ value: item.qtyValue, unit: item.qtyUnit });
    const qtyBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn qty-commit',
        onClick: async () => {
          const { qtyValue, qtyUnit } = editor.read();
          await updatePantryItem(item.id, { qtyValue, qtyUnit });
          toast('Quantità aggiornata', 'success');
        },
      },
      'OK'
    );

    // Expiry date editor -> updatePantryItem (stores 'YYYY-MM-DD' or null).
    const dateInput = el('input', {
      type: 'date',
      class: 'input',
      value: item.expiry || '',
      'aria-label': 'Scadenza',
      onChange: async (e) => {
        const v = e.target.value || null;
        await updatePantryItem(item.id, { expiry: v });
      },
    });

    main.appendChild(el('div', { class: 'row-qty-edit' }, [editor.element, qtyBtn]));
    main.appendChild(el('div', { class: 'row-expiry-edit' }, [dateInput]));

    const kebab = el(
      'button',
      { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(item, product) },
      '⋮'
    );

    return el('div', { class: 'row' }, [main, kebab]);
  }

  // --- Render list ---
  async function renderList() {
    let items = await getAllPantry();
    if (activeTab !== 'tutti') items = items.filter((i) => i.location === activeTab);

    listEl.textContent = '';
    if (items.length === 0) {
      listEl.appendChild(el('div', { class: 'empty' }, 'Niente qui. Aggiungi un prodotto.'));
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
    if (payload.store === 'pantry' || payload.store === 'products') renderList();
  });

  renderList();

  return {
    destroy() {
      unsubscribe();
      detachAuto();
    },
  };
}
