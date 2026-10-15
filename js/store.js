// js/store.js — domain layer over db.js (design §4/§5/§6/§7/§8).
// Encodes orchestrator decisions D1 (unit summing in mergePantryQuantity via units.combine)
// and D2 (deleteProductCascade inside a single db.runTx). Store never calls UI or sync.

import * as db from './db.js';
import { UNITS, combine } from './units.js';

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

// countExpiring() — how many live pantry items need attention (expiring/expired).
export async function countExpiring() {
  const items = await getAllPantry();
  let n = 0;
  for (const it of items) {
    if (EXPIRING_LEVELS.has(expiryLevel(it.expiry))) n += 1;
  }
  return n;
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
  return (await db.getAll('pantry')).filter((v) => v.deleted === false);
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

// ----- Pantry (§8) -----------------------------------------------------------

export async function addPantryItem({ productId, location, qtyValue = null, qtyUnit = null, expiry = null }) {
  const q = coerceQty(qtyValue, qtyUnit);
  const now = nowISO();
  const voice = {
    id: uid(),
    productId,
    location,
    qtyValue: q.qtyValue,
    qtyUnit: q.qtyUnit,
    expiry,
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
  if ('qtyValue' in patch || 'qtyUnit' in patch) {
    const q = coerceQty(next.qtyValue, next.qtyUnit);
    next.qtyValue = q.qtyValue;
    next.qtyUnit = q.qtyUnit;
  }
  next.updatedAt = nowISO();
  await db.put('pantry', next);
  return next;
}

export async function removePantryItem(id) {
  await db.del('pantry', id);
}

// mergePantryQuantity (D1, §8) — UI-free structured result {merged, items[]}.
export async function mergePantryQuantity(location, productId, qtyValue, qtyUnit) {
  const q = coerceQty(qtyValue, qtyUnit);
  const live = (await getAllPantry()).filter(
    (v) => v.productId === productId && v.location === location
  );
  const existing = live[0];

  // No existing live entry -> create.
  if (!existing) {
    const created = await addPantryItem({ productId, location, qtyValue: q.qtyValue, qtyUnit: q.qtyUnit });
    return { merged: false, items: [created] };
  }

  // Null-side handling: treat null as "unspecified"; use the non-null one.
  if (existing.qtyValue == null || q.qtyValue == null) {
    let newValue;
    let newUnit;
    if (existing.qtyValue == null && q.qtyValue == null) {
      newValue = null;
      newUnit = null;
    } else if (existing.qtyValue == null) {
      newValue = q.qtyValue;
      newUnit = q.qtyUnit;
    } else {
      newValue = existing.qtyValue;
      newUnit = existing.qtyUnit;
    }
    const updated = await updatePantryItem(existing.id, { qtyValue: newValue, qtyUnit: newUnit });
    return { merged: true, items: [updated] };
  }

  // Both non-null -> try to combine.
  const combined = combine(
    { qtyValue: existing.qtyValue, qtyUnit: existing.qtyUnit },
    { qtyValue: q.qtyValue, qtyUnit: q.qtyUnit }
  );
  if (combined.ok) {
    const updated = await updatePantryItem(existing.id, {
      qtyValue: combined.qtyValue,
      qtyUnit: combined.qtyUnit,
    });
    return { merged: true, items: [updated] };
  }

  // Incompatible units -> keep existing, add a second separate entry.
  const newEntry = await addPantryItem({ productId, location, qtyValue: q.qtyValue, qtyUnit: q.qtyUnit });
  return { merged: false, items: [existing, newEntry] };
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
