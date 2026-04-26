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
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 기존 탭이 있으면 → postMessage 로 SPA 에 navigate 요청 + focus.
    //  (client.navigate() 는 풀 리로드이며 await 누락 시 동작 안 함 → SPA 에 위임)
    for (const client of clientList) {
      try {
        client.postMessage({ type: 'sw-navigate', url });
        await client.focus();
        return;
      } catch {
        // 이 client 가 응답 못 하면 다음 후보로
      }
    }
    // 열린 탭이 없으면 새 창 오픈 (이 경우는 React Router 가 초기 URL 로 라우팅됨)
    if (clients.openWindow) {
      await clients.openWindow(url);
    }
  })());
});
