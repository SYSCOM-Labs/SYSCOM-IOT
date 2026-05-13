import contract from '../../shared/lorawan-gateway-bands.json';

/** Mismo archivo que valida el servidor (`shared/lorawan-gateway-bands.json`). */
export const LORAWAN_GATEWAY_BAND_OPTIONS = contract.bands;
export const LORAWAN_GATEWAY_BAND_VALUES = new Set(contract.bands.map((b) => b.value));
