// js/store.js — domain layer over db.js (design §4/§5/§6/§7/§8).
// Encodes orchestrator decisions D1 (unit summing in mergePantryQuantity via units.combine)
// and D2 (deleteProductCascade inside a single db.runTx). Store never calls UI or sync.

import * as db from './db.js';
import { UNITS, combine, compatible, formatQty, dimensionOf, parseDecimal } from './units.js';

// ----- Utilities (§5) --------------------------------------------------------

// uid() — UUID v4. crypto.randomUUID() in secure contexts, else a getRandomValues fallback
// (works in non-secure contexts like plain http://<lan-ip>). Finding #13.
export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

export function nowISO() {
  return new Date().toISOString();
}

// todayISO() — 'YYYY-MM-DD' local date.
export function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function normalizeName(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// daysUntil(expiryYMD) — integer local-calendar day delta (§5 contract).
export function daysUntil(expiryYMD) {
  const [y, m, d] = expiryYMD.split('-').map(Number);
  const exp = new Date(y, m - 1, d); // local midnight of expiry
  const now = new Date();
  now.setHours(0, 0, 0, 0); // local midnight today
  return Math.round((exp - now) / 86400000);
}

// expiryLevel(expiryYMD) — single source of truth for expiry severity, shared by
// the pantry rows, the nav badges and any summary. Returns one of:
//   null       -> no expiry set (expiryYMD null/empty)
//   'ok'       -> more than 7 days left
//   'warn'     -> 4..7 days left (yellow)
//   'soon'     -> 1..3 days left (orange)
//   'today'    -> expires today (red)
//   'expired'  -> already past (red, worst)
export function expiryLevel(expiryYMD) {
  if (expiryYMD == null || expiryYMD === '') return null;
  const d = daysUntil(expiryYMD);
  if (d < 0) return 'expired';
  if (d === 0) return 'today';
  if (d <= 3) return 'soon';
  if (d <= 7) return 'warn';
  return 'ok';
}

// A pantry item "counts as expiring" when its level is one of the attention
// states (warn/soon/today/expired) — used for the nav badge and summaries.
const EXPIRING_LEVELS = new Set(['warn', 'soon', 'today', 'expired']);

// countExpiring() — how many live pantry VOICES need attention (expiring/expired).
// A voice counts if ANY of its batches is expiring (voiceIsExpiring, reusing EXPIRING_LEVELS).
export async function countExpiring() {
  const items = await getAllPantry();
  return items.filter(voiceIsExpiring).length;
}

// countListToBuy() — how many live shopping items are not yet bought.
export async function countListToBuy() {
  const items = await getAllList();
  return items.filter((v) => v.bought === false).length;
}

// ----- Meta helpers ----------------------------------------------------------

export async function getMeta(key, fallback = null) {
  const rec = await db.get('meta', key);
  return rec === undefined ? fallback : rec.value;
}

export async function setMeta(key, value) {
  await db.put('meta', { key, value });
}

// ----- coerceQty invariant (§4) ----------------------------------------------
// null<->null together; non-null value + null unit -> 'pz'; else leave as given.
function coerceQty(qtyValue, qtyUnit) {
  if (qtyValue == null) return { qtyValue: null, qtyUnit: null };
  if (qtyUnit == null) return { qtyValue, qtyUnit: 'pz' };
  return { qtyValue, qtyUnit };
}

// ----- Pantry BATCH model — pure helpers (design §1.3/§3/§5.0/§5.1) ----------
// A pantry voice carries a `batches` array of { qtyValue, qtyUnit, expiry }.
// All of the following are PURE (no IDB/DOM): normalizeBatches/voiceUnitTotals are
// also time-independent (no daysUntil); voiceMostUrgentLevel/voiceIsExpiring derive
// from the clock and are RENDER derivations (not persisted).

// sameExpiry(a, b) — two batches share the same expiry (both null == same).
function sameExpiry(a, b) {
  return (a.expiry ?? null) === (b.expiry ?? null);
}

// round3(x) — round to 3 decimals, consistent with units.combine.
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// normalizeBatches(rawBatches) -> Batch[]
//   Deterministic, idempotent, TIME-INDEPENDENT arbiter of the §1.3 invariant.
//   0) tolerant to non-array input (undefined/null/object -> []);
//   1) coerceQty per batch; drop qtyValue === 0;
//   2) group by (expiryKey, dimKey) and sum compatibles via combine (<=1 per pair);
//   3) per expiry, absorb qtyValue == null batches when a quantified one exists;
//   4) canonical stable order: expiry asc (null last), then dimKey, then qtyUnit.
export function normalizeBatches(rawBatches) {
  const src = Array.isArray(rawBatches) ? rawBatches : [];

  // Step 1: coerce + drop zero-quantity batches.
  const coerced = [];
  for (const b of src) {
    if (!b) continue;
    const q = coerceQty(b.qtyValue, b.qtyUnit);
    if (q.qtyValue === 0) continue; // zero = nothing
    coerced.push({ qtyValue: q.qtyValue, qtyUnit: q.qtyUnit, expiry: b.expiry ?? null });
  }

  // Step 2: group by (expiryKey, dimKey) and sum compatibles.
  const groups = new Map(); // key -> accumulated batch
  for (const b of coerced) {
    const expiryKey = b.expiry ?? '\u2205'; // null/empty -> "no expiry"
    const dimKey = dimensionOf(b.qtyUnit) ?? ('?' + String(b.qtyUnit));
    const key = expiryKey + '|' + dimKey;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, { ...b });
      continue;
    }
    // One of them may be a null-quantity placeholder; prefer the quantified one.
    if (cur.qtyValue == null) {
      groups.set(key, { ...b });
    } else if (b.qtyValue == null) {
      // keep cur (quantified), absorb the null
    } else {
      const sum = combine(
        { qtyValue: cur.qtyValue, qtyUnit: cur.qtyUnit },
        { qtyValue: b.qtyValue, qtyUnit: b.qtyUnit }
      );
      if (sum.ok) {
        groups.set(key, { qtyValue: sum.qtyValue, qtyUnit: sum.qtyUnit, expiry: cur.expiry });
      } else {
        // Shouldn't happen within a single dimKey, but keep cur defensively.
      }
    }
  }

  let out = Array.from(groups.values());

  // Step 3: per expiry, drop null-quantity batches if a quantified one exists.
  const hasQtyForExpiry = new Set();
  for (const b of out) {
    if (b.qtyValue != null) hasQtyForExpiry.add(b.expiry ?? '\u2205');
  }
  out = out.filter((b) => {
    if (b.qtyValue != null) return true;
    return !hasQtyForExpiry.has(b.expiry ?? '\u2205'); // absorb redundant null
  });

  // Step 4: canonical stable order (expiry asc, null last; then dim; then unit).
  out.sort((a, b) => {
    const ea = a.expiry ?? null;
    const eb = b.expiry ?? null;
    if (ea !== eb) {
      if (ea == null) return 1; // null expiry sinks to the bottom
      if (eb == null) return -1;
      return ea < eb ? -1 : 1;
    }
    const da = dimensionOf(a.qtyUnit) ?? ('?' + String(a.qtyUnit));
    const dbk = dimensionOf(b.qtyUnit) ?? ('?' + String(b.qtyUnit));
    if (da !== dbk) return da < dbk ? -1 : 1;
    const ua = String(a.qtyUnit);
    const ub = String(b.qtyUnit);
    if (ua !== ub) return ua < ub ? -1 : 1;
    return 0;
  });

  return out;
}

