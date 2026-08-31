'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDurationToMs,
  actualValueToDurationMs,
  evaluateTimeCondition,
  isTimeOperator,
  parseHoldDurationMs,
  applyConditionHold,
} = require('../lib/automation-duration.cjs');
const { __test: { evaluateCondition } } = require('../automation-runner');

describe('automation duration conditions', () => {
  it('parsea 60s, 5m y 0.30 como 30 segundos', () => {
    assert.equal(parseDurationToMs('60s', { userInput: true }), 60000);
    assert.equal(parseDurationToMs('5m', { userInput: true }), 300000);
    assert.equal(parseDurationToMs('0.30', { userInput: true }), 30000);
    assert.equal(parseDurationToMs('1.15', { userInput: true }), 75000);
    assert.equal(parseDurationToMs('0:30', { userInput: true }), 30000);
    assert.equal(parseDurationToMs('90', { userInput: true }), 90000);
  });

  it('trata la lectura del dispositivo como segundos', () => {
    assert.equal(actualValueToDurationMs(90), 90000);
    assert.equal(actualValueToDurationMs('45s'), 45000);
  });

  it('tiempo mayor a / menor a compara duraciones', () => {
    assert.equal(evaluateTimeCondition(90, 'time_gt', '60s'), true);
    assert.equal(evaluateTimeCondition(20, 'time_gt', '0.30'), false);
    assert.equal(evaluateTimeCondition(20, 'time_lt', '0.30'), true);
    assert.equal(evaluateTimeCondition(45, 'time_lt', '1m'), true);
    assert.equal(isTimeOperator('time_gt'), true);
    assert.equal(evaluateCondition(90, 'time_gt', '60s'), true);
    assert.equal(evaluateCondition(10, 'time_lt', '0.30'), true);
    assert.equal(evaluateCondition(10, '>', '5'), true);
  });

  it('parseHoldDurationMs vacío es 0 y 60s son 60 segundos', () => {
    assert.equal(parseHoldDurationMs(''), 0);
    assert.equal(parseHoldDurationMs('   '), 0);
    assert.equal(parseHoldDurationMs('60'), 60000);
    assert.equal(parseHoldDurationMs('60s'), 60000);
    assert.equal(parseHoldDurationMs('0.30'), 30000);
  });

  it('applyConditionHold espera la permanencia y reinicia si deja de cumplirse', () => {
    const store = {};
    const t0 = 1_000_000;
    assert.equal(applyConditionHold(store, 'k', true, 0, t0).met, true);
    assert.equal(applyConditionHold(store, 'k', true, 60000, t0).met, false);
    assert.equal(applyConditionHold(store, 'k', true, 60000, t0 + 59999).met, false);
    assert.equal(applyConditionHold(store, 'k', true, 60000, t0 + 60000).met, true);
    assert.equal(applyConditionHold(store, 'k', false, 60000, t0 + 70000).met, false);
    const again = applyConditionHold(store, 'k', true, 60000, t0 + 70001);
    assert.equal(again.met, false);
    assert.equal(again.remainingMs, 60000);
  });
});
