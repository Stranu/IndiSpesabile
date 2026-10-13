// js/views/dispensa.js — Pantry view (design §8).
// Segmented filter Frigo | Dispensa | Tutti. Add via a floating "+" that opens a panel
// (name + autocomplete, location, optional quantity, optional expiry). Row quantity/expiry
// are edited from the kebab ("Modifica"), not inline. Expiry classification via daysUntil.
// Orphaned-ref rows render '(prodotto eliminato)'. All Italian.

import * as db from '../db.js';
import {
  getAllPantry,
  getProduct,
  getOrCreateProduct,
  daysUntil,
  expiryLevel,
  mergePantryQuantity,
  updatePantryItem,
  removePantryItem,
  ensureListRef,
  ensureWishlistRef,
} from '../store.js';
import { el, toast, openSheet, openModal, qtyEditor, nameField, fab } from '../ui.js';
import { formatQty } from '../units.js';

const TABS = [
  { label: 'Frigo', value: 'frigo' },
  { label: 'Dispensa', value: 'dispensa' },
  { label: 'Tutti', value: 'tutti' },
];

// Severity icon + accessible label per expiry level (shared source: store.expiryLevel).
const EXPIRY_ICON = {
  warn: { icon: '🟡', label: 'In scadenza (entro una settimana)' },
  soon: { icon: '🟠', label: 'In scadenza (pochi giorni)' },
  today: { icon: '🔴', label: 'Scade oggi' },
  expired: { icon: '⚠️', label: 'Scaduto' },
};

// Sort rank: most urgent first (expired < today < soon < warn < ok/none).
const EXPIRY_RANK = { expired: 0, today: 1, soon: 2, warn: 3, ok: 4, null: 5 };

