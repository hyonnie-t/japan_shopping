/**
 * 일본 쇼핑 도감 — 구글 시트 동기화 (시트에 붙은 앱스 스크립트)
 * 시트 탭: 상품 / 사진 / 설정. 사진 파일은 Drive «일본쇼핑 사진» 폴더.
 * 배포: 배포 > 새 배포 > 웹 앱, 실행: 나, 액세스: 모든 사용자.
 * 비밀번호는 앱에서 처음 «연결 확인»을 누를 때 정해진다(스크립트 속성 SYNC_KEY). 코드·레포에는 넣지 않는다.
 */

const P_COLS = ['id', '이름_한글', '이름_일본어', '읽는법', '브랜드_한글', '브랜드_일본어', '대분류', '세부분류', '용량_수량',
  '특징_한줄', '장점', '주의점', '엔화_세금별도', '엔화_세금포함', '세율', '한국가격', '한국가격_어디', '판매처', '매장내위치',
  '면세가능', '면세메모', '목표개수', '우선순위', '선물대상', '구입완료', '구입가격', '구입개수', '구입산곳', '구입날짜',
  '메모', '확인필요', '색상_호수', '추천이유_출처', '헷갈리는제품', 'updatedAt', 'deleted', 'syncedAt'];
const PH_COLS = ['id', 'productId', '설명', '순서', 'fileId', 'updatedAt', 'deleted', 'syncedAt'];
const NUM_COLS = ['엔화_세금별도', '엔화_세금포함', '세율', '한국가격', '목표개수', '구입가격', '구입개수', 'updatedAt', 'syncedAt'];
const FOLDER = '일본쇼핑 사진';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    const saved = props.getProperty('SYNC_KEY');
    if (!saved) {
      if (d.action !== 'hello' || !d.key || String(d.key).length < 4) return out_({ ok: false, error: '처음 연결: 비밀번호를 4자 이상으로 정해 주세요' });
      props.setProperty('SYNC_KEY', String(d.key));
      setup_();
      return out_({ ok: true, firstSetup: true });
    }
    if (d.key !== saved) return out_({ ok: false, error: '비밀번호가 맞지 않아요' });
    switch (d.action) {
      case 'hello': setup_(); return out_({ ok: true });
      case 'pull': return out_(pull_(Number(d.since) || 0));
      case 'push': return out_(withLock_(() => push_(d.products || [], d.photos || [])));
      case 'putPhoto': return out_(putPhoto_(d));
      case 'getPhoto': return out_(getPhoto_(d.id));
      case 'saveSettings': return out_(saveSettings_(d.settings || {}));
    }
    return out_({ ok: false, error: '모르는 요청: ' + d.action });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() { return out_({ ok: true, app: 'japan_shopping', hint: 'POST로 요청하세요' }); }

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#FFE3EB');
    sh.setFrozenRows(1);
    // 용량(1/2)·날짜처럼 보이는 글자가 바뀌지 않게 숫자 칸 말고는 글자 형식으로
    cols.forEach((c, i) => { if (NUM_COLS.indexOf(c) < 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
  }
  return sh;
}

function setup_() {
  sheet_('상품', P_COLS);
  sheet_('사진', PH_COLS);
  sheet_('설정', ['key', 'value']);
}

/* 상품 ↔ 시트 한 줄. 표처럼 고치기 쉬운 칸은 그대로, 묶음 정보는 JSON 칸으로 둔다 */
function toRow_(p) {
  const g = p.구입 || {}, k = p.한국가격 || {}, f = p.면세 || {}, t = p.특징 || {};
  const v = {
    id: p.id, 이름_한글: p.이름_한글, 이름_일본어: p.이름_일본어, 읽는법: p.읽는법, 브랜드_한글: p.브랜드_한글, 브랜드_일본어: p.브랜드_일본어,
    대분류: p.대분류, 세부분류: p.세부분류, 용량_수량: p.용량_수량, 특징_한줄: t.한줄, 장점: (t.장점 || []).join('\n'), 주의점: t.주의점,
    엔화_세금별도: p.엔화_세금별도, 엔화_세금포함: p.엔화_세금포함, 세율: p.세율, 한국가격: k.금액, 한국가격_어디: k.어디,
    판매처: JSON.stringify(p.판매처 || []), 매장내위치: p.매장내위치, 면세가능: f.가능 === true ? 'O' : f.가능 === false ? 'X' : '', 면세메모: f.메모,
    목표개수: p.목표개수, 우선순위: p.우선순위, 선물대상: p.선물대상, 구입완료: g.완료 ? 'O' : '', 구입가격: g.가격, 구입개수: g.개수,
    구입산곳: g.산곳, 구입날짜: g.날짜, 메모: p.메모, 확인필요: (p.확인필요 || []).join(', '),
    색상_호수: JSON.stringify(p.색상_호수 || []), 추천이유_출처: JSON.stringify(p.추천이유_출처 || []), 헷갈리는제품: JSON.stringify(p.헷갈리는제품 || []),
    updatedAt: p.updatedAt || Date.now(), deleted: p.deleted ? 'O' : '', syncedAt: Date.now(),
  };
  return P_COLS.map((c) => safe_(v[c]));
}

// =로 시작하는 글자가 수식으로 바뀌지 않게
function safe_(x) {
  if (x === undefined || x === null) return '';
  return typeof x === 'string' && /^[=+@]|^-[^0-9]/.test(x) && isNaN(Number(x)) ? "'" + x : x;
}

function fromRow_(r) {
  const v = {}; P_COLS.forEach((c, i) => { v[c] = r[i]; });
  const num = (x) => (x === '' || x === null || isNaN(Number(x)) ? null : Number(x));
  const js = (x, d) => { try { return x ? JSON.parse(x) : d; } catch (e) { return d; } };
  return {
    id: String(v.id), 이름_한글: String(v.이름_한글 || ''), 이름_일본어: String(v.이름_일본어 || ''), 읽는법: String(v.읽는법 || ''),
    브랜드_한글: String(v.브랜드_한글 || ''), 브랜드_일본어: String(v.브랜드_일본어 || ''), 대분류: String(v.대분류 || '기타'), 세부분류: String(v.세부분류 || ''),
    용량_수량: String(v.용량_수량 || ''),
    특징: { 한줄: String(v.특징_한줄 || ''), 장점: String(v.장점 || '').split('\n').filter(String), 주의점: String(v.주의점 || '') },
    엔화_세금별도: num(v.엔화_세금별도), 엔화_세금포함: num(v.엔화_세금포함), 세율: num(v.세율) ?? 0.1,
    한국가격: { 금액: num(v.한국가격), 어디: String(v.한국가격_어디 || '') },
    판매처: js(v.판매처, []), 매장내위치: String(v.매장내위치 || ''),
    면세: { 가능: v.면세가능 === 'O' ? true : v.면세가능 === 'X' ? false : null, 메모: String(v.면세메모 || '') },
    목표개수: num(v.목표개수) || 1, 우선순위: String(v.우선순위 || '있으면 살 것'), 선물대상: String(v.선물대상 || ''),
    구입: { 완료: v.구입완료 === 'O' || v.구입완료 === true, 가격: num(v.구입가격), 개수: num(v.구입개수), 산곳: String(v.구입산곳 || ''), 날짜: fmtDate_(v.구입날짜) },
    메모: String(v.메모 || ''), 확인필요: String(v.확인필요 || '').split(',').map((s) => s.trim()).filter(String),
    색상_호수: js(v.색상_호수, []), 추천이유_출처: js(v.추천이유_출처, []), 헷갈리는제품: js(v.헷갈리는제품, []),
    updatedAt: num(v.updatedAt) || 0, deleted: v.deleted === 'O',
  };
}

function fmtDate_(x) {
  if (x instanceof Date) return Utilities.formatDate(x, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(x || '');
}

function rows_(sh, cols) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, cols.length).getValues() : [];
}

