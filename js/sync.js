// js/sync.js — local-first sync engine: push / pull / fullSync + mapping (design §14).
// The only module performing network table I/O against Supabase. The logged-out/offline
// path is zero-network and never throws toward the UI. Only spesa_* tables referenced.

import { supabase, getSession } from './supabase.js';
import * as db from './db.js';
import { getMeta, setMeta, nowISO } from './store.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const DOMAIN_STORES = ['products', 'list', 'pantry', 'wishlist'];
const PUSH_CHUNK = 500;
const PULL_PAGE = 1000;

// ----- Table mapping registry (§14) ------------------------------------------
// toRemote deliberately OMITS user_id (injected at push time). toLocal coerces
// createdAt via normIso(r.created_at ?? r.updated_at ?? nowISO()); booleans !!.
const TABLES = [
  {
    store: 'products',
    remote: 'spesa_products',
    toRemote: (p) => ({
      id: p.id,
      name: p.name,
      name_lower: p.nameLower,
      recurring: p.recurring,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      deleted: p.deleted,
    }),
    toLocal: (r) => ({
      id: r.id,
      name: r.name,
      nameLower: r.name_lower,
      recurring: !!r.recurring,
      createdAt: normIso(r.created_at ?? r.updated_at ?? nowISO()),
      updatedAt: normIso(r.updated_at),
      deleted: !!r.deleted,
    }),
  },
  {
    store: 'list',
    remote: 'spesa_list',
    toRemote: (v) => ({
      id: v.id,
      product_id: v.productId,
      qty_value: v.qtyValue,
      qty_unit: v.qtyUnit,
      bought: v.bought,
      created_at: v.createdAt,
      updated_at: v.updatedAt,
      deleted: v.deleted,
    }),
    toLocal: (r) => ({
      id: r.id,
      productId: r.product_id,
      qtyValue: r.qty_value,
      qtyUnit: r.qty_unit,
      bought: !!r.bought,
      createdAt: normIso(r.created_at ?? r.updated_at ?? nowISO()),
      updatedAt: normIso(r.updated_at),
      deleted: !!r.deleted,
    }),
  },
  {
    store: 'pantry',
    remote: 'spesa_pantry',
    toRemote: (v) => ({
      id: v.id,
      product_id: v.productId,
      location: v.location,
      qty_value: v.qtyValue,
      qty_unit: v.qtyUnit,
      expiry: v.expiry,
      created_at: v.createdAt,
      updated_at: v.updatedAt,
      deleted: v.deleted,
    }),
    toLocal: (r) => ({
      id: r.id,
      productId: r.product_id,
      location: r.location,
      qtyValue: r.qty_value,
      qtyUnit: r.qty_unit,
      expiry: r.expiry,
      createdAt: normIso(r.created_at ?? r.updated_at ?? nowISO()),
      updatedAt: normIso(r.updated_at),
      deleted: !!r.deleted,
    }),
  },
  {
    store: 'wishlist',
    remote: 'spesa_wishlist',
    toRemote: (v) => ({
      id: v.id,
      product_id: v.productId,
      created_at: v.createdAt,
      updated_at: v.updatedAt,
      deleted: v.deleted,
    }),
    toLocal: (r) => ({
      id: r.id,
      productId: r.product_id,
      createdAt: normIso(r.created_at ?? r.updated_at ?? nowISO()),
      updatedAt: normIso(r.updated_at),
      deleted: !!r.deleted,
    }),
  },
];

// ----- Timestamp helpers (§14) -----------------------------------------------
function ts(x) {
  const n = Date.parse(x);
  return Number.isNaN(n) ? 0 : n; // NaN -> oldest in comparisons
}

function normIso(s) {
  return s ? new Date(s).toISOString() : s; // '+00:00' -> 'Z'
}

// ----- sync:status emitter ---------------------------------------------------
let _statusCb = null;
export function onStatus(cb) {
  _statusCb = cb;
}
function emitStatus(status, extra = {}) {
  if (_statusCb) {
    try {
      _statusCb({ status, ...extra });
    } catch (e) {
      console.warn('sync status callback threw', e);
    }
  }
}

// ----- push echo suppression during pull -------------------------------------
let suppressPush = false;

// ----- push() (§14) ----------------------------------------------------------
export async function push() {
  let session;
  try {
    const res = await getSession();
    session = res.data.session;
  } catch (e) {
    console.warn('push: getSession failed, treating as no session', e);
    return { pushed: 0, failedTables: [] };
  }
  if (!session) return { pushed: 0, failedTables: [] }; // zero network, never throws

  let pushed = 0;
  const failedTables = [];
  const userId = session.user.id;

  for (const t of TABLES) {
    const cursor = await getMeta('pushCursor:' + t.remote, EPOCH);
    // Inclusive lower bound; includes tombstones.
    const rows = await db.getByIndex(t.store, 'updatedAt', IDBKeyRange.lowerBound(cursor, false));
    if (rows.length === 0) continue;

    const mapped = rows.map((r) => ({ ...t.toRemote(r), user_id: userId }));
    const batchMax = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), cursor);

    let tableFailed = false;
    for (let i = 0; i < mapped.length; i += PUSH_CHUNK) {
      const chunk = mapped.slice(i, i + PUSH_CHUNK);
      try {
        const { error } = await supabase.from(t.remote).upsert(chunk, { onConflict: 'id' });
        if (error) {
          console.warn(`push: upsert error for ${t.remote}`, error);
          tableFailed = true;
          break;
        }
      } catch (e) {
        console.warn(`push: upsert threw for ${t.remote}`, e);
        tableFailed = true;
        break;
      }
    }

    if (tableFailed) {
      failedTables.push(t.remote); // do NOT advance pushCursor; continue to next table
      continue;
    }
    pushed += mapped.length;
    await setMeta('pushCursor:' + t.remote, batchMax); // advance only on all-chunks-success
  }

  return { pushed, failedTables };
}

