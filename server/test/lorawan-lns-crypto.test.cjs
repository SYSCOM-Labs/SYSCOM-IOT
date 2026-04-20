'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lora_packet = require('lora-packet');
const { deriveSessionKeys10x } = require('../lns/lorawan-lns-crypto');

test('deriveSessionKeys10x coincide con lora-packet.generateSessionKeys10', () => {
  const appKey = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const appNonce = Buffer.from('a1b2c3', 'hex');
  const netId = Buffer.from('010203', 'hex');
  const devNonce = Buffer.from('abcd', 'hex');

  const fromLib = lora_packet.generateSessionKeys10(appKey, netId, appNonce, devNonce);
  const ours = deriveSessionKeys10x(appKey, appNonce, netId, devNonce);

  assert.equal(Buffer.compare(ours.nwkSKey, fromLib.NwkSKey), 0, 'NwkSKey');
  assert.equal(Buffer.compare(ours.appSKey, fromLib.AppSKey), 0, 'AppSKey');
});
