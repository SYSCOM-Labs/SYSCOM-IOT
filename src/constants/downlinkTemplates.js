// Suggested commands by model.
// "hex" can be either a raw hex payload or a serviceId string (e.g. "reboot"),
// since sendDownlink now supports fallback to service calls.
export const MODEL_DOWNLINK_TEMPLATES = {
  WS101: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Consultar estado', hex: 'query_device_status' },
  ],
  WS303: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Detener alarma', hex: 'stop_alarming' },
    { name: 'Consultar estado', hex: 'query_device_status' },
  ],
  AM307: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Detener buzzer', hex: 'stop_buzzer' },
    { name: 'Consultar estado LED/Buzzer', hex: 'led_buzzer_status' },
  ],
  UC512_DI: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Consultar estado', hex: 'query_device_status' },
    { name: 'Sincronizar hora', hex: 'time_synchronize' },
  ],
  EM500_CO2: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Consultar estado', hex: 'query_device_status' },
    { name: 'Sincronizar hora', hex: 'time_synchronize' },
  ],
  TS302: [
    { name: 'Reiniciar dispositivo', hex: 'reboot' },
    { name: 'Consultar estado', hex: 'query_device_status' },
    { name: 'Sincronizar hora', hex: 'time_synchronize' },
  ],
};

const normalizeModelKey = (model = '') => String(model).toUpperCase().replace(/[^A-Z0-9]/g, '_');

export const getTemplateCommandsForModel = (model) => {
  const key = normalizeModelKey(model);
  return MODEL_DOWNLINK_TEMPLATES[key] || [];
};

