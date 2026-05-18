'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyVs133TelemetryAliases } = require('../lib/vs133-telemetry-aliases');

test('VS133 aliases: people_count from line_1_total_in', () => {
  const p = { line_1_total_in: 42, line_1_total_out: 10, line_1_period_in: 3 };
  assert.equal(applyVs133TelemetryAliases(p, { productModel: 'VS133' }), true);
  assert.equal(p.people_count, 42);
  assert.equal(p.people_in_period, 3);
  assert.equal(p.people_inside, 32);
});

test('VS133 aliases: promote from history when root missing', () => {
  const p = { history: [{ timestamp: 1, line_1_total_in: 99 }] };
  applyVs133TelemetryAliases(p, { productModel: 'Milesight · VS133' });
  assert.equal(p.line_1_total_in, 99);
  assert.equal(p.people_count, 99);
});

test('VS133 aliases: skip non-VS133 payloads', () => {
  const p = { temperature: 22.5 };
  assert.equal(applyVs133TelemetryAliases(p, { productModel: 'WS101' }), false);
  assert.equal(p.people_count, undefined);
});
