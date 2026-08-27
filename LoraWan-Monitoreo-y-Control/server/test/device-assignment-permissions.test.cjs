'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  emptyPermissions,
  allPermissions,
  sanitizePermissions,
  parsePermissionsJson,
  intersectPermissions,
  effectivePermissionsForActor,
  actorHasDevicePermission,
} = require('../lib/device-assignment-permissions.cjs');

test('sanitizePermissions ignora claves extra y valores no booleanos', () => {
  assert.deepEqual(
    sanitizePermissions({ edit: true, delete: 'true', downlink: 1, assign: false, extra: true }),
    { edit: true, delete: true, downlink: true, assign: false }
  );
  assert.deepEqual(sanitizePermissions(null), emptyPermissions());
});

test('parsePermissionsJson: sin JSON (alta previa) = editar y downlinks, sin eliminar/asignar', () => {
  assert.deepEqual(parsePermissionsJson(null), { edit: true, delete: false, downlink: true, assign: false });
  assert.deepEqual(parsePermissionsJson(''), { edit: true, delete: false, downlink: true, assign: false });
});

test('parsePermissionsJson: JSON explícito vacío = ningún permiso', () => {
  assert.deepEqual(parsePermissionsJson('{"edit":false,"delete":false,"downlink":false,"assign":false}'), emptyPermissions());
});

test('intersectPermissions no concede más de lo que tiene el actor', () => {
  const granted = { edit: true, delete: true, downlink: true, assign: true };
  const actor = { edit: true, delete: false, downlink: true, assign: false };
  assert.deepEqual(intersectPermissions(granted, actor), {
    edit: true,
    delete: false,
    downlink: true,
    assign: false,
  });
});

test('superadmin siempre tiene todos los permisos', () => {
  const actor = { role: 'superadmin' };
  const ud = { assignmentPermissionsJson: JSON.stringify(emptyPermissions()) };
  assert.deepEqual(effectivePermissionsForActor(actor, ud), allPermissions());
  assert.equal(actorHasDevicePermission(actor, ud, 'delete'), true);
});

test('demo nunca tiene permisos de dispositivo (ni downlink)', () => {
  const actor = { role: 'demo' };
  const ud = { assignmentPermissionsJson: JSON.stringify(allPermissions()) };
  assert.deepEqual(effectivePermissionsForActor(actor, ud), emptyPermissions());
});

test('usuario asignado respeta el JSON', () => {
  const actor = { role: 'user' };
  const ud = { assignmentPermissionsJson: JSON.stringify({ edit: true, downlink: true }) };
  assert.equal(actorHasDevicePermission(actor, ud, 'edit'), true);
  assert.equal(actorHasDevicePermission(actor, ud, 'delete'), false);
  assert.equal(actorHasDevicePermission(actor, ud, 'assign'), false);
});
