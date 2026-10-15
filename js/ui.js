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
// Returns { element, detach }. `element` is the .autocomplete wrapper the caller
// must mount (it already contains inputEl); `detach` removes listeners + the list.
// Suggestion <ul> populated on input (debounced 150ms) via store.suggestProducts.
// Tap/Enter selects a product via onPick, or confirms the typed text via onConfirmNew.
// Parent-independent: works whether inputEl already has a parent or not.
export function attachAutocomplete(inputEl, { onPick, onConfirmNew }) {
  // Ensure the input lives inside a positioned .autocomplete wrapper.
  let wrap = inputEl.parentElement;
  if (!wrap || !wrap.classList.contains('autocomplete')) {
    wrap = el('div', { class: 'autocomplete' });
    if (inputEl.parentNode) {
      inputEl.parentNode.insertBefore(wrap, inputEl);
    }
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

  function detach() {
    if (timer) clearTimeout(timer);
    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('keydown', onKey);
    inputEl.removeEventListener('blur', onBlur);
    listEl.remove();
  }

  return { element: wrap, detach };
}

// ----- fab({label, onClick}) — floating "+" action button --------------------
// Returns the button element. Fixed bottom-right above the nav; 56px round, large +.
export function fab({ label = 'Aggiungi', onClick } = {}) {
  return el(
    'button',
    {
      type: 'button',
      class: 'fab',
      'aria-label': label,
      title: label,
      onClick: (e) => {
        if (typeof onClick === 'function') onClick(e);
      },
    },
    el('span', { class: 'fab-plus', 'aria-hidden': 'true' }, '+')
  );
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

  // Per-unit step for the quick +/- buttons: 1 for 'pz', 0.1 for weights/volumes.
  function stepFor(u) {
    return u === 'pz' ? 1 : 0.1;
  }

  function nudge(delta) {
    const current = parseDecimal(valueInput.value.trim());
    const base = current == null ? 0 : current;
    let next = base + delta;
    if (next < 0) next = 0;
    // Round to 3 decimals to avoid float noise (0.1+0.2 etc.).
    next = Math.round(next * 1000) / 1000;
    valueInput.value = String(next).replace('.', ',');
  }

  const minusBtn = el(
    'button',
    { type: 'button', class: 'qty-step', 'aria-label': 'Diminuisci', onClick: () => nudge(-stepFor(unitSelect.value)) },
    '−'
  );
  const plusBtn = el(
    'button',
    { type: 'button', class: 'qty-step', 'aria-label': 'Aumenta', onClick: () => nudge(stepFor(unitSelect.value)) },
    '+'
  );

  const element = el('div', { class: 'qty-editor' }, [minusBtn, valueInput, plusBtn, unitSelect]);

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

// ----- selectionController() — reusable multi-select mode for list views ------
// Manages a Set of selected ids and a "selection mode" flag. The view calls:
//   enter(id?)     -> turn on selection mode (optionally pre-selecting one id)
//   exit()         -> turn off and clear
//   toggle(id)     -> select/deselect one id
//   isActive()     -> selection mode on?
//   has(id)        -> id selected?
//   ids()          -> array of selected ids
//   count()        -> number selected
// It takes an onChange() callback fired whenever mode/selection changes, so the
// view can re-render rows and the selection action bar. Pure state; no DOM.
export function selectionController(onChange) {
  let active = false;
  const sel = new Set();
  const fire = () => { if (typeof onChange === 'function') onChange(); };

  return {
    enter(id) {
      active = true;
      if (id != null) sel.add(id);
      fire();
    },
    exit() {
      active = false;
      sel.clear();
      fire();
    },
    toggle(id) {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      // Leaving zero selected keeps mode on (user can still pick); the view may
      // choose to auto-exit — it decides in its onChange.
      fire();
    },
    isActive: () => active,
    has: (id) => sel.has(id),
    ids: () => Array.from(sel),
    count: () => sel.size,
  };
}

// ----- dragHandle() — the grip graphic (⠿) that starts a reorder drag ---------
export function dragHandle() {
  return el('span', { class: 'drag-handle', 'aria-label': 'Trascina per riordinare', role: 'button' }, '⠿');
}

// ----- attachReorder(listEl, { onReorder }) -----------------------------------
// Enables touch drag-to-reorder for rows inside listEl. A drag only starts from
// an element with class 'drag-handle' inside a row carrying data-reorder-id, so
// it never conflicts with row swipe / long-press / vertical scroll elsewhere.
// On drop, onReorder(orderedIds) is called with the new top-to-bottom order of
// the data-reorder-id values. Returns detach().
export function attachReorder(listEl, { onReorder } = {}) {
  let dragEl = null;      // the row being dragged
  let placeholder = null; // spacer showing the drop target
  let startY = 0;
  let offsetY = 0;        // pointer offset within the dragged row
  let rows = [];          // snapshot of draggable rows at drag start

  function rowFromHandle(target) {
    const handle = target.closest && target.closest('.drag-handle');
    if (!handle) return null;
    return handle.closest('[data-reorder-id]');
  }

  function onTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const row = rowFromHandle(t.target);
    if (!row) return;

    dragEl = row;
    rows = Array.from(listEl.querySelectorAll('[data-reorder-id]'));
    const rect = row.getBoundingClientRect();
    offsetY = t.clientY - rect.top;
    startY = t.clientY;

    placeholder = el('div', { class: 'reorder-placeholder' });
    placeholder.style.height = rect.height + 'px';
    row.parentNode.insertBefore(placeholder, row.nextSibling);

    row.classList.add('dragging');
    row.style.width = rect.width + 'px';
    row.style.position = 'fixed';
    row.style.left = rect.left + 'px';
    row.style.top = rect.top + 'px';
    row.style.zIndex = '80';
    row.style.pointerEvents = 'none';
  }

  function onTouchMove(e) {
    if (!dragEl) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    dragEl.style.top = (t.clientY - offsetY) + 'px';

    // Find the sibling the dragged row's midpoint is currently over.
    const midY = t.clientY;
    let ref = null;
    for (const r of rows) {
      if (r === dragEl) continue;
      const rect = r.getBoundingClientRect();
      if (midY < rect.top + rect.height / 2) { ref = r; break; }
    }
    if (ref) listEl.insertBefore(placeholder, ref);
    else listEl.appendChild(placeholder);
  }

  function onTouchEnd() {
    if (!dragEl) return;
    // Drop the row where the placeholder is.
    listEl.insertBefore(dragEl, placeholder);
    placeholder.remove();
    dragEl.classList.remove('dragging');
    dragEl.style.cssText = dragEl.style.cssText
      .replace(/width:[^;]+;?/, '')
      .replace(/position:[^;]+;?/, '')
      .replace(/left:[^;]+;?/, '')
      .replace(/top:[^;]+;?/, '')
      .replace(/z-index:[^;]+;?/, '')
      .replace(/pointer-events:[^;]+;?/, '');
    dragEl.removeAttribute('style');

    const ids = Array.from(listEl.querySelectorAll('[data-reorder-id]'))
      .map((r) => r.getAttribute('data-reorder-id'));
    dragEl = null;
    placeholder = null;
    rows = [];
    if (typeof onReorder === 'function') onReorder(ids);
  }

  listEl.addEventListener('touchstart', onTouchStart, { passive: true });
  listEl.addEventListener('touchmove', onTouchMove, { passive: true });
  listEl.addEventListener('touchend', onTouchEnd);
  listEl.addEventListener('touchcancel', onTouchEnd);

  return function detach() {
    listEl.removeEventListener('touchstart', onTouchStart);
    listEl.removeEventListener('touchmove', onTouchMove);
    listEl.removeEventListener('touchend', onTouchEnd);
    listEl.removeEventListener('touchcancel', onTouchEnd);
  };
}

// ----- swipeRow(rowEl, {onSwipeLeft, onSwipeRight, leftLabel, leftIcon, rightLabel, rightIcon}) --
// Wraps a row element to support horizontal swipe gestures with a revealed
// background action. Returns { element, detach } where `element` is the wrapper
// to mount in place of the row.
//   - Swipe LEFT  (finger moves left)  -> reveals the DESTRUCTIVE action (red
//     trash + leftLabel) on the right side; past threshold fires onSwipeLeft().
//   - Swipe RIGHT (finger moves right) -> reveals rightLabel/rightIcon on the
//     left side; past threshold fires onSwipeRight(). Omit onSwipeRight to allow
//     only left-swipe (delete).
// The gesture only engages when horizontal movement clearly dominates vertical,
// so it never hijacks list scrolling. Releasing before the threshold snaps back.
export function swipeRow(rowEl, {
  onSwipeLeft,
  onSwipeRight,
  leftLabel = 'Elimina',
  leftIcon = '🗑️',
  rightLabel = 'Comprato',
  rightIcon = '✅',
} = {}) {
  const THRESHOLD = 96;         // px past which the action triggers
  const DIRECTION_LOCK = 12;    // px of horizontal travel before we commit to a swipe
  const allowRight = typeof onSwipeRight === 'function';
  const allowLeft = typeof onSwipeLeft === 'function';

  // Background: a right-reveal (left side) and a left-reveal (right side).
  const rightReveal = el('div', { class: 'swipe-reveal swipe-reveal-right' }, [
    el('span', { class: 'swipe-ic', 'aria-hidden': 'true' }, rightIcon),
    el('span', { class: 'swipe-tx' }, rightLabel),
  ]);
  const leftReveal = el('div', { class: 'swipe-reveal swipe-reveal-left' }, [
    el('span', { class: 'swipe-tx' }, leftLabel),
    el('span', { class: 'swipe-ic', 'aria-hidden': 'true' }, leftIcon),
  ]);

  const bg = el('div', { class: 'swipe-bg' }, [rightReveal, leftReveal]);
  rowEl.classList.add('swipe-fg');
  const wrapper = el('div', { class: 'swipe-wrap' }, [bg, rowEl]);

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;    // committed to a horizontal swipe
  let decided = false;     // direction decided for this gesture

  function setTranslate(x) {
    rowEl.style.transform = x ? `translateX(${x}px)` : '';
    // Reveal only the side matching the swipe direction, intensify past threshold.
    const past = Math.abs(x) >= THRESHOLD;
    if (x < 0) {
      leftReveal.classList.add('visible');
      rightReveal.classList.remove('visible');
      leftReveal.classList.toggle('armed', past);
    } else if (x > 0) {
      rightReveal.classList.add('visible');
      leftReveal.classList.remove('visible');
      rightReveal.classList.toggle('armed', past);
    } else {
      leftReveal.classList.remove('visible', 'armed');
      rightReveal.classList.remove('visible', 'armed');
    }
  }

  function reset(animate) {
    if (animate) rowEl.classList.add('swipe-animate');
    setTranslate(0);
    if (animate) {
      setTimeout(() => rowEl.classList.remove('swipe-animate'), 200);
    }
    dx = 0;
    dragging = false;
    decided = false;
  }

  let ignore = false; // true when the gesture started on a drag handle (reorder)

  function onTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    // Don't treat a drag that starts on the reorder handle as a swipe.
    ignore = !!(t.target.closest && t.target.closest('.drag-handle'));
    startX = t.clientX;
    startY = t.clientY;
    dx = 0;
    dragging = false;
    decided = false;
  }

  function onTouchMove(e) {
    if (ignore) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const mx = t.clientX - startX;
    const my = t.clientY - startY;

    if (!decided) {
      if (Math.abs(mx) < DIRECTION_LOCK && Math.abs(my) < DIRECTION_LOCK) return;
      // Commit to horizontal only if clearly more horizontal than vertical.
      if (Math.abs(mx) > Math.abs(my)) {
        dragging = true;
      }
      decided = true;
      if (!dragging) return; // vertical scroll — leave it alone
    }
    if (!dragging) return;

    // Clamp to allowed directions.
    let x = mx;
    if (x > 0 && !allowRight) x = 0;
    if (x < 0 && !allowLeft) x = 0;
    // A little resistance past threshold.
    dx = x;
    rowEl.classList.remove('swipe-animate');
    setTranslate(x);
  }

  function onTouchEnd() {
    if (!dragging) { reset(false); return; }
    if (dx <= -THRESHOLD && allowLeft) {
      onSwipeLeft();
      reset(true);
    } else if (dx >= THRESHOLD && allowRight) {
      onSwipeRight();
      reset(true);
    } else {
      reset(true);
    }
  }

  rowEl.addEventListener('touchstart', onTouchStart, { passive: true });
  rowEl.addEventListener('touchmove', onTouchMove, { passive: true });
  rowEl.addEventListener('touchend', onTouchEnd);
  rowEl.addEventListener('touchcancel', () => reset(true));

  function detach() {
    rowEl.removeEventListener('touchstart', onTouchStart);
    rowEl.removeEventListener('touchmove', onTouchMove);
    rowEl.removeEventListener('touchend', onTouchEnd);
    rowEl.removeEventListener('touchcancel', reset);
  }

  return { element: wrapper, detach };
}

