'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeTemperatureControl,
  encodeTemperatureControlEnable,
  resolveWt201DownlinkHex,
} = require('../lib/wt201-downlink-encode.cjs');

test('WT201 enable/disable', () => {
  assert.equal(encodeTemperatureControlEnable(1), 'ffc501');
  assert.equal(encodeTemperatureControlEnable(0), 'ffc500');
});

test('WT201 setpoint auto 22/23', () => {
  assert.equal(encodeTemperatureControl(3, 22, 0), 'ffb70316');
  assert.equal(encodeTemperatureControl(3, 23, 0), 'ffb70317');
});

test('WT201 setpoint frío 24 °C', () => {
  assert.equal(encodeTemperatureControl(2, 24, 0), 'ffb70218');
});

test('resolveWt201DownlinkHex aliases', () => {
  assert.equal(resolveWt201DownlinkHex('encender'), 'ffc501');
  assert.equal(resolveWt201DownlinkHex('temp_22'), 'ffb70316');
  assert.equal(resolveWt201DownlinkHex('ffb70317'), 'ffb70317');
});