export function render(container) {
  let activeTab = 'frigo'; // default Frigo
  let onlyExpiring = false;

  // --- Segmented filter ---
  const tabsEl = el('div', { class: 'segmented' });
  TABS.forEach((t) => {
    const btn = el(
      'button',
      {
        type: 'button',
        class: `segmented-btn${activeTab === t.value ? ' active' : ''}`,
        dataset: { tab: t.value },
        onClick: () => {
          activeTab = t.value;
          Array.from(tabsEl.children).forEach((c) =>
            c.classList.toggle('active', c.getAttribute('data-tab') === t.value)
          );
          renderList();
        },
      },
      t.label
    );
    tabsEl.appendChild(btn);
  });

  // "Solo in scadenza" filter chip (orthogonal to the Frigo/Dispensa/Tutti tabs).
  const expiringChip = el(
    'button',
    {
      type: 'button',
      class: 'filter-chip',
      'aria-pressed': 'false',
      onClick: () => {
        onlyExpiring = !onlyExpiring;
        expiringChip.classList.toggle('active', onlyExpiring);
        expiringChip.setAttribute('aria-pressed', String(onlyExpiring));
        renderList();
      },
    },
    '⏰ Solo in scadenza'
  );
  const filterRow = el('div', { class: 'filter-row' }, [expiringChip]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(tabsEl);
  container.appendChild(filterRow);
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi alla dispensa', onClick: () => openAddForm() });
  container.appendChild(addFab);

  // --- Add / edit panel.
  // mode 'add': resolves a product from a typed name, then merges into the pantry.
  // mode 'edit': edits quantity + expiry of an existing pantry item in place.
  function openAddForm() {
    const defaultLocation = activeTab === 'dispensa' ? 'dispensa' : 'frigo';
    const name = nameField({ label: 'Prodotto', placeholder: 'Es. Yogurt, Riso…' });

    let location = defaultLocation;
    const { field: locField, read: readLocation } = buildLocationSeg(location, (l) => { location = l; });

    const qty = qtyEditor({});
    const qtyField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Quantità (facoltativa)'),
      qty.element,
    ]);

    const dateInput = el('input', { type: 'date', class: 'input', 'aria-label': 'Scadenza' });
    const expiryField = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Scadenza (facoltativa)'),
      dateInput,
    ]);

    const content = el('div', {}, [name.element, locField, qtyField, expiryField]);

    const modal = openModal({
      title: 'Aggiungi alla dispensa',
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
            const loc = readLocation();
            const { qtyValue, qtyUnit } = qty.read();
            const expiry = dateInput.value || null;
            const result = await mergePantryQuantity(loc, product.id, qtyValue, qtyUnit);
            if (expiry != null && result && result.items.length) {
              const entry = result.items[result.items.length - 1];
              await updatePantryItem(entry.id, { expiry });
            }
            name.detach();
            c();
            if (result && result.merged === false && result.items.length === 2) {
              toast('Unità diverse: tengo le voci separate', 'info');
            } else {
              toast('Aggiunto in dispensa', 'success');
            }
          },
        },
      ],
    });
    name.inputEl.focus();
    return modal;
  }

  // Edit an existing pantry item's quantity + expiry (location stays fixed).
  function openEditForm(item, product) {
    const qty = qtyEditor({ value: item.qtyValue, unit: item.qtyUnit });
    const dateInput = el('input', { type: 'date', class: 'input', value: item.expiry || '', 'aria-label': 'Scadenza' });

    const content = el('div', {}, [
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Prodotto'),
        el('div', { class: 'row-title' }, product ? product.name : '(prodotto eliminato)'),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Quantità'),
        qty.element,
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Scadenza'),
        dateInput,
      ]),
    ]);

    openModal({
      title: 'Modifica elemento',
      content,
      actions: [
        { label: 'Annulla', onClick: (c) => c() },
        {
          label: 'Salva',
          primary: true,
          onClick: async (c) => {
            const { qtyValue, qtyUnit } = qty.read();
            await updatePantryItem(item.id, { qtyValue, qtyUnit, expiry: dateInput.value || null });
            c();
            toast('Elemento aggiornato', 'success');
          },
        },
      ],
    });
  }

  // Build a Frigo/Dispensa segmented picker for the add form.
  function buildLocationSeg(initial, onChange) {
    let location = initial;
    const frigoBtn = el('button', { type: 'button', class: 'segmented-btn' }, 'Frigo');
    const dispensaBtn = el('button', { type: 'button', class: 'segmented-btn' }, 'Dispensa');
    function sync() {
      frigoBtn.classList.toggle('active', location === 'frigo');
      dispensaBtn.classList.toggle('active', location === 'dispensa');
    }
    frigoBtn.addEventListener('click', () => { location = 'frigo'; sync(); onChange(location); });
    dispensaBtn.addEventListener('click', () => { location = 'dispensa'; sync(); onChange(location); });
    sync();
    const field = el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Posizione'),
      el('div', { class: 'segmented segmented-inline' }, [frigoBtn, dispensaBtn]),
    ]);
    return { field, read: () => location };
  }

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
    const items = [];
    if (!orphaned) {
      items.push({ label: 'Modifica (quantità / scadenza)', icon: '✏️', value: 'edit' });
      items.push({ label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' });
      items.push({ label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' });
    }
    items.push({ label: 'Rimuovi', icon: '🗑️', value: 'remove', danger: true });

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items });
    if (choice === 'edit') {
      openEditForm(item, product);
    } else if (choice === 'toList') {
      await ensureListRef(item.productId);
      toast('Aggiunto alla spesa', 'success');
    } else if (choice === 'toWish') {
      await ensureWishlistRef(item.productId);
      toast('Aggiunto ai desideri', 'success');
    } else if (choice === 'remove') {
      await removePantryItem(item.id);
    }
  }

  // --- Build a row (clean: name + qty/location sub + expiry chip) ---
  function buildRow(item, product) {
    const orphaned = product === undefined;

    const level = expiryLevel(item.expiry);
    const sev = level && EXPIRY_ICON[level];

    const titleBits = [];
    if (sev) {
      titleBits.push(el('span', { class: 'sev-icon', title: sev.label, 'aria-label': sev.label }, sev.icon));
    }
    titleBits.push(
      el('span', { class: 'row-title-text' }, orphaned ? '(prodotto eliminato)' : product.name)
    );
    const title = el('div', { class: `row-title${orphaned ? ' orphaned' : ''}` }, titleBits);
    const main = el('div', { class: 'row-main' }, [title]);

    const subBits = [];
    const qtyStr = formatQty(item.qtyValue, item.qtyUnit);
    if (qtyStr) subBits.push(qtyStr);
    if (activeTab === 'tutti') subBits.push(item.location === 'frigo' ? 'Frigo' : 'Dispensa');
    if (subBits.length) main.appendChild(el('div', { class: 'row-sub' }, subBits.join(' · ')));

    const chip = expiryChip(item.expiry);
    if (chip) main.appendChild(el('div', { class: 'row-chips' }, [chip]));

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
    if (onlyExpiring) {
      items = items.filter((i) => {
        const lvl = expiryLevel(i.expiry);
        return lvl === 'warn' || lvl === 'soon' || lvl === 'today' || lvl === 'expired';
      });
    }

    listEl.textContent = '';
    if (items.length === 0) {
      const msg = onlyExpiring ? 'Niente in scadenza.' : 'Niente qui.';
      listEl.appendChild(
        el('div', { class: 'empty' }, [
          el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🧺'),
          el('p', {}, msg),
          el('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAddForm() }, 'Aggiungi un prodotto'),
        ])
      );
      return;
    }

    // Sort by expiry urgency first (most urgent on top), then by creation time.
    // Items with no expiry sink to the bottom.
    items.sort((a, b) => {
      const ra = EXPIRY_RANK[expiryLevel(a.expiry) ?? 'null'];
      const rb = EXPIRY_RANK[expiryLevel(b.expiry) ?? 'null'];
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });

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
    },
  };
}
