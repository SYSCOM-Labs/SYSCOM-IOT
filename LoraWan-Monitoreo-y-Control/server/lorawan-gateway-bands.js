'use strict';

const path = require('path');

/** Única fuente de valores (y etiquetas UI): `shared/lorawan-gateway-bands.json`. El front importa el mismo JSON. */
const { bands } = require(path.join(__dirname, '..', 'shared', 'lorawan-gateway-bands.json'));

const ALLOWED_LORAWAN_GATEWAY_BANDS = new Set(
  bands.map((b) => String(b && b.value != null ? b.value : '').trim()).filter(Boolean)
);

function isAllowedGatewayFrequencyBand(value) {
  const v = String(value || '').trim();
  return ALLOWED_LORAWAN_GATEWAY_BANDS.has(v);
}

module.exports = { ALLOWED_LORAWAN_GATEWAY_BANDS, isAllowedGatewayFrequencyBand };
