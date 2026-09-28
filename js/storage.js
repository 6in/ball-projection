// IndexedDB による永続化
//   kv:      設定 ('settings') と作業中の配置 ('current')
//   layouts: 名前付きで保存した配置 (keyPath: name)

const DB_NAME = 'ball-projection';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('layouts')) db.createObjectStore('layouts', { keyPath: 'name' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key));

export const listLayouts = async () =>
  ((await run('layouts', 'readonly', (s) => s.getAll())) || []).sort((a, b) => b.savedAt - a.savedAt);
export const getLayout = (name) => run('layouts', 'readonly', (s) => s.get(name));
export const putLayout = (layout) => run('layouts', 'readwrite', (s) => s.put(layout));
export const deleteLayout = (name) => run('layouts', 'readwrite', (s) => s.delete(name));
