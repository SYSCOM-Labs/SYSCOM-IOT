'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAppTimezone,
  getScheduleClockParts,
  isValidIanaTimezone,
  saveAppTimezone,
  getAppTimezoneStatus,
  APP_TIMEZONE_SETTING_KEY,
} = require('../lib/app-timezone.cjs');

describe('app-timezone', () => {
  it('valida zonas IANA', () => {
    assert.equal(isValidIanaTimezone('America/Mexico_City'), true);
    assert.equal(isValidIanaTimezone('Not/AZone'), false);
  });

  it('prioriza Ajustes sobre .env', () => {
    const prev = process.env.SYSCOM_AUTOMATION_TIMEZONE;
    process.env.SYSCOM_AUTOMATION_TIMEZONE = 'UTC';
    const store = {
      getServerSetting: (k) =>
        k === APP_TIMEZONE_SETTING_KEY ? 'America/Mexico_City' : '',
    };
    try {
      assert.equal(resolveAppTimezone(store, null), 'America/Mexico_City');
    } finally {
      if (prev == null) delete process.env.SYSCOM_AUTOMATION_TIMEZONE;
      else process.env.SYSCOM_AUTOMATION_TIMEZONE = prev;
    }
  });

  it('07:50 UTC ≠ 07:50 en America/Mexico_City', () => {
    const utc750 = new Date('2026-06-04T07:50:00.000Z');
    const mx = getScheduleClockParts(utc750, 'America/Mexico_City');
    const utc = getScheduleClockParts(utc750, 'UTC');
    assert.equal(utc.currentTimeStr, '07:50');
    assert.notEqual(mx.currentTimeStr, utc.currentTimeStr);
  });

  it('saveAppTimezone persiste en store', () => {
    const bag = {};
    const store = {
      getServerSetting: (k) => bag[k] || '',
      setServerSetting: (k, v) => {
        bag[k] = v;
      },
    };
    const status = saveAppTimezone(store, 'America/Monterrey');
    assert.equal(status.configured, 'America/Monterrey');
    assert.equal(getAppTimezoneStatus(store).source, 'settings');
  });
});
