// 오프라인용: 앱 파일을 캐시에 두고, 인터넷이 없으면 캐시에서 연다.
// 상품·사진은 IndexedDB에 있어서 여기서 따로 캐시하지 않는다.
const VERSION = 'v7';
const CACHE = 'wish-list-' + VERSION;
const FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/db.js', 'js/photo.js', 'js/sync.js',
  'data/products.json', 'images/mascot-320.png', 'images/mascot-dizzy-320.png', 'fonts/Jua-Regular.ttf',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => (k.startsWith('wish-list-') || k.startsWith('japan-shopping-')) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // 시트 동기화 요청은 건드리지 않는다
  // 네트워크 먼저(새 버전 반영, 브라우저 캐시 건너뜀). 신호가 약해 3초 안에 안 오면 캐시
  const fromCache = () => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('index.html'));
  const net = fetch(e.request, { cache: 'no-cache' }).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  });
  const timeout = new Promise((res) => setTimeout(res, 3000)).then(fromCache).then((m) => m || net);
  e.respondWith(Promise.race([net.catch(fromCache), timeout]));
});
