const STORES = Object.freeze({ records: 'runId', snapshots: 'snapshotId', reflexes: 'id' });

/**
 * @typedef {'local' | 'memory'} StorageScope
 * @typedef {{persistent: boolean, storageScope: StorageScope, state: 'initializing' | 'ready' | 'unavailable' | 'closed', message: string}} StorageStatus
 * @typedef {{type?: string, network?: string, owner?: string, templateId?: string, templateVersion?: string, from?: string, to?: string, limit?: number}} EvidenceFilters
 * @typedef {{indexedDB?: IDBFactory | null, name?: string}} EvidenceStoreOptions
 */

function copy(value) {
  if (value === undefined || value === null) return value;
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function createLocalId(prefix = 'local') {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local storage request failed.'));
  });
}

/** @param {IDBTransaction} transaction @returns {Promise<void>} */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Local storage transaction failed.'));
  });
}

/**
 * Browser-local evidence only. An unavailable IndexedDB explicitly becomes session memory.
 * @param {EvidenceStoreOptions} [options]
 */
export function createEvidenceStore(options = {}) {
  const factory = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
  // Preserve the internal database key across the RELVYK rename so existing
  // browser records remain accessible. This key is never a product display name.
  const name = options.name || 'resnomo-evidence-v1';
  const memory = Object.fromEntries(Object.keys(STORES).map((key) => [key, new Map()]));
  /** @type {Set<(status: StorageStatus) => void>} */
  const listeners = new Set();
  /** @type {IDBDatabase | null} */
  let database = null;
  /** @type {StorageStatus} */
  let status = { persistent: false, storageScope: 'memory', state: 'initializing', message: 'Opening browser storage.' };

  /** @param {StorageStatus} next */
  function setStatus(next) {
    status = next;
    for (const listener of listeners) {
      try { listener(copy(status)); } catch { /* A view cannot break storage. */ }
    }
  }

  function useMemory() {
    database?.close();
    database = null;
    setStatus({ persistent: false, storageScope: 'memory', state: 'unavailable', message: 'Browser storage is unavailable. Records are kept in this page session and are lost when it closes. Export records to keep a copy.' });
  }

  /** @type {Promise<void>} */
  const ready = new Promise((resolve) => {
    if (!factory?.open) { useMemory(); resolve(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [storeName, keyPath] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath });
        }
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        database = request.result;
        database.onversionchange = () => useMemory();
        setStatus({ persistent: true, storageScope: 'local', state: 'ready', message: 'Saved in this browser. Records are not uploaded or shared.' });
        finish();
      };
      request.onerror = request.onblocked = () => { useMemory(); finish(); };
    } catch { useMemory(); finish(); }
  });

  function checkStore(type) {
    if (!Object.hasOwn(STORES, type)) throw new TypeError('Unknown evidence collection.');
  }

  /**
   * @template T
   * @param {string} type
   * @param {IDBTransactionMode} mode
   * @param {(collection: IDBObjectStore) => Promise<T>} work
   * @param {() => T} fallback
   * @returns {Promise<T>}
   */
  async function perform(type, mode, work, fallback) {
    checkStore(type);
    await ready;
    if (!database) return fallback();
    try {
      const transaction = database.transaction(type, mode);
      const done = transactionDone(transaction);
      const [result] = await Promise.all([work(transaction.objectStore(type)), done]);
      return result;
    } catch {
      useMemory();
      return fallback();
    }
  }

  async function save(type, value) {
    checkStore(type);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Evidence must be an object.');
    const key = value[STORES[type]];
    if (typeof key !== 'string' || !key) throw new TypeError(`Evidence requires ${STORES[type]}.`);
    await ready;
    const item = { ...copy(value), storageScope: status.storageScope };
    return perform(type, 'readwrite', async (collection) => {
      await requestResult(collection.put(item));
      memory[type].set(key, copy(item));
      return copy(item);
    }, () => {
      const sessionItem = { ...item, storageScope: 'memory' };
      memory[type].set(key, copy(sessionItem));
      return copy(sessionItem);
    });
  }

  async function get(type, key) {
    return perform(type, 'readonly', async (collection) => {
      const value = await requestResult(collection.get(key));
      if (value) memory[type].set(key, copy(value));
      return copy(value) || null;
    }, () => copy(memory[type].get(key)) || null);
  }

  /** @param {string} type @param {EvidenceFilters} [filters] */
  async function list(type, filters = {}) {
    let items = await perform(type, 'readonly', async (collection) => {
      const values = await requestResult(collection.getAll());
      for (const value of values) memory[type].set(value[STORES[type]], copy(value));
      return copy(values);
    }, () => [...memory[type].values()].map(copy));
    items = items.filter((item) => {
      if (filters.type && filters.type !== 'all' && (item.taskType || item.type) !== filters.type) return false;
      if (filters.network && item.network !== filters.network) return false;
      if (filters.owner && (item.owner || item.input) !== filters.owner) return false;
      if (filters.templateId && item.templateId !== filters.templateId) return false;
      if (filters.templateVersion && item.templateVersion !== filters.templateVersion) return false;
      if (filters.from && (item.completedAt || item.observedAt || item.createdAt || '') < filters.from) return false;
      if (filters.to && (item.completedAt || item.observedAt || item.createdAt || '') > filters.to) return false;
      return true;
    });
    items.sort((a, b) => (b.completedAt || b.observedAt || b.createdAt || '').localeCompare(a.completedAt || a.observedAt || a.createdAt || ''));
    return Number.isInteger(filters.limit) && filters.limit >= 0 ? items.slice(0, filters.limit) : items;
  }

  async function remove(type, key) {
    return perform(type, 'readwrite', async (collection) => {
      await requestResult(collection.delete(key));
      memory[type].delete(key);
      return true;
    }, () => memory[type].delete(key));
  }

  const api = {
    ready,
    get status() { return copy(status); },
    /** @param {(status: StorageStatus) => void} listener */
    subscribeStatus(listener) {
      if (typeof listener !== 'function') throw new TypeError('A storage subscriber must be a function.');
      listeners.add(listener);
      listener(copy(status));
      return () => listeners.delete(listener);
    },
    save, get, list, delete: remove,
    saveRecord: (value) => save('records', value),
    getRecord: (id) => get('records', id),
    listRecords: (filters) => list('records', filters),
    async deleteRecord(id) {
      const record = await get('records', id);
      if (record?.result?.snapshotId) await remove('snapshots', record.result.snapshotId);
      return remove('records', id);
    },
    saveSnapshot: (value) => save('snapshots', value),
    getSnapshot: (id) => get('snapshots', id),
    listSnapshots: (filters) => list('snapshots', filters),
    deleteSnapshot: (id) => remove('snapshots', id),
    saveReflex: (value) => save('reflexes', value),
    getReflex: (id) => get('reflexes', id),
    listReflexes: (filters) => list('reflexes', filters),
    deleteReflex: (id) => remove('reflexes', id),
    async exportRecord(runId) {
      const record = await get('records', runId);
      if (!record) throw new Error('This local record is no longer available.');
      return JSON.stringify(record, null, 2);
    },
    close() {
      database?.close(); database = null;
      setStatus({ persistent: false, storageScope: 'memory', state: 'closed', message: 'The browser storage connection is closed. New records can only be kept in this page session.' });
      listeners.clear();
    }
  };
  return api;
}
