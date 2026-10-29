// 구글 시트(앱스 스크립트 웹 앱)와 동기화. 폰이 원본, 시트는 공유·백업.
// 같은 상품을 양쪽에서 고치면 updatedAt이 늦은 쪽이 이긴다.
// 받아 올 범위(since)는 시트 서버 시계로 적은 syncedAt으로 정해서 기기 시계 차이에 흔들리지 않게 한다.
import { db } from './db.js';

// 응답이 없으면 끝없이 «맞추는 중»에 머물지 않게 끊는다(사진 한 장도 이 안에 충분히 오간다)
const TIMEOUT_MS = 60000;

async function call(url, body) {
  // 앱스 스크립트는 CORS 사전 요청을 못 받으므로 text/plain으로 보낸다
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let r, j;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('시트가 1분 동안 답이 없어요. 인터넷을 확인하고 다시 눌러 주세요') : e;
  } finally { clearTimeout(t); }
  if (!j.ok) throw new Error(j.error || '실패');
  return j;
}

export async function getConfig() {
  return { url: await db.meta('syncUrl', ''), key: await db.meta('syncKey', ''), last: await db.meta('lastPull', 0), lastAt: await db.meta('lastSyncAt', 0), serverV: await db.meta('serverV', 1) };
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
  // 예전에 받다 실패한 사진(정보만 있고 그림이 없는 것)도 매번 다시 받는다. 시트 줄은 since 뒤로 밀려 다시 안 오기 때문
  for (const ph of await db.all('photos')) if (!ph.data && !ph.deleted && ph.fileId && !needData.includes(ph.id)) needData.push(ph.id);
  let failed = 0, lastErr = '';
  for (let i = 0; i < needData.length; i++) {
    onStep(`사진 받는 중 ${i + 1}/${needData.length}`);
    try {
      const r = await call(url, { action: 'getPhoto', key, id: needData[i] });
      const ph = await db.get('photos', needData[i]);
      if (ph && /^data:image\//.test(r.data || '')) { await db.put('photos', { ...ph, data: r.data }); changed++; }
      else failed++;
    } catch (e) { failed++; lastErr = e.message; }
  }
  if (res.settings) await mergeSettings(res.settings);
  // 목록은 기기끼리 합친다. 시트에 없는 것이 있으면 다시 보낸다
  const ml = await mergeLists(res.settings || {});
  if (ml) {
    await db.setMeta('lists', ml.merged); await db.setMeta('listsDel', ml.del); await db.setMeta('listsAt', ml.at);
    if (ml.needPush) await call(url, { action: 'saveSettings', key, settings: { 목록들: ml.merged, 목록삭제: ml.del, listsAt: ml.at } });
  }
  // 시트 스크립트가 올라간 첫 동기화: 예전 스크립트가 버린 칸(2: 목록·링크, 3: 필요없음)을 다시 보낸다
  const prevV = await db.meta('serverV', 1), v = res.v || 1;
  let again = false;
  if (prevV < 3 && v > prevV) {
    for (const p of await db.all('products')) if ((prevV < 2 && v >= 2 && (p.목록 || p.링크)) || (v >= 3 && p.필요없음)) { await db.put('products', { ...p, _dirty: true }); again = true; }
  }
  await db.setMeta('lastPull', res.now);
  await db.setMeta('lastSyncAt', Date.now());
  await db.setMeta('serverV', v); // 2부터 목록·링크, 3부터 필요없음 칸이 시트에 있다
  return { sent: dirtyP.length + dirtyPh.length + toUpload.length, got: changed, failed, lastErr, serverV: v, again };
}

const cleanLists = (a) => (Array.isArray(a) ? a : []).filter((l) => l && l.id && l.이름)
  .map((l) => ({ id: String(l.id), 이름: String(l.이름), 통화: l.통화 === 'JPY' ? 'JPY' : 'KRW', 예산: +l.예산 || 0 }));

// 목록은 통째로 덮지 않고 id별로 합친다. 같은 목록을 양쪽에서 고쳤으면 나중에 고친 기기 쪽, 지운 목록은 양쪽 모두에서 뺀다
export async function mergeLists(s) {
  const mine = await db.meta('lists', []), myAt = await db.meta('listsAt', 0), myDel = await db.meta('listsDel', []);
  const theirs = cleanLists(s.목록들), theirAt = Number(s.listsAt) || 0;
  const theirDel = Array.isArray(s.목록삭제) ? s.목록삭제.map(String) : [];
  const del = [...new Set([...myDel, ...theirDel])];
  const [first, second] = theirAt > myAt ? [theirs, mine] : [mine, theirs];
  const merged = [...first, ...second.filter((l) => !first.some((x) => x.id === l.id))].filter((l) => !del.includes(l.id));
  if (!merged.length) return null; // 다 지워지는 일은 없게(앱은 목록이 하나 이상 있어야 한다)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return { merged, del, at: Math.max(myAt, theirAt), needPush: !same(merged, theirs) || del.length !== theirDel.length };
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
