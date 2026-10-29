// 폰 안 저장소(IndexedDB). 앱의 원본 데이터는 여기 있고, 시트는 동기화·백업용이다.
// 레포 이름이 wish_list로 바뀌어도 같은 주소(hyonnie-t.github.io)라 이 이름을 그대로 써야 기존 상품·사진이 이어진다
const DB_NAME = 'japan_shopping';
const DB_VER = 1;
let dbp;

function open() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('products', { keyPath: 'id' });
      const ph = db.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('productId', 'productId');
      db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const out = fn(t.objectStore(store));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out instanceof IDBRequest ? out.result : out;
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
  putMany: (store, vals) => tx(store, 'readwrite', (s) => { vals.forEach((v) => s.put(v)); }),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  photosOf: async (productId) => {
    const db_ = await open();
    const list = await req(db_.transaction('photos').objectStore('photos').index('productId').getAll(productId));
    return list.filter((p) => !p.deleted).sort((a, b) => (a.순서 ?? 0) - (b.순서 ?? 0));
  },
  meta: (key, fallback) => tx('meta', 'readonly', (s) => s.get(key)).then((v) => (v === undefined ? fallback : v)),
  setMeta: (key, val) => tx('meta', 'readwrite', (s) => s.put(val, key)),
};

// 사파리가 오래 안 쓴 저장소를 지우지 않게 요청 (홈 화면 앱에서 효과가 크다)
export async function askPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) {}
}
