'use strict';

/**
 * Gateways LoRaWAN: **solo US915 subbanda FSB2** (`US902-928-FSB2`).
 * Corresponde a canales **125 kHz 8–15** y, en paralelo, enlaces **500 kHz 65–70** (DR4) del mismo plan.
 * `US915` / `US902-928` se aceptan solo por compatibilidad en API y se **normalizan** a `US902-928-FSB2` al guardar.
 * Debe coincidir con `src/constants/lorawanGatewayBands.js`.
 */

const CANONICAL_US915_FSB2 = 'US902-928-FSB2';

/** Valores que el API acepta (entrada); persistencia siempre CANONICAL. */
const ACCEPT_GATEWAY_BAND_INPUT = new Set([CANONICAL_US915_FSB2, 'US915', 'US902-928']);

const ALLOWED_LORAWAN_GATEWAY_BANDS = new Set([CANONICAL_US915_FSB2]);

function isAllowedGatewayFrequencyBand(value) {
  return ACCEPT_GATEWAY_BAND_INPUT.has(String(value || '').trim());
}

/** Banda guardada en BD y esperada por el LNS para esta instalación. */
function normalizeGatewayFrequencyBand(value) {
  if (!isAllowedGatewayFrequencyBand(value)) return null;
  return CANONICAL_US915_FSB2;
}

module.exports = {
  ALLOWED_LORAWAN_GATEWAY_BANDS,
  ACCEPT_GATEWAY_BAND_INPUT,
  CANONICAL_US915_FSB2,
  isAllowedGatewayFrequencyBand,
  normalizeGatewayFrequencyBand,
};
