/**
 * Plantillas prearmadas: añaden un conjunto de widgets para un dispositivo concreto.
 * Claves de ejemplo frecuentes en sensores LoRa/IoT; el usuario puede editar el widget después.
 */
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const withDevice = (device, w) => ({
  ...w,
  id: w.id || uid(),
  deviceId: device.deviceId,
  deviceName: device.name || device.sn || String(device.deviceId),
});

export const DASHBOARD_TEMPLATE_META = [
  { id: 'tracker', label: 'Tracker / GPS', description: 'Mapa, estado, batería y eventos' },
  { id: 'ambiente', label: 'Ambiente', description: 'KPI, tendencia, humedad y actividad' },
  { id: 'energia', label: 'Energía', description: 'KPI, histórico, gauge y línea de tiempo' },
];

export function buildDashboardTemplate(templateId, device) {
  if (!device?.deviceId) return [];

  switch (templateId) {
    case 'tracker':
      return [
        withDevice(device, {
          type: 'map',
          name: 'Posición',
          propertyKey: 'latitude',
          unit: '',
          colSpan: 2,
          rowSpan: 2,
        }),
        withDevice(device, {
          type: 'status',
          name: 'Conectividad',
          propertyKey: 'connectStatus',
          unit: '',
        }),
        withDevice(device, {
          type: 'kpi',
          name: 'Batería / nivel',
          propertyKey: 'electricity',
          unit: '%',
        }),
        withDevice(device, {
          type: 'events',
          name: 'Últimos eventos',
          propertyKey: 'electricity',
          unit: '',
          colSpan: 2,
          rowSpan: 2,
        }),
      ];
    case 'ambiente':
      return [
        withDevice(device, {
          type: 'kpi',
          name: 'Temperatura',
          propertyKey: 'temperature',
          unit: '°C',
        }),
        withDevice(device, {
          type: 'area',
          name: 'Tendencia temperatura',
          propertyKey: 'temperature',
          unit: '°C',
          colSpan: 2,
          rowSpan: 1,
        }),
        withDevice(device, {
          type: 'gauge',
          name: 'Humedad',
          propertyKey: 'humidity',
          unit: '%',
        }),
        withDevice(device, {
          type: 'events',
          name: 'Actividad reciente',
          propertyKey: 'temperature',
          unit: '',
          colSpan: 2,
          rowSpan: 1,
        }),
      ];
    case 'energia':
      return [
        withDevice(device, {
          type: 'kpi',
          name: 'Nivel / consumo',
          propertyKey: 'electricity',
          unit: '',
        }),
        withDevice(device, {
          type: 'area',
          name: 'Histórico',
          propertyKey: 'electricity',
          unit: '',
          colSpan: 2,
          rowSpan: 2,
        }),
        withDevice(device, {
          type: 'gauge',
          name: 'Gauge',
          propertyKey: 'electricity',
          unit: '',
        }),
        withDevice(device, {
          type: 'timeline',
          name: 'Estado / alarmas',
          propertyKey: 'connectStatus',
          unit: '',
          colSpan: 2,
          rowSpan: 1,
        }),
      ];
    default:
      return [];
  }
}
