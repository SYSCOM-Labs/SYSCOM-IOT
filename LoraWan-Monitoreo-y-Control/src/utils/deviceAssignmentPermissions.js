/** Permisos por dispositivo al asignar un equipo a un usuario. */
export const DEVICE_ASSIGNMENT_PERM_KEYS = [
  { key: 'edit', labelKey: 'devices.perm_edit' },
  { key: 'delete', labelKey: 'devices.perm_delete' },
  { key: 'downlink', labelKey: 'devices.perm_downlink' },
  { key: 'assign', labelKey: 'devices.perm_assign' },
];

export function emptyDeviceAssignmentPermissions() {
  return { edit: false, delete: false, downlink: false, assign: false };
}

export function allDeviceAssignmentPermissions() {
  return { edit: true, delete: true, downlink: true, assign: true };
}

export function sanitizeDeviceAssignmentPermissions(input) {
  const empty = emptyDeviceAssignmentPermissions();
  if (!input || typeof input !== 'object') return empty;
  return {
    edit: Boolean(input.edit),
    delete: Boolean(input.delete),
    downlink: Boolean(input.downlink),
    assign: Boolean(input.assign),
  };
}

/**
 * Acciones visibles en el listado. Superadmin siempre todo.
 * Si el API aún no envía `assignmentPermissions`, se usa el nav histórico.
 */
export function deviceActionPermissions(
  device,
  { isSuperAdmin = false, hasDevicesNav = false, canAssignNav = false } = {}
) {
  if (isSuperAdmin) return allDeviceAssignmentPermissions();
  if (device && device.assignmentPermissions && typeof device.assignmentPermissions === 'object') {
    return sanitizeDeviceAssignmentPermissions(device.assignmentPermissions);
  }
  return {
    edit: Boolean(hasDevicesNav),
    delete: false,
    downlink: Boolean(hasDevicesNav),
    assign: Boolean(canAssignNav),
  };
}
