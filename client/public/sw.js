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
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
