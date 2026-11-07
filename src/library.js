// The studio's own copy of what it read from the folder, kept in the browser. A page opened from disk
// can't reopen a folder by itself: Firefox can't remember one at all, and Chrome asks again every
// session. This copy needs neither, so after the first setup the studio opens with no questions.
const DB = 'pzSkinStudio';
const STORES = ['folder', 'catalog', 'meshes', 'textures', 'skins'];

// Whatever the browser refuses to store (a private window, a full disk) still lasts this visit.
const unsaved = new Map();

let connection = null;

function database() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const name of STORES) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return connection;
}

async function run(store, mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = work(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const slot = (store, key) => `${store}/${key}`;

export async function put(store, key, value) {
  try {
    await run(store, 'readwrite', (s) => s.put(value, key));
  } catch {
    unsaved.set(slot(store, key), value);
  }
}

export async function get(store, key) {
  if (unsaved.has(slot(store, key))) return unsaved.get(slot(store, key));
  return run(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
}

export async function getAll(store) {
  const kept = [...unsaved].filter(([k]) => k.startsWith(`${store}/`)).map(([, value]) => value);
  return [...await run(store, 'readonly', (s) => s.getAll()).catch(() => []), ...kept];
}

export async function clear(store) {
  for (const key of unsaved.keys()) if (key.startsWith(`${store}/`)) unsaved.delete(key);
  await run(store, 'readwrite', (s) => s.clear()).catch(() => {});
}