function pull_(since) {
  setup_();
  const ss = SpreadsheetApp.getActive();
  const ps = P_COLS.indexOf('syncedAt'), hs = PH_COLS.indexOf('syncedAt');
  const products = rows_(ss.getSheetByName('상품'), P_COLS).filter((r) => r[0] !== '' && Number(r[ps]) > since).map(fromRow_);
  const photos = rows_(ss.getSheetByName('사진'), PH_COLS).filter((r) => r[0] !== '' && Number(r[hs]) > since).map((r) => ({
    id: String(r[0]), productId: String(r[1]), 설명: String(r[2] || ''), 순서: Number(r[3]) || 0, fileId: String(r[4] || ''), updatedAt: Number(r[5]) || 0, deleted: r[6] === 'O',
  }));
  const settings = {};
  rows_(ss.getSheetByName('설정'), ['key', 'value']).forEach((r) => { try { settings[r[0]] = JSON.parse(r[1]); } catch (e) { settings[r[0]] = r[1]; } });
  return { ok: true, now: Date.now(), products, photos, settings };
}

function upsert_(sh, cols, items, toRow) {
  const data = rows_(sh, cols);
  const ui = cols.indexOf('updatedAt');
  const at = {}; data.forEach((r, i) => { at[String(r[0])] = i; });
  const appends = [];
  items.forEach((it) => {
    const row = toRow(it);
    const i = at[String(it.id)];
    if (i === undefined) { appends.push(row); at[String(it.id)] = -1; return; }
    if (i >= 0 && Number(data[i][ui]) > Number(row[ui])) return; // 시트 쪽이 더 최신이면 두기
    if (i >= 0) sh.getRange(i + 2, 1, 1, cols.length).setValues([row]);
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, cols.length).setValues(appends);
}

function push_(products, photos) {
  setup_();
  const ss = SpreadsheetApp.getActive();
  upsert_(ss.getSheetByName('상품'), P_COLS, products, toRow_);
  const phSheet = ss.getSheetByName('사진');
  const fileIds = {}; rows_(phSheet, PH_COLS).forEach((r) => { fileIds[String(r[0])] = r[4]; });
  upsert_(phSheet, PH_COLS, photos, (p) => [p.id, p.productId, safe_(p.설명 || ''), p.순서 || 0, fileIds[p.id] || p.fileId || '', p.updatedAt || Date.now(), p.deleted ? 'O' : '', Date.now()]);
  return { ok: true, now: Date.now() };
}

function folder_() {
  const it = DriveApp.getFoldersByName(FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
}

function putPhoto_(d) {
  const m = String(d.data || '').match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return { ok: false, error: '사진 형식이 아니에요' };
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], d.id + '.jpg');
  const file = folder_().createFile(blob);
  withLock_(() => {
    const sh = sheet_('사진', PH_COLS);
    const data = rows_(sh, PH_COLS);
    const i = data.findIndex((r) => String(r[0]) === String(d.id));
    if (i >= 0) sh.getRange(i + 2, 5, 1, 4).setValues([[file.getId(), data[i][5], data[i][6], Date.now()]]);
    else sh.appendRow([d.id, d.productId, '', 0, file.getId(), 0, '', Date.now()]); // updatedAt 0: 곧 오는 사진 정보(push)가 덮어쓰게
  });
  return { ok: true, fileId: file.getId() };
}

