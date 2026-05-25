'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  __test: {
    clockToMinutes,
    isTimeInRange,
    getConditionDeviceValue,
    expandNestedGatewayTelemetry,
    buildRuleConditionEventSignature,
    evaluateCondition,
  },
} = require('../automation-runner');

describe('automation-runner schedule + button conditions', () => {
  it('23:59–00:00 solo cubre el cruce de medianoche (2 minutos con resolución HH:mm)', () => {
    assert.equal(isTimeInRange('23:59', '23:59', '00:00'), true);
    assert.equal(isTimeInRange('00:00', '23:59', '00:00'), true);
    assert.equal(isTimeInRange('14:30', '23:59', '00:00'), false);
    assert.equal(isTimeInRange('00:01', '23:59', '00:00'), false);
  });

  it('00:00–23:59 cubre todo el día', () => {
    assert.equal(isTimeInRange('08:15', '00:00', '23:59'), true);
    assert.equal(isTimeInRange('23:59', '00:00', '23:59'), true);
    assert.equal(clockToMinutes('23:59') <= clockToMinutes('23:59'), true);
  });

  it('normaliza press short frente a button_event_status "short press"', () => {
    const props = expandNestedGatewayTelemetry({
      button_event: { status: 'short press', msgid: 381499 },
      press: 'short',
    });
    assert.equal(getConditionDeviceValue(props, 'press'), 'short');
    assert.equal(evaluateCondition(getConditionDeviceValue(props, 'press'), '==', 'short'), true);
  });

  it('cada uplink del botón genera firma distinta (msgid / last_update)', () => {
    const conds = [{ deviceId: 'dev1', propKey: 'press' }];
    const sig1 = buildRuleConditionEventSignature(
      {
        dev1: expandNestedGatewayTelemetry({
          press: 'short',
          button_event: { status: 'short press', msgid: 1 },
          last_update: 1000,
        }),
      },
      conds
    );
    const sig2 = buildRuleConditionEventSignature(
      {
        dev1: expandNestedGatewayTelemetry({
          press: 'short',
          button_event: { status: 'short press', msgid: 2 },
          last_update: 2000,
        }),
      },
      conds
    );
    assert.notEqual(sig1, sig2);
  });
});
