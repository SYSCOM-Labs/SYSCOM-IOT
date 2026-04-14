/**
 * Rutas amigables (español, kebab-case). Usar con react-router y enlaces compartibles.
 */
export const ROUTES = {
  panel: '/panel',
  dispositivos: '/dispositivos',
  dispositivo: (deviceId) => `/dispositivos/${encodeURIComponent(String(deviceId))}`,
  historial: '/historial',
  historialDispositivo: (deviceId) => `/historial/dispositivo/${encodeURIComponent(String(deviceId))}`,
  reporteEspecial: '/reporte-especial',
  automatizacion: '/automatizacion',
  ajustes: '/ajustes',
  gateway: '/gateway',
  usuarios: '/usuarios',
  usuarioNuevo: '/usuarios/nuevo',
  usuarioEditar: (userId) => `/usuarios/${encodeURIComponent(String(userId))}/editar`,
  usuarioClave: (userId) => `/usuarios/${encodeURIComponent(String(userId))}/clave`,
  plantillas: '/plantillas',
  plantillaNueva: '/plantillas/nueva',
  plantillaEditar: (templateId) => `/plantillas/${encodeURIComponent(String(templateId))}/editar`,
};

const PATH_BY_NAV_ID = {
  Dashboard: '/panel',
  Devices: '/dispositivos',
  History: '/historial',
  Gateway: '/gateway',
  Automations: '/automatizacion',
  SpecialReport: '/reporte-especial',
  Settings: '/ajustes',
  Templates: '/plantillas',
  Users: '/usuarios',
};

export function getPathForNavId(navId) {
  return PATH_BY_NAV_ID[navId] || '/panel';
}

/** Resalta el ítem del menú según la URL actual. */
export function isMainNavActive(itemId, pathname) {
  const p = pathname || '';
  switch (itemId) {
    case 'Dashboard':
      return p === '/' || p.startsWith('/panel');
    case 'Devices':
      return p.startsWith('/dispositivos');
    case 'History':
      return p.startsWith('/historial');
    case 'Gateway':
      return p.startsWith('/gateway');
    case 'Automations':
      return p.startsWith('/automatizacion');
    case 'SpecialReport':
      return p.startsWith('/reporte-especial');
    case 'Settings':
      return p.startsWith('/ajustes');
    case 'Templates':
      return p.startsWith('/plantillas');
    case 'Users':
      return p.startsWith('/usuarios');
    default:
      return false;
  }
}