function getPhoto_(id) {
  const data = rows_(sheet_('사진', PH_COLS), PH_COLS);
  const r = data.find((x) => String(x[0]) === String(id));
  if (!r || !r[4]) return { ok: false, error: '사진 파일이 없어요' };
  const blob = DriveApp.getFileById(r[4]).getBlob();
  return { ok: true, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function saveSettings_(s) {
  return withLock_(() => saveSettingsLocked_(s));
}

function saveSettingsLocked_(s) {
  const sh = sheet_('설정', ['key', 'value']);
  const data = rows_(sh, ['key', 'value']);
  Object.keys(s).forEach((k) => {
    const i = data.findIndex((r) => r[0] === k);
    const v = JSON.stringify(s[k]);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(v); else sh.appendRow([k, v]);
  });
  return { ok: true };
}

/* 시트에서 직접 고치면 그 줄의 updatedAt을 지금으로 바꿔 앱이 받아 가게 한다 (단순 트리거) */
function onEdit(e) {
  const sh = e.range.getSheet();
  const name = sh.getName();
  const cols = name === '상품' ? P_COLS : name === '사진' ? PH_COLS : null;
  if (!cols || e.range.getRow() < 2) return;
  const uc = cols.indexOf('updatedAt') + 1, sc = cols.indexOf('syncedAt') + 1;
  if (e.range.getColumn() <= uc && e.range.getLastColumn() >= uc) return;
  const now = Date.now();
  for (let r = e.range.getRow(); r <= e.range.getLastRow(); r++) { sh.getRange(r, uc).setValue(now); sh.getRange(r, sc).setValue(now); }
}
