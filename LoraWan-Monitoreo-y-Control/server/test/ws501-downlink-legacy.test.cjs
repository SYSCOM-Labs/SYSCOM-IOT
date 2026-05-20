'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { remapWs501LegacyDownlinkHex } = require('../lib/ws501-downlink-legacy.cjs');

test('remapWs501LegacyDownlinkHex: canónico 0810ff/0811ff y corrige ff2910/ff2911 solo WS501', () => {
  assert.equal(remapWs501LegacyDownlinkHex('0810ff', 'Milesight · WS501'), '0810ff');
  assert.equal(remapWs501LegacyDownlinkHex('0811FF', 'WS501'), '0811ff');
  assert.equal(remapWs501LegacyDownlinkHex('ff2910', 'WS501'), '0810ff');
  assert.equal(remapWs501LegacyDownlinkHex('ff2911', 'WS501'), '0811ff');
  assert.equal(remapWs501LegacyDownlinkHex('ff2910', 'WS558'), 'ff2910');
});
