// js/views/strumenti-porzioni.js — "Calcolo porzioni cotte" tool.
// Inputs are built once; typing only re-renders the results zone (keeps focus).
// Last use is stored in localStorage (not synced).
import { el } from '../ui.js';
import { navigate } from '../router.js';
import {
  parseGrams, calcolaPorzioni, formatYield, formatGrams, resolveLastFromTotal,
} from '../porzioni.js';

const STORAGE_KEY = 'spesa_tool_porzioni_v1';

function emptyState() {
  return { people: [{ name: '', grams: '' }, { name: '', grams: '' }], totalRaw: '', cooked: '' };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return emptyState();
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !Array.isArray(d.people) || d.people.length === 0) return emptyState();
    const people = d.people.map((p) => ({
      name: p && typeof p.name === 'string' ? p.name : '',
      grams: p && typeof p.grams === 'string' ? p.grams : '',
    }));
    return {
      people,
      totalRaw: typeof d.totalRaw === 'string' ? d.totalRaw : '',
      cooked: typeof d.cooked === 'string' ? d.cooked : '',
    };
  } catch (_) {
    return emptyState();
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...state }));
  } catch (_) {
    /* storage unavailable: ignore */
  }
}

export function render(container) {
  const state = loadState();

  const resultsEl = el('div', { class: 'porz-results', 'aria-live': 'polite' });
  const rowsEl = el('div', { class: 'porz-rows' });

  const totalRawInput = el('input', {
    type: 'text', inputMode: 'decimal', class: 'input', placeholder: 'Facoltativo',
    'aria-label': 'Peso crudo totale (g)', value: state.totalRaw, autocomplete: 'off',
    onInput: (e) => { state.totalRaw = e.target.value; onChange(); },
  });
  const cookedInput = el('input', {
    type: 'text', inputMode: 'decimal', class: 'input', placeholder: 'es. 700',
    'aria-label': 'Peso cotto totale (g)', value: state.cooked, autocomplete: 'off',
    onInput: (e) => { state.cooked = e.target.value; onChange(); },
  });

  const addBtn = el('button', {
    type: 'button', class: 'btn-ghost', onClick: () => {
      state.people.push({ name: '', grams: '' });
      saveState(state);
      buildRows(state.people.length - 1);
      updateResults();
    },
  }, '+ Aggiungi persona');

  function onChange() {
    saveState(state);
    updateResults();
  }

  // Grams value for the last row when a raw total is set and valid.
  function lastIsComputed() {
    return parseGrams(state.totalRaw) != null;
  }

  // Rebuilds the person rows. Only called on add/remove, never while typing.
  function buildRows(focusIndex) {
    rowsEl.textContent = '';
    const n = state.people.length;
    state.people.forEach((p, i) => {
      const computed = i === n - 1 && n > 1 && lastIsComputed();
      const nameInput = el('input', {
        type: 'text', class: 'input porz-name', placeholder: `Persona ${i + 1}`,
        'aria-label': `Nome persona ${i + 1}`, value: p.name, autocomplete: 'off',
        onInput: (e) => { p.name = e.target.value; onChange(); },
      });
      const gramsInput = el('input', {
        type: 'text', inputMode: 'decimal', class: 'input porz-grams', placeholder: 'g crudi',
        'aria-label': `Grammi crudi persona ${i + 1}`, value: p.grams, autocomplete: 'off',
        onInput: (e) => { p.grams = e.target.value; onChange(); },
      });
      if (computed) gramsInput.disabled = true;
      gramsInput.dataset.idx = String(i);
      const removeBtn = el('button', {
        type: 'button', class: 'kebab-btn', 'aria-label': `Rimuovi persona ${i + 1}`,
        disabled: n <= 1,
        onClick: () => {
          state.people.splice(i, 1);
          saveState(state);
          buildRows();
          updateResults();
        },
      }, '✕');
      rowsEl.appendChild(el('div', { class: 'porz-row' }, [nameInput, gramsInput, removeBtn]));
      if (i === focusIndex) setTimeout(() => nameInput.focus(), 0);
    });
  }

  // Effective raw grams per person (with last computed from total if set).
  // Returns { raws: number[]|null, error?: string }.
  function effectiveRaws() {
    const n = state.people.length;
    const raws = state.people.map((p) => parseGrams(p.grams));
    const totalRaw = parseGrams(state.totalRaw);
    if (totalRaw != null && n > 1) {
      const head = raws.slice(0, n - 1);
      if (head.some((g) => g == null)) return { raws: null };
      const last = resolveLastFromTotal([...head, 0], totalRaw);
      if (last == null) {
        return { raws: null, error: 'Il peso crudo totale deve essere maggiore della somma delle altre persone.' };
      }
      return { raws: [...head, last] };
    }
    if (raws.some((g) => g == null)) return { raws: null };
    return { raws };
  }

  // Show the computed grams in the disabled last field without rebuilding inputs.
  function syncComputedField(raws) {
    const n = state.people.length;
    const inputs = rowsEl.querySelectorAll('.porz-grams');
    const last = inputs[n - 1];
    if (!last) return;
    const shouldBeComputed = n > 1 && lastIsComputed();
    last.disabled = shouldBeComputed;
    if (shouldBeComputed) {
      last.value = raws ? String(raws[n - 1]).replace('.', ',') : '';
    } else if (last.value !== state.people[n - 1].grams) {
      last.value = state.people[n - 1].grams;
    }
  }

  function updateResults() {
    const { raws, error } = effectiveRaws();
    syncComputedField(raws);
    resultsEl.textContent = '';
    if (error) {
      resultsEl.appendChild(el('p', { class: 'porz-hint porz-error' }, error));
      return;
    }
    const cooked = parseGrams(state.cooked);
    if (!raws || cooked == null) {
      resultsEl.appendChild(el('p', { class: 'porz-hint' },
        'Inserisci i grammi crudi di ogni persona e il peso cotto totale per vedere come porzionare.'));
      return;
    }
    const res = calcolaPorzioni(raws, cooked);
    if (!res.ok) {
      resultsEl.appendChild(el('p', { class: 'porz-hint porz-error' }, res.error));
      return;
    }
    resultsEl.appendChild(el('div', { class: 'porz-yield' }, `Resa: ${formatYield(res.yieldFactor)}`));
    resultsEl.appendChild(el('div', { class: 'porz-hint' },
      `Crudo totale ${formatGrams(res.total)} → cotto ${formatGrams(Math.round(cooked))}`));
    const list = el('div', { class: 'card list-card' });
    res.portions.forEach((g, i) => {
      const name = state.people[i].name.trim() || `Persona ${i + 1}`;
      list.appendChild(el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, name)]),
        el('strong', { class: 'porz-portion' }, formatGrams(g)),
      ]));
    });
    resultsEl.appendChild(list);
  }

  const header = el('div', { class: 'porz-header' }, [
    el('button', { type: 'button', class: 'btn-ghost', onClick: () => navigate('/strumenti') }, '‹ Strumenti'),
  ]);
  const form = el('div', { class: 'card porz-form' }, [
    el('p', { class: 'porz-hint' }, 'Per ogni persona indica i grammi di pasta o riso da crudo, poi pesa il tutto da cotto.'),
    rowsEl,
    addBtn,
    el('label', { class: 'field' }, [el('span', { class: 'field-label' }, 'Peso crudo totale (g)'), totalRawInput]),
    el('label', { class: 'field' }, [el('span', { class: 'field-label' }, 'Peso cotto totale (g)'), cookedInput]),
  ]);

  container.appendChild(header);
  container.appendChild(el('h2', { class: 'tool-title' }, 'Calcolo porzioni cotte'));
  container.appendChild(form);
  container.appendChild(resultsEl);

  buildRows();
  updateResults();

  return { destroy() {} };
}
