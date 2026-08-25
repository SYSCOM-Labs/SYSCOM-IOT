const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePasswordStrength, validateProvisionalPassword } = require('../password-policy');

test('provisional 123456 is valid for admin-created accounts', () => {
  assert.equal(validateProvisionalPassword('123456').ok, true);
  assert.equal(validateProvisionalPassword(' 123456 ').ok, true);
  assert.equal(validateProvisionalPassword('12345').ok, false);
});

test('123456 is not a definitive password', () => {
  assert.equal(validatePasswordStrength('123456').ok, false);
  assert.equal(validatePasswordStrength('MiClave!8').ok, true);
});
