'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAutomationTimezone,
  getScheduleClockParts,
} = require('../lib/automation-schedule-clock.cjs');

describe('automation-schedule-clock', () => {
  it('resolveAutomationTimezone prioriza regla y env', () => {
    const prev = process.env.SYSCOM_AUTOMATION_TIMEZONE;
    process.env.SYSCOM_AUTOMATION_TIMEZONE = 'America/Chicago';
    try {
      assert.equal(resolveAutomationTimezone({ scheduleTimezone: 'America/Mexico_City' }), 'America/Mexico_City');
      assert.equal(resolveAutomationTimezone({}), 'America/Chicago');
    } finally {
      if (prev == null) delete process.env.SYSCOM_AUTOMATION_TIMEZONE;
      else process.env.SYSCOM_AUTOMATION_TIMEZONE = prev;
    }
  });

  it('07:50 America/Mexico_City no coincide con 07:50 UTC (desfase horario)', () => {
    const utc750 = new Date('2026-06-04T07:50:00.000Z');
    const mx = getScheduleClockParts(utc750, 'America/Mexico_City');
    const utc = getScheduleClockParts(utc750, 'UTC');
    assert.equal(utc.currentTimeStr, '07:50');
    assert.notEqual(mx.currentTimeStr, utc.currentTimeStr);
    assert.match(mx.currentTimeStr, /^01:5\d$/);
  });

  it('getScheduleClockParts devuelve día y HH:mm', () => {
    const d = new Date('2026-06-04T19:10:00.000Z');
    const parts = getScheduleClockParts(d, 'America/Mexico_City');
    assert.equal(typeof parts.currentDay, 'number');
    assert.match(parts.currentTimeStr, /^\d{2}:\d{2}$/);
  });
});
