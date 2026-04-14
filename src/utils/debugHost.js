/** True si la app se sirve desde host local (solo aquí se muestra el modo depuración en UI). */
export function isLocalDebugHost() {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}
