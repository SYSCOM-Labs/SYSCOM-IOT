/** IDs alineados con `App.jsx` / `Sidebar.jsx` y con el servidor (`navPermissions.js`). */
export const NAV_MODULE_DEFS = [
  { id: 'Dashboard', label: 'Panel de control' },
  { id: 'Devices', label: 'Dispositivos' },
  { id: 'Gateway', label: 'Gateway' },
  { id: 'Automations', label: 'Automatización' },
  { id: 'History', label: 'Reportes' },
  { id: 'SpecialReport', label: 'Reporte especial' },
  { id: 'Users', label: 'Usuarios' },
  { id: 'Templates', label: 'Plantillas' },
  { id: 'Settings', label: 'Ajustes' },
];

export const NAV_PAGE_IDS = NAV_MODULE_DEFS.map((d) => d.id);