// voiceMostUrgentLevel(voice) -> level | null — most urgent dated batch (min daysUntil).
// RENDER derivation (clock-dependent); null if no dated batch.
export function voiceMostUrgentLevel(voice) {
  const batches = Array.isArray(voice.batches) ? voice.batches : [];
  let best = null; // { level, days }
  for (const b of batches) {
    const level = expiryLevel(b.expiry);
    if (level == null) continue;
    const days = daysUntil(b.expiry);
    if (best == null || days < best.days) best = { level, days };
  }
  return best ? best.level : null;
}

// voiceIsExpiring(voice) -> boolean — at least one batch is warn/soon/today/expired.
// Reuses the EXPIRING_LEVELS set (no new threshold).
export function voiceIsExpiring(voice) {
  const batches = Array.isArray(voice.batches) ? voice.batches : [];
  return batches.some((b) => EXPIRING_LEVELS.has(expiryLevel(b.expiry)));
}

// voiceUnitTotals(voice) -> Array<{qtyValue, qtyUnit}> — per-dimension totals summed
// via units.combine (for the compact row summary). null-quantity batches don't contribute.
export function voiceUnitTotals(voice) {
  const batches = Array.isArray(voice.batches) ? voice.batches : [];
  const byDim = new Map(); // dimKey -> { qtyValue, qtyUnit }
  for (const b of batches) {
    if (b.qtyValue == null) continue;
    const dim = dimensionOf(b.qtyUnit);
    const dimKey = dim ?? ('?' + String(b.qtyUnit));
    const cur = byDim.get(dimKey);
    if (!cur) {
      byDim.set(dimKey, { qtyValue: b.qtyValue, qtyUnit: b.qtyUnit });
      continue;
    }
    const sum = combine(
      { qtyValue: cur.qtyValue, qtyUnit: cur.qtyUnit },
      { qtyValue: b.qtyValue, qtyUnit: b.qtyUnit }
    );
    if (sum.ok) {
      byDim.set(dimKey, { qtyValue: sum.qtyValue, qtyUnit: sum.qtyUnit });
    }
  }
  return Array.from(byDim.values());
}

