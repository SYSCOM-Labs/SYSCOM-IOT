'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downlinkDeferUntilUplink, downlinkUsesClassCImme } = require('../lib/lorawan-class-behavior.cjs');

test('clase C: downlink inmediato sin esperar uplink', () => {
  assert.equal(downlinkDeferUntilUplink('C'), false);
  assert.equal(downlinkUsesClassCImme('C'), true);
});

test('clase A: esperar ventana / cola tras uplink', () => {
  assert.equal(downlinkDeferUntilUplink('A'), true);
  assert.equal(downlinkUsesClassCImme('A'), false);
});
