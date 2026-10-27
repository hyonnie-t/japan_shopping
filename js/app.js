import { db, askPersist } from './db.js';
import { shrink, sizeKB } from './photo.js';
import { sync, getConfig, testConnection, pushSettings } from './sync.js';

const DEFAULT_RATE = 9.20; // 최근 1년 평균(Wise 중간 환율, 2026-10-27 확인)
const CATS = ['뷰티', '헤어·바디', '드럭스토어 건강', '생활용품', '먹거리', '기타'];
const CAT_EMO = { '뷰티': '💄', '헤어·바디': '🧴', '드럭스토어 건강': '💊', '생활용품': '🏠', '먹거리': '🍡', '기타': '🎀' };
const PRIOS = ['꼭 살 것', '있으면 살 것', '가격 보고 결정'];
const PRIO_CLS = { '꼭 살 것': 'must', '있으면 살 것': 'maybe', '가격 보고 결정': 'price' };
const PHOTO_KINDS = ['정면', '뒷면', '진열대', '색상 구분', '헷갈리는 제품', '기타'];

let products = [];          // 지워지지 않은 상품
const photos = new Map();   // productId → [사진]
let S = { rate: DEFAULT_RATE, stores: [], tab: 'list', view: 'grid' };
let ui = { q: '', cat: '전체', buy: 'all', prio: '전체', shop: '전체', sort: 'prio', store: null, withUnknown: true };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const yen = (n) => (n == null ? '' : '¥' + Math.round(n).toLocaleString('ko-KR'));
const won = (n) => (n == null ? '' : '₩' + (Math.round(n / 10) * 10).toLocaleString('ko-KR'));
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
  const c = [];
  if (p.엔화_세금포함) c.push(p.엔화_세금포함);
  else if (p.엔화_세금별도) c.push(p.엔화_세금별도 * (1 + (p.세율 ?? 0.1)));
  (p.판매처 || []).forEach((s) => s.가격 && c.push(s.가격));
  return c.length ? Math.max(...c) : null; // 넉넉하게: 가장 비싼 값
}
const isBought = (p) => !!p.구입?.완료;

function totals() {
  let est = 0, unknown = 0, real = 0, done = 0, saved = 0, savedN = 0;
  products.forEach((p) => {
    const e = estPrice(p), q = p.목표개수 || 1;
    if (e == null) unknown++; else est += e * q;
    if (isBought(p)) {
      done++;
      const b = p.구입, paid = (b.가격 || 0) * (b.개수 || 1);
      real += paid;
      if (p.한국가격?.금액 && b.가격) { saved += p.한국가격.금액 * (b.개수 || 1) - paid * S.rate; savedN++; }
    }
  });
  return { est, unknown, real, done, total: products.length, saved, savedN };
}

