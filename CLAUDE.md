# 큰손 효니의 위시리스트 (wish_list, 예전 위시 도감·일본 쇼핑 도감 japan_shopping)

## 무엇인지
배포 https://hyonnie-t.github.io/wish_list/ (2026-10-29 레포 이름 japan_shopping → wish_list, 옛 주소는 404).
효니 개인용 «사고 싶은 것» 도감 PWA. 2026-10-27 일본 여행 쇼핑 도감으로 만들고, 2026-10-29 목록 여러 개(✈️ 일본 여행=엔화 / 💝 위시리스트=원화 …)로 넓혔다. 엔화 목록은 매장 앞에서 일본어 이름·세금·면세·매장 모드, 원화 목록은 가격·어디서·구매 링크. 인터넷이 끊겨도 목록·사진·체크·가격 입력이 된다.
- 목록: meta `lists`([{id, 이름, 통화 JPY|KRW, 예산}])·`listsAt`·`listsDel`(지운 목록 id), 현재 목록 `curList`. 상품 `목록`(없거나 모르는 id면 첫 목록)·`링크`. 원화 상품 가격은 `한국가격.금액/어디`를 쓴다. 목록은 동기화 때 id별로 합친다(sync.js `mergeLists`).
- IndexedDB 이름은 `japan_shopping` 그대로(레포 이름이 바뀌어도 같은 origin이라 기존 데이터가 이어진다). 백업 JSON의 `app` 값도 `japan_shopping` 유지.

## 구조
- `index.html` 화면 뼈대, `css/app.css` 아기자기 스타일(파스텔·스티커·Jua 글꼴), `js/app.js` 화면 전부
- `js/db.js` 폰 저장소(IndexedDB: products / photos / meta) — **폰이 원본**
- `js/photo.js` 사진을 가로 800px JPEG로 줄임
- `js/sync.js` 구글 시트 동기화 클라이언트(앱스 스크립트 웹 앱, text/plain POST, 요청마다 60초 제한). updatedAt 늦은 쪽이 이김, 삭제는 deleted 표시
- `apps-script/Code.gs` 시트에 붙는 앱스 스크립트(시트 탭: 상품/사진/설정, 사진 파일은 Drive «일본쇼핑 사진»). onEdit가 시트 직접 수정 시 updatedAt 갱신. `VERSION`(지금 2)을 hello·pull로 돌려주고 앱은 `serverV`로 저장해 낮으면 안내한다. 상품 시트 칸은 **맨 뒤에만** 더한다(`sheet_`가 예전 시트에 머리글을 붙임)
- `data/products.json` 처음 넣는 상품(X 북마크에서 고른 일본 32개 p001~ + 2026-10-29 국내 29개 k001~, 목록 wish). 트윗 사진은 레포에 안 넣고 `design/*-가져오기.json`(OneDrive)을 폰 설정 «JSON 가져오기»로 넣는다. 새 id를 더하면 다음에 열 때 그것만 추가됨
- `sw.js` 서비스 워커(앱 파일 캐시, 네트워크 먼저), `manifest.webmanifest`, `icons/`(마스코트), `images/mascot-320.png`(힉스필드로 만든 삼색 고양이, 토끼 시안 스타일. `mascot-dizzy-320.png`는 예산 넘었을 때 눈 돌아간 고양이). 힉스필드 원본은 `design/higgsfield/`(gitignore, OneDrive에만), `fonts/Jua-Regular.ttf`(OFL)
- `preview.html` 처음 디자인 시안(참고용)

## 규칙
- 외부 라이브러리·CDN 없이 정적 파일만. 글꼴·그림은 레포 안에 둔다.
- 시트 비밀번호·웹 앱 주소는 레포·답변·로그에 넣지 않는다(앱 설정에서 입력, 기기 localStorage/IndexedDB에만).
- 앱 파일을 바꾸면 `sw.js`의 `VERSION`을 올린다(폰 캐시 갱신).
- 앱스 스크립트를 고치면 `apps-script/Code.gs`를 먼저 고치고, 시트의 스크립트 편집기에 반영 → 효니가 «배포 관리 > 새 버전»으로 다시 배포(주소 유지).
- 디자인은 아기자기하게(메모리 feedback-cute-design-default). 글자 대비는 WCAG AA(4.5:1) 이상.
- 화면 확인은 폰 375 · 태블릿 768/1180 · PC 1280 네 폭 모두.
- 가격·일본어 이름은 지어내지 않는다. 모르는 값은 «확인필요»에 적는다.