// ----- pull() (§14) ----------------------------------------------------------
export async function pull() {
  let session;
  try {
    const res = await getSession();
    session = res.data.session;
  } catch (e) {
    console.warn('pull: getSession failed, treating as no session', e);
    return { pulled: 0 };
  }
  if (!session) return { pulled: 0 }; // zero network

  let pulled = 0;
  suppressPush = true;
  try {
    for (const t of TABLES) {
      const cursor = await getMeta('pullCursor:' + t.remote, EPOCH);
      let maxSeen = cursor;
      let page = 0;
      let tableFailed = false;

      // Paginate until a short page (< PULL_PAGE) ends the result set.
      while (true) {
        const from = page * PULL_PAGE;
        const to = from + PULL_PAGE - 1;
        let data;
        try {
          const res = await supabase
            .from(t.remote)
            .select('*')
            .gte('updated_at', cursor)
            .order('updated_at', { ascending: true })
            .range(from, to);
          if (res.error) {
            console.warn(`pull: select error for ${t.remote}`, res.error);
            tableFailed = true;
            break;
          }
          data = res.data || [];
        } catch (e) {
          console.warn(`pull: select threw for ${t.remote}`, e);
          tableFailed = true;
          break;
        }

        for (const r of data) {
          if (r.updated_at && r.updated_at > maxSeen) maxSeen = r.updated_at;
          const local = await db.get(t.store, r.id);
          if (r.deleted === true) {
            if (local) await db.delLocal(t.store, r.id); // hard delete, no re-push
          } else if (!local || ts(r.updated_at) > ts(local.updatedAt)) {
            const mapped = t.toLocal(r);
            await db.put(t.store, mapped);
            pulled += 1;
          }
        }

        if (data.length < PULL_PAGE) break; // short page -> end
        page += 1;
      }

      if (tableFailed) continue; // leave pullCursor unadvanced for this table
      // Advance pullCursor ONCE after the last page to the max updated_at seen.
      await setMeta('pullCursor:' + t.remote, maxSeen);
    }
  } finally {
    suppressPush = false;
  }

  return { pulled };
}

// ----- fullSync() (§14) ------------------------------------------------------
export async function fullSync() {
  let session;
  try {
    const res = await getSession();
    session = res.data.session;
  } catch (e) {
    console.warn('fullSync: getSession failed, treating as no session', e);
    emitStatus('offline');
    return;
  }
  if (!session) {
    emitStatus('offline'); // zero network
    return;
  }

  const userId = session.user.id;
  const firstTime = !(await getMeta('migrated:' + userId, false));

  if (firstTime) {
    // Initial migration: upload the full local baseline BEFORE the first pull.
    for (const t of TABLES) {
      await setMeta('pushCursor:' + t.remote, EPOCH); // force push() to select every row
    }
    const { failedTables } = await push();
    if (failedTables.length === 0) {
      await setMeta('migrated:' + userId, true);
    } else {
      // Do NOT set migrated; abort this run; retry re-runs the full baseline.
      emitStatus('error');
      return;
    }
  }

  try {
    await pull();
    await push();
  } catch (e) {
    console.warn('fullSync: pull/push failed', e);
    emitStatus('error');
    return;
  }

  const lastSyncAt = nowISO();
  await setMeta('lastSyncAt', lastSyncAt);
  emitStatus('ok', { lastSyncAt });
}

// ----- Account-switch procedure (§14) ----------------------------------------
// Runs when an auth state change reports a session whose user.id differs from a
// non-null getMeta('lastSyncUser'). Order is mandatory: clear domain stores FIRST
// (NOT meta), then reset cursors to epoch, then set lastSyncUser, then fullSync.
export async function switchAccount(newUserId) {
  for (const store of DOMAIN_STORES) {
    await db.clearStore(store); // domain stores only; NEVER meta
  }
  for (const t of TABLES) {
    await setMeta('pullCursor:' + t.remote, EPOCH);
    await setMeta('pushCursor:' + t.remote, EPOCH);
  }
  await setMeta('lastSyncUser', newUserId);
  await fullSync();
}

// ----- scheduleSync (debounced push) -----------------------------------------
let _debounceTimer = null;
const DEBOUNCE_MS = 1500;

export function scheduleSync() {
  if (suppressPush) return; // ignore onChange echo during pull
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    push().then((res) => {
      if (res.failedTables.length > 0) emitStatus('error');
    }).catch((e) => {
      console.warn('scheduleSync: push failed', e);
      emitStatus('error');
    });
  }, DEBOUNCE_MS);
}

// ----- init() (§14 / §15 step 6) ---------------------------------------------
export function init() {
  db.onChange((payload) => {
    if (DOMAIN_STORES.includes(payload.store)) scheduleSync();
  });
  // Kick an initial fullSync (no-op/zero-network if no session).
  fullSync();
}

export { TABLES };
