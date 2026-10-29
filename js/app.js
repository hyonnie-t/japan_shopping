import { db, askPersist } from './db.js';
import { shrink, sizeKB } from './photo.js';
import { sync, getConfig, testConnection, pushSettings } from './sync.js';

const DEFAULT_RATE = 9.20; // 최근 1년 평균(Wise 중간 환율, 2026-10-27 확인)
const CATS = ['뷰티', '헤어·바디', '드럭스토어 건강', '생활용품', '먹거리', '패션·잡화', '디지털', '책·문구', '취미', '기타'];
const CAT_EMO = { '뷰티': '💄', '헤어·바디': '🧴', '드럭스토어 건강': '💊', '생활용품': '🏠', '먹거리': '🍡', '패션·잡화': '👜', '디지털': '🎧', '책·문구': '📚', '취미': '🧶', '기타': '🎀' };
// 목록마다 통화가 정해진다. 엔화 목록은 여행용(세금·면세·매장 모드), 원화 목록은 평소 위시리스트(가격·어디서·링크)
const DEFAULT_LISTS = [{ id: 'japan', 이름: '일본 여행', 통화: 'JPY', 예산: 0 }, { id: 'wish', 이름: '위시리스트', 통화: 'KRW', 예산: 0 }];
const PRIOS = ['꼭 살 것', '있으면 살 것', '가격 보고 결정'];
const PRIO_CLS = { '꼭 살 것': 'must', '있으면 살 것': 'maybe', '가격 보고 결정': 'price' };
const PHOTO_KINDS = ['정면', '뒷면', '진열대', '색상 구분', '헷갈리는 제품', '기타'];

let products = [];          // 지워지지 않은 상품
const photos = new Map();   // productId → [사진]
let S = { rate: DEFAULT_RATE, lists: [], cur: 'japan', stores: [], tab: 'list', view: 'grid' };
let ui = { q: '', cat: '전체', buy: 'all', prio: '전체', shop: '전체', sort: 'prio', store: null, withUnknown: true };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const yen = (n) => (n == null ? '' : '¥' + Math.round(n).toLocaleString('ko-KR'));
const won = (n) => (n == null ? '' : '₩' + (Math.round(n / 10) * 10).toLocaleString('ko-KR'));
const krw = (n) => (n == null ? '' : '₩' + Math.round(n).toLocaleString('ko-KR')); // 원화 목록은 적은 값 그대로
// 시트·백업 파일에서 온 값은 그대로 믿지 않는다
const catVar = (c) => `var(--c-${(CATS.includes(c) ? c : '기타').replace(/[·\s]/g, '')})`;
const img = (d) => (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d || '') ? d : '');
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

/* ---------- 데이터 ---------- */
async function boot() {
  askPersist();
  S.rate = await db.meta('rate', DEFAULT_RATE);
  S.lists = await db.meta('lists', null);
  if (!Array.isArray(S.lists) || !S.lists.length) {
    // 예전(일본 쇼핑 도감) 예산은 일본 여행 목록으로 옮긴다. listsAt은 0으로 둬서 다른 기기에서 정한 목록이 있으면 그쪽을 따른다
    S.lists = structuredClone(DEFAULT_LISTS);
    S.lists[0].예산 = await db.meta('budget', 0);
    await db.setMeta('lists', S.lists);
  }
  S.cur = await db.meta('curList', S.lists[0].id);
  S.view = await db.meta('view', 'grid');
  S.tab = await db.meta('tab', 'list');
  S.stores = await db.meta('stores', []);
  await seed();
  await loadAll();
  render();
  updateNet();
  autoSync(1500);
}

// 처음 열 때 data/products.json을 넣는다. 나중에 json에 새 id가 생기면 그것만 더한다.
async function seed() {
  let data;
  try { data = await (await fetch('data/products.json', { cache: 'no-cache' })).json(); } catch (e) { return; }
  const known = new Set(await db.meta('seededIds', []));
  const have = new Set((await db.all('products')).map((p) => p.id));
  const add = data.상품.filter((p) => !known.has(p.id) && !have.has(p.id)).map((p) => ({ ...p, updatedAt: 1, _dirty: true }));
  if (add.length) await db.putMany('products', add);
  await db.setMeta('seededIds', [...new Set([...known, ...data.상품.map((p) => p.id)])]);
  if (!S.stores.length) { S.stores = data.판매처목록; await db.setMeta('stores', S.stores); }
  // 면세가 비교(트래킹 작업이 json에 적는 값)는 시트에 칸이 없어서 저장하지 않고 열 때마다 json에서 읽는다.
  // 가격이 비어 있는 상품만 가장 싼 면세가를 채운다(효니가 적은 가격은 그대로 둔다)
  S.cmp = {};
  for (const p of data.상품) {
    if (!p.면세비교) continue;
    S.cmp[p.id] = p.면세비교;
    const l = await db.get('products', p.id);
    if (l && !l.deleted && l.한국가격?.금액 == null && p.한국가격?.금액 != null) await db.put('products', { ...l, 한국가격: p.한국가격, updatedAt: Date.now(), _dirty: true });
  }
  // json의 목록들도 처음 보는 id만 더한다(효니가 지운 목록은 다시 안 만든다)
  const knownL = new Set(await db.meta('seededLists', [])), delL = await db.meta('listsDel', []);
  const addL = (data.목록들 || []).filter((l) => !knownL.has(l.id) && !delL.includes(l.id) && !listById(l.id));
  if (addL.length) { S.lists.push(...addL.map((l) => ({ id: l.id, 이름: l.이름, 통화: l.통화 === 'JPY' ? 'JPY' : 'KRW', 예산: +l.예산 || 0 }))); await saveLists(); }
  await db.setMeta('seededLists', [...new Set([...knownL, ...(data.목록들 || []).map((l) => l.id)])]);
}

async function loadAll() {
  products = (await db.all('products')).filter((p) => !p.deleted);
  photos.clear();
  for (const ph of await db.all('photos')) {
    if (ph.deleted) continue;
    if (!photos.has(ph.productId)) photos.set(ph.productId, []);
    photos.get(ph.productId).push(ph);
  }
  photos.forEach((l) => l.sort((a, b) => (a.순서 ?? 0) - (b.순서 ?? 0)));
}

/* ---------- 목록 ---------- */
const listById = (id) => S.lists.find((l) => l.id === id);
const curList = () => listById(S.cur) || S.lists[0];
// 목록 칸이 비었거나 지워진 목록을 가리키면 첫 목록에 보인다
const listOf = (p) => (listById(p.목록) ? p.목록 : S.lists[0].id);
const isJP = (l = curList()) => l?.통화 === 'JPY';
const isJPItem = (p) => isJP(listById(listOf(p)));
const inCur = () => products.filter((p) => listOf(p) === curList().id);
const listEmo = (l) => (l.통화 === 'JPY' ? '✈️' : '💝');
// 가격 한 줄: 엔화 상품은 엔(원화 환산), 원화 상품은 원
const money = (n, jp) => (n == null ? '' : jp ? yen(n) : krw(n));
const moneySub = (n, jp) => (n == null || !jp ? '' : won(n * S.rate));

async function setCur(id) {
  S.cur = id; await db.setMeta('curList', id);
  ui.cat = '전체'; ui.shop = '전체'; ui.q = '';
  window.scrollTo(0, 0); render();
}

async function saveLists() {
  const at = Date.now();
  await db.setMeta('lists', S.lists); await db.setMeta('listsAt', at);
  pushSettings({ 목록들: S.lists, 목록삭제: await db.meta('listsDel', []), listsAt: at }); // 다른 기기 것과는 다음 동기화 때 id별로 합쳐진다
}

function listBar() {
  if (S.lists.length < 2) return '';
  return `<div class="chips listbar" role="group" aria-label="목록">${S.lists.map((l) => {
    const n = products.filter((p) => listOf(p) === l.id).length;
    return `<button class="chip" data-list="${esc(l.id)}" aria-pressed="${l.id === curList().id}">${listEmo(l)} ${esc(l.이름)} <small>${n}</small></button>`;
  }).join('')}</div>`;
}
const bindListBar = () => $$('[data-list]').forEach((b) => (b.onclick = () => setCur(b.dataset.list)));

const photosOf = (id) => photos.get(id) || [];
const cover = (p) => photosOf(p.id).find((x) => img(x.data) && x.설명 !== '헷갈리는 제품');

async function saveProduct(p) {
  p.updatedAt = Date.now(); p._dirty = true;
  await db.put('products', p);
  const i = products.findIndex((x) => x.id === p.id);
  if (p.deleted) { if (i >= 0) products.splice(i, 1); }
  else if (i >= 0) products[i] = p; else products.push(p);
  autoSync();
}

async function savePhoto(ph) {
  ph.updatedAt = Date.now(); ph._dirty = true;
  await db.put('photos', ph);
}

