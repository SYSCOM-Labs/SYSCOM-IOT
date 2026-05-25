'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveAutomationConditions,
  resolveAutomationRuleMode,
} = require('../lib/automation-rule-mode.cjs');

describe('automation-rule-mode', () => {
  it('respeta ruleMode explícito', () => {
    assert.equal(resolveAutomationRuleMode({ ruleMode: 'schedule', conditions: [{ deviceId: '1', propKey: 'x' }] }), 'schedule');
    assert.equal(resolveAutomationRuleMode({ ruleMode: 'conditions' }), 'conditions');
  });

  it('infiere modo por condiciones si no hay ruleMode', () => {
    assert.equal(resolveAutomationRuleMode({ conditions: [] }), 'schedule');
    assert.equal(
      resolveAutomationRuleMode({
        conditions: [{ deviceId: 'dev', propKey: 'press', value: 'short' }],
      }),
      'conditions'
    );
  });

  it('effectiveAutomationConditions ignora filas vacías', () => {
    assert.equal(
      effectiveAutomationConditions([{ deviceId: '', propKey: '' }, { deviceId: 'a', propKey: 'b' }]).length,
      1
    );
  });
});
