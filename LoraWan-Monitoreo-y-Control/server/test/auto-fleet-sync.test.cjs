'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchTemplateForDevice, normalizeDownlinks } = require('../lib/auto-fleet-sync.cjs');

test('matchTemplateForDevice por product_model WS501', () => {
  const store = {
    getDeviceTemplatesCatalog: () => ({ templates: [], defaultTemplateId: null }),
    getDeviceSharedPresetsParsed: () => null,
    getDeviceDecodeConfig: () => ({ productModel: 'Milesight · WS501' }),
  };
  const t = matchTemplateForDevice(store, '24e124777e282770', {
    productModel: 'Milesight · WS501',
  });
  assert.equal(t.modelo, 'WS501');
  assert.ok(normalizeDownlinks(t.downlinks).some((d) => d.hex === '0810ff'));
});
