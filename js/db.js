/* IndexedDB 历史录音存储（无框架，Promise 封装） */
(function (global) {
  'use strict';

  var DB_NAME = 'mic-recorder';
  var DB_VERSION = 1;
  var STORE = 'recordings';

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in global)) {
        reject(new Error('当前浏览器不支持 IndexedDB，历史记录不可用'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
  }

  function withStore(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;
        Promise.resolve(fn(store)).then(function (r) { result = r; });
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('IndexedDB 事务失败')); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error('IndexedDB 事务中止')); };
      });
    });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 请求失败')); };
    });
  }

  var RecorderDB = {
    /** 保存一条录音：{ blob, mimeType, duration, createdAt, name } */
    save: function (entry) {
      return withStore('readwrite', function (store) {
        return reqToPromise(store.add(entry));
      });
    },
    /** 读取全部录音（新→旧排序） */
    list: function () {
      return withStore('readonly', function (store) {
        return reqToPromise(store.getAll());
      }).then(function (items) {
        return (items || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
      });
    },
    remove: function (id) {
      return withStore('readwrite', function (store) {
        return reqToPromise(store.delete(id));
      });
    }
  };

  global.RecorderDB = RecorderDB;
})(window);
