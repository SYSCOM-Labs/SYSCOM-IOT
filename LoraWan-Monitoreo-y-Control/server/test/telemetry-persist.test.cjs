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

test('fingerprint: lastAppUplinkMs no abre una fila nueva', () => {
  const a = telemetryIngestFingerprint({ payload_hex: 'AB', fCnt: 4, lastAppUplinkMs: 1, water_cumulative_m3: 3 });
  const b = telemetryIngestFingerprint({ payload_hex: 'AB', fCnt: 4, lastAppUplinkMs: 999, water_cumulative_m3: 3 });
  assert.equal(a, b);
});

test('shouldSkipTelemetryInsert: misma trama de medidor dentro de una hora', () => {
  const store = {
    getLastTelemetryRow() {
      return {
        ts: Date.now() - 10_000,
        properties_json: JSON.stringify({
          payload_hex: '6811AA',
          timewave_protocol: true,
          timewave_meterNo: '00022026004140',
          timewave_frame: 'reading',
          timewave_di: '9097',
          timewave_seq: 1,
          water_cumulative_raw: 100,
          lastAppUplinkMs: 1,
        }),
      };
    },
  };
  const sameHex = shouldSkipTelemetryInsert(store, '1', 'dev1', {
    payload_hex: '6811aa',
    timewave_protocol: true,
    timewave_meterNo: '00022026004140',
    timewave_frame: 'reading',
    timewave_di: '9097',
    timewave_seq: 9,
    water_cumulative_raw: 100,
    lastAppUplinkMs: Date.now(),
  });
  assert.equal(sameHex.skip, true);
  assert.equal(sameHex.reason, 'same_payload');
  assert.equal(sameHex.suppressRealtime, true);

  const sameVolume = shouldSkipTelemetryInsert(store, '1', 'dev1', {
    payload_hex: '6811BB',
    timewave_protocol: true,
    timewave_meterNo: '00022026004140',
    timewave_frame: 'reading',
    timewave_di: '9097',
    timewave_seq: 9,
    water_cumulative_raw: 100,
  });
  assert.equal(sameVolume.skip, true);
  assert.equal(sameVolume.reason, 'same_reading');
});

test('shouldSkipTelemetryInsert: lectura distinta o reporte de la hora siguiente sí se guarda', () => {
  const recent = {
    getLastTelemetryRow() {
      return {
        ts: Date.now() - 10_000,
        properties_json: JSON.stringify({
          payload_hex: 'AA',
          timewave_protocol: true,
          timewave_meterNo: '00022026004140',
          timewave_frame: 'reading',
          timewave_di: '9097',
          water_cumulative_raw: 100,
        }),
      };
    },
  };
  const changed = shouldSkipTelemetryInsert(recent, '1', 'dev1', {
    payload_hex: 'BB',
    timewave_protocol: true,
    timewave_meterNo: '00022026004140',
    timewave_frame: 'reading',
    timewave_di: '9097',
    water_cumulative_raw: 101,
  });
  assert.equal(changed.skip, false);

  const hourLater = {
    getLastTelemetryRow() {
      return {
        ts: Date.now() - 2 * 60 * 60 * 1000,
        properties_json: JSON.stringify({ payload_hex: 'AA', water_cumulative_raw: 100 }),
      };
    },
  };
  const nextReport = shouldSkipTelemetryInsert(hourLater, '1', 'dev1', {
    payload_hex: 'AA',
    water_cumulative_raw: 100,
  });
  assert.equal(nextReport.skip, false);
});
