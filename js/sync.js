// 구글 시트(앱스 스크립트 웹 앱)와 동기화. 폰이 원본, 시트는 공유·백업.
// 같은 상품을 양쪽에서 고치면 updatedAt이 늦은 쪽이 이긴다.
// 받아 올 범위(since)는 시트 서버 시계로 적은 syncedAt으로 정해서 기기 시계 차이에 흔들리지 않게 한다.
import { db } from './db.js';

async function call(url, body) {
  // 앱스 스크립트는 CORS 사전 요청을 못 받으므로 text/plain으로 보낸다
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '실패');
  return j;
}

export async function getConfig() {
  return { url: await db.meta('syncUrl', ''), key: await db.meta('syncKey', ''), last: await db.meta('lastPull', 0), lastAt: await db.meta('lastSyncAt', 0) };
}

export async function testConnection(url, key) {
  return call(url, { action: 'hello', key });
}

const strip = ({ _dirty, data, uploaded, ...rest }) => rest;

// 보낸 뒤에도 사용자가 그새 또 고쳤으면(updatedAt이 바뀌었으면) _dirty를 그대로 둔다
async function markClean(store, sent, extra = {}) {
  for (const s of sent) {
    const now = await db.get(store, s.id);
    if (!now) continue;
    if ((now.updatedAt || 0) === (s.updatedAt || 0)) await db.put(store, { ...now, ...extra, _dirty: false });
    else if (Object.keys(extra).length) await db.put(store, { ...now, ...extra });
  }
}

export async function sync(onStep = () => {}) {
  const { url, key, last } = await getConfig();
  if (!url || !key) throw new Error('동기화 주소와 비밀번호를 먼저 넣어 주세요');
  if (!navigator.onLine) throw new Error('인터넷이 연결되지 않았어요');

  // 1) 새로 찍은 사진 올리기
  const toUpload = (await db.all('photos')).filter((p) => p._dirty && p.data && !p.uploaded && !p.deleted);
  for (let i = 0; i < toUpload.length; i++) {
    onStep(`사진 올리는 중 ${i + 1}/${toUpload.length}`);
    const p = toUpload[i];
    const r = await call(url, { action: 'putPhoto', key, id: p.id, productId: p.productId, data: p.data });
    const now = await db.get('photos', p.id);
    if (now) await db.put('photos', { ...now, uploaded: true, fileId: r.fileId });
  }

  // 2) 바뀐 상품·사진 정보 보내기
  onStep('바뀐 내용 보내는 중');
  const dirtyP = (await db.all('products')).filter((p) => p._dirty);
  const dirtyPh = (await db.all('photos')).filter((p) => p._dirty && (p.uploaded || p.deleted || !p.data));
  if (dirtyP.length || dirtyPh.length) {
    await call(url, { action: 'push', key, products: dirtyP.map(strip), photos: dirtyPh.map(strip) });
    await markClean('products', dirtyP);
    await markClean('photos', dirtyPh);
  }

  // 3) 시트·다른 기기에서 바뀐 것 받기
  onStep('새 내용 받는 중');
  const res = await call(url, { action: 'pull', key, since: Math.max(0, last - 60000) });
  let changed = 0;
  for (const rp of res.products) {
    const lp = await db.get('products', rp.id);
    if (!lp || (!lp._dirty && (rp.updatedAt || 0) > (lp.updatedAt || 0))) { await db.put('products', { ...rp, _dirty: false }); changed++; }
  }
  const needData = [];
  for (const rph of res.photos) {
    const lph = await db.get('photos', rph.id);
    if (!lph || (!lph._dirty && (rph.updatedAt || 0) > (lph.updatedAt || 0))) {
      await db.put('photos', { ...rph, data: lph?.data, uploaded: true, _dirty: false });
      if (!lph?.data && !rph.deleted && rph.fileId) needData.push(rph.id);
      changed++;
    }
  }
  // 4) 이 기기에 없는 사진 내려받기 (한 장이 실패해도 나머지는 계속)
  let failed = 0;
  for (let i = 0; i < needData.length; i++) {
    onStep(`사진 받는 중 ${i + 1}/${needData.length}`);
    try {
      const r = await call(url, { action: 'getPhoto', key, id: needData[i] });
      const ph = await db.get('photos', needData[i]);
      if (ph && /^data:image\//.test(r.data || '')) await db.put('photos', { ...ph, data: r.data });
    } catch (e) { failed++; }
  }
  if (res.settings) await mergeSettings(res.settings);
  await db.setMeta('lastPull', res.now);
  await db.setMeta('lastSyncAt', Date.now());
  return { sent: dirtyP.length + dirtyPh.length + toUpload.length, got: changed, failed };
}

// 판매처 목록은 마지막으로 고친 기기의 것을 따른다
async function mergeSettings(s) {
  const mineAt = await db.meta('storesAt', 0);
  if (Array.isArray(s.판매처목록) && s.판매처목록.length && (s.storesAt || 0) > mineAt) {
    await db.setMeta('stores', s.판매처목록.map(String));
    await db.setMeta('storesAt', s.storesAt);
  }
}

export async function pushSettings(settings) {
  const { url, key } = await getConfig();
  if (!url || !key || !navigator.onLine) return false;
  try { await call(url, { action: 'saveSettings', key, settings }); return true; } catch (e) { return false; }
}
