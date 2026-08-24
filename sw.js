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

// 웹 푸시 알림: 서버(sendPushToAll)가 { title, body, url } 형태의 JSON을 담아 보내면,
// 이 리스너가 실제로 기기에 알림을 띄운다. 클릭하면 url로 이동(이미 열려있는 탭이 있으면 그 탭을
// 그 화면으로 옮기고, 없으면 새 탭을 연다) - 알림만 오고 눌러도 아무 일이 없으면 쓸모가 없어서다.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: '팀 스케줄', body: event.data ? event.data.text() : '' }; }
  const title = data.title || '팀 스케줄';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin && 'focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        } catch (e) { /* ignore */ }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
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
