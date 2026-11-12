// Persistent cache of analyses so a line is only ever paid for once.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const DB_NAME = 'subgloss';
  const STORES = ['lines', 'deep'];
  const memory = { lines: new Map(), deep: new Map() };
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          for (const name of STORES) {
            if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch((err) => {
        // Private windows and some profiles have no IndexedDB; fall back to memory only.
        console.warn('SubGloss: persistent cache unavailable', err);
        return null;
      });
    }
    return dbPromise;
  }

  async function getMany(store, keys) {
    const found = new Map();
    const missing = [];
    for (const k of keys) {
      if (memory[store].has(k)) found.set(k, memory[store].get(k));
      else missing.push(k);
    }
    const db = missing.length ? await open() : null;
    if (!db) return found;
    await new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      for (const k of missing) {
        const req = os.get(k);
        req.onsuccess = () => {
          if (req.result !== undefined) {
            found.set(k, req.result);
            memory[store].set(k, req.result);
          }
        };
      }
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    return found;
  }

  async function putMany(store, entries) {
    for (const [k, v] of entries) memory[store].set(k, v);
    const db = await open();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  }

  async function clear() {
    for (const name of STORES) memory[name].clear();
    const db = await open();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(STORES, 'readwrite');
      for (const name of STORES) tx.objectStore(name).clear();
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  }

  SG.cache = { getMany, putMany, clear };
})(typeof globalThis !== 'undefined' ? globalThis : this);