function estPrice(p) {
  if (!isJPItem(p)) return p.한국가격?.금액 ?? null; // 원화 목록은 적은 가격 하나
  const c = [];
  if (p.엔화_세금포함) c.push(p.엔화_세금포함);
  else if (p.엔화_세금별도) c.push(p.엔화_세금별도 * (1 + (p.세율 ?? 0.1)));
  (p.판매처 || []).forEach((s) => s.가격 && c.push(s.가격));
  return c.length ? Math.max(...c) : null; // 넉넉하게: 가장 비싼 값
}
const isBought = (p) => !!p.구입?.완료;

// 지금 고른 목록 안에서만 센다(목록마다 통화가 같아서 더할 수 있다)
function totals() {
  let est = 0, unknown = 0, real = 0, done = 0, saved = 0, savedN = 0;
  const list = inCur(), jp = isJP();
  list.forEach((p) => {
    const e = estPrice(p), q = p.목표개수 || 1;
    if (e == null) unknown++; else est += e * q;
    if (isBought(p)) {
      done++;
      const b = p.구입, paid = (b.가격 || 0) * (b.개수 || 1);
      real += paid;
      if (jp && p.한국가격?.금액 && b.가격) { saved += p.한국가격.금액 * (b.개수 || 1) - paid * S.rate; savedN++; }
    }
  });
  return { est, unknown, real, done, total: list.length, saved, savedN };
}

// 쇼핑을 많이 하면 고양이 눈이 돌아간다: 산 돈 ÷ (목록 예산, 없으면 넉넉한 예상 합계)
function mood(t = totals()) {
  const limit = curList().예산 || t.est;
  const r = limit ? t.real / limit : 0;
  return { m: r > 1 ? 'dizzy' : r >= 0.8 ? 'wobble' : '', limit, pct: Math.round(r * 100) }; // 딱 맞게 쓰면 «0원 더 썼어요»가 되니 넘을 때만
}
const mascotSrc = (m) => (m === 'dizzy' ? 'images/mascot-dizzy-320.png' : 'images/mascot-320.png');
const headImg = () => { const { m } = mood(); return `<img src="${mascotSrc(m)}" class="${m}" alt="">`; };

