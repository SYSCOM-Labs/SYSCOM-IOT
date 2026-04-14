'use strict';

/** Debe coincidir con los valores del selector en `src/pages/GatewaysPage.jsx`. */
const ALLOWED_LORAWAN_GATEWAY_BANDS = new Set([
  'EU868-RX2-SF9',
  'US902-928-FSB2',
  'AU915-928-FSB2',
  'AU915-928-FSB2-LATAM',
  'AS923',
  'AS923-LBT',
]);

function isAllowedGatewayFrequencyBand(value) {
  const v = String(value || '').trim();
  return ALLOWED_LORAWAN_GATEWAY_BANDS.has(v);
}

module.exports = { ALLOWED_LORAWAN_GATEWAY_BANDS, isAllowedGatewayFrequencyBand };
