/* Service Worker: notificaciones del sistema aunque la pestaña esté en segundo plano (más fiable que solo `new Notification` desde la página). */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'SYSCOM_SHOW_NOTIFY') return;
  const title = d.title || 'SYSCOM IoT';
  const body = d.body && String(d.body).trim() ? String(d.body).trim() : undefined;
  const icon = d.icon;
  const tag = d.tag || 'syscom-iot';
  const openUrl = d.openUrl || self.registration.scope;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      tag,
      data: { openUrl },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const openUrl =
    (event.notification.data && event.notification.data.openUrl) || self.registration.scope;
  let origin;
  try {
    origin = new URL(openUrl).origin;
  } catch {
    origin = self.registration.scope;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (let i = 0; i < clientList.length; i++) {
        const c = clientList[i];
        if (c.url.startsWith(origin) && 'focus' in c) {
          return c.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(openUrl);
      }
    })
  );
});
