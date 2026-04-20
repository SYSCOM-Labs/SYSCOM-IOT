'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { milesightWs101Decode } = require('../decoders/milesight-ws101');

test('WS101: batería + long press (0xff 0x2e)', () => {
  const buf = Buffer.from('017564ff2e02', 'hex');
  const d = milesightWs101Decode(buf);
  assert.equal(d.battery, 100);
  assert.equal(d.button_event.status, 'long press');
  assert.equal(d.button_event_status, 'long press');
  assert.equal(d.press, 'long press');
});

test('WS101: short press vía 0x01 0x2e (compat)', () => {
  const d = milesightWs101Decode(Buffer.from('012e01', 'hex'));
  assert.equal(d.button_event.status, 'short press');
});

test('WS101: double press', () => {
  const d = milesightWs101Decode(Buffer.from('ff2e03', 'hex'));
  assert.equal(d.button_event.status, 'double press');
});

test('WS101: TLV desconocido no desalinea el siguiente bloque (se detiene)', () => {
  const d = milesightWs101Decode(Buffer.from('ffff0099aaff2e02', 'hex'));
  assert.equal(d.button_event && d.button_event.status, undefined);
});
