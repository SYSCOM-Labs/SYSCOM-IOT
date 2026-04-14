/** Valores permitidos (alineados con `server/lorawan-gateway-bands.js`). */
export const LORAWAN_GATEWAY_BAND_OPTIONS = [
  { value: 'EU868-RX2-SF9', label: 'Europa 863-870 MHz (SF9 para RX2)' },
  { value: 'US902-928-FSB2', label: 'Estados Unidos 902-928 MHz, FSB 2' },
  { value: 'AU915-928-FSB2', label: 'Australia 915-928 MHz, FSB 2' },
  { value: 'AU915-928-FSB2-LATAM', label: 'Australia 915-928 MHz, FSB 2 (Latinoamérica)' },
  { value: 'AS923', label: 'Asia 920-923 MHz' },
  { value: 'AS923-LBT', label: 'Asia 920-923 MHz con LBT' },
];

export const LORAWAN_GATEWAY_BAND_VALUES = new Set(LORAWAN_GATEWAY_BAND_OPTIONS.map((o) => o.value));
