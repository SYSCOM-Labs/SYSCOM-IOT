'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  preparePropertiesForPersistence,
  telemetryIngestFingerprint,
  shouldSkipTelemetryInsert,
  isJoinOnlyProperties,
} = require('../lib/telemetry-persist');

test('preparePropertiesForPersistence: quita campos de sesión LNS', () => {
  const p = preparePropertiesForPersistence({
    temperature: 22,
    fcntUp: 9,
    pendingMacAck: true,
    join_cflist_hex: '00FF',
  });
  assert.equal(p.temperature, 22);
  assert.equal(p.fcntUp, undefined);
  assert.equal(p.join_cflist_hex, undefined);
});

test('fingerprint: ignora RSSI distinto con mismo payload', () => {
  const a = telemetryIngestFingerprint({ fCnt: 1, payload_hex: 'AB', rssi: -90 });
  const b = telemetryIngestFingerprint({ fCnt: 1, payload_hex: 'AB', rssi: -40 });
  assert.equal(a, b);
});

test('shouldSkipTelemetryInsert: join duplicado', () => {
  const store = {
    getLastTelemetryRow() {
      return {
        ts: Date.now() - 5000,
        properties_json: JSON.stringify({ lorawan_event: 'join_accept_sent', devEUI: 'abc' }),
      };
    },
  };
  const r = shouldSkipTelemetryInsert(store, '1', 'dev1', {
    lorawan_event: 'join_accept_sent',
    devEUI: 'abc',
    gateway_id: 'gw2',
  });
  assert.equal(r.skip, true);
  assert.equal(r.reason, 'join_duplicate');
  assert.equal(r.refreshLastSeen, true);
});

test('isJoinOnlyProperties', () => {
  assert.equal(isJoinOnlyProperties({ lorawan_event: 'join_accept_sent' }), true);
  assert.equal(isJoinOnlyProperties({ lorawan_event: 'join_accept_sent', payload_hex: '01' }), false);
});
