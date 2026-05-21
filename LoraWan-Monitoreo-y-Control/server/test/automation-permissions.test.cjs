'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canRunAutomationsForUser,
  canUseGlobalNotificationEmailForUser,
  automationPermitsForUser,
  isAutomationActionPermitted,
} = require('../lib/automation-permissions.cjs');

describe('automation-permissions', () => {
  it('subcuenta sin Automations puede usar email global', () => {
    const sub = {
      role: 'user',
      navPermissionsJson: JSON.stringify({
        Dashboard: true,
        Devices: true,
        History: true,
        SpecialReport: true,
        Automations: false,
      }),
    };
    assert.equal(canRunAutomationsForUser(sub), false);
    assert.equal(canUseGlobalNotificationEmailForUser(sub), true);
    const perm = automationPermitsForUser(sub);
    assert.equal(
      isAutomationActionPermitted({ type: 'email' }, { allowFull: false, allowEmail: true }),
      true
    );
    assert.equal(
      isAutomationActionPermitted({ type: 'downlink' }, { allowFull: false, allowEmail: true }),
      false
    );
  });

  it('superadmin tiene todo', () => {
    const sup = { role: 'superadmin' };
    assert.equal(canRunAutomationsForUser(sup), true);
    assert.equal(canUseGlobalNotificationEmailForUser(sup), true);
  });
});
