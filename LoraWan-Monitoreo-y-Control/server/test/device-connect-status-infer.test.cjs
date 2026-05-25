'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppUplinkStaleMs, isLastDbIngestStale } = require('../comms-stale-policy');

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
