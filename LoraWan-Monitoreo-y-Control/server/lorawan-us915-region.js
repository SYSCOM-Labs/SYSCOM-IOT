'use strict';

/**
 * Despliegue solo US915 (defecto): el motor LNS, simulación y sesiones ABP asumen plan US
 * aunque en BD quede una banda antigua no-US.
 * Laboratorio multi-región: SYSCOM_LNS_US915_ONLY=0
 */
function lorawanUs915Only() {
  const raw = process.env.SYSCOM_LNS_US915_ONLY;
  if (raw == null || String(raw).trim() === '') return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'off');
}

function isUs915FrequencyBandString(bandU) {
  const b = String(bandU || '').toUpperCase();
  return b.startsWith('US902') || b.includes('US915') || b.includes('915');
}

/** US915 si el despliegue lo fuerza, o si la cadena de banda del gateway lo indica. */
function isUs915ForUserGateway(bandU) {
  if (lorawanUs915Only()) return true;
  return isUs915FrequencyBandString(bandU);
}

module.exports = { lorawanUs915Only, isUs915FrequencyBandString, isUs915ForUserGateway };
