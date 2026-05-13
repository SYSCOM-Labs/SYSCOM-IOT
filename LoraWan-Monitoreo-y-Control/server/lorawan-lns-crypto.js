'use strict';

const crypto = require('crypto');
const lora_packet = require('lora-packet');

function aes128EncryptBlock(key16, block16) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block16), cipher.final()]);
}

/**
 * LoRaWAN 1.0.x NwkSKey / AppSKey tras Join-Accept.
 * Debe coincidir con el stack del nodo y con `lora-packet` (Join-Accept y MIC de datos).
 * @param {Buffer} appKey 16 B
 * @param {Buffer} appNonce 3 B (Join-Accept)
 * @param {Buffer} netId 3 B
 * @param {Buffer} devNonce 2 B (Join-Request)
 */
function deriveSessionKeys10x(appKey, appNonce, netId, devNonce) {
  const out = lora_packet.generateSessionKeys10(appKey, netId, appNonce, devNonce);
  return {
    nwkSKey: out.NwkSKey,
    appSKey: out.AppSKey,
  };
}

function parseKeyHex32(hex) {
  const s = String(hex || '').replace(/\s/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

function normEui16(buf8) {
  return buf8.toString('hex').toLowerCase();
}

module.exports = { aes128EncryptBlock, deriveSessionKeys10x, parseKeyHex32, normEui16 };
