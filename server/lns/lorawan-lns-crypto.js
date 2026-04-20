'use strict';

const lora_packet = require('lora-packet');

/**
 * LoRaWAN 1.0.x derivación de NwkSKey / AppSKey tras Join-Accept.
 * Debe coincidir con la fórmula de `lora-packet` (MIC / cifrado Join-Accept).
 *
 * @param {Buffer} appKey 16 B
 * @param {Buffer} appNonce 3 B (Join-Accept)
 * @param {Buffer} netId 3 B
 * @param {Buffer} devNonce 2 B (Join-Request)
 */
function deriveSessionKeys10x(appKey, appNonce, netId, devNonce) {
  const { NwkSKey, AppSKey } = lora_packet.generateSessionKeys10(appKey, netId, appNonce, devNonce);
  return { nwkSKey: NwkSKey, appSKey: AppSKey };
}

function parseKeyHex32(hex) {
  const s = String(hex || '').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

function normEui16(buf8) {
  return buf8.toString('hex').toLowerCase();
}

module.exports = { deriveSessionKeys10x, parseKeyHex32, normEui16 };
