export class StorageConflictError extends Error {
  constructor() { super('扩展队列已由其他页面更新，请重试'); this.name = 'StorageConflictError'; this.code = 'storage_conflict'; }
}

function storageFailure() { return new Error('扩展数据库操作失败，请检查浏览器存储空间和扩展运行状态'); }

/**
 * Injectable storage contract:
 * readState() -> state|null; readImage(key) -> Blob|null;
 * listImageKeys() -> string[];
 * commit({expectedRevision,state,putImages:[{key,blob}],deleteImages:[key]})
 * atomically writes all records and returns the new revision.
 */
export class IndexedDBStorage {
  static async open(name = 'chatgpt-bot-bridge', indexedDB = globalThis.indexedDB) {
    if (!indexedDB) throw new Error('当前浏览器环境不支持扩展持久存储');
    const db = await new Promise((resolve, reject) => {
      let finished = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      };
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        finished = true; resolve(request.result);
      };
      request.onerror = () => { if (!finished) { finished = true; reject(storageFailure()); } };
      request.onblocked = () => { if (!finished) { finished = true; reject(new Error('扩展数据库升级被旧页面占用，请关闭并重新打开扩展页面')); } };
    });
    return new IndexedDBStorage(db);
  }

  constructor(db) {
    this.db = db;
    this.db.onversionchange = () => this.db.close();
  }

  async readState() { return this.read('state', 'current'); }
  async readImage(key) { return this.read('images', key); }

  async read(store, key) {
    return new Promise((resolve, reject) => {
      let transaction; let result = null;
      try {
        transaction = this.db.transaction(store, 'readonly');
        const request = transaction.objectStore(store).get(key);
        request.onsuccess = () => { result = request.result ?? null; };
      } catch { reject(storageFailure()); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(storageFailure());
    });
  }

  async listImageKeys() {
    return new Promise((resolve, reject) => {
      let transaction; let result = [];
      try {
        transaction = this.db.transaction('images', 'readonly');
        const request = transaction.objectStore('images').getAllKeys();
        request.onsuccess = () => { result = request.result; };
      } catch { reject(storageFailure()); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(storageFailure());
    });
  }

  async commit({ expectedRevision, state, putImages = [], deleteImages = [] }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !state ||
      putImages.some(image => typeof image.key !== 'string' || !(image.blob instanceof Blob)) || deleteImages.some(key => typeof key !== 'string')) throw storageFailure();
    return new Promise((resolve, reject) => {
      let transaction; let failure;
      try {
        // Chrome supports strict durability. Other conforming implementations
        // may omit the optional durability argument while keeping atomicity.
        try { transaction = this.db.transaction(['state', 'images'], 'readwrite', { durability: 'strict' }); }
        catch { transaction = this.db.transaction(['state', 'images'], 'readwrite'); }
        const states = transaction.objectStore('state');
        const images = transaction.objectStore('images');
        const request = states.get('current');
        request.onsuccess = () => {
          try {
            const revision = request.result?.revision ?? 0;
            if (revision !== expectedRevision) { failure = new StorageConflictError(); transaction.abort(); return; }
            states.put({ ...state, revision: expectedRevision + 1 }, 'current');
            for (const { key, blob } of putImages) images.put(blob, key);
            for (const key of deleteImages) images.delete(key);
          } catch { failure = storageFailure(); transaction.abort(); }
        };
      } catch { reject(storageFailure()); return; }
      transaction.oncomplete = () => resolve(expectedRevision + 1);
      transaction.onabort = transaction.onerror = () => reject(failure ?? storageFailure());
    });
  }

  close() { this.db.close(); }
}
