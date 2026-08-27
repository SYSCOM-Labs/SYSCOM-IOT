'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDemoRole, demoAllowsWrite } = require('../lib/demo-role.cjs');
const navPerm = require('../navPermissions');
const { emptyPermissions, allPermissions, effectivePermissionsForActor } = require('../lib/device-assignment-permissions.cjs');
const {
  canRunAutomationsForUser,
  canUseGlobalNotificationEmailForUser,
} = require('../lib/automation-permissions.cjs');

test('isDemoRole reconoce demo y no otros roles', () => {
  assert.equal(isDemoRole('demo'), true);
  assert.equal(isDemoRole('DEMO'), true);
  assert.equal(isDemoRole(' user '), false);
  assert.equal(isDemoRole('superadmin'), false);
});

test('demoAllowsWrite: GET siempre; POST solo refresh y salir de soporte', () => {
  assert.equal(demoAllowsWrite('GET', '/api/devices'), true);
  assert.equal(demoAllowsWrite('GET', '/api/admin/database/export'), false);
  assert.equal(demoAllowsWrite('HEAD', '/api/users'), true);
  assert.equal(demoAllowsWrite('POST', '/api/auth/refresh'), true);
  assert.equal(demoAllowsWrite('POST', '/api/auth/impersonate/stop'), true);
  assert.equal(demoAllowsWrite('POST', '/api/devices/abc/downlink'), false);
  assert.equal(demoAllowsWrite('PUT', '/api/users/1'), false);
  assert.equal(demoAllowsWrite('DELETE', '/api/users/1'), false);
  assert.equal(demoAllowsWrite('PUT', '/api/me/panel-bsd-preferences'), false);
});

test('effectiveNavForUser demo ve todos los módulos incluyendo Plantillas', () => {
  const nav = navPerm.effectiveNavForUser({ role: 'demo', navPermissionsJson: '{}' });
  assert.equal(nav.Dashboard, true);
  assert.equal(nav.Devices, true);
  assert.equal(nav.Users, true);
  assert.equal(nav.Settings, true);
  assert.equal(nav.Templates, true);
  assert.equal(nav.Automations, true);
});

test('usuario normal sigue sin Plantillas', () => {
  const nav = navPerm.effectiveNavForUser({
    role: 'user',
    navPermissionsJson: JSON.stringify({ Templates: true, Dashboard: true }),
  });
  assert.equal(nav.Templates, false);
  assert.equal(nav.Dashboard, true);
});

test('demo nunca tiene permisos de dispositivo (ni downlink)', () => {
  const actor = { role: 'demo' };
  const ud = { assignmentPermissionsJson: JSON.stringify(allPermissions()) };
  assert.deepEqual(effectivePermissionsForActor(actor, ud), emptyPermissions());
});

test('demo no ejecuta automatizaciones ni email global', () => {
  const demo = { role: 'demo', navPermissionsJson: JSON.stringify(navPerm.allNavTrue()) };
  assert.equal(canRunAutomationsForUser(demo), false);
  assert.equal(canUseGlobalNotificationEmailForUser(demo), false);
});
