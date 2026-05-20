/**
 * Downlinks WT201 (Milesight). Deben coincidir con `server/lib/wt201-downlink-encode.cjs`.
 */
export const WT201_DOWNLINK_PRESETS = [
  { name: 'Encender (control temperatura)', hex: 'ffc501' },
  { name: 'Apagar (control temperatura)', hex: 'ffc500' },
  { name: 'Consigna 22 °C (auto)', hex: 'ffb70316' },
  { name: 'Consigna 23 °C (auto)', hex: 'ffb70317' },
  { name: 'Consigna 22 °C (frío)', hex: 'ffb70216' },
  { name: 'Consigna 23 °C (frío)', hex: 'ffb70217' },
  { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
  { name: 'Consultar estado', hex: 'ff28ff' },
];
