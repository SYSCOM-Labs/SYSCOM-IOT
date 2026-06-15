'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encryptEg71Password, CGI_MIN_INTERVAL_MS } = require('../milesight-eg71-gateway-client');

describe('milesight-eg71-gateway-client', () => {
  it('encryptEg71Password devuelve Base64 no vacío', () => {
    const enc = encryptEg71Password('admin');
    assert.ok(typeof enc === 'string' && enc.length > 8);
    assert.doesNotThrow(() => Buffer.from(enc, 'base64'));
  });

  it('CGI_MIN_INTERVAL_MS es 500', () => {
    assert.equal(CGI_MIN_INTERVAL_MS, 500);
  });
});
