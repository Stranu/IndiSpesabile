// js/porzioni.js — pure calculation for the "Calcolo porzioni cotte" tool (no DOM).
// Splits a cooked total proportionally to the raw grams of each person.
import { parseDecimal } from './units.js';

// parseGrams(text) -> number (>0) | null. Accepts "350", "350,5", "350.5".
export function parseGrams(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!/^\d+([.,]\d+)?$/.test(s)) return null; // no exponent/hex/sign
  const n = parseDecimal(s);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

// calcolaPorzioni(rawGrams, cookedTotal) — largest-remainder rounding so the
// integer portions always sum to Math.round(cookedTotal).
export function calcolaPorzioni(rawGrams, cookedTotal) {
  if (!Array.isArray(rawGrams) || rawGrams.length === 0) {
    return { ok: false, error: 'Inserisci almeno una persona.' };
  }
  for (const g of rawGrams) {
    if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0) {
      return { ok: false, error: 'I grammi crudi devono essere maggiori di zero.' };
    }
  }
  if (typeof cookedTotal !== 'number' || !Number.isFinite(cookedTotal) || cookedTotal <= 0) {
    return { ok: false, error: 'Il peso cotto deve essere maggiore di zero.' };
  }
  const S = rawGrams.reduce((a, b) => a + b, 0);
  const T = Math.round(cookedTotal);
  if (!Number.isFinite(S) || S <= 0 || T <= 0) {
    return { ok: false, error: 'Valori non validi.' };
  }
  const exact = rawGrams.map((g) => (T * g) / S);
  const portions = exact.map((x) => Math.floor(x));
  let left = T - portions.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) portions[order[k].i] += 1;
  return { ok: true, total: S, yieldFactor: cookedTotal / S, portions };
}

// formatYield(2) -> "2,0x"
export function formatYield(factor) {
  if (!Number.isFinite(factor)) return '';
  return factor.toFixed(1).replace('.', ',') + 'x';
}

// formatGrams(200) -> "200 g"
export function formatGrams(n) {
  if (!Number.isFinite(n)) return '';
  return `${Math.round(n * 10) / 10} g`.replace('.', ',');
}

// Grams of the last person = totalRaw - sum(others); null if <= 0 or invalid.
export function resolveLastFromTotal(rawGrams, totalRaw) {
  if (!Array.isArray(rawGrams) || typeof totalRaw !== 'number' || !Number.isFinite(totalRaw)) return null;
  const others = rawGrams.slice(0, -1).reduce((a, b) => a + b, 0);
  const v = totalRaw - others;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}
