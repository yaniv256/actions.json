function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
}

export function createIndexedDbAdapter({
  indexedDB = globalThis.indexedDB,
  databaseName = "actions-json-projection-embeddings",
  version = 1,
  stores = ["vectors", "progress", "authority"],
} = {}) {
  if (!indexedDB?.open) throw new TypeError("IndexedDB is unavailable");
  let databasePromise;
  const database = () => {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, version);
        request.onupgradeneeded = () => {
          for (const store of stores) {
            if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
        request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
      });
    }
    return databasePromise;
  };
  const transact = async (store, mode, operation) => {
    if (!stores.includes(store)) throw new TypeError(`Unknown IndexedDB store ${store}`);
    const db = await database();
    const transaction = db.transaction(store, mode);
    const done = transactionDone(transaction);
    const result = await operation(transaction.objectStore(store));
    await done;
    return result;
  };
  return Object.freeze({
    get: (store, key) => transact(store, "readonly", (objectStore) => requestResult(objectStore.get(key))),
    put: (store, key, value) => transact(store, "readwrite", async (objectStore) => {
      await requestResult(objectStore.put(structuredClone(value), key));
    }),
    delete: (store, key) => transact(store, "readwrite", async (objectStore) => {
      await requestResult(objectStore.delete(key));
    }),
    clear: (store) => transact(store, "readwrite", async (objectStore) => {
      await requestResult(objectStore.clear());
    }),
    entries: (store) => transact(store, "readonly", (objectStore) => new Promise((resolve, reject) => {
      const rows = [];
      const request = objectStore.openCursor();
      request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(rows);
        rows.push([cursor.key, structuredClone(cursor.value)]);
        cursor.continue();
      };
    })),
  });
}
