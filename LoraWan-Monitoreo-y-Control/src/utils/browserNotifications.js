/**
 * Notificaciones nativas del navegador cuando la pestaña de SYSCOM IoT está en segundo plano.
 * Usa un Service Worker (`/syscom-toast-sw.js`) para que el aviso llegue aunque Chrome limite
 * pestañas inactivas; requiere HTTPS o localhost y permiso concedido.
 */

const SW_SCRIPT = '/syscom-toast-sw.js';

export function registerSyscomNotifyServiceWorker() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  return navigator.serviceWorker
    .register(SW_SCRIPT, { scope: '/' })
    .then((reg) => reg)
    .catch((e) => {
      console.warn('[Syscom] No se pudo registrar el SW de notificaciones:', e && e.message);
      return null;
    });
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

export function getBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notificationIconUrl() {
  if (typeof window === 'undefined') return undefined;
  try {
    return new URL('/syscom-iot-logo.png', window.location.origin).href;
  } catch {
    return undefined;
  }
}

function fallbackPageNotification({ title, body, icon, tag }) {
  try {
    const n = new Notification(title, {
      body: body || undefined,
      icon,
      tag,
      requireInteraction: false,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      n.close();
    };
  } catch {
    /* ignore */
  }
}

/**
 * Muestra notificación del SO si hay permiso y la pestaña no está visible.
 * Prioriza `registration.showNotification` vía Service Worker.
 */
export async function tryShowAutomationBrowserNotification({ title, body, tag }) {
  if (!browserNotificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden) return;

  const t = String(title || 'SYSCOM IoT').trim() || 'SYSCOM IoT';
  const b = String(body || '').trim();
  const icon = notificationIconUrl();
  const effectiveTag = tag || `syscom-iot-${Date.now()}`;
  const openUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname || '/'}${window.location.search || ''}`
      : '/';

  const payload = {
    type: 'SYSCOM_SHOW_NOTIFY',
    title: t,
    body: b,
    icon,
    tag: effectiveTag,
    openUrl,
  };

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.active) {
        reg.active.postMessage(payload);
        return;
      }
    } catch {
      /* fall through */
    }
  }

  fallbackPageNotification({ title: t, body: b, icon, tag: effectiveTag });
}
