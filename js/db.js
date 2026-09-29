/* IndexedDB 历史记录存储（无框架，Promise 封装） */
(function (global) {
  'use strict';

  const DB_NAME = 'web-audio-recorder';
  const DB_VERSION = 1;
  const STORE = 'recordings';

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) {
        reject(new Error('当前浏览器不支持 IndexedDB，历史记录不可用'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result._value !== undefined ? result._value : result);
      t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
      t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
    });
  }

  const HistoryDB = {
    async add(record) {
      // record: { name, mimeType, size, durationMs, createdAt, blob }
      const db = await openDB();
      try {
        return await tx(db, 'readwrite', (store) => store.add(record));
      } finally {
        db.close();
      }
    },

    async list() {
      const db = await openDB();
      try {
        return await new Promise((resolve, reject) => {
          const t = db.transaction(STORE, 'readonly');
          const req = t.objectStore(STORE).getAll();
          req.onsuccess = () => {
            // 新的在前
            resolve((req.result || []).sort((a, b) => b.createdAt - a.createdAt));
          };
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },

    async remove(id) {
      const db = await openDB();
      try {
        return await tx(db, 'readwrite', (store) => store.delete(id));
      } finally {
        db.close();
      }
    },
  };

  global.HistoryDB = HistoryDB;
})(window);
