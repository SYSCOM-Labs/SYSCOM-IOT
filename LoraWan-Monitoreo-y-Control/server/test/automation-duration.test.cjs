'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDurationToMs,
  actualValueToDurationMs,
  evaluateTimeCondition,
  isTimeOperator,
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
});
