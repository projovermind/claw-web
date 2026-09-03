// v1.17.28
// ngrok 무료 플랜 abuse interstitial 우회 — 같은 origin 의 top-level
// navigation 요청에 `ngrok-skip-browser-warning` 헤더를 주입한다.
// (ngrok 은 헤더가 있으면 경고 페이지를 건너뜀. 쿼리 파라미터/UA 트릭은 무효.)
// 이 핸들러는 SW 가 활성화된 이후의 모든 새 탭/창 navigation 에서 동작.
// 첫 방문에서는 SW 가 아직 없어 1회는 interstitial 이 보이지만, 이후는 통과.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  if (!req.url.startsWith(self.location.origin)) return;
  event.respondWith((async () => {
    const headers = new Headers(req.headers);
    headers.set('ngrok-skip-browser-warning', '1');
    return fetch(req.url, {
      method: req.method,
      headers,
      credentials: req.credentials,
      cache: req.cache,
      redirect: req.redirect,
      referrer: req.referrer
    });
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Claw Web', body: '' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'Claw Web', body: event.data.text() };
    }
  }
  // actions: [{action, title}] — 권한 승인 푸시가 '승인'/'거부' 버튼을 실어 보낸다.
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'claw-notification',
      actions,
      data: data.url ? { url: data.url } : undefined
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const baseUrl = event.notification.data?.url || '/';
  // 액션 버튼 클릭이면 결정을 쿼리로 전달 — 페이지가 토큰을 갖고 POST 한다.
  const url = event.action
    ? baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'decision=' + encodeURIComponent(event.action)
    : baseUrl;
  event.waitUntil((async () => {
    const target = new URL(url, self.location.origin).href;

    // 안전망: cold-resume 대응 — App.tsx 마운트 시 확인할 pending URL 저장
    const pendingCache = await caches.open('claw-pending-nav');
    await pendingCache.put('/__pending_nav__', new Response(target));

    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      try {
        if (client.url !== target) {
          // 다른 URL에 있는 탭 → navigate (모바일 freeze/cold-resume 대응)
          await client.navigate(target).catch(() => {});
        }
        // URL 일치 or navigate 후 → postMessage + focus
        client.postMessage({ type: 'sw-navigate', url });
        await client.focus();
        return;
      } catch {
        // 이 client 가 응답 못 하면 다음 후보로
      }
    }
    // 열린 탭이 없으면 새 창 오픈 (React Router 가 초기 URL 로 라우팅됨)
    if (clients.openWindow) {
      await clients.openWindow(target);
    }
  })());
});
