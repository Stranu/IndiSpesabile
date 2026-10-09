// js/ui.js — DOM helpers + reusable 3-dots action-sheet, autocomplete, qty editor (design §9).
// Leaf utility: no app-state dependencies beyond store.js for suggestions and units for parsing.
// All strings Italian.

import { suggestProducts, UNITS } from './store.js';
import { parseDecimal, formatQty } from './units.js';

// ----- el(tag, props, children) — tiny hyperscript helper ---------------------
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null) continue;
    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, value);
      }
    } else {
      node.setAttribute(key, value);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

// ----- toast(message, type, ms) — bottom auto-dismiss toast --------------------
function toastWrap() {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = el('div', { class: 'toast-wrap' });
    document.body.appendChild(wrap);
  }
  return wrap;
}

export function toast(message, type = 'info', ms = 2500) {
  const wrap = toastWrap();
  const node = el('div', { class: `toast ${type}` }, message);
  wrap.appendChild(node);
  if (ms > 0) {
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 180);
    }, ms);
  }
  return { close: () => node.remove() };
}

// ----- openModal({title, content, actions}) -----------------------------------
// content: HTMLElement; actions: [{label, value?, danger?, primary?, onClick?}].
export function openModal({ title, content, actions = [] }) {
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  if (title) modal.appendChild(el('h2', { class: 'modal-title' }, title));
  if (content) modal.appendChild(content);

  const overlay = el('div', { class: 'overlay' }, [modal]);

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  if (actions.length) {
    const bar = el('div', { class: 'modal-actions' });
    for (const a of actions) {
      const btn = el(
        'button',
        {
          type: 'button',
          class: `btn${a.primary ? ' btn-primary' : ''}${a.danger ? ' btn-danger' : ''}`,
          onClick: () => {
            if (typeof a.onClick === 'function') a.onClick(close);
            else close();
          },
        },
        a.label
      );
      bar.appendChild(btn);
    }
    modal.appendChild(bar);
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);

  return { close, element: modal };
}

// ----- openSheet({title, items}) — THE reusable 3-dots action sheet ------------
// Single result mechanism: resolves the tapped item's `value`, or null on dismiss
// (backdrop / Esc / back). Items carry {label, icon, value, danger}; NO onSelect.
export function openSheet({ title, items = [] }) {
  return new Promise((resolve) => {
    let settled = false;

    const sheet = el('div', { class: 'sheet', role: 'menu' });
    if (title) sheet.appendChild(el('div', { class: 'sheet-title' }, title));

    const overlay = el('div', { class: 'overlay' }, [sheet]);

    function cleanup() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      overlay.remove();
    }
    function done(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(null);
    }
    function onPop() {
      done(null);
    }

    for (const item of items) {
      const btn = el(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: `sheet-item${item.danger ? ' danger' : ''}`,
          onClick: () => done(item.value),
        },
        [
          item.icon ? el('span', { class: 'sheet-icon', 'aria-hidden': 'true' }, item.icon) : null,
          el('span', { class: 'sheet-label' }, item.label),
        ]
      );
      sheet.appendChild(btn);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    document.body.appendChild(overlay);
  });
}

// ----- openChoice(title, options) — built on openSheet -------------------------
// options: array of strings (e.g. ['Frigo','Dispensa']); resolves the chosen label or null.
export function openChoice(title, options) {
  return openSheet({
    title,
    items: options.map((opt) => ({ label: opt, value: opt })),
  });
}

// ----- confirmSheet(message, {okLabel, danger}) — built on openSheet -----------
// Resolves true if confirmed, false on dismiss/annulla.
export async function confirmSheet(message, { okLabel = 'Conferma', danger = false } = {}) {
  const value = await openSheet({
    title: message,
    items: [
      { label: okLabel, value: 'ok', danger },
      { label: 'Annulla', value: 'cancel' },
    ],
  });
  return value === 'ok';
}

// ----- attachAutocomplete(inputEl, {onPick, onConfirmNew}) ---------------------
// Returns a detach fn. Suggestion <ul> populated on input (debounced 150ms) via
// store.suggestProducts. Tap/Enter selects a product via onPick, or confirms the
// typed text via onConfirmNew.
export function attachAutocomplete(inputEl, { onPick, onConfirmNew }) {
  // Ensure the input lives inside a positioned .autocomplete wrapper.
  let wrap = inputEl.parentElement;
  if (!wrap || !wrap.classList.contains('autocomplete')) {
    wrap = el('div', { class: 'autocomplete' });
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);
  }
  const listEl = el('ul', { class: 'autocomplete-list' });
  wrap.appendChild(listEl);

  let activeIndex = -1;
  let current = []; // current suggestion products
  let timer = null;

  function clearList() {
    listEl.textContent = '';
    current = [];
    activeIndex = -1;
  }

  function highlight(i) {
    activeIndex = i;
    Array.from(listEl.children).forEach((li, idx) => {
      li.classList.toggle('active', idx === activeIndex);
    });
  }

  async function refresh() {
    const q = inputEl.value;
    let products = [];
    try {
      products = await suggestProducts(q, 8);
    } catch (e) {
      console.warn('attachAutocomplete: suggestProducts failed', e);
    }
    current = products;
    listEl.textContent = '';
    activeIndex = -1;
    products.forEach((p, idx) => {
      const li = el(
        'li',
        {
          class: 'autocomplete-item',
          role: 'option',
          onClick: () => pick(idx),
        },
        p.name
      );
      listEl.appendChild(li);
    });
  }

  function pick(idx) {
    const product = current[idx];
    if (!product) return;
    clearList();
    if (typeof onPick === 'function') onPick(product);
  }

  function confirmNew() {
    const name = inputEl.value.trim();
    clearList();
    if (name && typeof onConfirmNew === 'function') onConfirmNew(name);
  }

  function onInput() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (current.length) highlight((activeIndex + 1) % current.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (current.length) highlight((activeIndex - 1 + current.length) % current.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && current[activeIndex]) pick(activeIndex);
      else confirmNew();
    } else if (e.key === 'Escape') {
      clearList();
    }
  }

  function onBlur() {
    // Delay so a click on a suggestion registers before the list is cleared.
    setTimeout(clearList, 150);
  }

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKey);
  inputEl.addEventListener('blur', onBlur);

  return function detach() {
    if (timer) clearTimeout(timer);
    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('keydown', onKey);
    inputEl.removeEventListener('blur', onBlur);
    listEl.remove();
  };
}

// ----- qtyEditor({value, unit}) ------------------------------------------------
// Returns { element, read():{qtyValue, qtyUnit} }. Numeric field accepts Italian
// comma via units.parseDecimal; unit <select> of UNITS.
export function qtyEditor({ value = null, unit = null } = {}) {
  const valueInput = el('input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'input qty-value',
    placeholder: 'Qt.',
    value: value != null ? formatQty(value, unit).split(' ')[0] : '',
  });

  const unitSelect = el(
    'select',
    { class: 'select qty-unit' },
    UNITS.map((u) =>
      el('option', { value: u, selected: unit === u }, u)
    )
  );
  if (unit) unitSelect.value = unit;

  const element = el('div', { class: 'qty-editor' }, [valueInput, unitSelect]);

  return {
    element,
    read() {
      const raw = valueInput.value.trim();
      if (raw === '') return { qtyValue: null, qtyUnit: null };
      const parsed = parseDecimal(raw);
      if (parsed == null) return { qtyValue: null, qtyUnit: null };
      return { qtyValue: parsed, qtyUnit: unitSelect.value };
    },
  };
}