// ----- attachLongPress(el, onLongPress, ms=500) --------------------------------
// Fires onLongPress() after a press held ms milliseconds without much movement.
// Works for touch and mouse. Returns a detach() to remove listeners. Cancels on
// move/scroll so it never hijacks a drag/scroll gesture.
export function attachLongPress(node, onLongPress, ms = 500) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const MOVE_TOLERANCE = 10;

  function start(x, y) {
    startX = x;
    startY = y;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (typeof onLongPress === 'function') onLongPress();
    }, ms);
  }
  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function onTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    // Ignore presses that begin on a reorder drag handle.
    if (t.target.closest && t.target.closest('.drag-handle')) return;
    start(t.clientX, t.clientY);
  }
  function onTouchMove(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - startX) > MOVE_TOLERANCE || Math.abs(t.clientY - startY) > MOVE_TOLERANCE) {
      clearTimer();
    }
  }
  function onMouseDown(e) { start(e.clientX, e.clientY); }
  function onMouseMove(e) {
    if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
      clearTimer();
    }
  }

  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: true });
  node.addEventListener('touchend', clearTimer);
  node.addEventListener('touchcancel', clearTimer);
  node.addEventListener('mousedown', onMouseDown);
  node.addEventListener('mousemove', onMouseMove);
  node.addEventListener('mouseup', clearTimer);
  node.addEventListener('mouseleave', clearTimer);

  return function detach() {
    clearTimer();
    node.removeEventListener('touchstart', onTouchStart);
    node.removeEventListener('touchmove', onTouchMove);
    node.removeEventListener('touchend', clearTimer);
    node.removeEventListener('touchcancel', clearTimer);
    node.removeEventListener('mousedown', onMouseDown);
    node.removeEventListener('mousemove', onMouseMove);
    node.removeEventListener('mouseup', clearTimer);
    node.removeEventListener('mouseleave', clearTimer);
  };
}

