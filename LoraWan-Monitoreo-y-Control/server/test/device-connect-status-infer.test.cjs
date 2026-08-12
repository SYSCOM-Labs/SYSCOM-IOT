'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppUplinkStaleMs, isLastDbIngestStale } = require('../comms-stale-policy');
const { inferFreshOnlineConnectStatus, joinOnlyTelemetryHint } = require('../lib/device-connect-status-infer');

test('resolveAppUplinkStaleMs default 3 min', () => {
  const prev = process.env.SYSCOM_APP_UPLINK_STALE_MS;
  delete process.env.SYSCOM_APP_UPLINK_STALE_MS;
  delete process.env.SYSCOM_COMMS_APP_UPLINK_STALE_MS;
  assert.equal(resolveAppUplinkStaleMs(), 180000);
  if (prev != null) process.env.SYSCOM_APP_UPLINK_STALE_MS = prev;
});

test('join-only raw + stale app uplink → offline window', () => {
  const now = Date.now();
  const lastApp = now - 10 * 60 * 1000;
  assert.equal(isLastDbIngestStale(lastApp, now, resolveAppUplinkStaleMs()), true);
  assert.equal(isLastDbIngestStale(now - 60 * 1000, now, resolveAppUplinkStaleMs()), false);
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
    { nowMs: now, commsStaleMs: 40 * 60 * 1000, appStaleMs: 3 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'ONLINE');
  assert.equal(row.ingestStatus, undefined);
});

test('join-only raw sin app uplink → JOIN_PENDING', () => {
  const now = Date.now();
  const row = {};
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now,
      properties: { lorawan_event: 'join_accept_sent' },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000, appStaleMs: 3 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'JOIN_PENDING');
});

test('join-only raw + app uplink viejo → OFFLINE', () => {
  const now = Date.now();
  const row = {};
  inferFreshOnlineConnectStatus(
    row,
    {
      timestamp: now,
      properties: { lastAppUplinkMs: now - 10 * 60 * 1000 },
    },
    { properties: { lorawan_event: 'join_accept_sent' } },
    { nowMs: now, commsStaleMs: 40 * 60 * 1000, appStaleMs: 3 * 60 * 1000 }
  );
  assert.equal(row.connectStatus, 'OFFLINE');
});
