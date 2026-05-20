'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMilesightButtonAliases } = require('../payload-decoder');

test('applyMilesightButtonAliases: short press', () => {
  const p = { button_event: { status: 'short press', msgid: 1 } };
  applyMilesightButtonAliases(p);
  assert.equal(p.button_event_status, 'short press');
  assert.equal(p.press, 'short');
});

test('applyMilesightButtonAliases: long press', () => {
  const p = { button_event: { status: 'long press', msgid: 2 } };
  applyMilesightButtonAliases(p);
  assert.equal(p.press, 'long');
});