/* ---------- 그리기 ---------- */
function render() {
  const lg = $('.logo img'), { m } = mood();
  lg.src = mascotSrc(m); lg.className = m;
  // 매장 모드·환율은 엔화(여행) 목록에서만
  const jp = isJP();
  if (!jp && S.tab === 'store') S.tab = 'list';
  $('.tab[data-tab=store]').hidden = !jp;
  $('.tabs-in').classList.toggle('three', !jp);
  $('.rate').hidden = !jp;
  $$('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.tab === S.tab));
  $('#fab').hidden = S.tab !== 'list';
  ({ list: renderList, store: renderStore, report: renderReport, set: renderSet })[S.tab]();
}

function ph(p) {
  const c = cover(p);
  return `<div class="ph ${c ? 'has-img' : ''}" style="background-color:${catVar(p.대분류)}">
    ${c ? `<img src="${img(c.data)}" alt="" loading="lazy">` : `<span class="emo" aria-hidden="true">${CAT_EMO[p.대분류] || '🎀'}</span>`}
    <span class="prio ${PRIO_CLS[p.우선순위] || 'maybe'}">${esc(p.우선순위)}</span>
    ${c ? '' : `<span class="brand">${esc(p.브랜드_일본어 || p.브랜드_한글 || '')}</span>`}
    ${isBought(p) ? '<div class="done-stamp"><span>購入済<br>♡</span></div>' : ''}
  </div>`;
}

function summaryHTML() {
  const t = totals();
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const md = mood(t), base = curList().예산 ? '예산' : '예상 합계', jp = isJP();
  return `<section class="summary" aria-label="요약"><img class="mascot ${md.m}" src="${mascotSrc(md.m)}" alt="">
    <div class="sum-top">
      <div><div class="sum-label">${jp ? '예상 합계 · 넉넉하게 ♡' : '사고 싶은 것 합계 ♡'}</div>
        <div class="sum-big"><span class="yen">${money(t.est, jp)}</span><span class="won">${moneySub(t.est, jp)}</span></div></div>
      <div class="sum-done">산 것<b>${t.done} / ${t.total}</b></div>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="산 비율"><i style="width:${pct}%"></i></div>
    <div class="note">${t.done ? `실제 쓴 돈 ${money(t.real, jp)}${jp ? ` (${won(t.real * S.rate)})` : ''} · ` : ''}${jp ? '세금 포함 · ' : ''}가격 미정 ${t.unknown}개는 빠져 있어요</div>
    ${md.m === 'dizzy' ? `<div class="mood dizzy">🌀 눈 돌아가요! ${base}보다 ${money(t.real - md.limit, jp)} 더 썼어요</div>` : md.m === 'wobble' ? `<div class="mood">💦 ${base}의 ${md.pct}%를 썼어요. 조금만 더 사면 눈 돌아가요</div>` : ''}
  </section>`;
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  const list = inCur().filter((p) => {
    if (ui.cat !== '전체' && p.대분류 !== ui.cat) return false;
    if (ui.buy === 'todo' && isBought(p)) return false;
    if (ui.buy === 'done' && !isBought(p)) return false;
    if (ui.prio !== '전체' && p.우선순위 !== ui.prio) return false;
    if (ui.shop !== '전체' && !(p.판매처 || []).some((x) => x.이름 === ui.shop)) return false;
    if (!q) return true;
    return [p.이름_한글, p.이름_일본어, p.읽는법, p.브랜드_한글, p.브랜드_일본어, p.세부분류, p.메모].join(' ').toLowerCase().includes(q);
  });
  const pr = (p) => PRIOS.indexOf(p.우선순위) + 1 || 9;
  const cmp = { prio: (a, b) => pr(a) - pr(b), price: (a, b) => (estPrice(a) ?? 1e9) - (estPrice(b) ?? 1e9), name: (a, b) => a.이름_한글.localeCompare(b.이름_한글, 'ko') }[ui.sort];
  return list.sort((a, b) => isBought(a) - isBought(b) || cmp(a, b));
}

function renderList() {
  const mine = inCur(), jp = isJP();
  const cats = ['전체', ...CATS.filter((c) => mine.some((p) => p.대분류 === c))];
  $('#main').innerHTML = listBar() + summaryHTML() + `
  <div class="tools">
    <div class="search">
      <input id="q" type="search" placeholder="${jp ? '한글·일본어·브랜드로 찾기' : '이름·브랜드로 찾기'}" value="${esc(ui.q)}" aria-label="검색">
      <button class="iconbtn" id="view" aria-label="${S.view === 'grid' ? '목록 보기로' : '사진 격자로'}">${S.view === 'grid'
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'}</button>
    </div>
    <div class="chips" role="group" aria-label="대분류">${cats.map((c) => `<button class="chip" data-cat="${c}" aria-pressed="${ui.cat === c}">${CAT_EMO[c] ? CAT_EMO[c] + ' ' : ''}${c}</button>`).join('')}</div>
    <div class="subtools">
      <select id="buyF" aria-label="구입 여부"><option value="all" ${ui.buy === 'all' ? 'selected' : ''}>전부 보기</option><option value="todo" ${ui.buy === 'todo' ? 'selected' : ''}>살 것만</option><option value="done" ${ui.buy === 'done' ? 'selected' : ''}>산 것만</option></select>
      <select id="prioF" aria-label="우선순위"><option value="전체">우선순위 전부</option>${PRIOS.map((x) => `<option ${ui.prio === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      ${jp ? `<select id="shopF" aria-label="판매처"><option value="전체">판매처 전부</option>${S.stores.map((x) => `<option value="${esc(x)}" ${ui.shop === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
      <select id="sort" aria-label="정렬">
        <option value="prio" ${ui.sort === 'prio' ? 'selected' : ''}>우선순위순</option>
        <option value="price" ${ui.sort === 'price' ? 'selected' : ''}>가격순</option>
        <option value="name" ${ui.sort === 'name' ? 'selected' : ''}>이름순</option>
      </select>
      <span class="count" id="count"></span>
    </div>
  </div>
  <div class="grid ${S.view === 'list' ? 'list' : ''}" id="grid"></div>`;
  drawGrid();
  $('#q').addEventListener('input', (e) => { ui.q = e.target.value; drawGrid(); });
  $('#view').onclick = () => { S.view = S.view === 'grid' ? 'list' : 'grid'; db.setMeta('view', S.view); renderList(); };
  $('#buyF').onchange = (e) => { ui.buy = e.target.value; drawGrid(); };
  $('#prioF').onchange = (e) => { ui.prio = e.target.value; drawGrid(); };
  if (jp) $('#shopF').onchange = (e) => { ui.shop = e.target.value; drawGrid(); };
  $('#sort').onchange = (e) => { ui.sort = e.target.value; drawGrid(); };
  $$('.chip[data-cat]').forEach((b) => (b.onclick = () => { ui.cat = b.dataset.cat; renderList(); }));
  bindListBar();
}

function drawGrid() {
  const list = filtered();
  $('#count').textContent = `${list.length}개`;
  $('#grid').innerHTML = list.length ? list.map((p) => {
    const e = estPrice(p), jp = isJPItem(p);
    return `<button class="card ${isBought(p) ? 'bought' : ''}" data-id="${esc(p.id)}" aria-label="${esc(p.이름_한글)} 자세히">
      ${ph(p)}
      <div class="body">
        ${jp && p.이름_일본어 ? `<div class="jpname">${esc(p.이름_일본어)}</div>` : ''}
        <div class="krname">${esc(p.이름_한글)}</div>
        ${e != null ? `<div class="price">${money(e, jp)} <small>${moneySub(e, jp)}</small></div>` : '<div class="price none">가격 미정</div>'}
        ${(p.확인필요 || []).length ? `<span class="need">확인 필요 ${p.확인필요.length}</span>` : ''}
      </div>
    </button>`;
  }).join('') : `<div class="empty-msg"><img src="images/mascot-320.png" alt="" width="96" height="96"><p>${inCur().length ? '맞는 상품이 없어요. 검색어나 분류를 바꿔 보세요.' : `«${esc(curList().이름)}»에 아직 아무것도 없어요. ＋를 눌러 사고 싶은 걸 담아 보세요.`}</p></div>`;
  $$('.card').forEach((c) => (c.onclick = () => openDetail(c.dataset.id)));
}

/* ---------- 시트(아래에서 올라오는 창) ---------- */
let sheetOnClose = null, sheetGuard = null;
function openSheet(html, { tall = false, onClose = null, guard = null } = {}) {
  const sh = $('#sheet');
  sh.innerHTML = html; sh.scrollTop = 0; sh.classList.toggle('tall', tall);
  sh.classList.add('on'); $('#scrim').classList.add('on');
  sheetOnClose = onClose; sheetGuard = guard;
  $$('.sheet-close', sh).forEach((b) => (b.onclick = () => closeSheet()));
}
function closeSheet(force) {
  if (!force && sheetGuard?.() && !confirm('고친 내용이 저장되지 않았어요. 닫을까요?')) return;
  sheetGuard = null;
  $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on');
  const f = sheetOnClose; sheetOnClose = null; f?.();
}
$('#scrim').onclick = () => closeSheet();
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#zoom').classList.contains('on')) return $('#zoom').classList.remove('on');
  if ($('#show').classList.contains('on')) return $('#show').classList.remove('on');
  closeSheet();
});

/* ---------- 상세 ---------- */
function openDetail(id) {
  const p = products.find((x) => x.id === id); if (!p) return;
  const e = estPrice(p), b = p.구입 || {}, jp = isJPItem(p), link = safeUrl(p.링크);
  const pics = photosOf(p.id).filter((x) => x.data);
  const gain = jp && p.한국가격?.금액 && e ? p.한국가격.금액 - e * S.rate : null;
  const mixPics = (p.헷갈리는제품 || []);
  const t = p.특징 || {};
  const slides = pics.length
    ? pics.map((x, i) => `<button class="slide img" data-i="${i}" aria-label="사진 크게 보기"><img src="${img(x.data)}" alt="${esc(x.설명)}"><span class="lbl">${esc(x.설명 || '사진')}</span></button>`).join('')
    : `<div class="slide" style="background-color:${catVar(p.대분류)}"><span class="slide-emo"><span>${CAT_EMO[p.대분류] || '🎀'}</span><span class="jp slide-brand">${esc(p.브랜드_일본어 || p.브랜드_한글)}</span></span><span class="lbl">사진 없음 · 수정에서 추가</span></div>`;
  openSheet(`<div class="grab"></div><button class="sheet-close" aria-label="닫기">×</button>
    <div class="slider" id="slider">${slides}</div>
    <div class="dots" id="dots">${(pics.length ? pics : [0]).map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>
    <div class="d-body">
      ${jp ? `<div class="d-jp">
        <div class="brandjp">${esc(p.브랜드_일본어 || p.브랜드_한글)}</div>
        <div class="big ${p.이름_일본어 ? '' : 'empty'}">${p.이름_일본어 ? esc(p.이름_일본어) : '일본어 이름 확인 필요'}</div>
        ${p.읽는법 ? `<div class="jp reading">${esc(p.읽는법)}</div>` : ''}
        <div class="kr">${esc(p.이름_한글)}</div>
        ${p.용량_수량 ? `<div class="sub">${esc(p.용량_수량)}</div>` : ''}
        <button class="btn dark block" id="showBtn" style="margin-top:12px">직원에게 보여 주기 (크게)</button>
      </div>` : `<div class="d-jp">
        ${p.브랜드_한글 ? `<div class="brandjp">${esc(p.브랜드_한글)}</div>` : ''}
        <div class="big">${esc(p.이름_한글)}</div>
        ${p.용량_수량 ? `<div class="sub">${esc(p.용량_수량)}</div>` : ''}
        ${link ? `<a class="btn dark block" href="${esc(link)}" target="_blank" rel="noopener" style="margin-top:12px">🔗 사러 가기</a>` : ''}
      </div>`}
      ${jp ? `<div class="prices">
        <div class="pbox"><div class="k">세금 포함</div><div class="v">${e != null ? yen(e) : '—'}</div></div>
        <div class="pbox"><div class="k">원화 (1엔 ${S.rate}원)</div><div class="v">${e != null ? won(e * S.rate) : '—'}</div></div>
        <div class="pbox"><div class="k">세금 별도 (${Math.round((p.세율 ?? 0.1) * 100)}%)</div><div class="v">${p.엔화_세금별도 ? yen(p.엔화_세금별도) : e != null ? yen(e / (1 + (p.세율 ?? 0.1))) : '—'}</div></div>
        <div class="pbox"><div class="k">한국 가격${p.한국가격?.어디 ? ' · ' + esc(p.한국가격.어디) : ''}</div><div class="v">${p.한국가격?.금액 ? won(p.한국가격.금액) : '—'}</div></div>
        ${gain != null ? `<div class="pbox gain"><div class="k">일본에서 사면</div><div class="v">${gain >= 0 ? won(gain) + ' 이득' : won(-gain) + ' 더 비싸요'}</div></div>` : ''}
      </div>` : `<div class="prices">
        <div class="pbox"><div class="k">가격</div><div class="v">${e != null ? krw(e) : '—'}</div></div>
        <div class="pbox"><div class="k">어디서</div><div class="v">${esc(p.한국가격?.어디 || '—')}</div></div>
      </div>`}
      ${(p.색상_호수 || []).filter((c) => c.번호 || c.이름).length ? `<div class="sec"><h3>색상·호수</h3><div class="tags">${p.색상_호수.filter((c) => c.번호 || c.이름).map((c) => `<span class="tag">${esc(c.번호)} ${esc(c.이름)}</span>`).join('')}</div></div>` : ''}
      <div class="sec"><h3>특징</h3><p>${esc(t.한줄 || '—')}</p>
        ${(t.장점 || []).length ? `<ul class="plain">${t.장점.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${t.주의점 ? `<p class="warn-line">주의: ${esc(t.주의점)}</p>` : ''}</div>
      ${jp ? `<div class="sec"><h3>어디서 살까</h3>${(p.판매처 || []).length ? `<div class="store-rows">${p.판매처.map((s) => `<div class="store-row"><b>${esc(s.이름)}</b>${s.지점 ? ` <span class="sub">${esc(s.지점)}</span>` : ''}<span class="sp">${s.가격 ? yen(s.가격) : ''}</span>${s.메모 ? `<div class="sub">${esc(s.메모)}</div>` : ''}</div>`).join('')}</div>` : '<div class="tags"><span class="tag">판매처 미정</span></div>'}
        ${p.매장내위치 ? `<p class="sub">매장 안 위치: ${esc(p.매장내위치)}</p>` : ''}</div>` : ''}
      ${jp && (p.면세?.가능 != null || p.면세?.메모) ? `<div class="sec"><h3>면세</h3><p>${p.면세.가능 === true ? '면세 가능' : p.면세.가능 === false ? '면세 안 됨' : ''} ${esc(p.면세.메모 || '')}</p></div>` : ''}
      ${jp && link ? `<div class="sec src"><h3>구매 링크</h3><a href="${esc(link)}" target="_blank" rel="noopener">${esc(link.replace(/^https?:\/\//, ''))}</a></div>` : ''}
      ${mixPics.length ? `<div class="sec"><h3>헷갈리는 제품</h3>${mixPics.map((m) => { const mp = photosOf(p.id).find((x) => x.id === m.photoId); return `<div class="mix">${mp?.data ? `<img src="${img(mp.data)}" alt="">` : ''}<p>${esc(m.구분점)}</p></div>`; }).join('')}</div>` : ''}
      ${p.선물대상 ? `<div class="sec"><h3>선물</h3><p>${esc(p.선물대상)}</p></div>` : ''}
      ${p.메모 ? `<div class="sec"><h3>메모</h3><p>${esc(p.메모)}</p></div>` : ''}
      ${S.cmp?.[p.id] ? `<div class="sec"><h3>면세가 비교</h3><p>${esc(S.cmp[p.id].요약 || '')}</p>${S.cmp[p.id].날짜 ? `<div class="sub">${esc(S.cmp[p.id].날짜)} 기준</div>` : ''}</div>` : ''}
      ${(p.확인필요 || []).length ? `<div class="sec"><h3>확인 필요</h3><div class="tags">${p.확인필요.map((x) => `<span class="tag warn">${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(p.추천이유_출처 || []).length ? `<div class="sec src"><h3>출처</h3>${p.추천이유_출처.map((s) => `${s.주소 ? `<a href="${esc(safeUrl(s.주소))}" target="_blank" rel="noopener">${esc(s.주소.replace(/^https?:\/\//, ''))}</a>` : ''}${s.메모 ? ` <span>${esc(s.메모)}</span>` : ''}`).join('<br>')}</div>` : ''}
      ${isBought(p) ? `<div class="sec"><h3>구매 기록</h3><p>${b.가격 ? money(b.가격, jp) : '가격 미입력'} × ${b.개수 || 1}개 · ${esc(b.산곳 || '')} · ${esc(b.날짜 || '')}</p></div>` : ''}
    </div>
    <div class="sticky-act">
      <button class="btn" id="edit">수정</button>
      ${isBought(p) ? `<button class="btn block" id="unbuy">구매 취소</button>` : `<button class="btn primary block" id="buy">샀어요 ♡</button>`}
    </div>`);
  if (jp) $('#showBtn').onclick = () => showStaff(p);
  $('#edit').onclick = () => { closeSheet(true); openEdit(p.id); };
  const sl = $('#slider');
  sl.onscroll = () => { const i = Math.round(sl.scrollLeft / sl.clientWidth); $$('#dots i').forEach((d, j) => d.classList.toggle('on', i === j)); };
  $$('.slide.img', sl).forEach((s) => (s.onclick = () => openZoom(pics, +s.dataset.i)));
  if (isBought(p)) $('#unbuy').onclick = () => unbuy(p, true);
  else $('#buy').onclick = () => openBuy(p);
}

function openZoom(pics, i) {
  const z = $('#zoom');
  let k = i;
  const draw = () => { z.innerHTML = `<img src="${img(pics[k].data)}" alt="${esc(pics[k].설명)}"><div class="zoom-bar"><button id="zp" aria-label="이전 사진">‹</button><span>${esc(pics[k].설명 || '')} ${k + 1}/${pics.length}</span><button id="zn" aria-label="다음 사진">›</button><button id="zc" aria-label="닫기">×</button></div>`;
    $('#zp', z).onclick = (e) => { e.stopPropagation(); k = (k - 1 + pics.length) % pics.length; draw(); };
    $('#zn', z).onclick = (e) => { e.stopPropagation(); k = (k + 1) % pics.length; draw(); };
    $('#zc', z).onclick = () => z.classList.remove('on');
    $('img', z).onclick = (e) => { e.stopPropagation(); z.classList.toggle('zoomed'); }; };
  let sx = null;
  z.ontouchstart = (e) => { sx = e.touches.length === 1 && !z.classList.contains('zoomed') ? e.touches[0].clientX : null; };
  z.ontouchend = (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50 && pics.length > 1) { k = (k + (dx < 0 ? 1 : -1) + pics.length) % pics.length; draw(); } };
  z.classList.remove('zoomed'); draw(); z.classList.add('on');
}

function showStaff(p) {
  $('#show').innerHTML = `<div class="q">これを探しています</div>
    ${p.이름_일본어 ? `<div class="brand">${esc(p.브랜드_일본어 || '')}</div>` : ''}
    <div class="name">${esc(p.이름_일본어 || p.브랜드_일본어 || p.이름_한글)}</div>
    ${(p.색상_호수 || [])[0]?.번호 ? `<div class="brand">${esc(p.색상_호수[0].번호)} ${esc(p.색상_호수[0].이름 || '')}</div>` : ''}
    ${cover(p) ? `<img class="show-img" src="${img(cover(p).data)}" alt="">` : ''}
    <div class="hint">화면을 누르면 닫혀요</div>`;
  $('#show').classList.add('on');
}
$('#show').onclick = () => $('#show').classList.remove('on');

/* ---------- 구매 ---------- */
function openBuy(p, store) {
  let n = p.목표개수 || 1;
  const e = estPrice(p), jp = isJPItem(p);
  const sel = store || p.판매처?.[0]?.이름;
  openSheet(`<div class="grab"></div><button class="sheet-close" aria-label="닫기">×</button>
    <div class="form">
      <h2>샀어요 · ${esc(p.이름_한글)}</h2>
      <div class="row2">
        <label class="field">산 가격(${jp ? '¥' : '₩'}, 1개)<input id="bp" inputmode="numeric" value="${e ? Math.round(e) : ''}" placeholder="${jp ? '예: 990' : '예: 29000'}"></label>
        <div class="field">개수<div class="stepper"><button type="button" id="m" aria-label="빼기">−</button><output id="n">${n}</output><button type="button" id="pl" aria-label="더하기">+</button></div></div>
      </div>
      <label class="field">산 곳${jp ? `<select id="bs">${S.stores.map((s) => `<option ${sel === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : `<input id="bs" value="${esc(p.한국가격?.어디 || '')}" placeholder="쿠팡, 무신사, 오프라인 매장…">`}</label>
      <label class="field">날짜<input id="bd" type="date" value="${today()}"></label>
      <button class="btn primary block" id="ok">구매 완료로 표시</button>
      <p class="hint-line">가격을 몰라도 그냥 눌러도 돼요. 나중에 고칠 수 있어요.</p>
    </div>`);
  $('#m').onclick = () => { n = Math.max(1, n - 1); $('#n').textContent = n; };
  $('#pl').onclick = () => { n++; $('#n').textContent = n; };
  $('#ok').onclick = async () => {
    await markBought(p, { 완료: true, 가격: num($('#bp').value), 개수: n, 산곳: $('#bs').value, 날짜: $('#bd').value });
    closeSheet(true);
  };
}

async function markBought(p, rec) {
  const prev = p.구입;
  p.구입 = rec; await saveProduct(p); render();
  toast(`${p.이름_한글.slice(0, 14)} 구매 완료`, async () => { p.구입 = prev || { 완료: false }; await saveProduct(p); render(); });
}

async function unbuy(p, fromDetail) {
  const prev = p.구입;
  p.구입 = { 완료: false, 가격: null, 개수: null, 산곳: '', 날짜: '' };
  await saveProduct(p);
  if (fromDetail) closeSheet(true);
  render();
  toast('구매 취소했어요', async () => { p.구입 = prev; await saveProduct(p); render(); });
}

let toastT;
function toast(msg, undo) {
  $('#toastMsg').textContent = msg;
  $('#toastUndo').hidden = !undo;
  $('#toast').classList.add('on');
  $('#toastUndo').onclick = () => { undo?.(); $('#toast').classList.remove('on'); };
  clearTimeout(toastT); toastT = setTimeout(() => $('#toast').classList.remove('on'), 4500);
}

/* ---------- 추가·수정 ---------- */
function blank() {
  return { id: uid('u'), 목록: curList().id, 링크: '', 이름_한글: '', 이름_일본어: '', 읽는법: '', 브랜드_한글: '', 브랜드_일본어: '', 대분류: isJP() ? '뷰티' : '기타', 세부분류: '',
    사진: [], 용량_수량: '', 색상_호수: [], 특징: { 한줄: '', 장점: [], 주의점: '' }, 추천이유_출처: [], 엔화_세금별도: null, 엔화_세금포함: null,
    세율: 0.1, 한국가격: { 금액: null, 어디: '' }, 판매처: [], 매장내위치: '', 면세: { 가능: null, 메모: '' }, 헷갈리는제품: [],
    목표개수: 1, 우선순위: '있으면 살 것', 선물대상: '', 구입: { 완료: false, 가격: null, 개수: null, 산곳: '', 날짜: '' }, 메모: '', 확인필요: [] };
}

function openEdit(id) {
  const orig = id ? products.find((x) => x.id === id) : null;
  const p = structuredClone(orig || blank());
  p.특징 ??= { 한줄: '', 장점: [], 주의점: '' }; p.한국가격 ??= { 금액: null, 어디: '' }; p.면세 ??= { 가능: null, 메모: '' };
  p.목록 = listOf(p);
  const listJP = (id) => isJP(listById(id));
  // 사진은 저장을 누를 때 반영한다
  let pics = photosOf(p.id).map((x) => ({ ...x }));
  const removed = [];
  let taxAuto = !p.엔화_세금포함 || (p.엔화_세금별도 && Math.round(p.엔화_세금별도 * (1 + (p.세율 ?? 0.1))) === Math.round(p.엔화_세금포함));
  const v = (x) => esc(x ?? '');
  openSheet(`<div class="grab"></div><button class="sheet-close" aria-label="닫기">×</button>
    <form class="form" id="ef" novalidate>
      <h2>${orig ? '상품 고치기' : '새 상품 추가 ♡'}</h2>
      <div class="field"><span>사진 <small>첫 번째가 대표 사진</small></span>
        <div class="pics" id="pics"></div>
        <div class="row2">
          <label class="btn file"><input type="file" accept="image/*" capture="environment" id="cam" hidden>📷 사진 찍기</label>
          <label class="btn file"><input type="file" accept="image/*" multiple id="gal" hidden>🖼️ 앨범에서</label>
        </div>
      </div>
      <label class="field">담을 목록<select name="목록">${S.lists.map((l) => `<option value="${esc(l.id)}" ${p.목록 === l.id ? 'selected' : ''}>${listEmo(l)} ${esc(l.이름)}</option>`).join('')}</select></label>
      <label class="field">이름 *<input name="이름_한글" value="${v(p.이름_한글)}" required></label>
      <label class="field jp-only"><span>일본어 이름 <small>(패키지에 적힌 그대로)</small></span><input name="이름_일본어" class="jp" value="${v(p.이름_일본어)}" lang="ja"></label>
      <div class="row2">
        <label class="field">브랜드<input name="브랜드_한글" value="${v(p.브랜드_한글)}"></label>
        <label class="field jp-only">브랜드(일본어)<input name="브랜드_일본어" class="jp" value="${v(p.브랜드_일본어)}" lang="ja"></label>
      </div>
      <div class="row2">
        <label class="field">대분류<select name="대분류">${CATS.map((c) => `<option ${p.대분류 === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field">우선순위<select name="우선순위">${PRIOS.map((c) => `<option ${p.우선순위 === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="row2 jp-only">
        <label class="field">세금 별도 ¥<input name="엔화_세금별도" inputmode="numeric" value="${v(p.엔화_세금별도)}"></label>
        <label class="field"><span>세금 포함 ¥ <small id="taxr">(${Math.round((p.세율 ?? 0.1) * 100)}%)</small></span><input name="엔화_세금포함" inputmode="numeric" value="${v(p.엔화_세금포함)}"></label>
      </div>
      <div class="row2 kr-only">
        <label class="field">가격 ₩<input name="원화가격" inputmode="numeric" value="${v(p.한국가격.금액)}" placeholder="예: 29000"></label>
        <label class="field">어디서<input name="원화어디" value="${v(p.한국가격.어디)}" placeholder="쿠팡, 무신사…"></label>
      </div>
      <div class="row2">
        <label class="field">살 개수<input name="목표개수" inputmode="numeric" value="${v(p.목표개수 || 1)}"></label>
        <label class="field">한 줄 특징<input name="특징_한줄" value="${v(p.특징.한줄)}"></label>
      </div>
      <label class="field"><span>구매 링크 <small>(있으면)</small></span><input name="링크" type="url" inputmode="url" value="${v(p.링크)}" placeholder="https://…"></label>
      <div class="field jp-only"><span>어디서 살까 <small>누르면 선택</small></span>
        <div class="chips wrap" id="storePick">${S.stores.map((s) => `<button type="button" class="chip" data-s="${esc(s)}" aria-pressed="${(p.판매처 || []).some((x) => x.이름 === s)}">${esc(s)}</button>`).join('')}</div>
        <div id="storeRows"></div>
      </div>
      <details class="more"><summary>더 적기 (색상·장점·메모·출처 등)</summary>
        <label class="field jp-only">읽는 법<input name="읽는법" class="jp" value="${v(p.읽는법)}" lang="ja"></label>
        <div class="row2">
          <label class="field">세부 분류<input name="세부분류" value="${v(p.세부분류)}" placeholder="립, 샴푸…"></label>
          <label class="field">용량·수량<input name="용량_수량" value="${v(p.용량_수량)}" placeholder="50ml, 3개입"></label>
        </div>
        <div class="field"><span>색상·호수</span><div id="colors"></div><button type="button" class="btn small" id="addColor">＋ 색상</button></div>
        <label class="field"><span>장점 <small>(한 줄에 하나)</small></span><textarea name="장점" rows="3">${v((p.특징.장점 || []).join('\n'))}</textarea></label>
        <label class="field"><span>주의점 <small>(피부 타입·향·알레르기)</small></span><input name="주의점" value="${v(p.특징.주의점)}"></label>
        <div class="row2 jp-only">
          <label class="field">한국 가격 ₩<input name="한국가격" inputmode="numeric" value="${v(p.한국가격.금액)}"></label>
          <label class="field">한국 어디<input name="한국가격_어디" value="${v(p.한국가격.어디)}" placeholder="올리브영, 쿠팡"></label>
        </div>
        <label class="field jp-only">매장 안 위치<input name="매장내위치" value="${v(p.매장내위치)}" placeholder="화장품 코너 3번 통로"></label>
        <div class="row2 jp-only">
          <label class="field">면세<select name="면세가능"><option value="">모름</option><option value="O" ${p.면세.가능 === true ? 'selected' : ''}>가능</option><option value="X" ${p.면세.가능 === false ? 'selected' : ''}>안 됨</option></select></label>
          <label class="field">면세 메모<input name="면세메모" value="${v(p.면세.메모)}" placeholder="봉투 밀봉 주의"></label>
        </div>
        <label class="field">선물 대상<input name="선물대상" value="${v(p.선물대상)}"></label>
        <div class="field"><span>헷갈리는 제품 <small>(사진 설명을 «헷갈리는 제품»으로 고르면 여기서 고를 수 있어요)</small></span><div id="mixes"></div><button type="button" class="btn small" id="addMix">＋ 구분점</button></div>
        <div class="field"><span>출처 (SNS 주소·후기 메모)</span><div id="srcs"></div><button type="button" class="btn small" id="addSrc">＋ 출처</button></div>
        <label class="field">메모<textarea name="메모" rows="3">${v(p.메모)}</textarea></label>
        <label class="field"><span>확인 필요 <small>(쉼표로 나누기)</small></span><input name="확인필요" value="${v((p.확인필요 || []).join(', '))}"></label>
      </details>
      <div class="edit-act">
        ${orig ? '<button type="button" class="btn danger" id="del">삭제</button>' : ''}
        <button type="submit" class="btn primary block">저장</button>
      </div>
    </form>`, { tall: true, guard: () => changed });
  let changed = false;

  const f = $('#ef');
  f.addEventListener('input', () => (changed = true));
  f.addEventListener('click', (e) => { if (e.target.closest('[data-x],[data-l],[data-r],#storePick .chip,[data-del],#addColor,#addMix,#addSrc')) changed = true; });
  // 사진
  const drawPics = () => {
    $('#pics').innerHTML = pics.length ? pics.map((x, i) => `<div class="pic">
      <img src="${img(x.data)}" alt="">
      <select data-i="${i}" aria-label="사진 설명">${PHOTO_KINDS.map((k) => `<option ${x.설명 === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <div class="pic-act"><button type="button" data-l="${i}" aria-label="앞으로" ${i ? '' : 'disabled'}>‹</button><button type="button" data-x="${i}" aria-label="사진 빼기">🗑</button><button type="button" data-r="${i}" aria-label="뒤로" ${i < pics.length - 1 ? '' : 'disabled'}>›</button></div>
    </div>`).join('') : '<p class="hint-line">아직 사진이 없어요. 패키지 정면부터 찍어 두면 매장에서 찾기 쉬워요.</p>';
    $$('#pics select').forEach((s) => (s.onchange = () => { pics[+s.dataset.i].설명 = s.value; drawMix(); }));
    $$('#pics [data-x]').forEach((b) => (b.onclick = () => { removed.push(...pics.splice(+b.dataset.x, 1)); drawPics(); drawMix(); }));
    $$('#pics [data-l]').forEach((b) => (b.onclick = () => { const i = +b.dataset.l; [pics[i - 1], pics[i]] = [pics[i], pics[i - 1]]; drawPics(); }));
    $$('#pics [data-r]').forEach((b) => (b.onclick = () => { const i = +b.dataset.r; [pics[i + 1], pics[i]] = [pics[i], pics[i + 1]]; drawPics(); }));
  };
  const addFiles = async (files) => {
    for (const file of files) {
      try {
        const data = await shrink(file);
        pics.push({ id: uid('ph'), productId: p.id, 설명: pics.length ? '기타' : '정면', 순서: pics.length, data });
        drawPics();
        if (sizeKB(data) > 600) toast('사진이 커서 저장 공간을 많이 써요');
      } catch (e) { toast('이 사진은 읽지 못했어요'); }
    }
  };
  const pick = async (e) => { const fs_ = [...e.target.files]; e.target.value = ''; changed = true; await addFiles(fs_); };
  $('#cam').onchange = pick;
  $('#gal').onchange = pick;

  // 판매처
  const drawStores = () => {
    $('#storeRows').innerHTML = (p.판매처 || []).map((s, i) => `<div class="store-edit">
      <b>${esc(s.이름)}</b>
      <input data-k="지점" data-i="${i}" value="${v(s.지점)}" placeholder="지점 (예: 신주쿠점)">
      <input data-k="가격" data-i="${i}" value="${v(s.가격)}" inputmode="numeric" placeholder="¥ 가격">
      <input data-k="메모" data-i="${i}" value="${v(s.메모)}" placeholder="재고 있었음/없었음">
    </div>`).join('');
    $$('#storeRows input').forEach((inp) => (inp.oninput = () => { const s = p.판매처[+inp.dataset.i]; s[inp.dataset.k] = inp.dataset.k === '가격' ? num(inp.value) : inp.value; }));
  };
  $$('#storePick .chip').forEach((b) => (b.onclick = () => {
    const name = b.dataset.s; p.판매처 ??= [];
    const i = p.판매처.findIndex((x) => x.이름 === name);
    if (i >= 0) p.판매처.splice(i, 1); else p.판매처.push({ 이름: name, 지점: '', 가격: null, 메모: '' });
    b.setAttribute('aria-pressed', i < 0); drawStores();
  }));

  // 여러 줄 입력칸들(색상·헷갈리는 제품·출처)
  const listEditor = (box, arr, fields, onDraw) => {
    const draw = () => {
      $(box).innerHTML = arr.map((it, i) => `<div class="mini-row">${fields.map(([k, ph, type]) => type === 'photo'
        ? `<select data-k="${k}" data-i="${i}"><option value="">사진 고르기</option>${pics.filter((x) => x.설명 === '헷갈리는 제품').map((x, j) => `<option value="${esc(x.id)}" ${it[k] === x.id ? 'selected' : ''}>헷갈리는 사진 ${j + 1}</option>`).join('')}</select>`
        : `<input data-k="${k}" data-i="${i}" value="${v(it[k])}" placeholder="${ph}">`).join('')}<button type="button" data-del="${i}" aria-label="빼기">×</button></div>`).join('');
      $$(`${box} [data-k]`).forEach((inp) => (inp.oninput = inp.onchange = () => { arr[+inp.dataset.i][inp.dataset.k] = inp.value; }));
      $$(`${box} [data-del]`).forEach((b) => (b.onclick = () => { arr.splice(+b.dataset.del, 1); draw(); }));
    };
    draw(); return draw;
  };
  p.색상_호수 ??= []; p.헷갈리는제품 ??= []; p.추천이유_출처 ??= [];
  listEditor('#colors', p.색상_호수, [['번호', '번호 (예: 07)'], ['이름', '색 이름']]);
  const drawMix = listEditor('#mixes', p.헷갈리는제품, [['photoId', '', 'photo'], ['구분점', '구분점 (예: 뚜껑 색이 다름)']]);
  const drawSrc = listEditor('#srcs', p.추천이유_출처, [['주소', 'https://…'], ['메모', '메모']]);
  $('#addColor').onclick = () => { p.색상_호수.push({ 번호: '', 이름: '' }); listEditor('#colors', p.색상_호수, [['번호', '번호 (예: 07)'], ['이름', '색 이름']]); };
  $('#addMix').onclick = () => { p.헷갈리는제품.push({ photoId: '', 구분점: '' }); drawMix(); };
  $('#addSrc').onclick = () => { p.추천이유_출처.push({ 주소: '', 메모: '' }); drawSrc(); };

  // 세금 포함 자동 계산 (먹거리 8%, 나머지 10%)
  const rateOf = () => (f.대분류.value === '먹거리' ? 0.08 : 0.1);
  const recalc = () => {
    $('#taxr').textContent = `(${Math.round(rateOf() * 100)}%)`;
    const ex = num(f.엔화_세금별도.value);
    if (taxAuto && ex) f.엔화_세금포함.value = Math.round(ex * (1 + rateOf()));
  };
  f.엔화_세금별도.oninput = recalc; f.대분류.onchange = recalc;
  f.엔화_세금포함.oninput = () => { taxAuto = !f.엔화_세금포함.value; };
  // 목록에 따라 여행용 칸(일본어·세금·면세·판매처)과 원화 칸을 바꿔 보여 준다
  const applyKind = () => { const j = listJP(f.목록.value); $$('.jp-only', f).forEach((x) => (x.hidden = !j)); $$('.kr-only', f).forEach((x) => (x.hidden = j)); };
  f.목록.onchange = applyKind; applyKind();

  drawPics(); drawStores();

  f.onsubmit = async (e) => {
    e.preventDefault();
    const g = (k) => f.elements[k]?.value?.trim() ?? '';
    if (!g('이름_한글')) { f.이름_한글.focus(); toast('이름은 꼭 적어 주세요'); return; }
    if (g('링크') && !safeUrl(g('링크'))) { f.링크.focus(); toast('링크는 https://로 시작하게 적어 주세요'); return; }
    const j = listJP(g('목록'));
    Object.assign(p, {
      목록: g('목록'), 링크: safeUrl(g('링크')),
      이름_한글: g('이름_한글'), 이름_일본어: g('이름_일본어'), 읽는법: g('읽는법'), 브랜드_한글: g('브랜드_한글'), 브랜드_일본어: g('브랜드_일본어'),
      대분류: g('대분류'), 세부분류: g('세부분류'), 용량_수량: g('용량_수량'), 우선순위: g('우선순위'),
      엔화_세금별도: num(g('엔화_세금별도')), 엔화_세금포함: num(g('엔화_세금포함')), 세율: rateOf(), 목표개수: num(g('목표개수')) || 1,
      특징: { 한줄: g('특징_한줄'), 장점: g('장점').split('\n').map((s) => s.trim()).filter(Boolean), 주의점: g('주의점') },
      한국가격: j ? { 금액: num(g('한국가격')), 어디: g('한국가격_어디') } : { 금액: num(g('원화가격')), 어디: g('원화어디') }, 매장내위치: g('매장내위치'),
      면세: { 가능: g('면세가능') === 'O' ? true : g('면세가능') === 'X' ? false : null, 메모: g('면세메모') },
      선물대상: g('선물대상'), 메모: g('메모'), 확인필요: g('확인필요').split(',').map((s) => s.trim()).filter(Boolean),
    });
    p.색상_호수 = p.색상_호수.filter((c) => c.번호 || c.이름);
    p.헷갈리는제품 = p.헷갈리는제품.filter((m) => m.구분점 || m.photoId);
    p.추천이유_출처 = p.추천이유_출처.filter((s) => s.주소 || s.메모);
    for (const r of removed) if (photosOf(p.id).some((x) => x.id === r.id)) await savePhoto({ ...r, deleted: true });
    for (let i = 0; i < pics.length; i++) {
      const x = pics[i], old = photosOf(p.id).find((o) => o.id === x.id);
      if (!old || old.순서 !== i || old.설명 !== x.설명) await savePhoto({ ...old, ...x, 순서: i, uploaded: old?.uploaded });
    }
    await saveProduct(p);
    await loadAll();
    closeSheet(true);
    const moved = p.목록 !== curList().id;
    render();
    toast(moved ? `«${listById(p.목록).이름}»에 담았어요` : orig ? '저장했어요' : '새로 담았어요');
  };
  if (orig) $('#del').onclick = async () => {
    if (!confirm(`«${p.이름_한글}»을(를) 지울까요?`)) return;
    const keep = { ...orig };
    await saveProduct({ ...orig, deleted: true });
    closeSheet(true); render();
    toast('삭제했어요', async () => { await saveProduct({ ...keep, deleted: false }); await loadAll(); render(); });
  };
}

/* ---------- 매장 모드 ---------- */
function renderStore() {
  if (!S.stores.includes(ui.store)) ui.store = S.stores[0];
  const list = inCur().filter((p) => (p.판매처 || []).some((s) => s.이름 === ui.store) || (ui.withUnknown && !(p.판매처 || []).length))
    .sort((a, b) => isBought(a) - isBought(b) || PRIOS.indexOf(a.우선순위) - PRIOS.indexOf(b.우선순위));
  const left = list.filter((p) => !isBought(p)).length;
  $('#main').innerHTML = `<div class="store-head">${headImg()}<div><h2>매장 모드</h2><p>고른 매장에서 살 것만 크게! 누르면 바로 구매 완료</p></div></div>
    <div class="chips" role="group" aria-label="판매처">${S.stores.map((s) => `<button class="chip" data-st="${esc(s)}" aria-pressed="${ui.store === s}">${esc(s)}</button>`).join('')}</div>
    <div class="subtools"><label class="toggle"><input type="checkbox" id="unk" ${ui.withUnknown ? 'checked' : ''}> 판매처 미정도 보기</label><span class="count">남은 것 ${left}개</span></div>
    <div class="big-list">${list.length ? list.map((p) => {
      const e = estPrice(p), sp = (p.판매처 || []).find((s) => s.이름 === ui.store);
      return `<div class="bigcard ${isBought(p) ? 'bought' : ''}">
        <button class="ph-btn" data-open="${esc(p.id)}" aria-label="${esc(p.이름_한글)} 자세히">${ph(p)}</button>
        <div class="info">
          <div class="jp brand-line">${esc(p.브랜드_일본어 || p.브랜드_한글)}</div>
          ${p.이름_일본어 ? `<div class="jpname">${esc(p.이름_일본어)}</div>` : ''}
          <div class="krname-big">${esc(p.이름_한글)}</div>
          ${sp?.지점 || p.매장내위치 ? `<div class="sub">${esc([sp?.지점, p.매장내위치].filter(Boolean).join(' · '))}</div>` : ''}
          <div class="act"><span>${sp?.가격 ? yen(sp.가격) : e != null ? yen(e) : '가격 미정'}</span>
          <button class="check" data-id="${esc(p.id)}">${isBought(p) ? '샀어요 ♡' : '샀어요'}</button></div>
        </div></div>`;
    }).join('') : '<div class="empty-msg"><img src="images/mascot-320.png" alt="" width="96" height="96"><p>이 매장에서 살 것으로 정한 상품이 없어요.</p></div>'}</div>`;
  $$('[data-st]').forEach((b) => (b.onclick = () => { ui.store = b.dataset.st; renderStore(); }));
  $('#unk').onchange = (e) => { ui.withUnknown = e.target.checked; renderStore(); };
  $$('[data-open]').forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
  $$('.check').forEach((b) => (b.onclick = () => {
    const p = products.find((x) => x.id === b.dataset.id);
    if (isBought(p)) return unbuy(p);
    const sp = (p.판매처 || []).find((s) => s.이름 === ui.store);
    const e = sp?.가격 || estPrice(p);
    markBought(p, { 완료: true, 가격: e ? Math.round(e) : null, 개수: p.목표개수 || 1, 산곳: ui.store, 날짜: today() });
  }));
}

/* ---------- 정리 ---------- */
function renderReport() {
  const t = totals(), jp = isJP(), mine = inCur();
  const both = (n) => (jp ? `${yen(n)} · ${won(n * S.rate)}` : krw(n));
  const bought = mine.filter(isBought), todo = mine.filter((p) => !isBought(p));
  const byStore = {};
  bought.forEach((p) => { const k = p.구입.산곳 || '기타'; byStore[k] = (byStore[k] || 0) + (p.구입.가격 || 0) * (p.구입.개수 || 1); });
  $('#main').innerHTML = `<div class="store-head">${headImg()}<div><h2>정리 · ${esc(curList().이름)}</h2><p>산 것과 안 산 것, 쓴 돈을 한눈에</p></div></div>
  ${listBar()}
  <div class="report">
    <div class="rcard"><h3>쓴 돈</h3>
      <div class="rline"><span>실제 합계</span><b>${both(t.real)}</b></div>
      <div class="rline"><span>처음 예상</span><span>${both(t.est)}</span></div>
      ${jp ? `<div class="rline"><span>한국 가격 대비</span><b class="${t.saved >= 0 ? 'good' : ''}">${t.savedN ? (t.saved >= 0 ? won(t.saved) + ' 절약' : won(-t.saved) + ' 더 씀') + ` (${t.savedN}개 기준)` : '한국 가격을 넣으면 계산돼요'}</b></div>` : ''}
      ${Object.keys(byStore).length ? Object.entries(byStore).map(([k, v]) => `<div class="rline"><span>${esc(k)}</span><span>${money(v, jp)}</span></div>`).join('') : ''}
    </div>
    <div class="rcard"><h3>산 것 ${bought.length}개</h3>${bought.length ? bought.map((p) => `<button class="rline link" data-open="${esc(p.id)}"><span>${esc(p.이름_한글)}</span><span>${p.구입.가격 ? money(p.구입.가격, jp) : '—'} × ${p.구입.개수 || 1}</span></button>`).join('') : '<p class="sub">아직 없어요</p>'}</div>
    <div class="rcard"><h3>안 산 것 ${todo.length}개</h3>${todo.map((p) => `<button class="rline link" data-open="${esc(p.id)}"><span>${esc(p.이름_한글)}</span><span class="sub">${esc(p.우선순위)}</span></button>`).join('')}</div>
  </div>`;
  $$('[data-open]').forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
  bindListBar();
}

/* ---------- 설정 ---------- */
async function renderSet() {
  const cfg = await getConfig();
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1048576).toFixed(1)}MB 사용 중`; } catch (e) {}
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const cnt = (id) => products.filter((p) => listOf(p) === id).length;
  $('#main').innerHTML = `<div class="store-head">${headImg()}<div><h2>설정</h2><p>목록·환율·판매처·동기화·백업</p></div></div>
  <div class="report">
    <div class="rcard"><h3>목록과 예산</h3>
      <div class="list-rows">${S.lists.map((l, i) => `<div class="list-row">
        <input data-ln="${i}" value="${esc(l.이름)}" aria-label="목록 이름">
        <select data-lc="${i}" aria-label="통화"><option value="JPY" ${l.통화 === 'JPY' ? 'selected' : ''}>✈️ 엔화</option><option value="KRW" ${l.통화 === 'KRW' ? 'selected' : ''}>💝 원화</option></select>
        <input data-lb="${i}" inputmode="numeric" value="${l.예산 || ''}" placeholder="예산 (${l.통화 === 'JPY' ? '¥' : '₩'})" aria-label="${esc(l.이름)} 예산">
        <button class="btn small" data-ld="${i}" aria-label="${esc(l.이름)} 지우기" ${S.lists.length < 2 || cnt(l.id) ? 'disabled' : ''}>×</button>
      </div>`).join('')}</div>
      <div class="row2" style="margin-top:10px"><input id="newList" placeholder="새 목록 (예: 생일 선물)"><button class="btn" id="addList">＋ 목록</button></div>
      <p class="sub">예산을 비우면 예상 합계가 기준이에요. 산 돈이 80%를 넘으면 고양이가 비틀거리고, 넘기면 눈이 돌아가요 🌀 · 담긴 게 있는 목록은 지울 수 없어요.</p>
    </div>
    <div class="rcard"><h3>환율</h3>
      <label class="field">1엔당 원<input id="rate2" inputmode="decimal" value="${S.rate}"></label>
      <p class="sub">기본값 9.20원은 최근 1년 평균(2026-10-27 Wise 기준)이에요. 여행 직전에 바꿔 주세요.</p>
    </div>
    <div class="rcard"><h3>일본 판매처</h3>
      <div class="tags" id="storeTags">${S.stores.map((s, i) => `<span class="tag">${esc(s)} <button class="x" data-rm="${i}" aria-label="${esc(s)} 빼기">×</button></span>`).join('')}</div>
      <div class="row2" style="margin-top:10px"><input id="newStore" placeholder="새 판매처 (예: 스기약국)"><button class="btn" id="addStore">추가</button></div>
    </div>
    <div class="rcard"><h3>구글 시트 동기화</h3>
      <label class="field">웹 앱 주소<input id="sUrl" value="${esc(cfg.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="field"><span>비밀번호 <small>(처음 연결할 때 정한 값)</small></span><input id="sKey" type="password" value="${esc(cfg.key)}" autocomplete="off"></label>
      <div class="row2"><button class="btn" id="sTest">연결 확인</button><button class="btn primary" id="sNow">지금 동기화</button></div>
      <p class="sub" id="sMsg">${cfg.lastAt ? '마지막 동기화: ' + new Date(cfg.lastAt).toLocaleString('ko-KR') : '아직 동기화한 적 없어요'}</p>
      ${cfg.lastAt && cfg.serverV < 2 ? '<p class="sub warn-line">시트 스크립트가 예전 버전이라 «목록»·«링크»가 시트에 저장되지 않아요. 앱스 스크립트에서 «배포 관리 → 새 버전»으로 다시 배포해 주세요.</p>' : ''}
    </div>
    <div class="rcard"><h3>백업</h3>
      <div style="display:grid;gap:8px">
        <button class="btn" id="exp">JSON으로 내보내기 (사진 포함)</button>
        <label class="btn file"><input type="file" accept="application/json,.json" id="imp" hidden>JSON 가져오기</label>
      </div>
      <p class="sub">${usage}${persisted ? ' · 저장소 보호 켜짐' : ' · 홈 화면에 추가하면 저장소가 더 안전해요'}</p>
    </div>
  </div>`;
  $('#rate2').onchange = (e) => setRate(e.target.value);
  $$('[data-ln]').forEach((x) => (x.onchange = async () => { const n = x.value.trim(); if (!n) { x.value = S.lists[+x.dataset.ln].이름; return; } S.lists[+x.dataset.ln].이름 = n; await saveLists(); render(); }));
  $$('[data-lc]').forEach((x) => (x.onchange = async () => {
    const l = S.lists[+x.dataset.lc], n = cnt(l.id);
    // 엔화 상품은 엔화 칸, 원화 상품은 한국 가격 칸에 값이 있어서 통화를 바꾸면 가격이 안 보일 수 있다
    if (n && !confirm(`«${l.이름}»에 담긴 ${n}개는 가격 칸이 달라서 «가격 미정»으로 보일 수 있어요. 통화를 바꿀까요?`)) { x.value = l.통화; return; }
    l.통화 = x.value; await saveLists(); render();
  }));
  $$('[data-lb]').forEach((x) => (x.onchange = async () => { const v = num(x.value); S.lists[+x.dataset.lb].예산 = v > 0 ? v : 0; await saveLists(); render(); }));
  $$('[data-ld]').forEach((b) => (b.onclick = async () => {
    const l = S.lists[+b.dataset.ld];
    if (S.lists.length < 2 || cnt(l.id) || !confirm(`«${l.이름}» 목록을 지울까요?`)) return;
    S.lists.splice(+b.dataset.ld, 1);
    await db.setMeta('listsDel', [...new Set([...(await db.meta('listsDel', [])), l.id])]);
    if (S.cur === l.id) { S.cur = S.lists[0].id; await db.setMeta('curList', S.cur); }
    await saveLists(); render();
  }));
  $('#addList').onclick = async () => {
    const n = $('#newList').value.trim(); if (!n) return;
    const l = { id: uid('l'), 이름: n, 통화: 'KRW', 예산: 0 };
    S.lists.push(l); await saveLists();
    toast(`«${n}» 목록을 만들었어요`); setCur(l.id); S.tab = 'list'; db.setMeta('tab', 'list'); render();
  };
  $$('[data-rm]').forEach((b) => (b.onclick = async () => { S.stores.splice(+b.dataset.rm, 1); await saveStores(); renderSet(); }));
  $('#addStore').onclick = async () => { const n = $('#newStore').value.trim(); if (!n || S.stores.includes(n)) return; S.stores.push(n); await saveStores(); renderSet(); };
  const saveCfg = async () => { await db.setMeta('syncUrl', $('#sUrl').value.trim()); await db.setMeta('syncKey', $('#sKey').value); };
  $('#sTest').onclick = async () => {
    await saveCfg(); $('#sMsg').textContent = '확인하는 중…';
    try { const r = await testConnection($('#sUrl').value.trim(), $('#sKey').value); $('#sMsg').textContent = r.firstSetup ? '연결됐어요! 이 비밀번호로 정해졌어요. 다른 기기에도 같은 값을 넣어 주세요.' : '연결됐어요 ♡'; }
    catch (e) { $('#sMsg').textContent = '연결 실패: ' + e.message; }
  };
  $('#sNow').onclick = async () => { await saveCfg(); runSync(true); };
  $('#exp').onclick = exportJSON;
  $('#imp').onchange = (e) => e.target.files[0] && importJSON(e.target.files[0]);
}

async function saveStores() {
  const at = Date.now();
  await db.setMeta('stores', S.stores); await db.setMeta('storesAt', at);
  pushSettings({ 판매처목록: S.stores, storesAt: at });
}

async function setRate(val) {
  const v = parseFloat(val);
  if (!(v > 0)) { $('#rate').value = S.rate; return; }
  S.rate = v; await db.setMeta('rate', v); $('#rate').value = v; render();
}

async function exportJSON() {
  const all = { app: 'japan_shopping', version: 2, exportedAt: new Date().toISOString(), 설정: { rate: S.rate, 목록들: S.lists, 판매처목록: S.stores },
    상품: (await db.all('products')).map(({ _dirty, ...r }) => r), 사진: (await db.all('photos')).filter((x) => !x.deleted).map(({ _dirty, uploaded, ...r }) => r) };
  const blob = new Blob([JSON.stringify(all)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `큰손위시-백업-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('백업 파일을 만들었어요');
}

async function importJSON(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'japan_shopping') throw new Error('이 앱의 백업 파일이 아니에요');
    let n = 0;
    for (const p of d.상품 || []) { const l = await db.get('products', p.id); if (!l || (p.updatedAt || 0) >= (l.updatedAt || 0)) { await db.put('products', { ...p, _dirty: true }); n++; } }
    for (const x of d.사진 || []) { const l = await db.get('photos', x.id); if (!l || (x.updatedAt || 0) >= (l.updatedAt || 0)) await db.put('photos', { ...x, _dirty: true, uploaded: !!x.fileId }); }
    if (d.설정?.판매처목록) { S.stores = [...new Set([...S.stores, ...d.설정.판매처목록.map(String)])]; await saveStores(); }
    // 목록은 없는 것만 더한다. 예전 백업(예산 하나)은 첫 엔화 목록 예산으로
    if (Array.isArray(d.설정?.목록들)) {
      const add = d.설정.목록들.filter((l) => l && l.id && l.이름 && !listById(l.id))
        .map((l) => ({ id: String(l.id), 이름: String(l.이름), 통화: l.통화 === 'JPY' ? 'JPY' : 'KRW', 예산: +l.예산 || 0 }));
      if (add.length) { S.lists.push(...add); await saveLists(); }
    } else if (d.설정?.budget > 0) {
      const l = S.lists.find((x) => x.통화 === 'JPY');
      if (l && !l.예산) { l.예산 = +d.설정.budget; await saveLists(); }
    }
    if (d.설정?.rate > 0) { S.rate = d.설정.rate; await db.setMeta('rate', S.rate); $('#rate').value = S.rate; }
    await loadAll(); render(); toast(`가져왔어요 (상품 ${n}개)`); autoSync();
  } catch (e) { toast('가져오기 실패: ' + e.message); }
}

/* ---------- 동기화 ---------- */
let syncT, syncing = false, syncAgain = false, warnedOld = false;
function autoSync(delay = 4000) {
  clearTimeout(syncT);
  syncT = setTimeout(() => runSync(false), delay);
}
async function runSync(manual) {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.key) { if (manual) toast('동기화 주소와 비밀번호를 먼저 넣어 주세요'); return; }
  if (!navigator.onLine) { if (manual) toast('지금은 오프라인이라 나중에 맞출게요'); setSyncState('off'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSyncState('busy');
  try {
    const r = await sync((m) => { if (manual && $('#sMsg')) $('#sMsg').textContent = m; });
    S.stores = await db.meta('stores', S.stores);
    const lists = await db.meta('lists', S.lists);
    const listsChanged = JSON.stringify(lists) !== JSON.stringify(S.lists);
    S.lists = lists;
    if (r.got || listsChanged) { await loadAll(); render(); }
    setSyncState('ok');
    if (r.again) syncAgain = true; // 목록·링크를 새 스크립트로 다시 보내기
    if (r.serverV < 2 && !warnedOld) { warnedOld = true; toast('시트 스크립트를 새 버전으로 배포해야 목록·링크가 저장돼요 (설정 참고)'); }
    if (manual) { toast(`동기화 끝! 보낸 것 ${r.sent} · 받은 것 ${r.got}` + (r.failed ? ` · 못 받은 사진 ${r.failed}${r.lastErr ? ` (${r.lastErr})` : ''}` : '')); if (S.tab === 'set') renderSet(); }
  } catch (e) {
    setSyncState('err');
    if (manual) { toast('동기화 실패: ' + e.message); if ($('#sMsg')) $('#sMsg').textContent = '실패: ' + e.message; }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; autoSync(1500); }
  }
}
function setSyncState(s) {
  const b = $('#syncBtn');
  b.dataset.state = s;
  b.title = { ok: '시트와 맞춰졌어요', busy: '맞추는 중', err: '동기화 실패 — 눌러서 다시', off: '오프라인' }[s] || '';
}
function updateNet() {
  $('#net').hidden = navigator.onLine;
  if (!navigator.onLine) setSyncState('off');
}
window.addEventListener('online', () => { updateNet(); autoSync(1000); });
window.addEventListener('offline', updateNet);

/* ---------- 시작 ---------- */
$$('.tab').forEach((t) => (t.onclick = () => { S.tab = t.dataset.tab; db.setMeta('tab', S.tab); window.scrollTo(0, 0); render(); }));
$('#fab').onclick = () => openEdit(null);
$('#syncBtn').onclick = () => runSync(true);
const rateIn = $('#rate');
db.meta('rate', DEFAULT_RATE).then((r) => (rateIn.value = r));
rateIn.addEventListener('change', () => setRate(rateIn.value));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot().catch((e) => { $('#main').innerHTML = `<p class="empty-msg">앱을 여는 중에 문제가 생겼어요: ${esc(e.message)}</p>`; });