// ----- membershipBadges(productId, membership, exclude) -----------------------
// Returns an array of small presence-badge spans showing which OTHER lists a
// product also appears in: 🛒 shopping list, 🧺 pantry, ⭐ wishlist.
// `membership` is store.getProductMembership() output; `exclude` is the current
// section ('list' | 'pantry' | 'wishlist') whose own badge is omitted (it would
// be redundant). Returns [] when the product is in no other list.
export function membershipBadges(productId, membership, exclude) {
  if (!membership) return [];
  const defs = [
    { key: 'list', set: membership.inList, icon: '🛒', label: 'In lista della spesa' },
    { key: 'pantry', set: membership.inPantry, icon: '🧺', label: 'In dispensa' },
    { key: 'wishlist', set: membership.inWishlist, icon: '⭐', label: 'Nei desideri' },
  ];
  const out = [];
  for (const d of defs) {
    if (d.key === exclude) continue;
    if (d.set && d.set.has(productId)) {
      out.push(el('span', { class: 'presence-badge', title: d.label, 'aria-label': d.label }, d.icon));
    }
  }
  return out;
}

// ----- openRenameProduct(currentName, onSave) ---------------------------------
// Reusable "rename product" modal shared by every section. Shows a text field
// pre-filled with the current name; on Save (non-empty, changed) calls
// onSave(newName) and closes. onSave should perform the actual store update
// (store.updateProduct), which renames the product everywhere it is referenced.
export function openRenameProduct(currentName, onSave) {
  const input = el('input', {
    type: 'text',
    class: 'input',
    value: currentName || '',
    placeholder: 'Nome prodotto…',
    autocomplete: 'off',
    'aria-label': 'Nuovo nome',
  });
  const content = el('div', {}, [
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, 'Nome'),
      input,
    ]),
  ]);
  openModal({
    title: 'Rinomina prodotto',
    content,
    actions: [
      { label: 'Annulla', onClick: (close) => close() },
      {
        label: 'Salva',
        primary: true,
        onClick: async (close) => {
          const name = input.value.trim();
          if (name === '') {
            toast('Inserisci un nome', 'info');
            return;
          }
          if (name === (currentName || '').trim()) {
            close();
            return;
          }
          if (typeof onSave === 'function') await onSave(name);
          close();
          toast('Nome aggiornato', 'success');
        },
      },
    ],
  });
  input.focus();
  input.select();
}

// ----- nameField({label, placeholder, onPick}) --------------------------------
// A labelled name input with product autocomplete wired in. Returns
// { element, inputEl, detach, value() }. onPick(product) fires when a suggestion
// is tapped (the caller may prefill the input). The typed text is read via value().
export function nameField({ label = 'Nome', placeholder = 'Nome prodotto…', onPick } = {}) {
  const inputEl = el('input', {
    type: 'text',
    class: 'input',
    placeholder,
    autocomplete: 'off',
    'aria-label': label,
  });
  const auto = attachAutocomplete(inputEl, {
    onPick: (product) => {
      inputEl.value = product.name;
      if (typeof onPick === 'function') onPick(product);
    },
    onConfirmNew: () => {
      // In a form, confirming via Enter should NOT submit on its own; the form has
      // its own primary action. We just keep the typed text.
    },
  });
  const element = el('div', { class: 'field' }, [
    el('span', { class: 'field-label' }, label),
    auto.element,
  ]);
  return {
    element,
    inputEl,
    detach: auto.detach,
    value: () => inputEl.value.trim(),
  };
}
