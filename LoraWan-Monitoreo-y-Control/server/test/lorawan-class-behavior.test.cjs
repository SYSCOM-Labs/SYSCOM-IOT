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

test('classARxStillOpen: RX1 de 1 s no admite un click 2 s después del uplink', () => {
  const { classARxStillOpen } = require('../lib/lorawan-class-behavior.cjs');
  assert.equal(classARxStillOpen(50, 1, { slackMs: 300 }), true);
  assert.equal(classARxStillOpen(2000, 1, { slackMs: 300 }), false);
  assert.equal(classARxStillOpen(2000, 5, { slackMs: 300 }), true);
  assert.equal(classARxStillOpen(4800, 5, { slackMs: 300 }), false);
  assert.equal(classARxStillOpen(1500, 1, { windowMode: 'RX2', rx2AfterRx1Sec: 1, slackMs: 300 }), true);
  assert.equal(classARxStillOpen(2500, 1, { windowMode: 'RX2', rx2AfterRx1Sec: 1, slackMs: 300 }), false);
});
