'use strict';

const crypto = require('crypto');

function aes128EncryptBlock(key16, block16) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block16), cipher.final()]);
}

/**
 * LoRaWAN 1.0.x derivación de NwkSKey / AppSKey tras Join-Accept.
 * @param {Buffer} appKey 16 B
 * @param {Buffer} appNonce 3 B (Join-Accept)
 * @param {Buffer} netId 3 B
 * @param {Buffer} devNonce 2 B (Join-Request)
 */
function deriveSessionKeys10x(appKey, appNonce, netId, devNonce) {
  const B0 = Buffer.alloc(16, 0);
  B0[0] = 0x01;
  appNonce.copy(B0, 1, 0, 3);
  netId.copy(B0, 4, 0, 3);
  devNonce.copy(B0, 7, 0, 2);
  const B1 = Buffer.alloc(16, 0);
  B1[0] = 0x02;
  appNonce.copy(B1, 1, 0, 3);
  netId.copy(B1, 4, 0, 3);
  devNonce.copy(B1, 7, 0, 2);
  return {
    nwkSKey: aes128EncryptBlock(appKey, B0),
    appSKey: aes128EncryptBlock(appKey, B1),
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
