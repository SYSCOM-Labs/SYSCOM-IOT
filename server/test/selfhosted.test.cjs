'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, defaultKeyFromReq } = require('../middleware/rate-limit-memory');
const { createRealtimeHub } = require('../realtime/realtime-hub');
const metrics = require('../monitoring/syscom-metrics');

test('rate limit: allows under max', async () => {
  const lim = createRateLimiter({ windowMs: 60000, max: 5 });
  let n = 0;
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  const resStub = { setHeader: () => {} };
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => {
      lim(req, resStub, () => resolve());
    });
    n += 1;
  }
  assert.equal(n, 5);
});

test('rate limit: rejects over max', async () => {
  const lim = createRateLimiter({ windowMs: 60000, max: 2 });
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.2' } };
  const run = () =>
    new Promise((resolve, reject) => {
      lim(
        req,
        {
          status: (code) => ({
            json: (b) => resolve({ code, b }),
          }),
          setHeader: () => {},
        },
        (err) => {
          if (err) reject(err);
          else resolve({ ok: true });
        }
      );
    });
  assert.equal((await run()).ok, true);
  assert.equal((await run()).ok, true);
  const r3 = await run();
  assert.equal(r3.code, 429);
});

test('realtime hub: broadcast increments metrics when listeners', () => {
  const hub = createRealtimeHub();
  const chunks = [];
  const listeners = {};
  const res = {
    write: (s) => chunks.push(s),
    on: (ev, fn) => {
      if (!listeners[ev]) listeners[ev] = [];
      listeners[ev].push(fn);
    },
  };
  hub.subscribe('user-1', res);
  const before = metrics.snapshot().counters.sse_broadcast_telemetry;
  hub.broadcast('user-1', 'telemetry', { deviceId: 'd1', timestamp: 1 });
  const after = metrics.snapshot().counters.sse_broadcast_telemetry;
  assert.equal(after, before + 1);
  assert.ok(chunks.some((c) => c.includes('event: telemetry')));
  for (const ev of ['close', 'finish']) {
    for (const fn of listeners[ev] || []) fn();
  }
});

test('defaultKeyFromReq uses x-forwarded-for', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(defaultKeyFromReq(req), '203.0.113.5');
});
