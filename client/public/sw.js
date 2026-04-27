// v1.11.1
self.addEventListener('push', (event) => {
  let data = { title: 'Claw Web', body: '' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'Claw Web', body: event.data.text() };
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'claw-notification',
      data: data.url ? { url: data.url } : undefined
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
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
