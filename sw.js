// 팀 스케줄 앱 - 최소 서비스 워커
// 목적: PWA 설치(홈 화면 추가) 요건 충족 + 오프라인일 때 완전 백지 방지
// API 응답(/api/*)은 캐시하지 않음 (항상 최신 일정 데이터를 보여줘야 하므로)

const CACHE_NAME = 'team-schedule-shell-v1';
const SHELL_FILES = ['/', '/app.html', '/cases.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 요청은 항상 네트워크로 (캐시하지 않음)
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});