// ensureVoiceShape(voice) — lazy on-read migration (design §10). Idempotent + lossless.
//   New-shape voice (batches is array) -> returned unchanged.
//   Old flat shape -> { ...voice, batches: normalizeBatches([{qtyValue,qtyUnit,expiry}]) }.
//   Legacy flat fields are left on the object in RAM (nulled on remote write, §6).
export function ensureVoiceShape(voice) {
  if (Array.isArray(voice.batches)) return voice;
  const b =
    voice.qtyValue != null || voice.expiry != null
      ? [{ qtyValue: voice.qtyValue, qtyUnit: voice.qtyUnit, expiry: voice.expiry }]
      : [];
  return { ...voice, batches: normalizeBatches(b) };
}

// ----- Tombstone-filtering read helpers (§5) ---------------------------------

export async function getAllProducts() {
  return (await db.getAll('products')).filter((p) => p.deleted === false);
}

export async function getProduct(id) {
  const p = await db.get('products', id);
  return p && p.deleted === false ? p : undefined;
}

export async function getAllList() {
  return (await db.getAll('list')).filter((v) => v.deleted === false);
}

export async function getAllPantry() {
  // Lazy on-read migration to the batch shape (§10): never rewrites, no updatedAt bump.
  return (await db.getAll('pantry')).filter((v) => v.deleted === false).map(ensureVoiceShape);
}

export async function getAllWishlist() {
  return (await db.getAll('wishlist')).filter((v) => v.deleted === false);
}

// getProductMembership() — for cross-section presence badges. Returns three Sets
// of productId: which products currently appear (live, non-deleted) in the
// shopping list, the pantry, and the wishlist. Views load this once per render
// and look up each row's productId in O(1).
export async function getProductMembership() {
  const [list, pantry, wishlist] = await Promise.all([
    getAllList(),
    getAllPantry(),
    getAllWishlist(),
  ]);
  return {
    inList: new Set(list.map((v) => v.productId)),
    inPantry: new Set(pantry.map((v) => v.productId)),
    inWishlist: new Set(wishlist.map((v) => v.productId)),
  };
}

