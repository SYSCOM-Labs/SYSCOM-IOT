'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppUplinkStaleMs, isLastDbIngestStale } = require('../comms-stale-policy');
const { inferFreshOnlineConnectStatus, joinOnlyTelemetryHint } = require('../lib/device-connect-status-infer');

test('resolveAppUplinkStaleMs default alineado a comunicación (40 min)', () => {
  const prevApp = process.env.SYSCOM_APP_UPLINK_STALE_MS;
  const prevComms = process.env.SYSCOM_COMMS_STALE_OFFLINE_MS;
  const prevDev = process.env.SYSCOM_DEVICE_STALE_OFFLINE_MS;
  delete process.env.SYSCOM_APP_UPLINK_STALE_MS;
  delete process.env.SYSCOM_COMMS_APP_UPLINK_STALE_MS;
  delete process.env.SYSCOM_COMMS_STALE_OFFLINE_MS;
  delete process.env.SYSCOM_DEVICE_STALE_OFFLINE_MS;
  assert.equal(resolveAppUplinkStaleMs(), 40 * 60 * 1000);
  if (prevApp != null) process.env.SYSCOM_APP_UPLINK_STALE_MS = prevApp;
  if (prevComms != null) process.env.SYSCOM_COMMS_STALE_OFFLINE_MS = prevComms;
  if (prevDev != null) process.env.SYSCOM_DEVICE_STALE_OFFLINE_MS = prevDev;
});

test('join-only raw + app uplink de 10 min (dentro de 40 min) no está stale', () => {
  const now = Date.now();
  const lastApp = now - 10 * 60 * 1000;
  assert.equal(isLastDbIngestStale(lastApp, now, resolveAppUplinkStaleMs()), false);
  assert.equal(isLastDbIngestStale(now - 60 * 1000, now, resolveAppUplinkStaleMs()), false);
  assert.equal(isLastDbIngestStale(now - 50 * 60 * 1000, now, resolveAppUplinkStaleMs()), true);
});

test('joinOnlyTelemetryHint: join sin payload', () => {
  assert.ok(joinOnlyTelemetryHint({ lorawan_event: 'join_accept_sent' }));
  assert.equal(joinOnlyTelemetryHint({ lorawan_event: 'join_accept_sent', payload_hex: '0167' }), null);
  assert.equal(joinOnlyTelemetryHint({ temperature: 22.5 }), null);
});

test('join-only raw + app uplink reciente → ONLINE', () => {
  const now = Date.now();
  const row = { ingestStatus: 'Solo join LoRaWAN (sin uplink de aplicación reciente).' };
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now,
      properties: { lastAppUplinkMs: now - 30_000, temperature: 22.1 },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'ONLINE');
  assert.equal(row.ingestStatus, undefined);
});

test('join-only raw sin app uplink (Visto reciente) → ONLINE', () => {
  const now = Date.now();
  const row = {};
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now,
      properties: { lorawan_event: 'join_accept_sent' },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'ONLINE');
  assert.equal(row.ingestStatus, undefined);
  assert.equal(row.lastUpdateTime, now);
});

test('join-only raw + app uplink de 10 min → ONLINE', () => {
  const now = Date.now();
  const row = {};
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now,
      properties: { lastAppUplinkMs: now - 10 * 60 * 1000 },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'ONLINE');
});

test('actividad más vieja que la ventana de comunicación no fuerza ONLINE', () => {
  const now = Date.now();
  const row = { connectStatus: 'OFFLINE' };
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now - 50 * 60 * 1000,
      properties: { lorawan_event: 'join_accept_sent' },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'OFFLINE');
});