/* ---------- 그리기 ---------- */
function render() {
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
  return `<section class="summary" aria-label="요약"><img class="mascot" src="images/mascot-320.png" alt="">
    <div class="sum-top">
      <div><div class="sum-label">예상 합계 · 넉넉하게 ♡</div>
        <div class="sum-big"><span class="yen">${yen(t.est)}</span><span class="won">${won(t.est * S.rate)}</span></div></div>
      <div class="sum-done">산 것<b>${t.done} / ${t.total}</b></div>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="산 비율"><i style="width:${pct}%"></i></div>
    <div class="note">${t.done ? `실제 쓴 돈 ${yen(t.real)} (${won(t.real * S.rate)}) · ` : ''}세금 포함 · 가격 미정 ${t.unknown}개는 빠져 있어요</div>
  </section>`;
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  const list = products.filter((p) => {
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
  const cats = ['전체', ...CATS.filter((c) => products.some((p) => p.대분류 === c))];
  $('#main').innerHTML = summaryHTML() + `
  <div class="tools">
    <div class="search">
      <input id="q" type="search" placeholder="한글·일본어·브랜드로 찾기" value="${esc(ui.q)}" aria-label="검색">
      <button class="iconbtn" id="view" aria-label="${S.view === 'grid' ? '목록 보기로' : '사진 격자로'}">${S.view === 'grid'
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'}</button>
    </div>
    <div class="chips" role="group" aria-label="대분류">${cats.map((c) => `<button class="chip" data-cat="${c}" aria-pressed="${ui.cat === c}">${CAT_EMO[c] ? CAT_EMO[c] + ' ' : ''}${c}</button>`).join('')}</div>
    <div class="subtools">
      <select id="buyF" aria-label="구입 여부"><option value="all" ${ui.buy === 'all' ? 'selected' : ''}>산 것·살 것 다</option><option value="todo" ${ui.buy === 'todo' ? 'selected' : ''}>살 것만</option><option value="done" ${ui.buy === 'done' ? 'selected' : ''}>산 것만</option></select>
      <select id="prioF" aria-label="우선순위"><option value="전체">우선순위 전부</option>${PRIOS.map((x) => `<option ${ui.prio === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select id="shopF" aria-label="판매처"><option value="전체">판매처 전부</option>${S.stores.map((x) => `<option value="${esc(x)}" ${ui.shop === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
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
  $('#shopF').onchange = (e) => { ui.shop = e.target.value; drawGrid(); };
  $('#sort').onchange = (e) => { ui.sort = e.target.value; drawGrid(); };
  $$('.chip[data-cat]').forEach((b) => (b.onclick = () => { ui.cat = b.dataset.cat; renderList(); }));
}

function drawGrid() {
  const list = filtered();
  $('#count').textContent = `${list.length}개`;
  $('#grid').innerHTML = list.length ? list.map((p) => {
    const e = estPrice(p);
    return `<button class="card ${isBought(p) ? 'bought' : ''}" data-id="${esc(p.id)}" aria-label="${esc(p.이름_한글)} 자세히">
      ${ph(p)}
      <div class="body">
        ${p.이름_일본어 ? `<div class="jpname">${esc(p.이름_일본어)}</div>` : ''}
        <div class="krname">${esc(p.이름_한글)}</div>
        ${e != null ? `<div class="price">${yen(e)} <small>${won(e * S.rate)}</small></div>` : '<div class="price none">가격 미정</div>'}
        ${(p.확인필요 || []).length ? `<span class="need">확인 필요 ${p.확인필요.length}</span>` : ''}
      </div>
    </button>`;
  }).join('') : `<div class="empty-msg"><img src="images/mascot-320.png" alt="" width="96" height="96"><p>${products.length ? '맞는 상품이 없어요. 검색어나 분류를 바꿔 보세요.' : '아직 상품이 없어요. ＋를 눌러 추가해 보세요.'}</p></div>`;
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
  const e = estPrice(p), b = p.구입 || {};
  const pics = photosOf(p.id).filter((x) => x.data);
  const gain = p.한국가격?.금액 && e ? p.한국가격.금액 - e * S.rate : null;
  const mixPics = (p.헷갈리는제품 || []);
  const t = p.특징 || {};
  const slides = pics.length
    ? pics.map((x, i) => `<button class="slide img" data-i="${i}" aria-label="사진 크게 보기"><img src="${img(x.data)}" alt="${esc(x.설명)}"><span class="lbl">${esc(x.설명 || '사진')}</span></button>`).join('')
    : `<div class="slide" style="background-color:${catVar(p.대분류)}"><span class="slide-emo"><span>${CAT_EMO[p.대분류] || '🎀'}</span><span class="jp slide-brand">${esc(p.브랜드_일본어 || p.브랜드_한글)}</span></span><span class="lbl">사진 없음 · 수정에서 추가</span></div>`;
  openSheet(`<div class="grab"></div><button class="sheet-close" aria-label="닫기">×</button>
    <div class="slider" id="slider">${slides}</div>
    <div class="dots" id="dots">${(pics.length ? pics : [0]).map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>
    <div class="d-body">
      <div class="d-jp">
        <div class="brandjp">${esc(p.브랜드_일본어 || p.브랜드_한글)}</div>
        <div class="big ${p.이름_일본어 ? '' : 'empty'}">${p.이름_일본어 ? esc(p.이름_일본어) : '일본어 이름 확인 필요'}</div>
        ${p.읽는법 ? `<div class="jp reading">${esc(p.읽는법)}</div>` : ''}
        <div class="kr">${esc(p.이름_한글)}</div>
        ${p.용량_수량 ? `<div class="sub">${esc(p.용량_수량)}</div>` : ''}
        <button class="btn dark block" id="showBtn" style="margin-top:12px">직원에게 보여 주기 (크게)</button>
      </div>
      <div class="prices">
        <div class="pbox"><div class="k">세금 포함</div><div class="v">${e != null ? yen(e) : '—'}</div></div>
        <div class="pbox"><div class="k">원화 (1엔 ${S.rate}원)</div><div class="v">${e != null ? won(e * S.rate) : '—'}</div></div>
        <div class="pbox"><div class="k">세금 별도 (${Math.round((p.세율 ?? 0.1) * 100)}%)</div><div class="v">${p.엔화_세금별도 ? yen(p.엔화_세금별도) : e != null ? yen(e / (1 + (p.세율 ?? 0.1))) : '—'}</div></div>
        <div class="pbox"><div class="k">한국 가격${p.한국가격?.어디 ? ' · ' + esc(p.한국가격.어디) : ''}</div><div class="v">${p.한국가격?.금액 ? won(p.한국가격.금액) : '—'}</div></div>
        ${gain != null ? `<div class="pbox gain"><div class="k">일본에서 사면</div><div class="v">${gain >= 0 ? won(gain) + ' 이득' : won(-gain) + ' 더 비싸요'}</div></div>` : ''}
      </div>
      ${(p.색상_호수 || []).filter((c) => c.번호 || c.이름).length ? `<div class="sec"><h3>색상·호수</h3><div class="tags">${p.색상_호수.filter((c) => c.번호 || c.이름).map((c) => `<span class="tag">${esc(c.번호)} ${esc(c.이름)}</span>`).join('')}</div></div>` : ''}
      <div class="sec"><h3>특징</h3><p>${esc(t.한줄 || '—')}</p>
        ${(t.장점 || []).length ? `<ul class="plain">${t.장점.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${t.주의점 ? `<p class="warn-line">주의: ${esc(t.주의점)}</p>` : ''}</div>
      <div class="sec"><h3>어디서 살까</h3>${(p.판매처 || []).length ? `<div class="store-rows">${p.판매처.map((s) => `<div class="store-row"><b>${esc(s.이름)}</b>${s.지점 ? ` <span class="sub">${esc(s.지점)}</span>` : ''}<span class="sp">${s.가격 ? yen(s.가격) : ''}</span>${s.메모 ? `<div class="sub">${esc(s.메모)}</div>` : ''}</div>`).join('')}</div>` : '<div class="tags"><span class="tag">판매처 미정</span></div>'}
        ${p.매장내위치 ? `<p class="sub">매장 안 위치: ${esc(p.매장내위치)}</p>` : ''}</div>
      ${p.면세?.가능 != null || p.면세?.메모 ? `<div class="sec"><h3>면세</h3><p>${p.면세.가능 === true ? '면세 가능' : p.면세.가능 === false ? '면세 안 됨' : ''} ${esc(p.면세.메모 || '')}</p></div>` : ''}
      ${mixPics.length ? `<div class="sec"><h3>헷갈리는 제품</h3>${mixPics.map((m) => { const mp = photosOf(p.id).find((x) => x.id === m.photoId); return `<div class="mix">${mp?.data ? `<img src="${img(mp.data)}" alt="">` : ''}<p>${esc(m.구분점)}</p></div>`; }).join('')}</div>` : ''}
      ${p.선물대상 ? `<div class="sec"><h3>선물</h3><p>${esc(p.선물대상)}</p></div>` : ''}
      ${p.메모 ? `<div class="sec"><h3>메모</h3><p>${esc(p.메모)}</p></div>` : ''}
      ${(p.확인필요 || []).length ? `<div class="sec"><h3>확인 필요</h3><div class="tags">${p.확인필요.map((x) => `<span class="tag warn">${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${(p.추천이유_출처 || []).length ? `<div class="sec src"><h3>출처</h3>${p.추천이유_출처.map((s) => `${s.주소 ? `<a href="${esc(safeUrl(s.주소))}" target="_blank" rel="noopener">${esc(s.주소.replace(/^https?:\/\//, ''))}</a>` : ''}${s.메모 ? ` <span>${esc(s.메모)}</span>` : ''}`).join('<br>')}</div>` : ''}
      ${isBought(p) ? `<div class="sec"><h3>구매 기록</h3><p>${b.가격 ? yen(b.가격) : '가격 미입력'} × ${b.개수 || 1}개 · ${esc(b.산곳 || '')} · ${esc(b.날짜 || '')}</p></div>` : ''}
    </div>
    <div class="sticky-act">
      <button class="btn" id="edit">수정</button>
      ${isBought(p) ? `<button class="btn block" id="unbuy">구매 취소</button>` : `<button class="btn primary block" id="buy">샀어요 ♡</button>`}
    </div>`);
  $('#showBtn').onclick = () => showStaff(p);
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
  const e = estPrice(p);
  const sel = store || p.판매처?.[0]?.이름;
  openSheet(`<div class="grab"></div><button class="sheet-close" aria-label="닫기">×</button>
    <div class="form">
      <h2>샀어요 · ${esc(p.이름_한글)}</h2>
      <div class="row2">
        <label class="field">산 가격(¥, 1개)<input id="bp" inputmode="numeric" value="${e ? Math.round(e) : ''}" placeholder="예: 990"></label>
        <div class="field">개수<div class="stepper"><button type="button" id="m" aria-label="빼기">−</button><output id="n">${n}</output><button type="button" id="pl" aria-label="더하기">+</button></div></div>
      </div>
      <label class="field">산 곳<select id="bs">${S.stores.map((s) => `<option ${sel === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
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
  return { id: uid('u'), 이름_한글: '', 이름_일본어: '', 읽는법: '', 브랜드_한글: '', 브랜드_일본어: '', 대분류: '뷰티', 세부분류: '',
    사진: [], 용량_수량: '', 색상_호수: [], 특징: { 한줄: '', 장점: [], 주의점: '' }, 추천이유_출처: [], 엔화_세금별도: null, 엔화_세금포함: null,
    세율: 0.1, 한국가격: { 금액: null, 어디: '' }, 판매처: [], 매장내위치: '', 면세: { 가능: null, 메모: '' }, 헷갈리는제품: [],
    목표개수: 1, 우선순위: '있으면 살 것', 선물대상: '', 구입: { 완료: false, 가격: null, 개수: null, 산곳: '', 날짜: '' }, 메모: '', 확인필요: [] };
}

function openEdit(id) {
  const orig = id ? products.find((x) => x.id === id) : null;
  const p = structuredClone(orig || blank());
  p.특징 ??= { 한줄: '', 장점: [], 주의점: '' }; p.한국가격 ??= { 금액: null, 어디: '' }; p.면세 ??= { 가능: null, 메모: '' };
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
      <label class="field">한국어 이름 *<input name="이름_한글" value="${v(p.이름_한글)}" required></label>
      <label class="field"><span>일본어 이름 <small>(패키지에 적힌 그대로)</small></span><input name="이름_일본어" class="jp" value="${v(p.이름_일본어)}" lang="ja"></label>
      <div class="row2">
        <label class="field">브랜드(한글)<input name="브랜드_한글" value="${v(p.브랜드_한글)}"></label>
        <label class="field">브랜드(일본어)<input name="브랜드_일본어" class="jp" value="${v(p.브랜드_일본어)}" lang="ja"></label>
      </div>
      <div class="row2">
        <label class="field">대분류<select name="대분류">${CATS.map((c) => `<option ${p.대분류 === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field">우선순위<select name="우선순위">${PRIOS.map((c) => `<option ${p.우선순위 === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="row2">
        <label class="field">세금 별도 ¥<input name="엔화_세금별도" inputmode="numeric" value="${v(p.엔화_세금별도)}"></label>
        <label class="field"><span>세금 포함 ¥ <small id="taxr">(${Math.round((p.세율 ?? 0.1) * 100)}%)</small></span><input name="엔화_세금포함" inputmode="numeric" value="${v(p.엔화_세금포함)}"></label>
      </div>
      <div class="row2">
        <label class="field">살 개수<input name="목표개수" inputmode="numeric" value="${v(p.목표개수 || 1)}"></label>
        <label class="field">한 줄 특징<input name="특징_한줄" value="${v(p.특징.한줄)}"></label>
      </div>
      <div class="field"><span>어디서 살까 <small>누르면 선택</small></span>
        <div class="chips wrap" id="storePick">${S.stores.map((s) => `<button type="button" class="chip" data-s="${esc(s)}" aria-pressed="${(p.판매처 || []).some((x) => x.이름 === s)}">${esc(s)}</button>`).join('')}</div>
        <div id="storeRows"></div>
      </div>
      <details class="more"><summary>더 적기 (읽는 법·색상·한국 가격·면세·메모 등)</summary>
        <label class="field">읽는 법<input name="읽는법" class="jp" value="${v(p.읽는법)}" lang="ja"></label>
        <div class="row2">
          <label class="field">세부 분류<input name="세부분류" value="${v(p.세부분류)}" placeholder="립, 샴푸…"></label>
          <label class="field">용량·수량<input name="용량_수량" value="${v(p.용량_수량)}" placeholder="50ml, 3개입"></label>
        </div>
        <div class="field"><span>색상·호수</span><div id="colors"></div><button type="button" class="btn small" id="addColor">＋ 색상</button></div>
        <label class="field"><span>장점 <small>(한 줄에 하나)</small></span><textarea name="장점" rows="3">${v((p.특징.장점 || []).join('\n'))}</textarea></label>
        <label class="field"><span>주의점 <small>(피부 타입·향·알레르기)</small></span><input name="주의점" value="${v(p.특징.주의점)}"></label>
        <div class="row2">
          <label class="field">한국 가격 ₩<input name="한국가격" inputmode="numeric" value="${v(p.한국가격.금액)}"></label>
          <label class="field">한국 어디<input name="한국가격_어디" value="${v(p.한국가격.어디)}" placeholder="올리브영, 쿠팡"></label>
        </div>
        <label class="field">매장 안 위치<input name="매장내위치" value="${v(p.매장내위치)}" placeholder="화장품 코너 3번 통로"></label>
        <div class="row2">
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

  drawPics(); drawStores();

  f.onsubmit = async (e) => {
    e.preventDefault();
    const g = (k) => f.elements[k]?.value?.trim() ?? '';
    if (!g('이름_한글')) { f.이름_한글.focus(); toast('한국어 이름은 꼭 적어 주세요'); return; }
    Object.assign(p, {
      이름_한글: g('이름_한글'), 이름_일본어: g('이름_일본어'), 읽는법: g('읽는법'), 브랜드_한글: g('브랜드_한글'), 브랜드_일본어: g('브랜드_일본어'),
      대분류: g('대분류'), 세부분류: g('세부분류'), 용량_수량: g('용량_수량'), 우선순위: g('우선순위'),
      엔화_세금별도: num(g('엔화_세금별도')), 엔화_세금포함: num(g('엔화_세금포함')), 세율: rateOf(), 목표개수: num(g('목표개수')) || 1,
      특징: { 한줄: g('특징_한줄'), 장점: g('장점').split('\n').map((s) => s.trim()).filter(Boolean), 주의점: g('주의점') },
      한국가격: { 금액: num(g('한국가격')), 어디: g('한국가격_어디') }, 매장내위치: g('매장내위치'),
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
    closeSheet(true); render();
    toast(orig ? '저장했어요' : '새 상품을 추가했어요');
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
  const list = products.filter((p) => (p.판매처 || []).some((s) => s.이름 === ui.store) || (ui.withUnknown && !(p.판매처 || []).length))
    .sort((a, b) => isBought(a) - isBought(b) || PRIOS.indexOf(a.우선순위) - PRIOS.indexOf(b.우선순위));
  const left = list.filter((p) => !isBought(p)).length;
  $('#main').innerHTML = `<div class="store-head"><img src="images/mascot-320.png" alt=""><div><h2>매장 모드</h2><p>고른 매장에서 살 것만 크게! 누르면 바로 구매 완료</p></div></div>
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
  const t = totals();
  const bought = products.filter(isBought), todo = products.filter((p) => !isBought(p));
  const byStore = {};
  bought.forEach((p) => { const k = p.구입.산곳 || '기타'; byStore[k] = (byStore[k] || 0) + (p.구입.가격 || 0) * (p.구입.개수 || 1); });
  $('#main').innerHTML = `<div class="store-head"><img src="images/mascot-320.png" alt=""><div><h2>정리</h2><p>산 것과 안 산 것, 쓴 돈을 한눈에</p></div></div>
  <div class="report">
    <div class="rcard"><h3>쓴 돈</h3>
      <div class="rline"><span>실제 합계</span><b>${yen(t.real)} · ${won(t.real * S.rate)}</b></div>
      <div class="rline"><span>처음 예상</span><span>${yen(t.est)} · ${won(t.est * S.rate)}</span></div>
      <div class="rline"><span>한국 가격 대비</span><b class="${t.saved >= 0 ? 'good' : ''}">${t.savedN ? (t.saved >= 0 ? won(t.saved) + ' 절약' : won(-t.saved) + ' 더 씀') + ` (${t.savedN}개 기준)` : '한국 가격을 넣으면 계산돼요'}</b></div>
      ${Object.keys(byStore).length ? Object.entries(byStore).map(([k, v]) => `<div class="rline"><span>${esc(k)}</span><span>${yen(v)}</span></div>`).join('') : ''}
    </div>
    <div class="rcard"><h3>산 것 ${bought.length}개</h3>${bought.length ? bought.map((p) => `<button class="rline link" data-open="${esc(p.id)}"><span>${esc(p.이름_한글)}</span><span>${p.구입.가격 ? yen(p.구입.가격) : '—'} × ${p.구입.개수 || 1}</span></button>`).join('') : '<p class="sub">아직 없어요</p>'}</div>
    <div class="rcard"><h3>안 산 것 ${todo.length}개</h3>${todo.map((p) => `<button class="rline link" data-open="${esc(p.id)}"><span>${esc(p.이름_한글)}</span><span class="sub">${esc(p.우선순위)}</span></button>`).join('')}</div>
  </div>`;
  $$('[data-open]').forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
}

/* ---------- 설정 ---------- */
async function renderSet() {
  const cfg = await getConfig();
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1048576).toFixed(1)}MB 사용 중`; } catch (e) {}
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#main').innerHTML = `<div class="store-head"><img src="images/mascot-320.png" alt=""><div><h2>설정</h2><p>환율·판매처·동기화·백업</p></div></div>
  <div class="report">
    <div class="rcard"><h3>환율</h3>
      <label class="field">1엔당 원<input id="rate2" inputmode="decimal" value="${S.rate}"></label>
      <p class="sub">기본값 9.20원은 최근 1년 평균(2026-10-27 Wise 기준)이에요. 여행 직전에 바꿔 주세요.</p>
    </div>
    <div class="rcard"><h3>판매처 목록</h3>
      <div class="tags" id="storeTags">${S.stores.map((s, i) => `<span class="tag">${esc(s)} <button class="x" data-rm="${i}" aria-label="${esc(s)} 빼기">×</button></span>`).join('')}</div>
      <div class="row2" style="margin-top:10px"><input id="newStore" placeholder="새 판매처 (예: 스기약국)"><button class="btn" id="addStore">추가</button></div>
    </div>
    <div class="rcard"><h3>구글 시트 동기화</h3>
      <label class="field">웹 앱 주소<input id="sUrl" value="${esc(cfg.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="field"><span>비밀번호 <small>(처음 연결할 때 정한 값)</small></span><input id="sKey" type="password" value="${esc(cfg.key)}" autocomplete="off"></label>
      <div class="row2"><button class="btn" id="sTest">연결 확인</button><button class="btn primary" id="sNow">지금 동기화</button></div>
      <p class="sub" id="sMsg">${cfg.lastAt ? '마지막 동기화: ' + new Date(cfg.lastAt).toLocaleString('ko-KR') : '아직 동기화한 적 없어요'}</p>
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
  const all = { app: 'japan_shopping', version: 1, exportedAt: new Date().toISOString(), 설정: { rate: S.rate, 판매처목록: S.stores },
    상품: (await db.all('products')).map(({ _dirty, ...r }) => r), 사진: (await db.all('photos')).filter((x) => !x.deleted).map(({ _dirty, uploaded, ...r }) => r) };
  const blob = new Blob([JSON.stringify(all)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `일본쇼핑-백업-${today()}.json`;
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
    if (d.설정?.rate > 0) { S.rate = d.설정.rate; await db.setMeta('rate', S.rate); $('#rate').value = S.rate; }
    await loadAll(); render(); toast(`가져왔어요 (상품 ${n}개)`); autoSync();
  } catch (e) { toast('가져오기 실패: ' + e.message); }
}

/* ---------- 동기화 ---------- */
let syncT, syncing = false, syncAgain = false;
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
    if (r.got) { await loadAll(); render(); }
    setSyncState('ok');
    if (manual) { toast(`동기화 끝! 보낸 것 ${r.sent} · 받은 것 ${r.got}` + (r.failed ? ` · 못 받은 사진 ${r.failed}` : '')); if (S.tab === 'set') renderSet(); }
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
