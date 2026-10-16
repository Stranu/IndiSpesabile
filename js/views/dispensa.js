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
  mergePantryQuantity,
  setPantryBatches,
  movePantryBatches,
  updateProduct,
  removePantryItem,
  removePantryItemsMany,
  voicesToList,
  voicesToWishlist,
  ensureListRef,
  ensureWishlistRef,
  ensureVoiceShape,
  normalizeBatches,
  voiceMostUrgentLevel,
  voiceIsExpiring,
  voiceUnitTotals,
  getProductMembership,
} from '../store.js';
import {
  el, toast, haptic, openSheet, openModal, qtyEditor, nameField, fab,
  selectionController, attachLongPress, swipeRow, membershipBadges,
} from '../ui.js';
import { formatQty, parseDecimal } from '../units.js';

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
  let activeTab = 'tutti'; // default: show everything
  let onlyExpiring = false;
  let lastRendered = [];
  let membership = null; // cross-section presence (loaded per render)
  const longPressDetachers = [];
  const swipeDetachers = [];

  const selection = selectionController(() => {
    updateSelectionUI();
    renderList();
  });

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
  const selectBtn = el('button', { type: 'button', class: 'filter-chip', onClick: () => selection.enter() }, '☑️ Seleziona');
  const filterRow = el('div', { class: 'filter-row' }, [expiringChip, selectBtn]);

  // --- Selection action bar ---
  const selCount = el('span', { class: 'sel-count' }, '0 selezionati');
  const selAllBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: selectAllShown }, 'Tutti');
  const selActionsBtn = el('button', { type: 'button', class: 'btn btn-primary sel-actions-btn', onClick: openBulkActions }, 'Azioni');
  const selCancelBtn = el('button', { type: 'button', class: 'btn-ghost', onClick: () => selection.exit() }, 'Annulla');
  const selectionBar = el('div', { class: 'selection-bar', hidden: true }, [
    el('div', { class: 'selection-bar-left' }, [selCancelBtn, selCount]),
    el('div', { class: 'selection-bar-right' }, [selAllBtn, selActionsBtn]),
  ]);

  const listEl = el('div', { class: 'card list-card' });
  container.appendChild(tabsEl);
  container.appendChild(filterRow);
  container.appendChild(selectionBar);
  container.appendChild(listEl);

  const addFab = fab({ label: 'Aggiungi alla dispensa', onClick: () => openAddForm() });
  container.appendChild(addFab);

  function updateSelectionUI() {
    const active = selection.isActive();
    selectionBar.hidden = !active;
    tabsEl.hidden = active;
    filterRow.hidden = active;
    addFab.hidden = active;
    selCount.textContent = `${selection.count()} selezionati`;
    selActionsBtn.disabled = selection.count() === 0;
  }

  function selectAllShown() {
    for (const it of lastRendered) if (!selection.has(it.id)) selection.toggle(it.id);
  }

  async function openBulkActions() {
    const ids = selection.ids();
    if (ids.length === 0) return;
    const choice = await openSheet({
      title: `${ids.length} elementi selezionati`,
      items: [
        { label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' },
        { label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' },
        { label: 'Rimuovi dalla dispensa', icon: '🗑️', value: 'remove', danger: true },
      ],
    });
    if (!choice) return;

    if (choice === 'toList') {
      const n = await voicesToList('pantry', ids);
      toast(`Aggiunti ${n} alla spesa`, 'success');
      selection.exit();
    } else if (choice === 'toWish') {
      const n = await voicesToWishlist('pantry', ids);
      toast(`Aggiunti ${n} ai desideri`, 'success');
      selection.exit();
    } else if (choice === 'remove') {
      const n = await removePantryItemsMany(ids);
      toast(`Rimossi ${n} elementi`, 'success');
      selection.exit();
    }
  }

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
            const result = await mergePantryQuantity(loc, product.id, qtyValue, qtyUnit, expiry);
            name.detach();
            c();
            if (result && result.keptSeparate) {
              toast(result.separateReason === 'expiry'
                ? 'Scadenza diversa: tengo i lotti separati'
                : 'Unità diverse: tengo i lotti separati', 'info');
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

  // Edit an existing pantry voice as a LIST OF BATCHES (design §4.2).
  // Each row: qtyEditor + date ("Scadenza") + remove button. "Aggiungi lotto" appends
  // an empty row. On save, EVERY row is passed RAW to setPantryBatches (no pre-filter):
  // normalizeBatches is the sole arbiter (absorbs redundant nulls, drops zero-qty,
  // soft-deletes the voice if nothing remains -> toast 'Elemento rimosso').
  function openEditForm(item, product) {
    // Rows shown in urgency order (same as the list row), but save order is irrelevant.
    const initial = sortBatchesByUrgency(normalizeBatches(ensureVoiceShape(item).batches));
    const rows = []; // { element, read():{qtyValue,qtyUnit,expiry} }

    const batchesWrap = el('div', { class: 'batch-editor' });

    function addBatchRow(batch) {
      const qty = qtyEditor({ value: batch ? batch.qtyValue : null, unit: batch ? batch.qtyUnit : null });
      const dateInput = el('input', {
        type: 'date',
        class: 'input',
        value: batch && batch.expiry ? batch.expiry : '',
        'aria-label': 'Scadenza',
      });
      const row = el('div', { class: 'batch-row' });
      const removeBtn = el(
        'button',
        {
          type: 'button',
          class: 'btn-ghost batch-remove',
          'aria-label': 'Rimuovi lotto',
          onClick: () => {
            const idx = rows.indexOf(entry);
            if (idx >= 0) rows.splice(idx, 1);
            row.remove();
          },
        },
        '✕'
      );
      // Row 1: quantity on its own line (full width so the +/- buttons show).
      row.appendChild(el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Quantità'),
        qty.element,
      ]));
      // Row 2: expiry (narrow) + the remove (✕) button to its right.
      row.appendChild(el('div', { class: 'batch-expiry-row' }, [
        el('div', { class: 'field batch-expiry-field' }, [
          el('span', { class: 'field-label' }, 'Scadenza'),
          dateInput,
        ]),
        removeBtn,
      ]));
      const entry = {
        element: row,
        read: () => {
          const { qtyValue, qtyUnit } = qty.read();
          return { qtyValue, qtyUnit, expiry: dateInput.value || null };
        },
      };
      rows.push(entry);
      batchesWrap.appendChild(row);
    }

    if (initial.length === 0) {
      addBatchRow(null); // voice with no batch: show one empty row to re-add a quantity
    } else {
      for (const b of initial) addBatchRow(b);
    }

    const addBatchBtn = el(
      'button',
      { type: 'button', class: 'btn-ghost', onClick: () => addBatchRow(null) },
      '+ Aggiungi lotto'
    );

    // Editable product name (renames the product everywhere). Hidden for orphaned refs.
    const nameInput = product
      ? el('input', { type: 'text', class: 'input', value: product.name, autocomplete: 'off', 'aria-label': 'Nome prodotto' })
      : null;
    const nameField = product
      ? el('div', { class: 'field' }, [el('span', { class: 'field-label' }, 'Nome'), nameInput])
      : el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, 'Prodotto'),
          el('div', { class: 'row-title' }, '(prodotto eliminato)'),
        ]);

    const content = el('div', {}, [
      nameField,
      el('div', { class: 'field' }, [
        el('span', { class: 'field-label' }, 'Lotti'),
        batchesWrap,
      ]),
      addBatchBtn,
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
            // Rename the product if the name changed (affects every section).
            if (product && nameInput) {
              const newName = nameInput.value.trim();
              if (newName !== '' && newName !== product.name) {
                await updateProduct(product.id, { name: newName });
              }
            }
            // Read ALL rows raw (empty row -> all-null batch). No pre-filter: the
            // store's normalizeBatches decides (absorb/drop/soft-delete).
            const raw = rows.map((r) => r.read());
            const result = await setPantryBatches(item.id, raw);
            c();
            toast(result && result.removed ? 'Elemento rimosso' : 'Elemento aggiornato', 'success');
          },
        },
      ],
    });
  }

  // --- Details panel (read-only) with a pencil shortcut to edit ---
  function openDetails(item, product) {
    const name = product ? product.name : '(prodotto eliminato)';
    const locationLabel = item.location === 'frigo' ? 'Frigo' : 'Dispensa';

    // Per-unit totals summary.
    const totals = voiceUnitTotals(item)
      .map((t) => formatQty(t.qtyValue, t.qtyUnit))
      .filter(Boolean);
    const totalStr = totals.length ? totals.join(' · ') : 'Quantità non indicata';

    // Batch breakdown (quantity + expiry), urgency-ordered.
    const batches = sortBatchesByUrgency(normalizeBatches(ensureVoiceShape(item).batches));
    const batchRows = batches.length
      ? batches.map((b) => {
          const qtyStr = formatQty(b.qtyValue, b.qtyUnit) || 'Quantità ignota';
          const chip = expiryChip(b.expiry);
          return el('div', { class: 'detail-batch' }, [
            el('span', { class: 'detail-batch-qty' }, qtyStr),
            chip || el('span', { class: 'detail-batch-noexp' }, 'Senza scadenza'),
          ]);
        })
      : [el('div', { class: 'detail-batch-noexp' }, 'Nessun lotto')];

    const content = el('div', { class: 'detail-view' }, [
      el('div', { class: 'detail-row' }, [
        el('span', { class: 'detail-label' }, 'Posizione'),
        el('span', { class: 'detail-value' }, locationLabel),
      ]),
      el('div', { class: 'detail-row' }, [
        el('span', { class: 'detail-label' }, 'Totale'),
        el('span', { class: 'detail-value' }, totalStr),
      ]),
      el('div', { class: 'detail-section-label' }, 'Lotti'),
      el('div', { class: 'detail-batches' }, batchRows),
    ]);

    const modal = openModal({ title: name, content });

    // Pencil shortcut in the modal title area -> jump straight to edit.
    const editBtn = el(
      'button',
      {
        type: 'button',
        class: 'detail-edit-btn',
        'aria-label': 'Modifica',
        title: 'Modifica',
        onClick: () => { modal.close(); openEditForm(item, product); },
      },
      '✏️'
    );
    // Place the pencil at the top-right of the modal title.
    const titleEl = modal.element.querySelector('.modal-title');
    if (titleEl) {
      titleEl.classList.add('modal-title-with-action');
      titleEl.appendChild(editBtn);
    } else {
      modal.element.insertBefore(editBtn, modal.element.firstChild);
    }
  }

  // Sort a batch array by expiry urgency for display (most urgent first, no-date last).
  // Pure render ordering; does not touch the persisted canonical order.
  function sortBatchesByUrgency(batches) {
    return [...batches].sort((a, b) => {
      const da = a.expiry != null ? daysUntil(a.expiry) : Infinity;
      const dbk = b.expiry != null ? daysUntil(b.expiry) : Infinity;
      return da - dbk;
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

  // Format an ISO date 'YYYY-MM-DD' as Italian 'DD/MM/YYYY'.
  function formatDateIt(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return (y && m && d) ? `${d}/${m}/${y}` : iso;
  }

  // --- Expiry chip ---
  function expiryChip(expiry) {
    if (expiry == null) return null;
    const d = daysUntil(expiry);
    let cls = 'neutral';
    let label = `Scade ${formatDateIt(expiry)}`;
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
      items.push({ label: 'Modifica', icon: '✏️', value: 'edit' });
      // "Sposta in …" shows the OTHER location (§8.1).
      if (item.location === 'frigo') {
        items.push({ label: 'Sposta in dispensa', icon: '🧺', value: 'move' });
      } else {
        items.push({ label: 'Sposta in frigo', icon: '❄️', value: 'move' });
      }
      items.push({ label: 'Aggiungi alla spesa', icon: '🛒', value: 'toList' });
      items.push({ label: 'Aggiungi ai desideri', icon: '⭐', value: 'toWish' });
    }
    items.push({ label: 'Seleziona più elementi', icon: '☑️', value: 'select' });
    items.push({ label: 'Rimuovi', icon: '🗑️', value: 'remove', danger: true });

    const choice = await openSheet({ title: product ? product.name : '(prodotto eliminato)', items });
    if (choice === 'edit') {
      openEditForm(item, product);
    } else if (choice === 'move') {
      openMoveFlow(item);
    } else if (choice === 'toList') {
      await ensureListRef(item.productId);
      toast('Aggiunto alla spesa', 'success');
    } else if (choice === 'toWish') {
      await ensureWishlistRef(item.productId);
      toast('Aggiunto ai desideri', 'success');
    } else if (choice === 'select') {
      selection.enter(item.id);
    } else if (choice === 'remove') {
      await removePantryItem(item.id);
    }
  }

  // --- Move between frigo/dispensa (design §8.2) ---
  async function openMoveFlow(item) {
    const toLocation = item.location === 'frigo' ? 'dispensa' : 'frigo';
    const movedToast = toLocation === 'frigo' ? 'Spostato in frigo' : 'Spostato in dispensa';
    const snap = sortBatchesByUrgency(normalizeBatches(ensureVoiceShape(item).batches));

    // Single batch (or empty) -> wholesale move, no modal.
    if (snap.length <= 1) {
      await movePantryBatches(item.id, toLocation, 'all');
      haptic();
      toast(movedToast, 'success');
      return;
    }

    // Multi-batch -> selection modal. Indices refer to this snapshot.
    const rowStates = []; // { index, checkbox, qtyInput }
    const listWrap = el('div', { class: 'move-list' });

    // "Sposta tutto" toggle at the top.
    const allCheckbox = el('input', { type: 'checkbox', 'aria-label': 'Sposta tutto' });
    const allRow = el('label', { class: 'move-row move-row-all' }, [
      allCheckbox,
      el('span', {}, 'Sposta tutto'),
    ]);
    allCheckbox.addEventListener('change', () => {
      const on = allCheckbox.checked;
      for (const st of rowStates) {
        st.checkbox.checked = on;
        if (st.qtyInput) st.qtyInput.disabled = on; // moving whole batches
      }
    });
    listWrap.appendChild(allRow);

    snap.forEach((b, index) => {
      const checkbox = el('input', { type: 'checkbox', 'aria-label': 'Seleziona lotto' });
      const qtyStr = formatQty(b.qtyValue, b.qtyUnit) || 'Quantità ignota';
      const dateStr = b.expiry ? `Scade ${b.expiry}` : 'Senza scadenza';
      let qtyInput = null;
      if (b.qtyValue != null) {
        qtyInput = el('input', {
          type: 'number',
          inputmode: 'decimal',
          min: '0',
          class: 'input move-qty',
          placeholder: 'Tutto',
          'aria-label': 'Quantità da spostare',
        });
      }
      const label = el('label', { class: 'move-row' }, [
        checkbox,
        el('span', { class: 'move-batch-info' }, `${qtyStr} · ${dateStr}`),
      ]);
      const row = el('div', { class: 'move-row-wrap' }, qtyInput ? [label, qtyInput] : [label]);
      listWrap.appendChild(row);
      rowStates.push({ index, checkbox, qtyInput });
    });

    const content = el('div', {}, [listWrap]);

    openModal({
      title: movedToast.replace('Spostato', 'Sposta'),
      content,
      actions: [
        { label: 'Annulla', onClick: (c) => c() },
        {
          label: 'Sposta',
          primary: true,
          // Button ALWAYS enabled; validate on click (OPTION A, §8.2).
          onClick: async (close) => {
            if (allCheckbox.checked) {
              await movePantryBatches(item.id, toLocation, 'all');
              haptic();
              toast(movedToast, 'success');
              close();
              return;
            }
            const selectionArr = [];
            for (const st of rowStates) {
              if (!st.checkbox.checked) continue;
              const sel = { index: st.index };
              if (st.qtyInput && st.qtyInput.value.trim() !== '') {
                sel.qty = st.qtyInput.value;
              }
              selectionArr.push(sel);
            }
            if (selectionArr.length === 0) {
              toast('Seleziona almeno un lotto', 'info');
              return; // do NOT close
            }
            await movePantryBatches(item.id, toLocation, selectionArr);
            haptic();
            toast(movedToast, 'success');
            close();
          },
        },
      ],
    });
  }

  // --- Build a row (clean: name + qty/location sub + expiry chip) ---
  function buildRow(item, product) {
    const orphaned = product === undefined;

    const level = voiceMostUrgentLevel(item);
    const sev = level && EXPIRY_ICON[level];

    const titleBits = [];
    if (sev) {
      titleBits.push(el('span', { class: 'sev-icon', title: sev.label, 'aria-label': sev.label }, sev.icon));
    }
    titleBits.push(
      el('span', { class: 'row-title-text' }, orphaned ? '(prodotto eliminato)' : product.name)
    );
    // Presence badges: show where else this product appears (not the pantry itself).
    if (!orphaned) {
      for (const b of membershipBadges(item.productId, membership, 'pantry')) titleBits.push(b);
    }
    const title = el('div', { class: `row-title${orphaned ? ' orphaned' : ''}` }, titleBits);
    const main = el('div', { class: 'row-main' }, [title]);

    const subBits = [];
    // Per-unit totals summed across batches (e.g. '3 pz · 0,5 kg').
    const totals = voiceUnitTotals(item)
      .map((t) => formatQty(t.qtyValue, t.qtyUnit))
      .filter(Boolean);
    for (const t of totals) subBits.push(t);
    if (activeTab === 'tutti') subBits.push(item.location === 'frigo' ? 'Frigo' : 'Dispensa');
    if (subBits.length) main.appendChild(el('div', { class: 'row-sub' }, subBits.join(' · ')));

    // One chip per DATED batch, ordered by urgency at render.
    const datedBatches = (Array.isArray(item.batches) ? item.batches : [])
      .filter((b) => b.expiry != null)
      .sort((a, b) => daysUntil(a.expiry) - daysUntil(b.expiry));
    if (datedBatches.length) {
      const chips = datedBatches.map((b) => expiryChip(b.expiry)).filter(Boolean);
      if (chips.length) main.appendChild(el('div', { class: 'row-chips' }, chips));
    }

    const selMode = selection.isActive();
    const selected = selection.has(item.id);

    const children = [];
    if (selMode) {
      children.push(el('span', { class: `sel-check${selected ? ' checked' : ''}`, 'aria-hidden': 'true' }, selected ? '✓' : ''));
    }
    // Tap on the row content (not in selection mode) opens the read-only details.
    if (!selMode && !orphaned) {
      main.classList.add('row-main-tappable');
      main.addEventListener('click', () => openDetails(item, product));
    }

    children.push(main);
    if (!selMode) {
      children.push(el('button', { type: 'button', class: 'kebab-btn', 'aria-label': 'Azioni', onClick: () => openRowMenu(item, product) }, '⋮'));
    }

    const row = el('div', { class: `row${selMode && selected ? ' row-selected' : ''}` }, children);
    if (selMode) {
      row.addEventListener('click', () => selection.toggle(item.id));
      return row;
    }

    longPressDetachers.push(attachLongPress(row, () => selection.enter(item.id)));

    // Swipe left = remove from pantry; swipe right = add to the shopping list.
    const sw = swipeRow(row, {
      onSwipeLeft: () => removePantryItem(item.id),
      onSwipeRight: !orphaned
        ? async () => { await ensureListRef(item.productId); toast('Aggiunto alla spesa', 'success'); }
        : undefined,
      leftLabel: 'Elimina',
      leftIcon: '🗑️',
      rightLabel: 'Alla spesa',
      rightIcon: '🛒',
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

  // --- Render list ---
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
    membership = await getProductMembership();
    let items = await getAllPantry();
    if (activeTab !== 'tutti') items = items.filter((i) => i.location === activeTab);
    if (onlyExpiring) {
      items = items.filter(voiceIsExpiring);
    }

    listEl.textContent = '';
    if (items.length === 0) {
      lastRendered = [];
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
      const ra = EXPIRY_RANK[voiceMostUrgentLevel(a) ?? 'null'];
      const rb = EXPIRY_RANK[voiceMostUrgentLevel(b) ?? 'null'];
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
    lastRendered = items;

    for (const item of items) {
      const product = await getProduct(item.productId); // may be undefined -> orphaned
      listEl.appendChild(buildRow(item, product));
    }
  }

  // Re-render on pantry/product changes AND on list/wishlist changes, since the
  // presence badges reflect membership in those other sections too.
  const unsubscribe = db.onChange((payload) => {
    if (
      payload.store === 'pantry' ||
      payload.store === 'products' ||
      payload.store === 'list' ||
      payload.store === 'wishlist'
    ) {
      renderList();
    }
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
