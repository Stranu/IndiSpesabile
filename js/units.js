// js/units.js — unit compatibility/conversion + Italian-decimal parsing (design §11).
// Orchestrator decisions D1 (unit summing via combine) and D4 (Italian-comma parseDecimal).

export const UNITS = ['pz', 'kg', 'g', 'l', 'ml'];

// Dimension map: which units are mutually convertible.
const DIM = { pz: 'count', kg: 'mass', g: 'mass', l: 'vol', ml: 'vol' };
// Conversion to the dimension's base unit (base = g for mass, ml for vol, pz for count).
const TO_BASE = { kg: 1000, g: 1, l: 1000, ml: 1, pz: 1 };
// Normalize-to-larger target unit per dimension.
const LARGER = { mass: 'kg', vol: 'l', count: 'pz' };

// parseDecimal(input): accepts the Italian comma as the decimal separator ('0,5' -> 0.5).
// Thousands separators are NOT supported (D4, finding #12). Empty/NaN/negative -> null; 0 is valid.
export function parseDecimal(input) {
  if (input == null) return null;
  const s = String(input).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null; // NaN / Infinity -> null
  if (n < 0) return null;               // negative rejected
  return n;                             // 0 valid
}

// compatible(a, b): same dimension and both known units.
export function compatible(unitA, unitB) {
  return DIM[unitA] !== undefined && DIM[unitB] !== undefined && DIM[unitA] === DIM[unitB];
}

// combine(a, b) where a/b are {qtyValue, qtyUnit}.
// Returns {ok:true, qtyValue, qtyUnit} on a successful compatible sum, else {ok:false}.
export function combine(a, b) {
  // Guard (finding #6): a non-null qtyValue paired with a null/unknown unit -> not summable.
  if (a.qtyValue != null && DIM[a.qtyUnit] === undefined) return { ok: false };
  if (b.qtyValue != null && DIM[b.qtyUnit] === undefined) return { ok: false };
  // Incompatible dimensions (e.g. pz + kg) -> cannot sum.
  if (!compatible(a.qtyUnit, b.qtyUnit)) return { ok: false };

  const dim = DIM[a.qtyUnit];
  const baseSum = a.qtyValue * TO_BASE[a.qtyUnit] + b.qtyValue * TO_BASE[b.qtyUnit];
  const targetUnit = LARGER[dim];           // pz+pz stays pz
  const value = baseSum / TO_BASE[targetUnit];
  const rounded = Math.round(value * 1000) / 1000; // round to 3 decimals
  return { ok: true, qtyValue: rounded, qtyUnit: targetUnit };
}

// formatQty: Italian-comma display (e.g. '0,5 kg'); '' if value is null.
export function formatQty(qtyValue, qtyUnit) {
  if (qtyValue == null) return '';
  const str = String(qtyValue).replace('.', ',');
  return qtyUnit ? `${str} ${qtyUnit}` : str;
}
