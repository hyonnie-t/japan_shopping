# 일본 쇼핑 도감 (japan_shopping)

## 무엇인지
효니 개인용 일본 여행 쇼핑 도감 PWA. 폰으로 매장 앞에서 «사려던 물건이 이거 맞나» 확인하고, 산 뒤 체크한다. 인터넷이 끊겨도 목록·사진·체크·가격 입력이 된다. 2026-10-27 처음 만듦.

## 구조
- `index.html` 화면 뼈대, `css/app.css` 아기자기 스타일(파스텔·스티커·Jua 글꼴), `js/app.js` 화면 전부
- `js/db.js` 폰 저장소(IndexedDB: products / photos / meta) — **폰이 원본**
- `js/photo.js` 사진을 가로 800px JPEG로 줄임
- `js/sync.js` 구글 시트 동기화 클라이언트(앱스 스크립트 웹 앱, text/plain POST). updatedAt 늦은 쪽이 이김, 삭제는 deleted 표시
- `apps-script/Code.gs` 시트에 붙는 앱스 스크립트(시트 탭: 상품/사진/설정, 사진 파일은 Drive «일본쇼핑 사진»). onEdit가 시트 직접 수정 시 updatedAt 갱신
- `data/products.json` 처음 넣는 상품(X 북마크에서 고른 32개). 새 id를 더하면 다음에 열 때 그것만 추가됨
- `sw.js` 서비스 워커(앱 파일 캐시, 네트워크 먼저), `manifest.webmanifest`, `icons/`(마스코트), `images/mascot-320.png`(힉스필드로 만든 삼색 고양이, `mascot-dizzy-320.png`는 예산 넘었을 때 눈 돌아간 고양이), `fonts/Jua-Regular.ttf`(OFL)
- `preview.html` 처음 디자인 시안(참고용)

## 규칙
- 외부 라이브러리·CDN 없이 정적 파일만. 글꼴·그림은 레포 안에 둔다.
- 시트 비밀번호·웹 앱 주소는 레포·답변·로그에 넣지 않는다(앱 설정에서 입력, 기기 localStorage/IndexedDB에만).
- 앱 파일을 바꾸면 `sw.js`의 `VERSION`을 올린다(폰 캐시 갱신).
- 앱스 스크립트를 고치면 `apps-script/Code.gs`를 먼저 고치고, 시트의 스크립트 편집기에 반영 → 효니가 «배포 관리 > 새 버전»으로 다시 배포(주소 유지).
- 디자인은 아기자기하게(메모리 feedback-cute-design-default). 글자 대비는 WCAG AA(4.5:1) 이상.
- 화면 확인은 폰 375 · 태블릿 768/1180 · PC 1280 네 폭 모두.
- 가격·일본어 이름은 지어내지 않는다. 모르는 값은 «확인필요»에 적는다.
