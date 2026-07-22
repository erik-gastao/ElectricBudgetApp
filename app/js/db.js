/* ================================================================
   Electric Budget — camada IndexedDB (SPEC §4.2)
   Banco 'electricbudget' v1 · 6 object stores · keyPath 'id'
   (exceto 'preferencias', keyPath 'key')
   ================================================================ */

var DB_NAME = 'electricbudget';
var DB_VERSION = 1;
var _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise(function(resolve, reject) {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB indisponível neste navegador'));
      return;
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('clientes')) {
        var sc = db.createObjectStore('clientes', { keyPath: 'id', autoIncrement: false });
        sc.createIndex('nome', 'nome');
      }
      if (!db.objectStoreNames.contains('materiais')) {
        var sm = db.createObjectStore('materiais', { keyPath: 'id', autoIncrement: false });
        sm.createIndex('cat', 'cat');
        sm.createIndex('nome', 'nome');
      }
      if (!db.objectStoreNames.contains('orcamentos')) {
        var so = db.createObjectStore('orcamentos', { keyPath: 'id', autoIncrement: false });
        so.createIndex('clienteId', 'clienteId');
        so.createIndex('status', 'status');
        so.createIndex('data', 'data');
      }
      if (!db.objectStoreNames.contains('agendamentos')) {
        var sa = db.createObjectStore('agendamentos', { keyPath: 'id', autoIncrement: false });
        sa.createIndex('data', 'data');
      }
      if (!db.objectStoreNames.contains('pagamentos')) {
        var sp = db.createObjectStore('pagamentos', { keyPath: 'id', autoIncrement: false });
        sp.createIndex('clienteId', 'clienteId');
        sp.createIndex('status', 'status');
        sp.createIndex('data', 'dataVencimento');
      }
      if (!db.objectStoreNames.contains('preferencias')) {
        db.createObjectStore('preferencias', { keyPath: 'key' });
      }
    };

    req.onsuccess = function() {
      var db = req.result;
      db.onversionchange = function() { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = function() { reject(req.error || new Error('Falha ao abrir IndexedDB')); };
    req.onblocked = function() { reject(new Error('IndexedDB bloqueado por outra aba')); };
  });
  return _dbPromise;
}

/* ── helpers de transação (todos retornam Promise) ── */

function dbAll(store) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = function() { resolve(r.result || []); };
      r.onerror = function() { reject(r.error); };
    });
  });
}

function dbGet(store, key) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = function() { resolve(r.result); };
      r.onerror = function() { reject(r.error); };
    });
  });
}

function dbPut(store, obj) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(obj);
      tx.oncomplete = function() { resolve(obj); };
      tx.onerror = function() { reject(tx.error); };
      tx.onabort = function() { reject(tx.error || new Error('Transação abortada')); };
    });
  });
}

/* grava vários objetos (possivelmente em stores diferentes) numa
   ÚNICA transação — tudo confirma ou tudo aborta (atomicidade).
   items: [{ store, obj }] */
function dbPutMany(items) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var stores = [];
      items.forEach(function(i) { if (stores.indexOf(i.store) === -1) stores.push(i.store); });
      var tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
      tx.onabort = function() { reject(tx.error || new Error('Transação abortada')); };
      try {
        items.forEach(function(i) { tx.objectStore(i.store).put(i.obj); });
      } catch (e) { reject(e); }
    });
  });
}

function dbDelete(store, key) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
      tx.onabort = function() { reject(tx.error || new Error('Transação abortada')); };
    });
  });
}

function dbCount(store) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var r = db.transaction(store, 'readonly').objectStore(store).count();
      r.onsuccess = function() { resolve(r.result); };
      r.onerror = function() { reject(r.error); };
    });
  });
}
