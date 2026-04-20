/**
 * Banda de gateway: solo **US915 FSB2** (canales 125 kHz 8–15 + 500 kHz 65–70).
 * Alineado con `server/lns/lorawan-gateway-bands.js`.
 */
export const LORAWAN_GATEWAY_BAND_OPTIONS = [
  {
    value: 'US902-928-FSB2',
    label: 'US915 — FSB2: canales 125 kHz 8–15 y 500 kHz 65–70 (902–928 MHz)',
  },
];

export const LORAWAN_GATEWAY_BAND_VALUES = new Set(LORAWAN_GATEWAY_BAND_OPTIONS.map((o) => o.value));