// ----- touchProduct (internal, §5 / §7) --------------------------------------
// Bumps updatedAt for autocomplete recency. No-op if product missing or deleted.
// Called by EXACTLY: getOrCreateProduct (existing hit), ensureListRef, ensureWishlistRef,
// addListItem, addPantryItem, and the CREATE path of mergePantryQuantity. Nothing else.
async function touchProduct(productId) {
  const p = await db.get('products', productId);
  if (!p || p.deleted === true) return;
  p.updatedAt = nowISO();
  await db.put('products', p);
}

// ----- Get-or-create (§6) ----------------------------------------------------

export async function findProductByNameLower(nameLower) {
  const matches = await db.getByIndex('products', 'nameLower', nameLower);
  return matches.find((p) => p.deleted === false);
}

export async function getOrCreateProduct(name) {
  const nameLower = normalizeName(name);
  const existing = await findProductByNameLower(nameLower);
  if (existing) {
    await touchProduct(existing.id);
    return existing;
  }
  const now = nowISO();
  const product = {
    id: uid(),
    name: name.trim().replace(/\s+/g, ' '),
    nameLower,
    recurring: false,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('products', product);
  return product;
}

// ----- Autocomplete (§7) -----------------------------------------------------

export async function suggestProducts(query, limit = 8) {
  const q = normalizeName(query);
  const products = await getAllProducts();
  const byRecency = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

  if (q === '') {
    return products.sort(byRecency).slice(0, limit);
  }

  const filtered = products.filter((p) => p.nameLower.includes(q));
  const exact = filtered.filter((p) => p.nameLower === q).sort(byRecency);
  const starts = filtered
    .filter((p) => p.nameLower !== q && p.nameLower.startsWith(q))
    .sort(byRecency);
  const rest = filtered
    .filter((p) => p.nameLower !== q && !p.nameLower.startsWith(q))
    .sort(byRecency);
  return [...exact, ...starts, ...rest].slice(0, limit);
}

// ----- Product CRUD (§5/§8) --------------------------------------------------

export async function createProduct({ name, recurring = false }) {
  const now = nowISO();
  const product = {
    id: uid(),
    name: name.trim().replace(/\s+/g, ' '),
    nameLower: normalizeName(name),
    recurring,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('products', product);
  return product;
}

export async function updateProduct(id, patch) {
  const p = await db.get('products', id);
  if (!p) throw new Error(`updateProduct: product ${id} not found`);
  const updated = { ...p, ...patch, id: p.id, updatedAt: nowISO() };
  if (patch.name !== undefined) {
    updated.name = patch.name.trim().replace(/\s+/g, ' ');
    updated.nameLower = normalizeName(patch.name);
  }
  await db.put('products', updated);
  return updated;
}

// toggleRecurring — updates ONLY recurring + updatedAt. NOT a touchProduct caller (finding #8).
export async function toggleRecurring(id) {
  const p = await db.get('products', id);
  if (!p) throw new Error(`toggleRecurring: product ${id} not found`);
  p.recurring = !p.recurring;
  p.updatedAt = nowISO();
  await db.put('products', p);
  return p;
}

// deleteProductCascade (D2, §8) — soft-delete every live list/pantry/wishlist ref then the
// product, entirely inside ONE db.runTx. runTx's on-commit onChange drives view + single push.
export async function deleteProductCascade(id) {
  await db.runTx(['products', 'list', 'pantry', 'wishlist'], 'readwrite', (tx) => {
    const now = nowISO();

    const softDeleteRefs = (storeName) => {
      const idx = tx.objectStore(storeName).index('productId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value;
        if (rec.deleted === false) {
          rec.deleted = true;
          rec.updatedAt = now;
          cursor.update(rec);
        }
        cursor.continue();
      };
    };

    softDeleteRefs('list');
    softDeleteRefs('pantry');
    softDeleteRefs('wishlist');

    // Soft-delete the product itself.
    const prodStore = tx.objectStore('products');
    const getReq = prodStore.get(id);
    getReq.onsuccess = () => {
      const p = getReq.result;
      if (p && p.deleted === false) {
        p.deleted = true;
        p.updatedAt = now;
        prodStore.put(p);
      }
    };
  });
}

// ----- List (§8) -------------------------------------------------------------

// nextListSortOrder — a sortOrder that places a new item at the END of the list.
async function nextListSortOrder() {
  const live = await getAllList();
  let max = 0;
  for (const v of live) {
    const s = typeof v.sortOrder === 'number' ? v.sortOrder : 0;
    if (s > max) max = s;
  }
  return max + 1000; // leave gaps so manual reordering rarely needs a full rewrite
}

// addListItem — low-level create primitive, NO dedup. Called only by ensureListRef.
export async function addListItem({ productId, qtyValue = null, qtyUnit = null }) {
  const q = coerceQty(qtyValue, qtyUnit);
  const now = nowISO();
  const voice = {
    id: uid(),
    productId,
    qtyValue: q.qtyValue,
    qtyUnit: q.qtyUnit,
    bought: false,
    sortOrder: await nextListSortOrder(),
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('list', voice);
  await touchProduct(productId);
  return voice;
}

export async function updateListItem(id, patch) {
  const v = await db.get('list', id);
  if (!v) throw new Error(`updateListItem: list item ${id} not found`);
  const next = { ...v, ...patch, id: v.id };
  if ('qtyValue' in patch || 'qtyUnit' in patch) {
    const q = coerceQty(next.qtyValue, next.qtyUnit);
    next.qtyValue = q.qtyValue;
    next.qtyUnit = q.qtyUnit;
  }
  next.updatedAt = nowISO();
  await db.put('list', next);
  return next;
}

// markBought (D3) — item stays in the list, flagged bought.
export async function markBought(id, bought = true) {
  const v = await db.get('list', id);
  if (!v) throw new Error(`markBought: list item ${id} not found`);
  v.bought = bought;
  v.updatedAt = nowISO();
  await db.put('list', v);
  return v;
}

export async function discardListItem(id) {
  await db.del('list', id);
}

// setListOrder(orderedIds) — persist a manual ordering of shopping-list items.
// orderedIds is the desired top-to-bottom order of (typically not-bought) voices.
// Writes an increasing sortOrder to each; only rows whose value actually changes
// are written (fewer onChange/push). Returns the number of rows updated.
export async function setListOrder(orderedIds) {
  let changed = 0;
  let order = 1000;
  for (const id of orderedIds) {
    const v = await db.get('list', id);
    if (v && v.deleted === false && v.sortOrder !== order) {
      v.sortOrder = order;
      v.updatedAt = nowISO();
      await db.put('list', v);
      changed += 1;
    }
    order += 1000;
  }
  return changed;
}

// clearBoughtListItems — soft-delete every live BOUGHT shopping item in one pass.
// Returns the number removed. Each del() fires onChange so views re-render + a push
// is scheduled. The product stays in the catalog.
export async function clearBoughtListItems() {
  const bought = (await getAllList()).filter((v) => v.bought === true);
  for (const v of bought) {
    await db.del('list', v.id);
  }
  return bought.length;
}

// listItemToPantry (§8) — read qty -> mergePantryQuantity -> discardListItem.
export async function listItemToPantry(id, location) {
  const v = await db.get('list', id);
  if (!v) throw new Error(`listItemToPantry: list item ${id} not found`);
  const result = await mergePantryQuantity(location, v.productId, v.qtyValue, v.qtyUnit);
  await discardListItem(id);
  return result;
}

// boughtListItemsToPantry(moves) — bulk "put bought items away".
// `moves` is an array of { id, location ('frigo'|'dispensa'), expiry (YYYY-MM-DD|null),
//   qtyValue?, qtyUnit? }. The quantity, if provided (edited in the modal), overrides
// the list voice's quantity; otherwise the list voice's quantity is used.
// For each, read the list voice, add a batch to the destination pantry voice
// (merging per the batch rules), then remove it from the shopping list.
// Missing/non-bought voices are skipped. Returns the count moved.
export async function boughtListItemsToPantry(moves) {
  let moved = 0;
  for (const m of moves) {
    const v = await db.get('list', m.id);
    if (!v || v.deleted === true) continue;
    const qtyValue = m.qtyValue !== undefined ? m.qtyValue : v.qtyValue;
    const qtyUnit = m.qtyUnit !== undefined ? m.qtyUnit : v.qtyUnit;
    await addPantryBatch(m.location, v.productId, {
      qtyValue,
      qtyUnit,
      expiry: m.expiry ?? null,
    });
    await discardListItem(m.id);
    moved += 1;
  }
  return moved;
}

// ----- Pantry (§8) -----------------------------------------------------------

// addPantryItem({ productId, location, batches = [] }) — low-level create primitive
// in the BATCH model (§5.2). No merge with existing voices. Batches are normalized.
export async function addPantryItem({ productId, location, batches = [] }) {
  const now = nowISO();
  const voice = {
    id: uid(),
    productId,
    location,
    batches: normalizeBatches(batches),
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('pantry', voice);
  await touchProduct(productId);
  return voice;
}

export async function updatePantryItem(id, patch) {
  const v = await db.get('pantry', id);
  if (!v) throw new Error(`updatePantryItem: pantry item ${id} not found`);
  const next = { ...v, ...patch, id: v.id };
  if ('batches' in patch) {
    next.batches = normalizeBatches(patch.batches);
  }
  next.updatedAt = nowISO();
  await db.put('pantry', next);
  return next;
}

export async function removePantryItem(id) {
  await db.del('pantry', id);
}

// addPantryBatch(location, productId, batch) -> { merged, keptSeparate, separateReason, voice }
//   Merge a single batch into the live voice for (productId, location) per §5.3.
//   The live voice is resolved via getAllPantry() (ensureVoiceShape applied on-read), so
//   existing.batches is always a canonical array. keptSeparate/merged compare against the
//   normalized `base`; separateReason distinguishes 'unit' (same expiry, incompatible unit)
//   from 'expiry' (new date).
export async function addPantryBatch(location, productId, batch) {
  const existing = (await getAllPantry()).find(
    (v) => v.productId === productId && v.location === location
  );

  if (!existing) {
    const normalized = normalizeBatches([batch]);
    if (normalized.length === 0) {
      // Null/zero batch on a non-existent voice -> create nothing.
      return { merged: false, keptSeparate: false, separateReason: null, voice: null };
    }
    const created = await addPantryItem({ productId, location, batches: normalized });
    return { merged: false, keptSeparate: false, separateReason: null, voice: created };
  }

  const base = normalizeBatches(existing.batches);
  const next = normalizeBatches([...base, batch]);
  const keptSeparate = next.length > base.length;
  const merged = !keptSeparate;
  const separateReason = keptSeparate
    ? (base.some((b) => sameExpiry(b, batch)) ? 'unit' : 'expiry')
    : null;

  if (next.length === 0) {
    await removePantryItem(existing.id);
    return { merged, keptSeparate, separateReason, voice: null };
  }
  const updated = await updatePantryItem(existing.id, { batches: next });
  return { merged, keptSeparate, separateReason, voice: updated };
}

// setPantryBatches(voiceId, rawBatches) -> { voice|null, removed } — editor save path (§5.3).
// normalizeBatches is the sole arbiter; an empty result soft-deletes the voice.
export async function setPantryBatches(voiceId, rawBatches) {
  const v = await db.get('pantry', voiceId);
  if (!v) throw new Error(`setPantryBatches: pantry item ${voiceId} not found`);
  const next = normalizeBatches(rawBatches);
  if (next.length === 0) {
    await removePantryItem(voiceId);
    return { voice: null, removed: true };
  }
  const updated = await updatePantryItem(voiceId, { batches: next });
  return { voice: updated, removed: false };
}

// mergePantryQuantity(location, productId, qtyValue, qtyUnit, expiry = null)
//   Compat adapter over addPantryBatch for existing callers (§5.3). Extended return:
//   { merged, keptSeparate, separateReason, items }.
export async function mergePantryQuantity(location, productId, qtyValue, qtyUnit, expiry = null) {
  const r = await addPantryBatch(location, productId, { qtyValue, qtyUnit, expiry });
  return {
    merged: r.merged,
    keptSeparate: r.keptSeparate,
    separateReason: r.separateReason,
    items: r.voice ? [r.voice] : [],
  };
}

// movePantryBatches(sourceId, toLocation, selection) -> { moved, sourceRemoved, destVoice }
//   Single-snapshot algorithm (§5.4). selection: null|'all' = wholesale; else
//   Array<{index, qty?}> resolved ONCE against the snapshot before any mutation.
export async function movePantryBatches(sourceId, toLocation, selection) {
  const source = await db.get('pantry', sourceId);
  if (!source) throw new Error(`movePantryBatches: pantry item ${sourceId} not found`);
  if (toLocation === source.location) {
    return { moved: 0, sourceRemoved: false, destVoice: source };
  }

  // (a) read + normalize once.
  const snap = normalizeBatches(ensureVoiceShape(source).batches);

  // (b) resolve ALL selections against snap before mutating.
  const moved = [];
  const remaining = [];
  if (selection == null || selection === 'all') {
    for (const b of snap) moved.push({ ...b });
  } else {
    const picked = new Map(); // index -> qty
    for (const s of selection) {
      if (!s || typeof s.index !== 'number') continue;
      if (s.index < 0 || s.index >= snap.length) continue;
      if (picked.has(s.index)) continue;
      picked.set(s.index, s.qty);
    }
    for (let i = 0; i < snap.length; i++) {
      const b = snap[i];
      if (!picked.has(i)) {
        remaining.push({ ...b });
        continue;
      }
      if (b.qtyValue == null) {
        // Unknown quantity -> moved whole (qty ignored).
        moved.push({ ...b });
        continue;
      }
      const q = parseDecimal(picked.get(i));
      if (q == null || q >= b.qtyValue) {
        moved.push({ ...b }); // whole batch
        continue;
      }
      const residual = round3(b.qtyValue - q);
      moved.push({ qtyValue: q, qtyUnit: b.qtyUnit, expiry: b.expiry });
      if (residual > 0) {
        remaining.push({ qtyValue: residual, qtyUnit: b.qtyUnit, expiry: b.expiry });
      }
    }
  }

  // (c) apply to destination (standard merge rule).
  for (const b of moved) {
    await addPantryBatch(toLocation, source.productId, b);
  }

  // (d) rewrite the source once.
  let sourceRemoved = false;
  const next = normalizeBatches(remaining);
  if (next.length === 0) {
    await removePantryItem(sourceId);
    sourceRemoved = true;
  } else {
    await updatePantryItem(sourceId, { batches: next });
  }

  return { moved: moved.length, sourceRemoved, destVoice: null };
}

// ----- Wishlist (§8) ---------------------------------------------------------

export async function addWishlistItem({ productId }) {
  const now = nowISO();
  const voice = {
    id: uid(),
    productId,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('wishlist', voice);
  return voice;
}

export async function removeWishlistItem(id) {
  await db.del('wishlist', id);
}

// ----- Bulk helpers for multi-select actions ---------------------------------
// Each loops the per-item primitive so every mutation fires onChange (views
// re-render, push is scheduled). Returned count = items processed.

export async function deleteProductsCascade(ids) {
  for (const id of ids) await deleteProductCascade(id);
  return ids.length;
}

export async function addProductsToList(productIds) {
  for (const pid of productIds) await ensureListRef(pid);
  return productIds.length;
}

export async function addProductsToWishlist(productIds) {
  for (const pid of productIds) await ensureWishlistRef(pid);
  return productIds.length;
}

// setRecurringMany — force the recurring flag to a given value on many products.
export async function setRecurringMany(ids, value) {
  for (const id of ids) {
    const p = await db.get('products', id);
    if (p && p.deleted === false && p.recurring !== value) {
      p.recurring = value;
      p.updatedAt = nowISO();
      await db.put('products', p);
    }
  }
  return ids.length;
}

// ----- Bulk helpers keyed by VOICE id (list/pantry/wishlist) -----------------
// These take the ids of entries in a section (not product ids) and act in bulk.

// List voices:
export async function markBoughtMany(listIds, bought = true) {
  for (const id of listIds) {
    const v = await db.get('list', id);
    if (v && v.deleted === false && v.bought !== bought) {
      v.bought = bought;
      v.updatedAt = nowISO();
      await db.put('list', v);
    }
  }
  return listIds.length;
}

export async function discardListItemsMany(listIds) {
  for (const id of listIds) await db.del('list', id);
  return listIds.length;
}

// Move many list voices to the pantry at one location (inherits qty, sums if present).
export async function listItemsToPantryMany(listIds, location) {
  let moved = 0;
  for (const id of listIds) {
    const v = await db.get('list', id);
    if (!v || v.deleted === true) continue;
    await mergePantryQuantity(location, v.productId, v.qtyValue, v.qtyUnit);
    await db.del('list', id);
    moved += 1;
  }
  return moved;
}

// Pantry voices:
export async function removePantryItemsMany(pantryIds) {
  for (const id of pantryIds) await db.del('pantry', id);
  return pantryIds.length;
}

// Wishlist voices:
export async function removeWishlistItemsMany(wishlistIds) {
  for (const id of wishlistIds) await db.del('wishlist', id);
  return wishlistIds.length;
}

// Add many section voices' PRODUCTS to the shopping list / wishlist / pantry.
// `voiceStore` is 'list' | 'pantry' | 'wishlist'; we read each voice's productId.
async function productIdsFromVoices(voiceStore, voiceIds) {
  const out = [];
  for (const id of voiceIds) {
    const v = await db.get(voiceStore, id);
    if (v && v.deleted === false && v.productId) out.push(v.productId);
  }
  return out;
}

export async function voicesToList(voiceStore, voiceIds) {
  const pids = await productIdsFromVoices(voiceStore, voiceIds);
  for (const pid of pids) await ensureListRef(pid);
  return pids.length;
}

export async function voicesToWishlist(voiceStore, voiceIds) {
  const pids = await productIdsFromVoices(voiceStore, voiceIds);
  for (const pid of pids) await ensureWishlistRef(pid);
  return pids.length;
}

export async function voicesToPantry(voiceStore, voiceIds, location) {
  const pids = await productIdsFromVoices(voiceStore, voiceIds);
  for (const pid of pids) await mergePantryQuantity(location, pid, null, null);
  return pids.length;
}

// ----- Cross-section helpers (§8) --------------------------------------------

// ensureListRef — SOLE list dedup entry point. Returns the existing live not-bought voice;
// if the sole live voice is bought, creates a NEW not-bought voice. Calls touchProduct.
export async function ensureListRef(productId) {
  const live = (await getAllList()).filter((v) => v.productId === productId);
  const notBought = live.find((v) => v.bought === false);
  if (notBought) {
    await touchProduct(productId);
    return notBought;
  }
  // Either no live voice, or the only live voice(s) are bought -> create a new not-bought voice.
  // addListItem already calls touchProduct; call touchProduct here too so ensureListRef
  // always bumps recency per its §5 contract (no-op-safe duplicate bump is harmless).
  const created = await addListItem({ productId });
  await touchProduct(productId);
  return created;
}

export async function ensureWishlistRef(productId) {
  const live = (await getAllWishlist()).filter((v) => v.productId === productId);
  if (live[0]) {
    await touchProduct(productId);
    return live[0];
  }
  const created = await addWishlistItem({ productId });
  await touchProduct(productId);
  return created;
}

export { UNITS };
