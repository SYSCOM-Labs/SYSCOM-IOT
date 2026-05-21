'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifySmtpError, maskEmail } = require('../lib/smtp-mail.cjs');

describe('smtp-mail', () => {
  it('maskEmail oculta la parte local', () => {
    assert.equal(maskEmail('notificaciones@gmail.com'), 'no***@gmail.com');
  });

  it('classifySmtpError detecta autenticación', () => {
    const c = classifySmtpError({ code: 'EAUTH', message: 'Invalid login' });
    assert.equal(c.code, 'AUTH_FAILED');
    assert.equal(c.retryable, false);
  });

  it('classifySmtpError detecta límite', () => {
    const c = classifySmtpError({ responseCode: 421, response: '4.7.0 try again later' });
    assert.equal(c.code, 'RATE_LIMIT');
    assert.equal(c.retryable, true);
  });

  it('classifySmtpError detecta política spam', () => {
    const c = classifySmtpError({ response: '550 5.7.1 spam detected' });
    assert.equal(c.code, 'SPAM_POLICY');
  });
});
