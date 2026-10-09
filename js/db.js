// js/db.js — low-level IndexedDB wrapper + onChange hook (design §3).
// Database 'spesa_db' version 1. db.js knows nothing of domain entities beyond
// "stores of records with an id and updatedAt".

const DB_NAME = 'spesa_db';
const DB_VERSION = 1;

let _dbPromise = null;

// onChange subscribers. Each receives { store, type, id }.
const _listeners = new Set();

export function onChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function emit(payload) {
  for (const cb of _listeners) {
    try {
      cb(payload);
    } catch (e) {
      // A faulty listener must not break the mutation pipeline.
      console.warn('db.onChange listener threw', e);
    }
  }
}

// openDB — idempotent / memoized.
export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('products')) {
        const products = db.createObjectStore('products', { keyPath: 'id' });
        products.createIndex('nameLower', 'nameLower', { unique: false });
        products.createIndex('updatedAt', 'updatedAt', { unique: false });
        products.createIndex('recurring', 'recurring', { unique: false });
      }
      if (!db.objectStoreNames.contains('list')) {
        const list = db.createObjectStore('list', { keyPath: 'id' });
        list.createIndex('productId', 'productId', { unique: false });
        list.createIndex('updatedAt', 'updatedAt', { unique: false });
        list.createIndex('bought', 'bought', { unique: false });
      }
      if (!db.objectStoreNames.contains('pantry')) {
        const pantry = db.createObjectStore('pantry', { keyPath: 'id' });
        pantry.createIndex('productId', 'productId', { unique: false });
        pantry.createIndex('updatedAt', 'updatedAt', { unique: false });
        pantry.createIndex('location', 'location', { unique: false });
      }
      if (!db.objectStoreNames.contains('wishlist')) {
        const wishlist = db.createObjectStore('wishlist', { keyPath: 'id' });
        wishlist.createIndex('productId', 'productId', { unique: false });
        wishlist.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// Internal: wrap an IDBRequest in a Promise.
function reqAsync(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Internal: run fn within a transaction and resolve on commit (complete).
function txAsync(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    let fnError = null;
    tx.oncomplete = () => {
      if (fnError) reject(fnError);
      else resolve(result);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || fnError || new DOMException('Transaction aborted', 'AbortError'));
    try {
      result = fn(tx);
    } catch (e) {
      fnError = e;
      try { tx.abort(); } catch (_) { /* already aborting */ }
    }
  });
}

export async function get(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// getAll — RAW, includes tombstones.
export async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// getByIndex — query is a value or an IDBKeyRange.
export async function getByIndex(store, indexName, query) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(indexName).getAll(query);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// put — put as-is, return the record. Fires onChange after commit.
export async function put(store, record) {
  const db = await openDB();
  await txAsync(db, store, 'readwrite', (tx) => {
    tx.objectStore(store).put(record);
  });
  emit({ store, type: 'put', id: record.id });
  return record;
}

// putMany — single transaction. Fires one onChange per record after commit.
export async function putMany(store, records) {
  const db = await openDB();
  await txAsync(db, store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    for (const r of records) os.put(r);
  });
  for (const r of records) emit({ store, type: 'put', id: r.id });
}

// del — tombstone soft-delete (field-preserving, design §3 contract).
// Read existing; no-op if missing. Else set deleted=true + updatedAt=now, preserve
// every other field, put the full record back. Never reduce to {id,deleted,updatedAt}.
export async function del(store, id) {
  const db = await openDB();
  let changed = false;
  await txAsync(db, store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    const getReq = os.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return; // no-op if missing
      existing.deleted = true;
      existing.updatedAt = new Date().toISOString();
      os.put(existing);
      changed = true;
    };
  });
  if (changed) emit({ store, type: 'del', id });
}

// delLocal — HARD delete, no tombstone (used by pull for deleted=true remote rows).
export async function delLocal(store, id) {
  const db = await openDB();
  await txAsync(db, store, 'readwrite', (tx) => {
    tx.objectStore(store).delete(id);
  });
  emit({ store, type: 'delLocal', id });
}

export async function clearStore(store) {
  const db = await openDB();
  await txAsync(db, store, 'readwrite', (tx) => {
    tx.objectStore(store).clear();
  });
  emit({ store, type: 'clear' });
}

// runTx(stores, mode, fn) — multi-store atomic op. fn(tx) runs synchronously.
// On successful commit, emit exactly one {store, type:'tx'} per store in `stores`
// (id undefined). Emit nothing on abort/error.
export async function runTx(stores, mode, fn) {
  const db = await openDB();
  const storeList = Array.isArray(stores) ? stores : [stores];
  const result = await txAsync(db, storeList, mode, fn);
  for (const store of storeList) emit({ store, type: 'tx', id: undefined });
  return result;
}
